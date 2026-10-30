import { Injectable } from '@nestjs/common';
import { decrypt, encrypt } from '../../common/crypto';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AccountingService } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';
import { TreasuryService } from '../treasury/treasury.service';
import { computePayslip, DEFAULT_PAYROLL_PARAMS, familyParts, MaritalStatus, PayrollParams } from './payroll.calc';

export interface EmployeeInput {
  firstName: string; lastName: string; jobTitle?: string | null; department?: string | null; hireDate: string; endDate?: string | null;
  contractType?: 'cdi' | 'cdd' | 'stage' | 'journalier'; cnpsNumber?: string | null; maritalStatus?: MaritalStatus; children?: number; partsOverride?: number | null;
  baseSalary?: number; housingAllowance?: number; transportAllowance?: number; otherAllowances?: number;
  paymentMethod?: 'cash' | 'bank_transfer' | 'mobile_money'; bankDetails?: string | null; phone?: string | null; email?: string | null;
}
export interface PayslipInputs { overtime: number; bonus: number; absenceDays: number; advanceDeduction: number; otherDeduction: number }
const NO_INPUTS: PayslipInputs = { overtime: 0, bonus: 0, absenceDays: 0, advanceDeduction: 0, otherDeduction: 0 };

const COLUMNS: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', jobTitle: 'job_title', department: 'department', hireDate: 'hire_date', endDate: 'end_date',
  contractType: 'contract_type', cnpsNumber: 'cnps_number', maritalStatus: 'marital_status', children: 'children', partsOverride: 'parts_override',
  baseSalary: 'base_salary', housingAllowance: 'housing_allowance', transportAllowance: 'transport_allowance', otherAllowances: 'other_allowances',
  paymentMethod: 'payment_method', phone: 'phone', email: 'email',
};
const SALARY_FIELDS = ['baseSalary', 'housingAllowance', 'transportAllowance', 'otherAllowances'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const periodLabel = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const periodEnd = (p: string) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

type EmployeeRow = Awaited<ReturnType<PayrollService['employeeRow']>>;

@Injectable()
export class PayrollService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly accounting: AccountingService, private readonly treasury: TreasuryService) {}

  /** Les montants de paie ne sont visibles qu'avec la permission sensible « voir les salaires ». */
  private assertSalaries(t: TenantInfo) {
    if (!t.permissions.has('payroll.salaries')) throw forbidden('Consulter les salaires demande la permission « voir les salaires et bulletins ».', 'salaries_forbidden');
  }

  // ------------------------------------------------------------------ paramètres
  async params(trx: TenantTrx): Promise<PayrollParams> {
    const s = await trx.selectFrom('payroll_settings').select('params').executeTakeFirst();
    return { ...DEFAULT_PAYROLL_PARAMS, ...((s?.params as object) ?? {}) };
  }
  async getSettings(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => ({ params: await this.params(trx), defaults: DEFAULT_PAYROLL_PARAMS }));
  }
  async updateSettings(t: TenantInfo, patch: Partial<PayrollParams>) {
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await this.params(trx);
      const params = { ...before, ...patch };
      await trx.insertInto('payroll_settings').values({ company_id: t.companyId, params: JSON.stringify(params), updated_by: t.ctx.userId })
        .onConflict((oc) => oc.column('company_id').doUpdateSet({ params: JSON.stringify(params), updated_by: t.ctx.userId, updated_at: new Date() })).execute();
      const changes = Object.fromEntries(Object.keys(patch).map((k) => [k, { from: (before as any)[k], to: (params as any)[k] }]));
      await this.audit.tenant(trx, t.ctx, { action: 'payroll.settings_updated', data: { changes } });
      return { params };
    });
  }

  // ------------------------------------------------------------------ employés
  private async employeeRow(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Employé');
    const e = await trx.selectFrom('employee').selectAll().where('id', '=', id).executeTakeFirst();
    if (!e) throw notFound('Employé');
    return e;
  }

  private present(t: TenantInfo, e: EmployeeRow) {
    const salaries = t.permissions.has('payroll.salaries');
    const bank = t.permissions.has('employees.bank_details');
    const parts = e.parts_override !== null ? Number(e.parts_override) : familyParts(e.marital_status, e.children);
    return {
      id: e.id, number: e.number, firstName: e.first_name, lastName: e.last_name, fullName: `${e.first_name} ${e.last_name}`, jobTitle: e.job_title, department: e.department,
      hireDate: e.hire_date, endDate: e.end_date, contractType: e.contract_type, cnpsNumber: e.cnps_number, maritalStatus: e.marital_status, children: e.children,
      partsOverride: e.parts_override === null ? null : Number(e.parts_override), parts, paymentMethod: e.payment_method, phone: e.phone, email: e.email,
      active: !e.end_date || e.end_date >= today(),
      ...(salaries ? { baseSalary: Number(e.base_salary), housingAllowance: Number(e.housing_allowance), transportAllowance: Number(e.transport_allowance), otherAllowances: Number(e.other_allowances) } : {}),
      bankDetails: bank ? (e.bank_details_enc ? decrypt(e.bank_details_enc) : null) : e.bank_details_enc ? '••••' : null,
    };
  }

  /** Salaires et RIB : chaque catégorie de donnée exige sa permission sensible. */
  private assertFieldRights(t: TenantInfo, input: Partial<EmployeeInput>) {
    if (SALARY_FIELDS.some((f) => (input as any)[f] !== undefined)) this.assertSalaries(t);
    if (input.bankDetails !== undefined && !t.permissions.has('employees.bank_details')) {
      throw forbidden('Modifier les coordonnées bancaires demande la permission « coordonnées bancaires des employés ».', 'bank_details_forbidden');
    }
  }

  private columns(input: Partial<EmployeeInput>) {
    const out: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(COLUMNS)) if ((input as any)[k] !== undefined) out[col] = (input as any)[k];
    if (input.bankDetails !== undefined) out.bank_details_enc = input.bankDetails ? encrypt(input.bankDetails) : null;
    return out;
  }

  async employees(t: TenantInfo, f: { includeLeft?: boolean; q?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('employee').selectAll().orderBy('last_name').orderBy('first_name');
      if (!f.includeLeft) q = q.where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', today())]));
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('first_name', 'ilike', like), eb('last_name', 'ilike', like), eb('number', 'ilike', like), eb('job_title', 'ilike', like)]));
      }
      return (await q.execute()).map((e) => this.present(t, e));
    });
  }

  async getEmployee(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => this.present(t, await this.employeeRow(trx, id)));
  }

  async createEmployee(t: TenantInfo, input: EmployeeInput) {
    this.assertFieldRights(t, input);
    return this.db.tenant(t.ctx, async (trx) => {
      const number = await nextNumber(trx, t.companyId, 'employee', 'EMP');
      const e = await trx.insertInto('employee').values({ ...this.columns(input), number, company_id: t.companyId, created_by: t.ctx.userId } as any)
        .returningAll().executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'employee.created', entityType: 'employee', entityId: e.id, data: { number, name: `${e.first_name} ${e.last_name}` } });
      return this.present(t, e);
    });
  }

  async updateEmployee(t: TenantInfo, id: string, input: Partial<EmployeeInput>) {
    this.assertFieldRights(t, input);
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await this.employeeRow(trx, id);
      const patch = this.columns(input);
      if (input.endDate !== undefined && input.endDate && input.endDate < (input.hireDate ?? before.hire_date)) throw badRequest("La date de sortie précède la date d'embauche.", undefined, 'end_before_hire');
      const after = Object.keys(patch).length ? await trx.updateTable('employee').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow() : before;
      // Le journal ne garde que la liste des champs modifiés : ni salaire ni RIB en clair.
      await this.audit.tenant(trx, t.ctx, { action: 'employee.updated', entityType: 'employee', entityId: id, data: { number: before.number, fields: Object.keys(input) } });
      return this.present(t, after);
    });
  }

  // ------------------------------------------------------------------ paies mensuelles
  private async run(trx: TenantTrx, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Paie');
    const r = await trx.selectFrom('payroll_run').selectAll().where('id', '=', id).$if(lock, (q) => q.forUpdate()).executeTakeFirst();
    if (!r) throw notFound('Paie');
    return r;
  }

  /** Calcule le bulletin d'un employé pour la période à partir de sa fiche et des éléments variables. */
  private slip(e: EmployeeRow, inputs: PayslipInputs, params: PayrollParams) {
    const parts = e.parts_override !== null ? Number(e.parts_override) : familyParts(e.marital_status, e.children);
    const beneficiaries = 1 + (e.marital_status === 'married' ? 1 : 0) + e.children;
    const result = computePayslip({
      baseSalary: Number(e.base_salary), housingAllowance: Number(e.housing_allowance), otherAllowances: Number(e.other_allowances), transportAllowance: Number(e.transport_allowance),
      ...inputs, parts, cmuBeneficiaries: beneficiaries,
    }, params);
    if (result.net < 0) throw badRequest(`Le net à payer de ${e.first_name} ${e.last_name} serait négatif : réduisez les retenues.`, undefined, 'negative_net');
    const employee = { number: e.number, name: `${e.first_name} ${e.last_name}`, jobTitle: e.job_title, department: e.department, hireDate: e.hire_date,
      contractType: e.contract_type, cnpsNumber: e.cnps_number, maritalStatus: e.marital_status, children: e.children, parts, paymentMethod: e.payment_method };
    return { employee, result };
  }

  private async writeSlip(trx: TenantTrx, t: TenantInfo, runId: string, e: EmployeeRow, inputs: PayslipInputs, params: PayrollParams) {
    const { employee, result } = this.slip(e, inputs, params);
    const values = {
      employee: JSON.stringify(employee), inputs: JSON.stringify(inputs), lines: JSON.stringify(result.lines), totals: JSON.stringify(result.totals),
      gross: result.gross, taxable: result.taxable, net: result.net, employer_cost: result.totals.employerCost,
    };
    await trx.insertInto('payslip').values({ company_id: t.companyId, run_id: runId, employee_id: e.id, paid_at: null, ...values })
      .onConflict((oc) => oc.columns(['company_id', 'run_id', 'employee_id']).doUpdateSet(values)).execute();
  }

  async runs(t: TenantInfo) {
    this.assertSalaries(t);
    return this.db.tenant(t.ctx, async (trx) => {
      const runs = await trx.selectFrom('payroll_run').select(['id', 'period', 'status', 'validated_at as validatedAt']).orderBy('period', 'desc').execute();
      const slips = await trx.selectFrom('payslip').select(['run_id', 'gross', 'net', 'employer_cost', 'paid_at']).execute();
      return runs.map((r) => {
        const mine = slips.filter((s) => s.run_id === r.id);
        const sum = (k: 'gross' | 'net' | 'employer_cost') => mine.reduce((s, x) => s + Number(x[k]), 0);
        return { ...r, label: periodLabel(r.period), employees: mine.length, gross: sum('gross'), net: sum('net'), employerCost: sum('employer_cost'), paid: mine.filter((s) => s.paid_at).length };
      });
    });
  }

  async createRun(t: TenantInfo, period: string) {
    if (period > today().slice(0, 7)) throw badRequest('On ne prépare pas la paie d’un mois futur.', undefined, 'future_period');
    const id = await this.db.tenant(t.ctx, async (trx) => {
      if (await trx.selectFrom('payroll_run').select('id').where('period', '=', period).executeTakeFirst()) throw conflict(`La paie de ${periodLabel(period)} existe déjà.`, 'run_exists');
      const params = await this.params(trx);
      const employees = await trx.selectFrom('employee').selectAll().where('hire_date', '<=', periodEnd(period))
        .where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', `${period}-01`)])).execute();
      if (!employees.length) throw badRequest('Aucun employé présent sur cette période.', undefined, 'no_employees');
      const r = await trx.insertInto('payroll_run').values({ company_id: t.companyId, period, params: JSON.stringify(params), validated_by: null, created_by: t.ctx.userId })
        .returning('id').executeTakeFirstOrThrow();
      for (const e of employees) await this.writeSlip(trx, t, r.id, e, NO_INPUTS, params);
      await this.audit.tenant(trx, t.ctx, { action: 'payroll.run_created', entityType: 'payroll_run', entityId: r.id, data: { period, employees: employees.length } });
      return r.id;
    });
    return this.getRun(t, id);
  }

  async getRun(t: TenantInfo, id: string) {
    this.assertSalaries(t);
    return this.db.tenant(t.ctx, async (trx) => {
      const r = await this.run(trx, id);
      const slips = await trx.selectFrom('payslip').selectAll().where('run_id', '=', id).execute();
      const payslips = slips.map((s) => ({
        id: s.id, employeeId: s.employee_id, employee: s.employee as any, inputs: s.inputs as PayslipInputs, lines: s.lines, totals: s.totals as any,
        gross: Number(s.gross), taxable: Number(s.taxable), net: Number(s.net), employerCost: Number(s.employer_cost), paidAt: s.paid_at,
      })).sort((a, b) => a.employee.name.localeCompare(b.employee.name));
      const sum = (f: (p: (typeof payslips)[number]) => number) => payslips.reduce((s, p) => s + f(p), 0);
      const tot = (k: string) => sum((p) => Number(p.totals[k] ?? 0));
      return {
        id: r.id, period: r.period, label: periodLabel(r.period), status: r.status, validatedAt: r.validated_at, params: r.params, payslips,
        totals: { gross: sum((p) => p.gross), net: sum((p) => p.net), employerCost: sum((p) => p.employerCost), paid: payslips.filter((p) => p.paidAt).length },
        // Récapitulatif des déclarations du mois
        declarations: {
          cnps: { retirementEmployee: tot('cnpsEmployee'), retirementEmployer: tot('cnpsEmployer'), familyBenefits: tot('familyBenefits'), workAccident: tot('workAccident'),
            total: tot('cnpsEmployee') + tot('cnpsEmployer') + tot('familyBenefits') + tot('workAccident') },
          cmu: { employee: tot('cmuEmployee'), employer: tot('cmuEmployer'), total: tot('cmuEmployee') + tot('cmuEmployer') },
          its: { withheld: tot('its'), employerTax: tot('employerTax'), apprenticeship: tot('apprenticeship'), training: tot('training'),
            total: tot('its') + tot('employerTax') + tot('apprenticeship') + tot('training') },
        },
      };
    });
  }

  /** Éléments variables d'un bulletin (heures sup., primes, absences, retenues), recalculé aussitôt. */
  async updatePayslip(t: TenantInfo, runId: string, payslipId: string, inputs: Partial<PayslipInputs>) {
    this.assertSalaries(t);
    await this.db.tenant(t.ctx, async (trx) => {
      const r = await this.run(trx, runId, true);
      if (r.status !== 'draft') throw conflict('Cette paie est validée : ses bulletins ne se modifient plus.', 'run_validated');
      if (!isUuid(payslipId)) throw notFound('Bulletin');
      const s = await trx.selectFrom('payslip').select(['employee_id', 'inputs']).where('id', '=', payslipId).where('run_id', '=', runId).executeTakeFirst();
      if (!s) throw notFound('Bulletin');
      const merged = { ...NO_INPUTS, ...(s.inputs as object), ...inputs };
      await this.writeSlip(trx, t, runId, await this.employeeRow(trx, s.employee_id), merged, await this.params(trx));
    });
    return this.getRun(t, runId);
  }

  /** Recalcule tous les bulletins d'une paie en brouillon d'après les fiches et paramètres actuels. */
  async recompute(t: TenantInfo, runId: string) {
    this.assertSalaries(t);
    await this.db.tenant(t.ctx, async (trx) => {
      const r = await this.run(trx, runId, true);
      if (r.status !== 'draft') throw conflict('Cette paie est validée.', 'run_validated');
      const params = await this.params(trx);
      await trx.updateTable('payroll_run').set({ params: JSON.stringify(params) }).where('id', '=', runId).execute();
      for (const s of await trx.selectFrom('payslip').select(['employee_id', 'inputs']).where('run_id', '=', runId).execute()) {
        await this.writeSlip(trx, t, runId, await this.employeeRow(trx, s.employee_id), { ...NO_INPUTS, ...(s.inputs as object) }, params);
      }
    });
    return this.getRun(t, runId);
  }

  async deleteRun(t: TenantInfo, runId: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const r = await this.run(trx, runId, true);
      if (r.status !== 'draft') throw conflict('Une paie validée ne se supprime pas.', 'run_validated');
      await trx.deleteFrom('payroll_run').where('id', '=', runId).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'payroll.run_deleted', entityType: 'payroll_run', entityId: runId, data: { period: r.period } });
      return { ok: true };
    });
  }

  /**
   * Validation : la paie devient intangible et passe en comptabilité au dernier jour du mois :
   * D 661 salaires bruts, 664 charges sociales, 641 taxes sur salaires / C 422 net à payer, 431 CNPS,
   * 438 CMU, 447 ITS et taxes, 421 avances et retenues.
   */
  async validate(t: TenantInfo, runId: string) {
    this.assertSalaries(t);
    const run = await this.getRun(t, runId);
    if (run.status !== 'draft') throw conflict('Cette paie est déjà validée.', 'run_validated');
    await this.db.tenant(t.ctx, async (trx) => {
      await this.run(trx, runId, true);
      const d = run.declarations;
      const tot = (k: string) => run.payslips.reduce((s, p) => s + Number(p.totals[k] ?? 0), 0);
      const label = `Paie de ${run.label}`;
      const entry = await this.accounting.postEntry(trx, t, {
        journal: 'OD', date: periodEnd(run.period), label, sourceType: 'payroll_run', sourceId: runId, lines: [
          { account: '661', label: `${label} — salaires bruts`, debit: run.totals.gross },
          { account: '664', label: `${label} — charges sociales patronales`, debit: d.cnps.retirementEmployer + d.cnps.familyBenefits + d.cnps.workAccident + d.cmu.employer },
          { account: '641', label: `${label} — taxes sur salaires`, debit: d.its.employerTax + d.its.apprenticeship + d.its.training },
          { account: '422', label: `${label} — net à payer`, credit: run.totals.net },
          { account: '431', label: `${label} — CNPS`, credit: d.cnps.total },
          { account: '438', label: `${label} — CMU`, credit: d.cmu.total },
          { account: '447', label: `${label} — ITS et taxes`, credit: d.its.total },
          { account: '421', label: `${label} — avances et retenues`, credit: tot('advances') + tot('otherDeductions') },
        ],
      });
      await trx.updateTable('payroll_run').set({ status: 'validated', validated_at: new Date(), validated_by: t.ctx.userId }).where('id', '=', runId).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'payroll.run_validated', entityType: 'payroll_run', entityId: runId, data: { period: run.period, net: run.totals.net, entry: entry.number } });
    });
    return this.getRun(t, runId);
  }

  /** Paiement des salaires : un décaissement par bulletin (D 422 / C 5x). La caisse refuse un paiement qu'elle ne peut couvrir. */
  async pay(t: TenantInfo, runId: string, input: { accountId: string; date?: string; payslipIds?: string[] }) {
    this.assertSalaries(t);
    await this.db.tenant(t.ctx, async (trx) => {
      const r = await this.run(trx, runId);
      if (r.status !== 'validated') throw conflict('Validez la paie avant de payer les salaires.', 'run_not_validated');
      let q = trx.selectFrom('payslip').selectAll().where('run_id', '=', runId).where('paid_at', 'is', null);
      if (input.payslipIds?.length) q = q.where('id', 'in', input.payslipIds);
      const slips = await q.execute();
      if (!slips.length) throw conflict('Tous les salaires sélectionnés sont déjà payés.', 'already_paid');
      const date = input.date ?? today();
      for (const s of slips) {
        const name = (s.employee as any).name;
        if (Number(s.net) > 0) {
          await this.treasury.record(trx, t, { accountId: input.accountId, date, direction: 'out', amount: Number(s.net), category: 'net_salary',
            label: `Salaire de ${periodLabel(r.period)} — ${name}`, sourceType: 'payroll', sourceId: s.id });
        }
        await trx.updateTable('payslip').set({ paid_at: date }).where('id', '=', s.id).execute();
      }
      await this.audit.tenant(trx, t.ctx, { action: 'payroll.salaries_paid', entityType: 'payroll_run', entityId: runId, data: { period: r.period, count: slips.length, total: slips.reduce((s, x) => s + Number(x.net), 0) } });
    });
    return this.getRun(t, runId);
  }
}
