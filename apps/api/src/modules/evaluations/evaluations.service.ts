import { Injectable } from '@nestjs/common';
import { config } from '../../config';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { assertSiteAccess, inScope } from '../../common/sites';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { periodLabel, PayrollService } from '../payroll/payroll.service';

export interface Criterion { key: string; label: string; weight: number }
export type EvaluationStatus = 'draft' | 'submitted' | 'approved' | 'refused';

/** Grille proposée à la création d'une campagne (modifiable). */
export const DEFAULT_CRITERIA: Criterion[] = [
  { key: 'quality', label: 'Qualité du travail', weight: 2 },
  { key: 'productivity', label: 'Productivité et respect des délais', weight: 2 },
  { key: 'attendance', label: 'Ponctualité et assiduité', weight: 1 },
  { key: 'teamwork', label: "Esprit d'équipe", weight: 1 },
  { key: 'initiative', label: 'Initiative et autonomie', weight: 1 },
  { key: 'customer', label: 'Relation client', weight: 1 },
];

/** Appréciation globale d'après la note pondérée (sur 5). */
export const RATINGS = [
  { key: 'insufficient', label: 'Insuffisant', min: 1 },
  { key: 'improve', label: 'À améliorer', min: 1.75 },
  { key: 'good', label: 'Satisfaisant', min: 2.5 },
  { key: 'very_good', label: 'Très bien', min: 3.5 },
  { key: 'excellent', label: 'Excellent', min: 4.25 },
] as const;
export const rating = (score: number | null) => (score === null ? null : [...RATINGS].reverse().find((r) => score >= r.min)!.key);

export interface CampaignInput { name: string; periodStart: string; periodEnd: string; dueDate?: string | null; criteria?: Criterion[]; employeeIds?: string[]; evaluatorId?: string | null }
export interface EvaluationInput {
  scores?: Record<string, { score: number | null; comment?: string | null }>; strengths?: string | null; improvements?: string | null; goals?: string | null; comment?: string | null;
  evaluatorId?: string | null; bonusAmount?: number; bonusPeriod?: string | null; newBaseSalary?: number | null; raisePeriod?: string | null;
}
export interface DecisionInput { approve: boolean; note?: string | null; bonusAmount?: number; bonusPeriod?: string | null; newBaseSalary?: number | null; raisePeriod?: string | null }

const month = () => new Date().toISOString().slice(0, 7);
const nextMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); };

/** Note pondérée sur 5, arrondie au centième ; null tant qu'aucun critère n'est noté. */
function weighted(criteria: Criterion[], scores: Record<string, { score: number | null }>) {
  let sum = 0, weights = 0;
  for (const c of criteria) {
    const s = scores[c.key]?.score;
    if (s) { sum += s * c.weight; weights += c.weight; }
  }
  return weights ? Math.round((sum / weights) * 100) / 100 : null;
}

/**
 * Évaluations des employés : une campagne fixe la période et les critères ; chaque évaluation est remplie
 * par un évaluateur, soumise, puis approuvée avec une prime et/ou une augmentation qui rejoignent la paie.
 */
@Injectable()
export class EvaluationsService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly mail: MailService, private readonly payroll: PayrollService) {}

  private salaries(t: TenantInfo) { return t.permissions.has('payroll.salaries'); }

  private async campaignRow(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Campagne');
    const c = await trx.selectFrom('evaluation_campaign').selectAll().where('id', '=', id).executeTakeFirst();
    if (!c) throw notFound('Campagne');
    return c;
  }

  private base(trx: TenantTrx, t: TenantInfo) {
    return inScope(trx.selectFrom('evaluation as v')
      .innerJoin('employee as e', (j) => j.onRef('e.id', '=', 'v.employee_id').onRef('e.company_id', '=', 'v.company_id'))
      .innerJoin('evaluation_campaign as c', (j) => j.onRef('c.id', '=', 'v.campaign_id').onRef('c.company_id', '=', 'v.company_id'))
      .leftJoin('employee_photo as ph', (j) => j.onRef('ph.employee_id', '=', 'e.id').onRef('ph.company_id', '=', 'e.company_id'))
      .leftJoin('user_account as u', 'u.id', 'v.evaluator_id')
      .leftJoin('user_account as d', 'd.id', 'v.decided_by')
      .selectAll('v')
      .select(['e.first_name', 'e.last_name', 'e.number', 'e.job_title', 'e.department', 'e.hire_date', 'e.base_salary', 'e.site_id', 'e.user_id as employee_user_id', 'ph.updated_at as photo_at',
        'c.name as campaign_name', 'c.period_start', 'c.period_end', 'c.criteria', 'c.status as campaign_status', 'u.full_name as evaluator_name', 'd.full_name as decided_by_name']), t, 'e.site_id');
  }
  private present(t: TenantInfo, v: Awaited<ReturnType<ReturnType<EvaluationsService['base']>['execute']>>[number]) {
    const salaries = this.salaries(t);
    const score = v.score === null ? null : Number(v.score);
    const base = Number(v.base_salary);
    const newBase = v.new_base_salary === null ? null : Number(v.new_base_salary);
    const previous = v.previous_base_salary === null ? base : Number(v.previous_base_salary);
    return {
      id: v.id, campaignId: v.campaign_id, campaignName: v.campaign_name, campaignStatus: v.campaign_status, periodStart: v.period_start, periodEnd: v.period_end,
      employee: { id: v.employee_id, number: v.number, name: `${v.first_name} ${v.last_name}`, firstName: v.first_name, lastName: v.last_name, jobTitle: v.job_title, department: v.department,
        hireDate: v.hire_date, photo: v.photo_at ? `/company/employees/${v.employee_id}/photo?v=${new Date(v.photo_at).getTime()}` : null, ...(salaries ? { baseSalary: base } : {}) },
      evaluator: v.evaluator_id ? { id: v.evaluator_id, name: v.evaluator_name } : null,
      scores: v.scores as Record<string, { score: number | null; comment?: string | null }>, score, rating: rating(score),
      strengths: v.strengths, improvements: v.improvements, goals: v.goals, comment: v.comment,
      status: v.status as EvaluationStatus, submittedAt: v.submitted_at, decidedAt: v.decided_at, decidedBy: v.decided_by_name, decisionNote: v.decision_note,
      hasBonus: Number(v.bonus_amount) > 0, hasRaise: newBase !== null, raiseApplied: !!v.raise_applied_at,
      bonusPeriod: v.bonus_period, raisePeriod: v.raise_period,
      ...(salaries ? {
        bonusAmount: Number(v.bonus_amount), newBaseSalary: newBase, raiseAmount: newBase !== null ? newBase - previous : 0,
        raisePercent: newBase !== null && previous ? Math.round(((newBase - previous) / previous) * 1000) / 10 : null,
      } : {}),
      mine: v.employee_user_id === t.ctx.userId,
    };
  }

  /** Utilisateurs pouvant évaluer : membres actifs de l'entreprise. */
  async people(t: TenantInfo) {
    return this.db.tenant(t.ctx, (trx) => trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.full_name as name', 'u.email']).where('m.status', '=', 'active').orderBy('u.full_name').execute());
  }
  private async assertMember(trx: TenantTrx, userId: string | null | undefined) {
    if (!userId) return;
    if (!(await trx.selectFrom('company_membership').select('user_id').where('user_id', '=', userId).where('status', '=', 'active').executeTakeFirst())) {
      throw badRequest("L'évaluateur choisi n'est pas un utilisateur actif de l'entreprise.", undefined, 'unknown_evaluator');
    }
  }

  // ------------------------------------------------------------------ campagnes
  async campaigns(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await trx.selectFrom('evaluation_campaign as c').leftJoin('user_account as u', 'u.id', 'c.created_by')
        .selectAll('c').select('u.full_name as created_by_name').orderBy('c.period_end', 'desc').orderBy('c.created_at', 'desc').execute();
      const evals = (await this.base(trx, t).execute()).map((v) => this.present(t, v));
      return rows.map((c) => this.summary(t, c, evals.filter((v) => v.campaignId === c.id)));
    });
  }
  private summary(t: TenantInfo, c: { id: string; name: string; period_start: string; period_end: string; due_date: string | null; status: string; criteria: unknown; created_by_name?: string | null }, evals: ReturnType<EvaluationsService['present']>[]) {
    const scored = evals.filter((v) => v.score !== null && v.status !== 'refused');
    const approved = evals.filter((v) => v.status === 'approved');
    const count = (s: EvaluationStatus) => evals.filter((v) => v.status === s).length;
    const average = scored.length ? Math.round((scored.reduce((s, v) => s + v.score!, 0) / scored.length) * 100) / 100 : null;
    return {
      id: c.id, name: c.name, periodStart: c.period_start, periodEnd: c.period_end, dueDate: c.due_date, status: c.status, criteria: c.criteria as Criterion[], createdBy: c.created_by_name ?? null,
      total: evals.length, draft: count('draft'), submitted: count('submitted'), approved: approved.length, refused: count('refused'),
      average, averageRating: rating(average),
      distribution: Object.fromEntries(RATINGS.map((r) => [r.key, scored.filter((v) => v.rating === r.key).length])),
      ...(this.salaries(t) ? {
        bonusTotal: approved.reduce((s, v) => s + (v.bonusAmount ?? 0), 0),
        // Coût mensuel des augmentations approuvées (écart de salaire de base)
        raiseTotal: approved.reduce((s, v) => s + (v.raiseAmount ?? 0), 0),
      } : {}),
    };
  }

  async campaign(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await this.campaignRow(trx, id);
      const rows = await this.base(trx, t).where('v.campaign_id', '=', id).orderBy('e.last_name').orderBy('e.first_name').execute();
      const evals = rows.map((v) => this.present(t, v));
      const s = this.summary(t, c, evals);
      return { ...s, evaluations: evals };
    });
  }

  private checkCriteria(criteria: Criterion[]) {
    if (new Set(criteria.map((c) => c.key)).size !== criteria.length) throw badRequest('Deux critères portent le même nom.', undefined, 'duplicate_criteria');
  }

  async createCampaign(t: TenantInfo, input: CampaignInput) {
    if (input.periodEnd < input.periodStart) throw badRequest('La fin de la période précède son début.', undefined, 'end_before_start');
    const criteria = input.criteria?.length ? input.criteria : DEFAULT_CRITERIA;
    this.checkCriteria(criteria);
    const id = await this.db.tenant(t.ctx, async (trx) => {
      await this.assertMember(trx, input.evaluatorId);
      const c = await trx.insertInto('evaluation_campaign').values({
        company_id: t.companyId, name: input.name, period_start: input.periodStart, period_end: input.periodEnd, due_date: input.dueDate ?? null,
        criteria: JSON.stringify(criteria), created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      // Sans liste : tous les employés présents sur la période (dans les sites accessibles).
      const ids = input.employeeIds ?? (await inScope(trx.selectFrom('employee').select('id').where('hire_date', '<=', input.periodEnd)
        .where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', input.periodStart)])), t, 'site_id').execute()).map((e) => e.id);
      const added = await this.insertEvaluations(trx, t, c.id, ids, input.evaluatorId ?? null);
      await this.audit.tenant(trx, t.ctx, { action: 'evaluation.campaign_created', entityType: 'evaluation_campaign', entityId: c.id, data: { name: input.name, employees: added } });
      await this.notifyEvaluators(trx, t, c.id);
      return c.id;
    });
    return this.campaign(t, id);
  }

  private async insertEvaluations(trx: TenantTrx, t: TenantInfo, campaignId: string, employeeIds: string[], evaluatorId: string | null) {
    const ids = [...new Set(employeeIds)];
    if (!ids.length) return 0;
    const found = await trx.selectFrom('employee').select(['id', 'site_id']).where('id', 'in', ids).execute();
    if (found.length !== ids.length) throw badRequest('Un des employés choisis est introuvable.', undefined, 'unknown_employee');
    for (const e of found) assertSiteAccess(t, e.site_id);
    const r = await trx.insertInto('evaluation').values(ids.map((employee_id) => ({ company_id: t.companyId, campaign_id: campaignId, employee_id, evaluator_id: evaluatorId })))
      .onConflict((oc) => oc.columns(['company_id', 'campaign_id', 'employee_id']).doNothing()).returning('id').execute();
    return r.length;
  }

  /** Prévient chaque évaluateur (sauf soi-même) des évaluations qui l'attendent dans la campagne. */
  private async notifyEvaluators(trx: TenantTrx, t: TenantInfo, campaignId: string) {
    const c = await this.campaignRow(trx, campaignId);
    const todo = await trx.selectFrom('evaluation as v').innerJoin('user_account as u', 'u.id', 'v.evaluator_id')
      .select(['u.id', 'u.email', 'u.full_name']).select((eb) => eb.fn.countAll<string>().as('n'))
      .where('v.campaign_id', '=', campaignId).where('v.status', '=', 'draft').where('u.id', '!=', t.ctx.userId).groupBy(['u.id', 'u.email', 'u.full_name']).execute();
    if (!todo.length) return;
    const company = await trx.selectFrom('company').select('name').where('id', '=', t.companyId).executeTakeFirstOrThrow();
    for (const u of todo) {
      await this.mail.enqueue(trx, {
        companyId: t.companyId, to: u.email, kind: 'evaluation', entityId: campaignId, fromName: company.name, createdBy: t.ctx.userId,
        subject: `Évaluations à remplir — ${c.name}`,
        paragraphs: [`Bonjour ${u.full_name},`, `${Number(u.n)} évaluation(s) d'employés vous sont confiées dans la campagne « ${c.name} »${c.due_date ? `, à remplir avant le ${new Date(c.due_date).toLocaleDateString('fr-FR')}` : ''}.`],
        action: { label: 'Ouvrir les évaluations', url: `${config.webUrl}/app/evaluations/${campaignId}` },
      });
    }
  }

  async addEmployees(t: TenantInfo, campaignId: string, employeeIds: string[], evaluatorId: string | null) {
    await this.db.tenant(t.ctx, async (trx) => {
      const c = await this.campaignRow(trx, campaignId);
      if (c.status !== 'open') throw conflict('Cette campagne est close.', 'campaign_closed');
      await this.assertMember(trx, evaluatorId);
      await this.insertEvaluations(trx, t, campaignId, employeeIds, evaluatorId);
      await this.notifyEvaluators(trx, t, campaignId);
    });
    return this.campaign(t, campaignId);
  }

  async updateCampaign(t: TenantInfo, id: string, input: { name?: string; dueDate?: string | null; criteria?: Criterion[]; status?: 'open' | 'closed' }) {
    await this.db.tenant(t.ctx, async (trx) => {
      await this.campaignRow(trx, id);
      if (input.criteria) {
        this.checkCriteria(input.criteria);
        const started = await trx.selectFrom('evaluation').select('id').where('campaign_id', '=', id).where((eb) => eb.or([eb('score', 'is not', null), eb('status', '!=', 'draft')])).executeTakeFirst();
        if (started) throw conflict('Des évaluations sont déjà commencées : les critères ne changent plus.', 'evaluations_started');
      }
      if (input.status === 'closed') {
        const pending = await trx.selectFrom('evaluation').select('id').where('campaign_id', '=', id).where('status', '=', 'submitted').executeTakeFirst();
        if (pending) throw conflict('Des évaluations attendent encore une décision : approuvez-les ou refusez-les avant de clore.', 'evaluations_pending');
      }
      await trx.updateTable('evaluation_campaign').set({
        ...(input.name !== undefined ? { name: input.name } : {}), ...(input.dueDate !== undefined ? { due_date: input.dueDate } : {}),
        ...(input.criteria ? { criteria: JSON.stringify(input.criteria) } : {}), ...(input.status ? { status: input.status } : {}),
      }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'evaluation.campaign_updated', entityType: 'evaluation_campaign', entityId: id, data: { fields: Object.keys(input) } });
    });
    return this.campaign(t, id);
  }

  async deleteCampaign(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await this.campaignRow(trx, id);
      if (await trx.selectFrom('evaluation').select('id').where('campaign_id', '=', id).where('status', '=', 'approved').executeTakeFirst()) {
        throw conflict('Cette campagne a des évaluations approuvées : fermez-la plutôt que de la supprimer.', 'campaign_has_decisions');
      }
      await trx.deleteFrom('evaluation_campaign').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'evaluation.campaign_deleted', entityType: 'evaluation_campaign', entityId: id, data: { name: c.name } });
      return { deleted: true };
    });
  }

  // ------------------------------------------------------------------ évaluations
  private async row(trx: TenantTrx, t: TenantInfo, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Évaluation');
    if (lock) await trx.selectFrom('evaluation').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
    const v = await this.base(trx, t).where('v.id', '=', id).executeTakeFirst();
    if (!v) throw notFound('Évaluation');
    return v;
  }

  async get(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const v = await this.row(trx, t, id);
      // Les évaluations approuvées des campagnes précédentes : l'évolution de l'employé.
      const history = (await this.base(trx, t).where('v.employee_id', '=', v.employee_id).where('v.id', '!=', id).where('v.status', '=', 'approved')
        .orderBy('c.period_end', 'desc').limit(10).execute()).map((h) => this.present(t, h));
      return { ...this.present(t, v), criteria: v.criteria as Criterion[], ...this.rights(t, v), history };
    });
  }

  private rights(t: TenantInfo, v: { evaluator_id: string | null; status: string; employee_user_id: string | null; campaign_status: string }) {
    const validator = t.permissions.has('evaluations.validate');
    const mine = v.employee_user_id === t.ctx.userId;
    const open = v.campaign_status === 'open';
    return {
      canEdit: open && !mine && t.permissions.has('evaluations.update') && (v.status === 'draft' || (v.status === 'submitted' && validator)) && (validator || !v.evaluator_id || v.evaluator_id === t.ctx.userId),
      canDecide: open && !mine && validator && v.status === 'submitted',
      canReopen: open && !mine && validator && (v.status === 'approved' || v.status === 'refused'),
    };
  }

  /** Montants (prime, augmentation) : réservés à qui voit les salaires. */
  private checkMoney(t: TenantInfo, input: { bonusAmount?: number; bonusPeriod?: string | null; newBaseSalary?: number | null; raisePeriod?: string | null }) {
    if (['bonusAmount', 'bonusPeriod', 'newBaseSalary', 'raisePeriod'].some((k) => (input as any)[k] !== undefined) && !this.salaries(t)) {
      throw forbidden('Proposer une prime ou une augmentation demande la permission « voir les salaires et bulletins ».', 'salaries_forbidden');
    }
  }
  private moneyColumns(input: { bonusAmount?: number; bonusPeriod?: string | null; newBaseSalary?: number | null; raisePeriod?: string | null }) {
    const out: Record<string, unknown> = {};
    if (input.bonusAmount !== undefined) { out.bonus_amount = input.bonusAmount; if (!input.bonusAmount) out.bonus_period = null; }
    if (input.bonusPeriod !== undefined && input.bonusAmount !== 0) out.bonus_period = input.bonusPeriod;
    if (input.newBaseSalary !== undefined) { out.new_base_salary = input.newBaseSalary; if (input.newBaseSalary === null) out.raise_period = null; }
    if (input.raisePeriod !== undefined && input.newBaseSalary !== null) out.raise_period = input.raisePeriod;
    return out;
  }

  async update(t: TenantInfo, id: string, input: EvaluationInput) {
    this.checkMoney(t, input);
    await this.db.tenant(t.ctx, async (trx) => {
      const v = await this.row(trx, t, id, true);
      if (!this.rights(t, v).canEdit) {
        if (v.employee_user_id === t.ctx.userId) throw forbidden('On ne remplit pas sa propre évaluation.', 'own_evaluation');
        if (v.campaign_status !== 'open') throw conflict('Cette campagne est close.', 'campaign_closed');
        if (v.status !== 'draft') throw conflict('Cette évaluation est déjà soumise.', 'evaluation_submitted');
        throw forbidden("Cette évaluation est confiée à un autre évaluateur.", 'not_evaluator');
      }
      if (input.evaluatorId !== undefined) {
        if (!t.permissions.has('evaluations.validate') && !t.permissions.has('evaluations.create')) throw forbidden("Changer d'évaluateur demande le droit de créer des évaluations.", 'forbidden');
        await this.assertMember(trx, input.evaluatorId);
      }
      const criteria = v.criteria as Criterion[];
      let scores = v.scores as Record<string, { score: number | null; comment?: string | null }>;
      if (input.scores) {
        const unknown = Object.keys(input.scores).find((k) => !criteria.some((c) => c.key === k));
        if (unknown) throw badRequest(`Critère inconnu : ${unknown}.`, undefined, 'unknown_criterion');
        scores = { ...scores, ...input.scores };
      }
      await trx.updateTable('evaluation').set({
        scores: JSON.stringify(scores), score: weighted(criteria, scores),
        ...Object.fromEntries((['strengths', 'improvements', 'goals', 'comment'] as const).filter((k) => input[k] !== undefined).map((k) => [k, input[k]])),
        ...(input.evaluatorId !== undefined ? { evaluator_id: input.evaluatorId } : {}),
        ...this.moneyColumns(input),
      }).where('id', '=', id).execute();
    });
    return this.get(t, id);
  }

  async submit(t: TenantInfo, id: string) {
    await this.db.tenant(t.ctx, async (trx) => {
      const v = await this.row(trx, t, id, true);
      if (v.status !== 'draft') throw conflict('Cette évaluation est déjà soumise.', 'evaluation_submitted');
      if (!this.rights(t, v).canEdit) throw forbidden("Cette évaluation est confiée à un autre évaluateur.", 'not_evaluator');
      const scores = v.scores as Record<string, { score: number | null }>;
      const missing = (v.criteria as Criterion[]).filter((c) => !scores[c.key]?.score);
      if (missing.length) throw badRequest(`Notez tous les critères avant de soumettre : ${missing.map((c) => c.label).join(', ')}.`, undefined, 'criteria_missing');
      await trx.updateTable('evaluation').set({ status: 'submitted', submitted_at: new Date(), evaluator_id: v.evaluator_id ?? t.ctx.userId }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'evaluation.submitted', entityType: 'evaluation', entityId: id, data: { employee: v.number, score: Number(v.score) } });
    });
    return this.get(t, id);
  }

  /**
   * Décision : approuvée, elle fixe la prime (ajoutée à la paie du mois choisi) et l'augmentation
   * (nouveau salaire de base de la fiche à partir du mois choisi). Refusée, rien ne change pour l'employé.
   */
  async decide(t: TenantInfo, id: string, input: DecisionInput) {
    this.checkMoney(t, input);
    await this.db.tenant(t.ctx, async (trx) => {
      const v = await this.row(trx, t, id, true);
      if (v.employee_user_id === t.ctx.userId) throw forbidden('On ne décide pas de sa propre évaluation.', 'own_evaluation');
      if (v.status !== 'submitted') throw conflict("Seule une évaluation soumise reçoit une décision.", 'evaluation_not_submitted');
      if (v.campaign_status !== 'open') throw conflict('Cette campagne est close.', 'campaign_closed');
      if (!input.approve) {
        await trx.updateTable('evaluation').set({ status: 'refused', decided_by: t.ctx.userId, decided_at: new Date(), decision_note: input.note ?? null }).where('id', '=', id).execute();
        await this.audit.tenant(trx, t.ctx, { action: 'evaluation.refused', entityType: 'evaluation', entityId: id, data: { employee: v.number } });
        return;
      }
      const cols = this.moneyColumns(input);
      const bonus = Number(cols.bonus_amount ?? v.bonus_amount);
      const bonusPeriod = (cols.bonus_period !== undefined ? cols.bonus_period : v.bonus_period) as string | null;
      const newBase = (cols.new_base_salary !== undefined ? cols.new_base_salary : v.new_base_salary === null ? null : Number(v.new_base_salary)) as number | null;
      const raisePeriod = (cols.raise_period !== undefined ? cols.raise_period : v.raise_period) as string | null;
      if ((bonus > 0 || newBase !== null) && !this.salaries(t)) {
        throw forbidden('Approuver une prime ou une augmentation demande la permission « voir les salaires et bulletins ».', 'salaries_forbidden');
      }
      if (bonus > 0 && !bonusPeriod) throw badRequest('Choisissez le mois de paie de la prime.', undefined, 'bonus_period_required');
      if (newBase !== null) {
        if (!raisePeriod) throw badRequest("Choisissez le mois d'effet de l'augmentation.", undefined, 'raise_period_required');
        if (newBase <= Number(v.base_salary)) throw badRequest(`Le nouveau salaire de base doit dépasser le salaire actuel.`, undefined, 'raise_not_higher');
      }
      await trx.updateTable('evaluation').set({
        status: 'approved', decided_by: t.ctx.userId, decided_at: new Date(), decision_note: input.note ?? null,
        bonus_amount: bonus, bonus_period: bonus > 0 ? bonusPeriod : null, new_base_salary: newBase, raise_period: newBase !== null ? raisePeriod : null,
        previous_base_salary: newBase !== null ? Number(v.base_salary) : null, raise_applied_at: null,
      }).where('id', '=', id).execute();
      if (bonus > 0) await this.payroll.adjustDraftBonus(trx, t, bonusPeriod!, v.employee_id, bonus);
      // Augmentation dont le mois d'effet est arrivé : la fiche change aussitôt ; sinon à la paie de ce mois.
      if (newBase !== null && raisePeriod! <= month()) await this.payroll.applyDueRaises(trx, t, month());
      await this.audit.tenant(trx, t.ctx, { action: 'evaluation.approved', entityType: 'evaluation', entityId: id, data: { employee: v.number, bonus: bonus > 0, raise: newBase !== null } });
      await this.notifyEmployee(trx, t, v);
    });
    return this.get(t, id);
  }

  private async notifyEmployee(trx: TenantTrx, t: TenantInfo, v: { employee_user_id: string | null; campaign_name: string; first_name: string }) {
    if (!v.employee_user_id) return;
    const u = await trx.selectFrom('user_account').select('email').where('id', '=', v.employee_user_id).executeTakeFirst();
    if (!u) return;
    const company = await trx.selectFrom('company').select('name').where('id', '=', t.companyId).executeTakeFirstOrThrow();
    await this.mail.enqueue(trx, {
      companyId: t.companyId, to: u.email, kind: 'evaluation', fromName: company.name, createdBy: t.ctx.userId,
      subject: `Votre évaluation — ${v.campaign_name}`,
      paragraphs: [`Bonjour ${v.first_name},`, `Votre évaluation « ${v.campaign_name} » est finalisée. Retrouvez vos notes, les commentaires et les objectifs fixés dans votre espace.`],
      action: { label: 'Voir mon évaluation', url: `${config.webUrl}/app/moi` },
    });
  }

  /** Rouvre une décision : la prime quitte la paie en brouillon ; impossible si la paie est validée ou l'augmentation appliquée. */
  async reopen(t: TenantInfo, id: string) {
    await this.db.tenant(t.ctx, async (trx) => {
      const v = await this.row(trx, t, id, true);
      if (!this.rights(t, v).canReopen) throw conflict("Cette évaluation n'a pas de décision à rouvrir.", 'evaluation_not_decided');
      if (v.status === 'approved') {
        if (v.raise_applied_at) throw conflict("L'augmentation est déjà appliquée à la fiche de l'employé : modifiez sa fiche si besoin.", 'raise_applied');
        if (Number(v.bonus_amount) > 0) await this.payroll.adjustDraftBonus(trx, t, v.bonus_period!, v.employee_id, -Number(v.bonus_amount));
      }
      await trx.updateTable('evaluation').set({ status: 'submitted', decided_by: null, decided_at: null, decision_note: null, previous_base_salary: null }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'evaluation.reopened', entityType: 'evaluation', entityId: id, data: { employee: v.number } });
    });
    return this.get(t, id);
  }

  async remove(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const v = await this.row(trx, t, id, true);
      if (v.status === 'approved') throw conflict('Une évaluation approuvée ne se supprime pas : rouvrez-la d’abord.', 'evaluation_approved');
      await trx.deleteFrom('evaluation').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'evaluation.deleted', entityType: 'evaluation', entityId: id, data: { employee: v.number } });
      return { deleted: true };
    });
  }

  /** Évaluations d'un employé (fiche employé). */
  async forEmployee(t: TenantInfo, employeeId: string) {
    if (!isUuid(employeeId)) throw notFound('Employé');
    return this.db.tenant(t.ctx, async (trx) => (await this.base(trx, t).where('v.employee_id', '=', employeeId).orderBy('c.period_end', 'desc').execute()).map((v) => this.present(t, v)));
  }

  /** Espace employé : ses évaluations approuvées, avec la décision qui le concerne. */
  async mine(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await trx.selectFrom('evaluation as v').innerJoin('employee as e', (j) => j.onRef('e.id', '=', 'v.employee_id').onRef('e.company_id', '=', 'v.company_id'))
        .innerJoin('evaluation_campaign as c', (j) => j.onRef('c.id', '=', 'v.campaign_id').onRef('c.company_id', '=', 'v.company_id'))
        .leftJoin('user_account as u', 'u.id', 'v.evaluator_id')
        .select(['v.id', 'v.scores', 'v.score', 'v.strengths', 'v.improvements', 'v.goals', 'v.comment', 'v.decided_at', 'v.bonus_amount', 'v.bonus_period', 'v.new_base_salary', 'v.raise_period',
          'c.name', 'c.period_start', 'c.period_end', 'c.criteria', 'u.full_name as evaluator'])
        .where('e.user_id', '=', t.ctx.userId).where('v.status', '=', 'approved').orderBy('c.period_end', 'desc').execute();
      return rows.map((v) => ({
        id: v.id, campaignName: v.name, periodStart: v.period_start, periodEnd: v.period_end, criteria: v.criteria as Criterion[], scores: v.scores,
        score: v.score === null ? null : Number(v.score), rating: rating(v.score === null ? null : Number(v.score)), evaluator: v.evaluator,
        strengths: v.strengths, improvements: v.improvements, goals: v.goals, comment: v.comment, decidedAt: v.decided_at,
        bonusAmount: Number(v.bonus_amount), bonusPeriod: v.bonus_period, newBaseSalary: v.new_base_salary === null ? null : Number(v.new_base_salary), raisePeriod: v.raise_period,
      }));
    });
  }

  /** À traiter : évaluations à remplir (évaluateur) et à approuver (valideur), pour le tableau de bord. */
  async pending(trx: TenantTrx, t: TenantInfo) {
    const open = (q: ReturnType<EvaluationsService['base']>) => q.where('c.status', '=', 'open');
    const toFill = t.permissions.has('evaluations.update')
      ? (await open(this.base(trx, t)).where('v.status', '=', 'draft').where('v.evaluator_id', '=', t.ctx.userId).execute()).length : 0;
    const toDecide = t.permissions.has('evaluations.validate')
      ? (await open(this.base(trx, t)).where('v.status', '=', 'submitted').where((eb) => eb.or([eb('e.user_id', 'is', null), eb('e.user_id', '!=', t.ctx.userId)])).execute()).length : 0;
    return { toFill, toDecide };
  }

  /** Export CSV d'une campagne. */
  async exportRows(t: TenantInfo, campaignId: string) {
    const c = await this.campaign(t, campaignId);
    const label = (k: string | null) => RATINGS.find((r) => r.key === k)?.label ?? '';
    return c.evaluations.map((v: any) => ({
      Matricule: v.employee.number, Employe: v.employee.name, Poste: v.employee.jobTitle ?? '', Service: v.employee.department ?? '', Evaluateur: v.evaluator?.name ?? '',
      ...Object.fromEntries(c.criteria.map((k) => [k.label, v.scores[k.key]?.score ?? ''])),
      Note: v.score ?? '', Appreciation: label(v.rating), Statut: v.status,
      ...(this.salaries(t) ? { Prime: v.bonusAmount ?? 0, 'Mois de la prime': v.bonusPeriod ? periodLabel(v.bonusPeriod) : '', 'Nouveau salaire de base': v.newBaseSalary ?? '',
        'Augmentation (%)': v.raisePercent ?? '', "Mois d'effet": v.raisePeriod ? periodLabel(v.raisePeriod) : '' } : {}),
    }));
  }

  defaults() { return { criteria: DEFAULT_CRITERIA, ratings: RATINGS, nextMonth: nextMonth() }; }
}
