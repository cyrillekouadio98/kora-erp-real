import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { config } from '../../config';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { LeaveType } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { DEFAULT_PAYROLL_PARAMS } from '../payroll/payroll.calc';
import { fullMonths, workingDays } from './workdays';

export const LEAVE_TYPES: Record<LeaveType, string> = {
  annual: 'Congé payé', sick: 'Maladie', maternity: 'Maternité', family_event: 'Permission exceptionnelle (événement familial)', unpaid: 'Congé sans solde', other: 'Autre absence',
};
const today = () => new Date().toISOString().slice(0, 10);
const round1 = (n: number) => Math.round(n * 10) / 10;
const frDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
type EmployeeRow = { id: string; first_name: string; last_name: string; hire_date: string; end_date: string | null; email: string | null; user_id: string | null; leave_opening_balance: string; leave_opening_date: string | null };

/**
 * Congés : acquisition mensuelle (2,2 jours ouvrables par mois de service, paramétrable),
 * décompte en jours ouvrables, validation par un responsable. Seul le congé payé consomme le solde.
 */
@Injectable()
export class LeaveService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly mail: MailService) {}

  private async rate(trx: TenantTrx) {
    const s = await trx.selectFrom('payroll_settings').select('params').executeTakeFirst();
    return Number((s?.params as any)?.leaveDaysPerMonth ?? DEFAULT_PAYROLL_PARAMS.leaveDaysPerMonth);
  }

  private async employee(trx: TenantTrx, id: string): Promise<EmployeeRow> {
    if (!isUuid(id)) throw notFound('Employé');
    const e = await trx.selectFrom('employee').select(['id', 'first_name', 'last_name', 'hire_date', 'end_date', 'email', 'user_id', 'leave_opening_balance', 'leave_opening_date'])
      .where('id', '=', id).executeTakeFirst();
    if (!e) throw notFound('Employé');
    return e;
  }

  /** Fiche de l'employé rattachée à l'utilisateur connecté (espace employé). */
  async own(trx: TenantTrx, t: TenantInfo): Promise<EmployeeRow> {
    const e = await trx.selectFrom('employee').select(['id', 'first_name', 'last_name', 'hire_date', 'end_date', 'email', 'user_id', 'leave_opening_balance', 'leave_opening_date'])
      .where('user_id', '=', t.ctx.userId).executeTakeFirst();
    if (!e) throw forbidden("Votre compte n'est rattaché à aucune fiche employé de cette entreprise. Demandez à votre responsable de vous inviter depuis votre fiche.", 'not_an_employee');
    return e;
  }

  /** Solde : report d'ouverture + jours acquis − congés payés validés (les demandes en attente sont indiquées à part). */
  async balance(trx: TenantTrx, e: EmployeeRow, asOf = today()) {
    const until = e.end_date && e.end_date < asOf ? e.end_date : asOf;
    const months = fullMonths(e.leave_opening_date ?? e.hire_date, until);
    const rate = await this.rate(trx);
    const rows = await trx.selectFrom('leave_request').select(['status', 'days']).where('employee_id', '=', e.id).where('type', '=', 'annual').where('status', 'in', ['approved', 'pending']).execute();
    const taken = rows.filter((r) => r.status === 'approved').reduce((s, r) => s + Number(r.days), 0);
    const pending = rows.filter((r) => r.status === 'pending').reduce((s, r) => s + Number(r.days), 0);
    const opening = Number(e.leave_opening_balance);
    const accrued = round1(months * rate);
    return { opening, months, rate, accrued, taken: round1(taken), pending: round1(pending), available: round1(opening + accrued - taken) };
  }

  private async present(trx: TenantTrx, rows: any[]) {
    return rows.map((r) => ({
      id: r.id, employeeId: r.employee_id, employeeName: r.first_name ? `${r.first_name} ${r.last_name}` : undefined, type: r.type, typeLabel: LEAVE_TYPES[r.type as LeaveType],
      startDate: r.start_date, endDate: r.end_date, days: Number(r.days), reason: r.reason, status: r.status, decisionNote: r.decision_note, decidedAt: r.decided_at, createdAt: r.created_at,
    }));
  }

  // ------------------------------------------------------------------ demandes
  async request(t: TenantInfo, input: { employeeId?: string; type: LeaveType; startDate: string; endDate: string; reason?: string | null }, self: boolean) {
    return this.db.tenant(t.ctx, async (trx) => {
      const e = self ? await this.own(trx, t) : await this.employee(trx, input.employeeId!);
      if (input.endDate < input.startDate) throw badRequest('La date de fin précède la date de début.', undefined, 'invalid_dates');
      if (input.startDate < e.hire_date) throw badRequest("Le congé commence avant la date d'embauche.", undefined, 'before_hire');
      const days = workingDays(input.startDate, input.endDate);
      if (!days) throw badRequest('Cette période ne contient aucun jour ouvrable (dimanches et jours fériés exclus).', undefined, 'no_working_day');
      const overlap = await trx.selectFrom('leave_request').select(['start_date', 'end_date']).where('employee_id', '=', e.id).where('status', 'in', ['pending', 'approved'])
        .where('start_date', '<=', input.endDate).where('end_date', '>=', input.startDate).executeTakeFirst();
      if (overlap) throw conflict(`Une autre demande couvre déjà cette période (du ${frDate(overlap.start_date)} au ${frDate(overlap.end_date)}).`, 'leave_overlap');
      if (input.type === 'annual') {
        const b = await this.balance(trx, e);
        if (days > b.available - b.pending) {
          throw conflict(`Solde de congés insuffisant : ${round1(b.available - b.pending)} jour(s) disponible(s) (demandes en attente déduites), ${days} demandé(s).`, 'insufficient_leave');
        }
      }
      const r = await trx.insertInto('leave_request').values({
        company_id: t.companyId, employee_id: e.id, type: input.type, start_date: input.startDate, end_date: input.endDate, days, reason: input.reason ?? null,
        created_by: t.ctx.userId, decided_by: null, decision_note: null,
      }).returning('id').executeTakeFirstOrThrow();
      await this.notifyApprovers(trx, t, e, { type: input.type, startDate: input.startDate, endDate: input.endDate, days });
      await this.audit.tenant(trx, t.ctx, { action: 'leave.requested', entityType: 'leave_request', entityId: r.id, data: { employee: `${e.first_name} ${e.last_name}`, type: input.type, days } });
      return { id: r.id, days };
    });
  }

  /** Prévient par e-mail les personnes habilitées à valider les congés (sauf le demandeur). */
  private async notifyApprovers(trx: TenantTrx, t: TenantInfo, e: EmployeeRow, l: { type: LeaveType; startDate: string; endDate: string; days: number }) {
    const approvers = await trx.selectFrom('membership_role as mr')
      .innerJoin('role as r', (j) => j.onRef('r.id', '=', 'mr.role_id').onRef('r.company_id', '=', 'mr.company_id'))
      .innerJoin('company_membership as m', (j) => j.onRef('m.id', '=', 'mr.membership_id').onRef('m.company_id', '=', 'mr.company_id'))
      .innerJoin('user_account as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.email']).distinct().where('m.status', '=', 'active').where(sql<boolean>`${'leave.validate'} = ANY(r.permissions)`).where('u.id', '!=', t.ctx.userId).execute();
    if (!approvers.length) return;
    const company = await trx.selectFrom('company').select('name').where('id', '=', t.companyId).executeTakeFirstOrThrow();
    for (const a of approvers) {
      await this.mail.enqueue(trx, {
        companyId: t.companyId, to: a.email, kind: 'leave_request', fromName: company.name, createdBy: t.ctx.userId,
        subject: `Demande de congé — ${e.first_name} ${e.last_name}`,
        paragraphs: [`${e.first_name} ${e.last_name} demande : ${LEAVE_TYPES[l.type].toLowerCase()} du ${frDate(l.startDate)} au ${frDate(l.endDate)} (${l.days} jour(s) ouvrable(s)).`, 'Vous pouvez la valider ou la refuser dans Kora.'],
        action: { label: 'Voir les demandes de congé', url: `${config.webUrl}/app/conges` },
      });
    }
  }

  async decide(t: TenantInfo, id: string, approve: boolean, note?: string | null) {
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(id)) throw notFound('Demande');
      const r = await trx.selectFrom('leave_request').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Demande');
      if (r.status !== 'pending') throw conflict('Cette demande a déjà été traitée.', 'already_decided');
      const e = await this.employee(trx, r.employee_id);
      if (e.user_id === t.ctx.userId) throw forbidden('Vous ne pouvez pas valider votre propre demande de congé.', 'own_request');
      if (approve && r.type === 'annual') {
        const b = await this.balance(trx, e);
        if (Number(r.days) > b.available) throw conflict(`Solde insuffisant : ${b.available} jour(s) disponible(s) pour ${Number(r.days)} demandé(s).`, 'insufficient_leave');
      }
      await trx.updateTable('leave_request').set({ status: approve ? 'approved' : 'refused', decided_by: t.ctx.userId, decided_at: new Date(), decision_note: note ?? null }).where('id', '=', id).execute();
      const to = e.user_id ? (await trx.selectFrom('user_account').select('email').where('id', '=', e.user_id).executeTakeFirst())?.email : e.email;
      if (to) {
        const company = await trx.selectFrom('company').select('name').where('id', '=', t.companyId).executeTakeFirstOrThrow();
        await this.mail.enqueue(trx, {
          companyId: t.companyId, to, kind: 'leave_decision', entityId: id, fromName: company.name, createdBy: t.ctx.userId,
          subject: `Votre demande de congé a été ${approve ? 'acceptée' : 'refusée'}`,
          paragraphs: [`Bonjour ${e.first_name},`, `Votre demande (${LEAVE_TYPES[r.type].toLowerCase()} du ${frDate(r.start_date)} au ${frDate(r.end_date)}, ${Number(r.days)} jour(s)) a été ${approve ? 'acceptée' : 'refusée'}.`, ...(note ? [`Commentaire : ${note}`] : [])],
          ...(e.user_id ? { action: { label: 'Voir mon espace', url: `${config.webUrl}/app/moi` } } : {}),
        });
      }
      await this.audit.tenant(trx, t.ctx, { action: approve ? 'leave.approved' : 'leave.refused', entityType: 'leave_request', entityId: id, data: { employee: `${e.first_name} ${e.last_name}`, days: Number(r.days) } });
      return { ok: true };
    });
  }

  /** Annulation : par l'employé tant que la demande est en attente ; par un responsable avant le début d'un congé validé. */
  async cancel(t: TenantInfo, id: string, self: boolean) {
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(id)) throw notFound('Demande');
      const r = await trx.selectFrom('leave_request').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Demande');
      if (self) {
        const e = await this.own(trx, t);
        if (r.employee_id !== e.id) throw notFound('Demande');
        if (r.status !== 'pending') throw conflict('Seule une demande en attente peut être annulée ; adressez-vous à votre responsable.', 'not_pending');
      } else if (!(r.status === 'pending' || (r.status === 'approved' && r.start_date > today()))) {
        throw conflict('Seule une demande en attente, ou un congé validé qui n’a pas commencé, peut être annulé.', 'not_cancellable');
      }
      await trx.updateTable('leave_request').set({ status: 'cancelled' }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'leave.cancelled', entityType: 'leave_request', entityId: id });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ consultation
  async list(t: TenantInfo, f: { status?: string; employeeId?: string; month?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('leave_request as l').innerJoin('employee as e', (j) => j.onRef('e.id', '=', 'l.employee_id').onRef('e.company_id', '=', 'l.company_id'))
        .selectAll('l').select(['e.first_name', 'e.last_name']).orderBy('l.start_date', 'desc').limit(500);
      if (f.status) q = q.where('l.status', '=', f.status as any);
      if (f.employeeId) q = q.where('l.employee_id', '=', f.employeeId);
      if (f.month) {
        const end = new Date(Date.UTC(Number(f.month.slice(0, 4)), Number(f.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
        q = q.where('l.start_date', '<=', end).where('l.end_date', '>=', `${f.month}-01`);
      }
      return this.present(trx, await q.execute());
    });
  }

  async balances(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const employees = await trx.selectFrom('employee').select(['id', 'first_name', 'last_name', 'hire_date', 'end_date', 'email', 'user_id', 'leave_opening_balance', 'leave_opening_date', 'number'])
        .where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', today())])).orderBy('last_name').execute();
      const out = [];
      for (const e of employees) out.push({ employeeId: e.id, number: e.number, name: `${e.first_name} ${e.last_name}`, linked: !!e.user_id, ...(await this.balance(trx, e)) });
      return out;
    });
  }

  async setOpening(t: TenantInfo, employeeId: string, input: { balance: number; date?: string | null }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await this.employee(trx, employeeId);
      await trx.updateTable('employee').set({ leave_opening_balance: input.balance, leave_opening_date: input.date ?? null }).where('id', '=', employeeId).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'leave.opening_set', entityType: 'employee', entityId: employeeId, data: { employee: `${e.first_name} ${e.last_name}`, balance: input.balance, date: input.date } });
      return this.balance(trx, { ...e, leave_opening_balance: String(input.balance), leave_opening_date: input.date ?? null });
    });
  }

  /** Jours de congé sans solde validés dans un mois (repris comme absences dans la paie). */
  async unpaidDays(trx: TenantTrx, employeeId: string, period: string) {
    const start = `${period}-01`, end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const rows = await trx.selectFrom('leave_request').select(['start_date', 'end_date']).where('employee_id', '=', employeeId).where('type', '=', 'unpaid')
      .where('status', '=', 'approved').where('start_date', '<=', end).where('end_date', '>=', start).execute();
    return rows.reduce((s, r) => s + workingDays(r.start_date > start ? r.start_date : start, r.end_date < end ? r.end_date : end), 0);
  }

  // ------------------------------------------------------------------ espace employé
  async mySpace(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await this.own(trx, t);
      const full = await trx.selectFrom('employee').select(['number', 'job_title', 'department', 'contract_type', 'cnps_number', 'hire_date']).where('id', '=', e.id).executeTakeFirstOrThrow();
      const requests = await trx.selectFrom('leave_request').selectAll().where('employee_id', '=', e.id).orderBy('start_date', 'desc').limit(100).execute();
      return {
        employee: { id: e.id, name: `${e.first_name} ${e.last_name}`, number: full.number, jobTitle: full.job_title, department: full.department, contractType: full.contract_type, cnpsNumber: full.cnps_number, hireDate: full.hire_date },
        balance: await this.balance(trx, e), requests: await this.present(trx, requests),
      };
    });
  }

  /** Bulletins validés de l'employé connecté, et seulement les siens. */
  async myPayslips(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await this.own(trx, t);
      const rows = await trx.selectFrom('payslip as p').innerJoin('payroll_run as r', (j) => j.onRef('r.id', '=', 'p.run_id').onRef('r.company_id', '=', 'p.company_id'))
        .select(['p.id', 'r.period', 'p.gross', 'p.net', 'p.paid_at as paidAt']).where('p.employee_id', '=', e.id).where('r.status', '=', 'validated').orderBy('r.period', 'desc').execute();
      return rows.map((r) => ({ ...r, gross: Number(r.gross), net: Number(r.net) }));
    });
  }

  async myPayslip(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await this.own(trx, t);
      if (!isUuid(id)) throw notFound('Bulletin');
      const p = await trx.selectFrom('payslip as p').innerJoin('payroll_run as r', (j) => j.onRef('r.id', '=', 'p.run_id').onRef('r.company_id', '=', 'p.company_id'))
        .selectAll('p').select('r.period').where('p.id', '=', id).where('p.employee_id', '=', e.id).where('r.status', '=', 'validated').executeTakeFirst();
      if (!p) throw notFound('Bulletin');
      const company = await trx.selectFrom('company').select(['name', 'address', 'city', 'tax_id']).where('id', '=', t.companyId).executeTakeFirstOrThrow();
      return { company, period: p.period, slip: { id: p.id, employee: p.employee, lines: p.lines, totals: p.totals, gross: Number(p.gross), net: Number(p.net), employerCost: Number(p.employer_cost), paidAt: p.paid_at } };
    });
  }
}
