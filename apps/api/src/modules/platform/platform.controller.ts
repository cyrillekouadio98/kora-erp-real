import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';
import { Auth, PlatformRoles } from '../../common/decorators';
import { conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { AuthInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { BillingService } from '../billing/billing.service';
import { ALL_MODULES } from '../billing/entitlements';

const ALL = ['super_admin', 'sales_admin', 'support', 'billing'];
const quota = z.number().int().min(0).nullable();
const EntitlementsSchema = z.object({
  modules: z.array(z.enum(ALL_MODULES as [string, ...string[]])),
  quotas: z.object({ users: quota, companies: quota, storage_mb: quota, employees: quota }),
  features: z.object({ export_advanced: z.boolean(), api: z.boolean(), support_level: z.string().max(40) }),
});

/**
 * Console de l'éditeur. Elle travaille avec le rôle PostgreSQL kora_platform, qui n'a aucun droit
 * sur les données métier des entreprises (factures clients, écritures, paie).
 */
@ApiTags('Console éditeur')
@Controller('platform')
export class PlatformController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly billing: BillingService) {}

  @PlatformRoles(...ALL)
  @Get('companies')
  companies(@Query('q') q?: string) {
    return this.db.platform(async (trx) => {
      let query = trx.selectFrom('company as c').leftJoin('subscription as s', 's.company_id', 'c.id')
        .leftJoin('plan_version as v', 'v.id', 's.plan_version_id').leftJoin('plan as p', 'p.id', 'v.plan_id')
        .select((eb) => ['c.id', 'c.name', 'c.status', 'c.status_reason as statusReason', 'c.created_at as createdAt', 'p.code as planCode', 's.status as subscriptionStatus', 's.current_period_end as currentPeriodEnd',
          eb.selectFrom('company_membership as m').whereRef('m.company_id', '=', 'c.id').where('m.status', '=', 'active').select(eb.fn.countAll<string>().as('n')).as('activeUsers')])
        .orderBy('c.created_at', 'desc').limit(500);
      if (q) query = query.where('c.name', 'ilike', `%${q.replace(/[%_]/g, '')}%`);
      return query.execute();
    });
  }

  private setCompanyStatus(auth: AuthInfo, id: string, status: 'active' | 'suspended', reason: string) {
    if (!isUuid(id)) throw notFound('Entreprise');
    return this.db.platform(async (trx) => {
      const c = await trx.selectFrom('company').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw notFound('Entreprise');
      if (c.status === status) throw conflict(`L'entreprise est déjà ${status === 'active' ? 'active' : 'suspendue'}.`);
      await trx.updateTable('company').set({ status, status_reason: status === 'active' ? null : reason }).where('id', '=', id).execute();
      await this.audit.platform(trx, auth.userId, { companyId: id, action: status === 'active' ? 'company.reactivated' : 'company.suspended', entityType: 'company', entityId: id, data: { reason } });
      return { ok: true };
    });
  }

  @PlatformRoles('super_admin', 'sales_admin') @HttpCode(200)
  @Post('companies/:id/suspend')
  suspend(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), body);
    return this.setCompanyStatus(auth, id, 'suspended', reason);
  }

  @PlatformRoles('super_admin', 'sales_admin') @HttpCode(200)
  @Post('companies/:id/reactivate')
  reactivate(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), body);
    return this.setCompanyStatus(auth, id, 'active', reason);
  }

  @PlatformRoles('super_admin', 'sales_admin')
  @Get('plans')
  plans() {
    return this.db.platform(async (trx) => {
      const plans = await trx.selectFrom('plan').selectAll().orderBy('sort_order').execute();
      const versions = await trx.selectFrom('plan_version').selectAll().orderBy('version', 'desc').execute();
      return plans.map((p) => ({ ...p, versions: versions.filter((v) => v.plan_id === p.id) }));
    });
  }

  @PlatformRoles('super_admin', 'sales_admin')
  @Post('plans')
  createPlan(@Auth() auth: AuthInfo, @Body() body: unknown) {
    const input = parse(z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), name: z.string().trim().min(2).max(60), isPublic: z.boolean().default(true), sortOrder: z.number().int().default(0) }), body);
    return this.db.platform(async (trx) => {
      const exists = await trx.selectFrom('plan').select('id').where('code', '=', input.code).executeTakeFirst();
      if (exists) throw conflict('Ce code de formule existe déjà.');
      const p = await trx.insertInto('plan').values({ code: input.code, name: input.name, is_public: input.isPublic, sort_order: input.sortOrder }).returningAll().executeTakeFirstOrThrow();
      await this.audit.platform(trx, auth.userId, { action: 'plan.created', entityType: 'plan', entityId: p.id, data: input });
      return p;
    });
  }

  /** Nouvelle version d'une formule : les abonnements existants restent sur leur version. */
  @PlatformRoles('super_admin', 'sales_admin')
  @Post('plans/:code/versions')
  createVersion(@Auth() auth: AuthInfo, @Param('code') code: string, @Body() body: unknown) {
    const input = parse(z.object({
      priceMonthly: z.number().min(0), priceYearly: z.number().min(0), trialDays: z.number().int().min(0).max(90).default(14),
      graceDays: z.number().int().min(0).max(60).default(15), entitlements: EntitlementsSchema, publish: z.boolean().default(false),
    }), body);
    return this.db.platform(async (trx) => {
      const p = await trx.selectFrom('plan').select('id').where('code', '=', code).executeTakeFirst();
      if (!p) throw notFound('Formule');
      const last = await trx.selectFrom('plan_version').select((eb) => eb.fn.max('version').as('m')).where('plan_id', '=', p.id).executeTakeFirst();
      const v = await trx.insertInto('plan_version').values({
        plan_id: p.id, version: Number(last?.m ?? 0) + 1, price_monthly: input.priceMonthly, price_yearly: input.priceYearly,
        trial_days: input.trialDays, grace_days: input.graceDays, entitlements: JSON.stringify(input.entitlements), published_at: input.publish ? new Date() : null,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.platform(trx, auth.userId, { action: 'plan.version_created', entityType: 'plan_version', entityId: v.id, data: { code, version: v.version, published: input.publish } });
      return v;
    });
  }

  @PlatformRoles('super_admin', 'sales_admin') @HttpCode(200)
  @Post('plan-versions/:id/publish')
  publish(@Auth() auth: AuthInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Version');
    return this.db.platform(async (trx) => {
      const r = await trx.updateTable('plan_version').set({ published_at: new Date() }).where('id', '=', id).where('published_at', 'is', null).returning('id').executeTakeFirst();
      if (!r) throw notFound('Version non publiée');
      await this.audit.platform(trx, auth.userId, { action: 'plan.version_published', entityType: 'plan_version', entityId: id });
      return { ok: true };
    });
  }

  /** Indicateurs éditeur : facturé, encaissé et récurrent estimé sont distingués. */
  @PlatformRoles(...ALL)
  @Get('metrics')
  metrics() {
    return this.db.platform(async (trx) => {
      const companies = await trx.selectFrom('company').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).groupBy('status').execute();
      const subs = await trx.selectFrom('subscription').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).groupBy('status').execute();
      const byPlan = await trx.selectFrom('subscription as s').innerJoin('plan_version as v', 'v.id', 's.plan_version_id').innerJoin('plan as p', 'p.id', 'v.plan_id')
        .select(['p.code', (eb) => eb.fn.countAll<string>().as('n')]).where('s.status', 'in', ['trialing', 'active', 'grace']).groupBy('p.code').execute();
      const mrr = await sql<{ mrr: string | null }>`
        select sum(case when s.billing_cycle = 'yearly' then v.price_yearly / 12 else v.price_monthly end)::numeric(18,0)::text as mrr
        from subscription s join plan_version v on v.id = s.plan_version_id where s.status in ('active','grace')`.execute(trx);
      const month = await sql<{ invoiced: string | null; collected: string | null; open_amount: string | null; open_count: string }>`
        select (select coalesce(sum(amount),0) from platform_invoice where status <> 'void' and issued_at >= date_trunc('month', now()))::text as invoiced,
               (select coalesce(sum(amount),0) from platform_payment where status = 'succeeded' and received_at >= date_trunc('month', now()))::text as collected,
               (select coalesce(sum(amount),0) from platform_invoice where status = 'open')::text as open_amount,
               (select count(*) from platform_invoice where status = 'open')::text as open_count`.execute(trx);
      const churn = await sql<{ n: string }>`select count(*)::text as n from subscription_event where to_status = 'cancelled' and created_at >= now() - interval '30 days'`.execute(trx);
      const toObj = (rows: { n: string }[], key: string) => Object.fromEntries(rows.map((r: any) => [r[key], Number(r.n)]));
      const m = month.rows[0];
      return {
        companies: toObj(companies, 'status'), subscriptions: toObj(subs, 'status'), byPlan: toObj(byPlan, 'code'),
        mrrEstimated: Number(mrr.rows[0]?.mrr ?? 0), arrEstimated: Number(mrr.rows[0]?.mrr ?? 0) * 12,
        invoicedThisMonth: Number(m.invoiced), collectedThisMonth: Number(m.collected), openInvoices: { count: Number(m.open_count), amount: Number(m.open_amount) },
        cancellationsLast30Days: Number(churn.rows[0].n), currency: 'XOF',
      };
    });
  }

  @PlatformRoles('super_admin', 'billing')
  @Get('invoices')
  invoices(@Query('status') status?: string) {
    return this.db.platform(async (trx) => {
      let q = trx.selectFrom('platform_invoice as i').innerJoin('company as c', 'c.id', 'i.company_id')
        .select(['i.id', 'i.number', 'c.name as companyName', 'i.status', 'i.amount', 'i.currency', 'i.issued_at as issuedAt', 'i.due_at as dueAt', 'i.paid_at as paidAt'])
        .orderBy('i.issued_at', 'desc').limit(500);
      if (status && ['open', 'paid', 'void'].includes(status)) q = q.where('i.status', '=', status as any);
      return q.execute();
    });
  }

  /** Paiement reçu hors ligne (virement, chèque) et saisi par le gestionnaire de facturation. */
  @PlatformRoles('super_admin', 'billing') @HttpCode(200)
  @Post('invoices/:id/mark-paid')
  markPaid(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ reference: z.string().trim().min(3).max(80) }), body);
    if (!isUuid(id)) throw notFound('Facture');
    return this.db.platform(async (trx) => {
      const inv = await trx.selectFrom('platform_invoice').select(['amount', 'currency']).where('id', '=', id).executeTakeFirst();
      if (!inv) throw notFound('Facture');
      const outcome = await this.billing.applyPayment(trx, { invoiceId: id, provider: 'manual', providerRef: input.reference, amount: Number(inv.amount), currency: inv.currency }, auth.userId);
      if (outcome !== 'paid') throw conflict(`Paiement non appliqué (${outcome}).`, outcome);
      return { status: outcome };
    });
  }

  @PlatformRoles('super_admin') @HttpCode(200)
  @Post('jobs/billing-cycle')
  runCycle() { return this.billing.runCycle(); }

  @PlatformRoles('super_admin')
  @Get('audit')
  platformAudit() {
    return this.db.platform((trx) => trx.selectFrom('audit_log').selectAll().where('company_id', 'is', null).orderBy('id', 'desc').limit(200).execute());
  }
}
