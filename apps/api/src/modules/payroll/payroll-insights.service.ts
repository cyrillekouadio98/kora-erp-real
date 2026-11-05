import { Injectable } from '@nestjs/common';
import { inScope } from '../../common/sites';
import { randomUUID } from 'node:crypto';
import { forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { LeaveType } from '../../db/schema';
import { LeaveService } from '../leave/leave.service';
import { workingDays } from '../leave/workdays';
import { PayrollParams, slipFigures, PayslipLine } from './payroll.calc';
import { periodLabel, PayrollService } from './payroll.service';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monthEnd = (p: string) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);
const shiftMonth = (p: string, n: number) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
const round = (n: number) => Math.round(n);

type EmployeeRow = Awaited<ReturnType<PayrollInsightsService['employeeRows']>>[number];

/** Avertissements d'une fiche employé, dans l'ordre d'affichage du tableau de bord. */
export const CONTRACT_WARNINGS: Record<string, string> = {
  ending_soon: 'Contrats se terminant dans les 30 jours',
  cdd_no_end: 'CDD sans date de fin',
  below_smig: 'Salaire de base inférieur au SMIG',
  no_category: 'Employés sans catégorie professionnelle',
  no_cnps: 'Employés sans numéro CNPS',
  no_payment_details: 'Employés sans coordonnées de paiement',
};

export type SettlementReason = 'resignation' | 'dismissal' | 'serious_misconduct' | 'end_of_contract' | 'mutual' | 'retirement';
export const SETTLEMENT_REASONS: Record<SettlementReason, string> = {
  resignation: 'Démission', dismissal: 'Licenciement', serious_misconduct: 'Licenciement pour faute lourde', end_of_contract: 'Fin de contrat à durée déterminée',
  mutual: "Rupture d'un commun accord", retirement: 'Départ à la retraite',
};

export interface PayrollNote { id: string; title: string; body: string }

/**
 * Pilotage de la paie (tableau de bord, contrats, prestations, fiches, analyse) et solde de tout compte.
 * Lecture seule, à l'exception des notes de l'équipe paie.
 */
@Injectable()
export class PayrollInsightsService {
  constructor(private readonly db: DatabaseService, private readonly payroll: PayrollService, private readonly leave: LeaveService) {}

  private assertSalaries(t: TenantInfo) {
    if (!t.permissions.has('payroll.salaries')) throw forbidden('Consulter les salaires demande la permission « voir les salaires et bulletins ».', 'salaries_forbidden');
  }

  private employeeRows(trx: TenantTrx, t: TenantInfo) {
    return inScope(trx.selectFrom('employee').selectAll(), t, 'site_id').orderBy('last_name').orderBy('first_name').execute();
  }

  /** En cours, à venir, se termine bientôt (30 jours) ou terminé. */
  private contractStatus(e: EmployeeRow, on = today()) {
    if (e.hire_date > on) return 'upcoming' as const;
    if (e.end_date && e.end_date < on) return 'ended' as const;
    if (e.end_date && e.end_date <= addDays(on, 30)) return 'ending' as const;
    return 'running' as const;
  }

  private warnings(t: TenantInfo, e: EmployeeRow, p: PayrollParams) {
    const status = this.contractStatus(e);
    if (status === 'ended') return [];
    const out: string[] = [];
    if (status === 'ending') out.push('ending_soon');
    if (e.contract_type === 'cdd' && !e.end_date) out.push('cdd_no_end');
    // Le montant n'est révélé qu'à qui voit les salaires.
    if (t.permissions.has('payroll.salaries') && e.contract_type !== 'stage' && Number(e.base_salary) > 0 && Number(e.base_salary) < p.smig) out.push('below_smig');
    if (!e.category && e.contract_type !== 'stage') out.push('no_category');
    if (!e.cnps_number && e.contract_type !== 'stage') out.push('no_cnps');
    if ((e.payment_method === 'bank_transfer' && !e.bank_details_enc) || (e.payment_method === 'mobile_money' && !e.phone)) out.push('no_payment_details');
    return out;
  }

  // ------------------------------------------------------------------ contrats
  async contracts(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await this.payroll.params(trx);
      const salaries = t.permissions.has('payroll.salaries');
      return (await this.employeeRows(trx, t)).map((e) => ({
        id: e.id, number: e.number, name: `${e.first_name} ${e.last_name}`, jobTitle: e.job_title, department: e.department, category: e.category,
        contractType: e.contract_type, hireDate: e.hire_date, endDate: e.end_date, status: this.contractStatus(e), warnings: this.warnings(t, e, p),
        ...(salaries ? { monthlySalary: Number(e.base_salary) + Number(e.extra_salary) + Number(e.housing_allowance) + Number(e.transport_allowance) + Number(e.other_allowances) } : {}),
      }));
    });
  }

  // ------------------------------------------------------------------ tableau de bord
  async dashboard(t: TenantInfo) {
    this.assertSalaries(t);
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await this.payroll.params(trx);
      const employees = await this.employeeRows(trx, t);
      const now = today(), month = now.slice(0, 7);
      const runs = await trx.selectFrom('payroll_run').select(['id', 'period', 'status']).orderBy('period', 'desc').execute();
      const slips = await trx.selectFrom('payslip').select(['run_id', 'employee_id', 'gross', 'net', 'employer_cost', 'paid_at']).execute();

      const warnings = Object.entries(CONTRACT_WARNINGS).map(([key, label]) => ({ key, label, count: employees.filter((e) => this.warnings(t, e, p).includes(key)).length, href: `/app/paie/contrats?alerte=${key}` }));
      const current = runs.find((r) => r.period === month);
      if (current) {
        const inRun = new Set(slips.filter((s) => s.run_id === current.id).map((s) => s.employee_id));
        const missing = employees.filter((e) => e.hire_date <= monthEnd(month) && (!e.end_date || e.end_date >= `${month}-01`) && !inRun.has(e.id)).length;
        warnings.push({ key: 'missing_from_run', label: `Employés absents de la paie de ${periodLabel(month)}`, count: missing, href: `/app/paie/fiches/${current.id}` });
      }
      const validated = new Set(runs.filter((r) => r.status === 'validated').map((r) => r.id));
      warnings.push({ key: 'unpaid', label: 'Salaires validés non encore payés', count: slips.filter((s) => validated.has(s.run_id) && !s.paid_at).length, href: '/app/paie/fiches?vue=fiches&etat=unpaid' });

      const lots = runs.slice(0, 6).map((r) => {
        const mine = slips.filter((s) => s.run_id === r.id);
        const paid = mine.filter((s) => s.paid_at).length;
        return { id: r.id, period: r.period, label: periodLabel(r.period), payslips: mine.length, paid,
          net: round(mine.reduce((s, x) => s + Number(x.net), 0)), employerCost: round(mine.reduce((s, x) => s + Number(x.employer_cost), 0)),
          state: r.status === 'draft' ? 'draft' : paid === mine.length ? 'paid' : paid ? 'partly_paid' : 'validated' };
      });

      // Coût pour l'employeur : net versé et charges (cotisations, impôts et taxes), par mois et par année.
      const cost = (periods: string[]) => periods.map((key) => {
        const ids = new Set(runs.filter((r) => r.period.startsWith(key)).map((r) => r.id));
        const mine = slips.filter((s) => ids.has(s.run_id));
        const net = mine.reduce((s, x) => s + Number(x.net), 0), employerCost = mine.reduce((s, x) => s + Number(x.employer_cost), 0);
        return { period: key, net: round(net), charges: round(employerCost - net), employerCost: round(employerCost), draft: runs.some((r) => ids.has(r.id) && r.status === 'draft') };
      });
      const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
      const year = Number(now.slice(0, 4));
      const years = [year - 2, year - 1, year].map(String);

      // Effectif présent en fin de période (aujourd'hui pour la période en cours).
      const headcount = (periods: string[], end: (k: string) => string) => periods.map((key) => {
        const at = end(key) > now ? now : end(key);
        return { period: key, count: employees.filter((e) => e.hire_date <= at && (!e.end_date || e.end_date >= at)).length };
      });
      const moves = (from: string) => ({
        arrivals: employees.filter((e) => e.hire_date >= from && e.hire_date <= now).length,
        departures: employees.filter((e) => e.end_date && e.end_date >= from && e.end_date <= now).length,
      });

      return {
        warnings, lots, notes: await this.readNotes(trx),
        cost: { monthly: cost(months), yearly: cost(years) },
        headcount: { monthly: headcount(months, monthEnd), yearly: headcount(years, (y) => `${y}-12-31`) },
        moves: { monthly: moves(`${month}-01`), yearly: moves(`${year}-01-01`) },
      };
    });
  }

  // ------------------------------------------------------------------ notes de l'équipe paie
  private async readNotes(trx: TenantTrx): Promise<PayrollNote[]> {
    const s = await trx.selectFrom('payroll_settings').select('notes').executeTakeFirst();
    return (s?.notes as PayrollNote[] | undefined) ?? [];
  }

  async saveNotes(t: TenantInfo, notes: { id?: string; title: string; body: string }[]) {
    this.assertSalaries(t);
    return this.db.tenant(t.ctx, async (trx) => {
      const clean = notes.map((n) => ({ id: n.id && isUuid(n.id) ? n.id : randomUUID(), title: n.title, body: n.body }));
      await trx.insertInto('payroll_settings').values({ company_id: t.companyId, params: JSON.stringify({}), notes: JSON.stringify(clean), updated_by: t.ctx.userId })
        .onConflict((oc) => oc.column('company_id').doUpdateSet({ notes: JSON.stringify(clean) })).execute();
      return clean;
    });
  }

  // ------------------------------------------------------------------ fiches de paie
  /** Toutes les fiches, avec leur lot : base de la liste « Fiches de paie » et de l'analyse. */
  async payslips(t: TenantInfo, f: { from?: string; to?: string; employeeId?: string }) {
    this.assertSalaries(t);
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await trx.selectFrom('payslip as s').innerJoin('payroll_run as r', (j) => j.onRef('r.id', '=', 's.run_id').onRef('r.company_id', '=', 's.company_id'))
        .select(['s.id', 's.run_id as runId', 's.employee_id as employeeId', 's.employee', 's.lines', 's.totals', 's.gross', 's.taxable', 's.net', 's.employer_cost', 's.paid_at as paidAt', 'r.period', 'r.status'])
        .$if(!!f.from, (q) => q.where('r.period', '>=', f.from!)).$if(!!f.to, (q) => q.where('r.period', '<=', f.to!))
        .$if(!!f.employeeId, (q) => q.where('s.employee_id', '=', f.employeeId!))
        .orderBy('r.period', 'desc').execute();
      return rows.map((s) => {
        const e = s.employee as any;
        const fig = slipFigures({ lines: s.lines as PayslipLine[], totals: s.totals as Record<string, number>, taxable: Number(s.taxable), net: Number(s.net) });
        return {
          id: s.id, runId: s.runId, period: s.period, label: periodLabel(s.period), runStatus: s.status, employeeId: s.employeeId,
          name: e.name, number: e.number, department: e.department, jobTitle: e.jobTitle,
          gross: Number(s.gross), net: Number(s.net), employerCost: Number(s.employer_cost), employeeCharges: fig.employeeCharges, employerCharges: fig.employerCharges,
          its: Number((s.totals as any).its ?? 0), paidAt: s.paidAt,
        };
      }).sort((a, b) => (a.period === b.period ? a.name.localeCompare(b.name) : a.period < b.period ? 1 : -1));
    });
  }

  // ------------------------------------------------------------------ prestations (jours du mois)
  /**
   * Prestations d'un mois, par employé : jours ouvrables du mois, absences par nature (congés validés),
   * jours retenus et éléments variables saisis dans la paie du mois si elle existe.
   */
  async workEntries(t: TenantInfo, period: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const start = `${period}-01`, end = monthEnd(period);
      const employees = (await this.employeeRows(trx, t)).filter((e) => e.hire_date <= end && (!e.end_date || e.end_date >= start));
      const leaves = await trx.selectFrom('leave_request').select(['employee_id', 'type', 'start_date', 'end_date']).where('status', '=', 'approved')
        .where('start_date', '<=', end).where('end_date', '>=', start).execute();
      const run = await trx.selectFrom('payroll_run').select(['id', 'status']).where('period', '=', period).executeTakeFirst();
      const slips = run ? await trx.selectFrom('payslip').select(['employee_id', 'inputs']).where('run_id', '=', run.id).execute() : [];
      const salaries = t.permissions.has('payroll.salaries');
      const total = workingDays(start, end);
      const rows = employees.map((e) => {
        // Jours ouvrables de présence au contrat sur le mois (embauche ou départ en cours de mois)
        const from = e.hire_date > start ? e.hire_date : start, to = e.end_date && e.end_date < end ? e.end_date : end;
        const contract = workingDays(from, to);
        const byType: Partial<Record<LeaveType, number>> = {};
        for (const l of leaves.filter((x) => x.employee_id === e.id)) {
          const a = l.start_date > from ? l.start_date : from, b = l.end_date < to ? l.end_date : to;
          if (a <= b) byType[l.type] = (byType[l.type] ?? 0) + workingDays(a, b);
        }
        const absent = Object.values(byType).reduce((s, n) => s + n, 0);
        const inputs = slips.find((s) => s.employee_id === e.id)?.inputs as any;
        return {
          employeeId: e.id, number: e.number, name: `${e.first_name} ${e.last_name}`, department: e.department, contractType: e.contract_type,
          contractDays: contract, worked: Math.max(0, contract - absent), leave: byType, inPayroll: !!inputs,
          absenceDays: inputs ? Number(inputs.absenceDays ?? 0) : null,
          ...(salaries && inputs ? { overtime: Number(inputs.overtime ?? 0), bonus: Number(inputs.bonus ?? 0) } : {}),
        };
      });
      return { period, label: periodLabel(period), workingDays: total, run: run ?? null, rows };
    });
  }

  // ------------------------------------------------------------------ solde de tout compte
  /**
   * Solde de tout compte (Code du travail ivoirien) : indemnité de licenciement par tranches d'ancienneté
   * (30 % du salaire mensuel moyen par année jusqu'à 5 ans, 35 % de 6 à 10 ans, 40 % au-delà), préavis,
   * congés acquis non pris et indemnité de fin de CDD (3 % des salaires bruts perçus). Calcul indicatif, à valider.
   */
  async finalSettlement(t: TenantInfo, f: { employeeId: string; endDate: string; reason: SettlementReason; noticeMonths?: number; leaveDays?: number }) {
    this.assertSalaries(t);
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(f.employeeId)) throw notFound('Employé');
      const e = await trx.selectFrom('employee').selectAll().where('id', '=', f.employeeId).executeTakeFirst();
      if (!e) throw notFound('Employé');
      const end = f.endDate < e.hire_date ? e.hire_date : f.endDate;
      const days = (Date.parse(end) - Date.parse(e.hire_date)) / 86_400_000 + 1;
      const years = Math.max(0, days / 365.25);

      // Salaire mensuel moyen des 12 derniers mois payés (bulletins validés), à défaut le salaire du contrat.
      const slips = await trx.selectFrom('payslip as s').innerJoin('payroll_run as r', (j) => j.onRef('r.id', '=', 's.run_id').onRef('r.company_id', '=', 's.company_id'))
        .select(['r.period', 's.gross']).where('s.employee_id', '=', e.id).where('r.status', '=', 'validated').where('r.period', '<=', end.slice(0, 7))
        .orderBy('r.period', 'desc').execute();
      const last12 = slips.slice(0, 12);
      const contractMonthly = Number(e.base_salary) + Number(e.extra_salary) + Number(e.housing_allowance) + Number(e.transport_allowance) + Number(e.other_allowances);
      const average = last12.length ? round(last12.reduce((s, x) => s + Number(x.gross), 0) / last12.length) : contractMonthly;
      const daily = average / 26; // jour ouvrable

      const lines: { code: string; label: string; basis: string; amount: number; taxable: boolean }[] = [];
      const severance = ['dismissal', 'mutual', 'retirement'].includes(f.reason) && years >= 1;
      if (severance) {
        const factor = 0.3 * Math.min(years, 5) + 0.35 * Math.min(Math.max(years - 5, 0), 5) + 0.4 * Math.max(years - 10, 0);
        lines.push({ code: 'LIC', label: f.reason === 'retirement' ? 'Indemnité de départ à la retraite' : 'Indemnité de licenciement',
          basis: `${years.toFixed(2).replace('.', ',')} an(s) d'ancienneté : 30 % jusqu'à 5 ans, 35 % de 6 à 10 ans, 40 % au-delà`, amount: round(average * factor), taxable: false });
      }
      const suggestedNotice = ['dismissal', 'mutual'].includes(f.reason) ? (years < 6 ? 1 : years < 11 ? 2 : years < 16 ? 3 : 4) : 0;
      const noticeMonths = f.noticeMonths ?? suggestedNotice;
      if (noticeMonths > 0) lines.push({ code: 'PRE', label: 'Indemnité compensatrice de préavis', basis: `${String(noticeMonths).replace('.', ',')} mois non effectué(s)`, amount: round(average * noticeMonths), taxable: true });
      // Jours à indemniser : le solde du module Congés, sauf correction (report d'ouverture absent, congés pris hors N'Ora…).
      const balance = await this.leave.balance(trx, e, end);
      const leaveDays = f.leaveDays ?? Math.max(0, balance.available);
      if (leaveDays > 0) lines.push({ code: 'CP', label: 'Indemnité compensatrice de congés payés', basis: `${String(leaveDays).replace('.', ',')} jour(s) acquis non pris × salaire journalier moyen (1/26 du mois)`, amount: round(daily * leaveDays), taxable: true });
      if (e.contract_type === 'cdd' && f.reason === 'end_of_contract') {
        const paid = slips.reduce((s, x) => s + Number(x.gross), 0);
        lines.push({ code: 'FCDD', label: 'Indemnité de fin de contrat (CDD)', basis: '3 % des salaires bruts perçus pendant le contrat', amount: round(paid * 0.03), taxable: true });
      }
      return {
        employee: { id: e.id, number: e.number, name: `${e.first_name} ${e.last_name}`, jobTitle: e.job_title, department: e.department, category: e.category,
          contractType: e.contract_type, hireDate: e.hire_date, endDate: e.end_date, cnpsNumber: e.cnps_number },
        endDate: end, reason: f.reason, reasonLabel: SETTLEMENT_REASONS[f.reason], seniority: { years: Math.floor(years), months: Math.floor((years % 1) * 12), decimal: Math.round(years * 100) / 100 },
        average, averageBasis: last12.length ? `moyenne des ${last12.length} dernier(s) bulletin(s) validé(s)` : 'salaire mensuel du contrat (aucun bulletin validé)',
        suggestedNotice, noticeMonths, leaveDays, leave: { available: balance.available, acquired: Math.round((balance.opening + balance.accrued) * 10) / 10, taken: balance.taken },
        lines, total: lines.reduce((s, l) => s + l.amount, 0),
      };
    });
  }
}
