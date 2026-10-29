import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, Trx } from '../../db/database.service';
import type { SubscriptionStatus } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { normalizeEntitlements } from './entitlements';
import { PAYMENT_PROVIDERS, VerifiedPayment } from './payment-provider';
import { QuotaService } from './quota.service';

type Cycle = 'monthly' | 'yearly';
const DAY = 86400_000;

export function addCycle(d: Date, cycle: Cycle): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + (cycle === 'yearly' ? 12 : 1));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}
const price = (v: { price_monthly: string; price_yearly: string }, c: Cycle) => Number(c === 'yearly' ? v.price_yearly : v.price_monthly);
/** Prix ramené au mois, pour comparer une montée et une descente de gamme. */
const monthlyEquivalent = (v: { price_monthly: string; price_yearly: string }, c: Cycle) => (c === 'yearly' ? Number(v.price_yearly) / 12 : Number(v.price_monthly));

/** Rappels envoyés avant et après l'échéance (jours relatifs). */
const REMINDERS = [-7, -1, 0, 3, 10];
const ARCHIVE_AFTER_DAYS = 90;

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Facturation');
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly quotas: QuotaService) {}

  // ------------------------------------------------------------------ lecture (côté entreprise)
  async publicPlans() {
    return this.db.asUser(null, async (trx) => {
      const all = await trx.selectFrom('plan as p').innerJoin('plan_version as v', 'v.plan_id', 'p.id')
        .select(['p.code', 'p.name', 'p.sort_order', 'v.version', 'v.currency', 'v.price_monthly', 'v.price_yearly', 'v.trial_days', 'v.entitlements'])
        .where('p.is_public', '=', true).where('v.published_at', 'is not', null)
        .orderBy('p.sort_order').orderBy('v.version', 'desc').execute();
      const rows = all.filter((r, i) => all.findIndex((x) => x.code === r.code) === i);
      return rows.map((r) => ({ code: r.code, name: r.name, version: r.version, currency: r.currency, priceMonthly: Number(r.price_monthly), priceYearly: Number(r.price_yearly), trialDays: r.trial_days, entitlements: normalizeEntitlements(r.entitlements) }));
    });
  }

  async overview(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const s = await trx.selectFrom('subscription as s').innerJoin('plan_version as v', 'v.id', 's.plan_version_id').innerJoin('plan as p', 'p.id', 'v.plan_id')
        .select(['s.id', 's.status', 's.billing_cycle', 's.current_period_start', 's.current_period_end', 's.grace_until', 's.cancel_at_period_end', 's.cancelled_at', 's.auto_renew', 's.overrides', 'p.code', 'p.name', 'v.price_monthly', 'v.price_yearly', 'v.currency'])
        .where('s.company_id', '=', t.companyId).executeTakeFirst();
      if (!s) throw notFound('Abonnement');
      const usage = await this.quotas.usage(trx, t.companyId);
      const openInvoices = await trx.selectFrom('platform_invoice').select(['id', 'number', 'amount', 'currency', 'due_at', 'status'])
        .where('status', '=', 'open').orderBy('issued_at', 'desc').execute();
      return {
        plan: { code: s.code, name: s.name, priceMonthly: Number(s.price_monthly), priceYearly: Number(s.price_yearly), currency: s.currency },
        status: s.status, billingCycle: s.billing_cycle, currentPeriodStart: s.current_period_start, currentPeriodEnd: s.current_period_end,
        graceUntil: s.grace_until, cancelAtPeriodEnd: s.cancel_at_period_end, cancelledAt: s.cancelled_at, autoRenew: s.auto_renew,
        pendingChange: (s.overrides as any)?.pending_change ?? null, entitlements: t.entitlements, usage, readOnly: t.readOnly,
        openInvoices: openInvoices.map((i) => ({ ...i, amount: Number(i.amount) })),
      };
    });
  }

  async invoices(t: TenantInfo) {
    return this.db.tenant(t.ctx, (trx) => trx.selectFrom('platform_invoice')
      .select(['id', 'number', 'kind', 'status', 'amount', 'currency', 'lines', 'period_start', 'period_end', 'issued_at', 'due_at', 'paid_at'])
      .orderBy('issued_at', 'desc').limit(100).execute()
      .then((rows) => rows.map((r) => ({ ...r, amount: Number(r.amount) }))));
  }

  // ------------------------------------------------------------------ actions de l'entreprise (exécutées par la plateforme)
  private async lockSub(trx: Trx, companyId: string) {
    const s = await trx.selectFrom('subscription as s').innerJoin('plan_version as v', 'v.id', 's.plan_version_id').innerJoin('plan as p', 'p.id', 'v.plan_id')
      .selectAll('s').select(['v.price_monthly', 'v.price_yearly', 'v.currency', 'v.grace_days', 'p.code as plan_code'])
      .where('s.company_id', '=', companyId).forUpdate('s').executeTakeFirst();
    if (!s) throw notFound('Abonnement');
    return s;
  }

  private async latestVersion(trx: Trx, code: string) {
    const v = await trx.selectFrom('plan_version as v').innerJoin('plan as p', 'p.id', 'v.plan_id')
      .select(['v.id', 'v.price_monthly', 'v.price_yearly', 'v.currency', 'v.entitlements', 'p.code', 'p.is_public'])
      .where('p.code', '=', code).where('v.published_at', 'is not', null).orderBy('v.version', 'desc').limit(1).executeTakeFirst();
    if (!v || !v.is_public) throw notFound('Formule');
    return v;
  }

  private async event(trx: Trx, s: { id: string; company_id: string }, type: string, from: string | null, to: string | null, data: Record<string, unknown> = {}) {
    await trx.insertInto('subscription_event').values({ subscription_id: s.id, company_id: s.company_id, type, from_status: from, to_status: to, data: JSON.stringify(data) }).execute();
  }

  private async setStatus(trx: Trx, s: { id: string; company_id: string; status: string }, to: SubscriptionStatus, patch: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
    await trx.updateTable('subscription').set({ status: to, ...patch }).where('id', '=', s.id).execute();
    await this.event(trx, s, 'status_changed', s.status, to, data);
    await this.audit.platform(trx, null, { companyId: s.company_id, actorType: 'system', action: 'subscription.status_changed', entityType: 'subscription', entityId: s.id, data: { from: s.status, to, ...data } });
  }

  async createInvoice(trx: Trx, s: { id: string; company_id: string; currency: string }, opts: { amount: number; lines: unknown[]; periodStart?: Date | null; periodEnd?: Date | null; dueAt: Date }) {
    const year = new Date().getUTCFullYear();
    const seq = await sql<{ n: string }>`select nextval('platform_invoice_seq')::text as n`.execute(trx);
    const number = `KORA-${year}-${seq.rows[0].n.padStart(6, '0')}`;
    return trx.insertInto('platform_invoice').values({
      number, company_id: s.company_id, subscription_id: s.id, kind: 'invoice', status: 'open', currency: s.currency,
      amount: Math.round(opts.amount), lines: JSON.stringify(opts.lines), period_start: opts.periodStart ?? null, period_end: opts.periodEnd ?? null, due_at: opts.dueAt,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async changePlan(t: TenantInfo, input: { planCode: string; billingCycle: Cycle }) {
    return this.db.platform(async (trx) => {
      const s = await this.lockSub(trx, t.companyId);
      const target = await this.latestVersion(trx, input.planCode);
      if (target.id === s.plan_version_id && input.billingCycle === s.billing_cycle) throw conflict('Vous êtes déjà sur cette formule.', 'same_plan');
      const targetEnt = normalizeEntitlements(target.entitlements);
      const usage = await this.quotas.usage(trx, t.companyId, { includePending: false });
      const warnings = targetEnt.quotas.users !== null && usage.users > targetEnt.quotas.users
        ? [`Vous avez ${usage.users} utilisateurs actifs pour ${targetEnt.quotas.users} inclus : aucun ne sera supprimé, mais vous ne pourrez plus en ajouter.`] : [];
      const auditUser = (action: string, data: Record<string, unknown>) =>
        this.audit.platform(trx, t.ctx.userId, { companyId: t.companyId, actorType: 'user', action, entityType: 'subscription', entityId: s.id, data });
      const now = new Date();

      if (s.status === 'trialing') {
        await trx.updateTable('subscription').set({ plan_version_id: target.id, billing_cycle: input.billingCycle }).where('id', '=', s.id).execute();
        await this.event(trx, s, 'plan_changed', s.status, s.status, { to: input.planCode, during_trial: true });
        await auditUser('subscription.plan_changed', { to: input.planCode, cycle: input.billingCycle, during_trial: true });
        return { applied: 'immediately', invoice: null, warnings };
      }

      const oldCycle = s.billing_cycle as Cycle;
      const isUpgrade = monthlyEquivalent(target, input.billingCycle) > monthlyEquivalent(s, oldCycle);

      if (s.status === 'active' && !isUpgrade) {
        const overrides = { ...(s.overrides as object), pending_change: { plan_version_id: target.id, plan_code: input.planCode, billing_cycle: input.billingCycle } };
        await trx.updateTable('subscription').set({ overrides: JSON.stringify(overrides) }).where('id', '=', s.id).execute();
        await this.event(trx, s, 'downgrade_scheduled', s.status, s.status, { to: input.planCode, at: s.current_period_end });
        await auditUser('subscription.downgrade_scheduled', { to: input.planCode, cycle: input.billingCycle, effective_at: s.current_period_end });
        return { applied: 'at_period_end', effectiveAt: s.current_period_end, invoice: null, warnings };
      }

      // Montée de gamme (ou reprise après suspension) : facture immédiate, changement appliqué au paiement.
      await trx.updateTable('platform_invoice').set({ status: 'void' }).where('subscription_id', '=', s.id).where('status', '=', 'open').execute();
      let amount: number; let periodStart: Date; let periodEnd: Date;
      const remaining = Math.min(1, Math.max(0, (new Date(s.current_period_end).getTime() - now.getTime()) / (new Date(s.current_period_end).getTime() - new Date(s.current_period_start).getTime())));
      if (s.status === 'active' && input.billingCycle === oldCycle) {
        amount = (price(target, input.billingCycle) - price(s, oldCycle)) * remaining;
        periodStart = new Date(s.current_period_start); periodEnd = new Date(s.current_period_end);
      } else {
        const credit = s.status === 'active' ? price(s, oldCycle) * remaining : 0;
        amount = Math.max(0, price(target, input.billingCycle) - credit);
        periodStart = now; periodEnd = addCycle(now, input.billingCycle);
      }
      const invoice = await this.createInvoice(trx, { id: s.id, company_id: t.companyId, currency: target.currency }, {
        amount, periodStart, periodEnd, dueAt: new Date(now.getTime() + 7 * DAY),
        lines: [{ type: 'plan_change', label: `Formule ${input.planCode} (${input.billingCycle === 'yearly' ? 'annuelle' : 'mensuelle'})`, amount: Math.round(amount),
          change: { plan_version_id: target.id, billing_cycle: input.billingCycle, period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() } }],
      });
      await auditUser('subscription.change_requested', { to: input.planCode, cycle: input.billingCycle, invoice: invoice.number, amount: Math.round(amount) });
      return { applied: 'on_payment', invoice: { id: invoice.id, number: invoice.number, amount: Number(invoice.amount), currency: invoice.currency }, warnings };
    });
  }

  async cancel(t: TenantInfo) {
    return this.db.platform(async (trx) => {
      const s = await this.lockSub(trx, t.companyId);
      if (s.status === 'trialing') {
        await this.setStatus(trx, s, 'cancelled', { cancelled_at: new Date() }, { reason: 'trial_cancelled' });
      } else if (s.status === 'active') {
        await trx.updateTable('subscription').set({ cancel_at_period_end: true }).where('id', '=', s.id).execute();
        await this.event(trx, s, 'cancel_scheduled', s.status, s.status, { at: s.current_period_end });
      } else throw conflict("L'abonnement ne peut pas être résilié dans son état actuel.", 'invalid_state');
      await this.audit.platform(trx, t.ctx.userId, { companyId: t.companyId, actorType: 'user', action: 'subscription.cancel_requested', entityType: 'subscription', entityId: s.id });
      return { ok: true };
    });
  }

  async resume(t: TenantInfo) {
    return this.db.platform(async (trx) => {
      const s = await this.lockSub(trx, t.companyId);
      if (s.status === 'active' && s.cancel_at_period_end) {
        await trx.updateTable('subscription').set({ cancel_at_period_end: false }).where('id', '=', s.id).execute();
        await this.event(trx, s, 'cancel_withdrawn', s.status, s.status);
        await this.audit.platform(trx, t.ctx.userId, { companyId: t.companyId, actorType: 'user', action: 'subscription.cancel_withdrawn', entityType: 'subscription', entityId: s.id });
        return { ok: true, invoice: null };
      }
      throw conflict('Rien à reprendre : pour réactiver un abonnement suspendu ou résilié, choisissez une formule et réglez la facture.', 'invalid_state');
    });
  }

  async checkout(t: TenantInfo, invoiceId: string, providerCode = 'sandbox') {
    if (!isUuid(invoiceId)) throw notFound('Facture');
    const inv = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('platform_invoice').selectAll().where('id', '=', invoiceId).executeTakeFirst());
    if (!inv) throw notFound('Facture');
    if (inv.status !== 'open') throw conflict("Cette facture n'est pas à régler.", 'invoice_not_open');
    const provider = PAYMENT_PROVIDERS[providerCode];
    if (!provider) throw badRequest('Moyen de paiement indisponible.');
    return provider.createCheckout({ id: inv.id, number: inv.number, amount: Number(inv.amount), currency: inv.currency, companyId: t.companyId });
  }

  // ------------------------------------------------------------------ paiements
  /** Traite une notification de paiement une seule fois, même si le prestataire la renvoie. */
  async handleNotification(providerCode: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const provider = PAYMENT_PROVIDERS[providerCode];
    if (!provider || !rawBody) throw notFound('Prestataire');
    let p: VerifiedPayment;
    try { p = await provider.verifyNotification(rawBody, headers); }
    catch { throw badRequest('Notification de paiement refusée.', undefined, 'invalid_notification'); }

    return this.db.platform(async (trx) => {
      const ev = await trx.insertInto('payment_webhook_event').values({ provider: providerCode, event_id: p.eventId, payload: rawBody.toString('utf8') })
        .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing()).returning('id').executeTakeFirst();
      if (!ev) return { status: 'duplicate' };
      const outcome = p.status === 'succeeded' ? await this.applyPayment(trx, { ...p, provider: providerCode }) : 'payment_failed';
      await trx.updateTable('payment_webhook_event').set({ processed_at: new Date(), outcome }).where('id', '=', ev.id).execute();
      return { status: outcome };
    });
  }

  async applyPayment(trx: Trx, p: { invoiceId: string; provider: string; providerRef: string; amount: number; currency: string }, actorId: string | null = null): Promise<string> {
    if (!isUuid(p.invoiceId)) return 'unknown_invoice';
    const inv = await trx.selectFrom('platform_invoice').selectAll().where('id', '=', p.invoiceId).forUpdate().executeTakeFirst();
    if (!inv) return 'unknown_invoice';
    const inserted = await trx.insertInto('platform_payment').values({
      invoice_id: inv.id, company_id: inv.company_id, provider: p.provider, provider_ref: p.providerRef, amount: p.amount, currency: p.currency, status: 'succeeded',
    }).onConflict((oc) => oc.columns(['provider', 'provider_ref']).doNothing()).returning('id').executeTakeFirst();
    if (!inserted) return 'duplicate_payment';
    if (inv.status !== 'open') return 'invoice_not_open';
    if (Math.round(p.amount) !== Math.round(Number(inv.amount)) || p.currency !== inv.currency) return 'amount_mismatch';

    await trx.updateTable('platform_invoice').set({ status: 'paid', paid_at: new Date() }).where('id', '=', inv.id).execute();
    const s = await this.lockSub(trx, inv.company_id);
    const lines = (inv.lines as any[]) ?? [];
    const change = lines.find((l) => l.change)?.change;
    const patch: Record<string, unknown> = { grace_until: null, cancel_at_period_end: false, cancelled_at: null };
    if (change) {
      patch.plan_version_id = change.plan_version_id;
      patch.billing_cycle = change.billing_cycle;
      patch.current_period_start = change.period_start;
      patch.current_period_end = change.period_end;
    } else if (inv.period_start && inv.period_end) {
      patch.current_period_start = inv.period_start;
      patch.current_period_end = inv.period_end;
    }
    const pending = (s.overrides as any)?.pending_change;
    if (pending && lines.some((l) => l.type === 'renewal' && l.applies_pending_change)) {
      patch.plan_version_id = pending.plan_version_id;
      patch.billing_cycle = pending.billing_cycle;
      const { pending_change, ...rest } = s.overrides as any;
      patch.overrides = JSON.stringify(rest);
    }
    await trx.updateTable('subscription').set(patch).where('id', '=', s.id).execute();
    if (s.status !== 'active') await this.event(trx, s, 'status_changed', s.status, 'active', { invoice: inv.number });
    await trx.updateTable('subscription').set({ status: 'active' }).where('id', '=', s.id).execute();
    await this.event(trx, s, 'payment_received', s.status, 'active', { invoice: inv.number, amount: p.amount, provider: p.provider });
    await this.audit.platform(trx, actorId, { companyId: inv.company_id, actorType: actorId ? 'platform' : 'system', action: 'subscription.payment_received', entityType: 'platform_invoice', entityId: inv.id, data: { number: inv.number, amount: p.amount, provider: p.provider } });
    return 'paid';
  }

  // ------------------------------------------------------------------ cycle de facturation
  private async notify(trx: Trx, companyId: string, type: string, key: string, payload: Record<string, unknown>) {
    await trx.insertInto('notification').values({ company_id: companyId, type, dedupe_key: key, payload: JSON.stringify(payload) })
      .onConflict((oc) => oc.column('dedupe_key').doNothing()).execute();
  }

  /** Fait avancer tous les abonnements : factures de renouvellement, rappels, grâce, suspension, archivage. Idempotent. */
  async runCycle(now = new Date()) {
    const summary = { renewalsInvoiced: 0, toGrace: 0, suspended: 0, cancelled: 0, archived: 0, reminders: 0 };
    const subs = await this.db.platformDb.selectFrom('subscription').select('company_id').where('status', 'in', ['trialing', 'active', 'grace', 'cancelled']).execute();
    for (const { company_id } of subs) {
      await this.db.platform(async (trx) => {
        const s = await this.lockSub(trx, company_id);
        const end = new Date(s.current_period_end);
        const cycle = s.billing_cycle as Cycle;
        const openRenewal = await trx.selectFrom('platform_invoice').select(['id', 'number', 'due_at']).where('subscription_id', '=', s.id)
          .where('status', '=', 'open').where('period_start', '=', end).executeTakeFirst();

        // Facture de renouvellement à J-7 (ou dès la fin d'essai).
        if ((s.status === 'active' && !s.cancel_at_period_end && now.getTime() >= end.getTime() - 7 * DAY) || (s.status === 'trialing' && now >= end)) {
          if (!openRenewal) {
            const pending = (s.overrides as any)?.pending_change;
            const v = pending ? await trx.selectFrom('plan_version').select(['price_monthly', 'price_yearly']).where('id', '=', pending.plan_version_id).executeTakeFirstOrThrow() : s;
            const c: Cycle = pending?.billing_cycle ?? cycle;
            const periodStart = end;
            await this.createInvoice(trx, { id: s.id, company_id, currency: s.currency }, {
              amount: price(v, c), periodStart, periodEnd: addCycle(periodStart, c), dueAt: end,
              lines: [{ type: 'renewal', label: `Abonnement ${pending?.plan_code ?? s.plan_code} (${c === 'yearly' ? 'annuel' : 'mensuel'})`, amount: price(v, c), applies_pending_change: !!pending }],
            });
            summary.renewalsInvoiced++;
          }
        }

        // Rappels relatifs à l'échéance.
        if (['active', 'grace', 'trialing'].includes(s.status) && !s.cancel_at_period_end) {
          for (const d of REMINDERS) {
            if (now.getTime() >= end.getTime() + d * DAY && now.getTime() < end.getTime() + (d + 1) * DAY) {
              await this.notify(trx, company_id, 'billing_reminder', `reminder:${s.id}:${end.toISOString()}:${d}`, { days_from_due: d, period_end: end });
              summary.reminders++;
            }
          }
        }

        if (now < end && s.status !== 'grace' && s.status !== 'cancelled') return;

        if (s.status === 'active' && s.cancel_at_period_end) {
          await this.setStatus(trx, s, 'cancelled', { cancelled_at: now }, { reason: 'cancelled_at_period_end' });
          summary.cancelled++;
        } else if (s.status === 'trialing' || s.status === 'active') {
          const graceUntil = new Date(end.getTime() + s.grace_days * DAY);
          await this.setStatus(trx, s, 'grace', { grace_until: graceUntil }, { reason: 'unpaid_at_period_end' });
          await this.notify(trx, company_id, 'billing_grace_started', `grace:${s.id}:${end.toISOString()}`, { grace_until: graceUntil });
          summary.toGrace++;
        } else if (s.status === 'grace' && s.grace_until && now >= new Date(s.grace_until)) {
          await this.setStatus(trx, s, 'suspended', {}, { reason: 'grace_expired' });
          await this.notify(trx, company_id, 'billing_suspended', `suspended:${s.id}:${end.toISOString()}`, {});
          summary.suspended++;
        } else if (s.status === 'cancelled' && s.cancelled_at && now.getTime() >= new Date(s.cancelled_at).getTime() + ARCHIVE_AFTER_DAYS * DAY) {
          await this.setStatus(trx, s, 'archived', {}, { reason: 'retention_period_over' });
          summary.archived++;
        }
      });
    }
    return summary;
  }
}
