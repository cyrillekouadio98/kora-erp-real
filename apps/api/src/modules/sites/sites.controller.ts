import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { siteScope } from '../../common/sites';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { isoDate } from '../sales/sales.controller';
import { today } from '../sales/sales.service';
import { SitesService } from './sites.service';

const opt = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const SiteSchema = z.object({
  name: z.string().trim().min(2, { message: 'Le nom doit contenir au moins 2 caractères' }).max(80),
  code: z.string().trim().max(20).regex(/^[A-Za-z0-9._-]*$/, { message: 'Le code ne contient que lettres, chiffres, points, tirets' }).transform((v) => v.toUpperCase() || null).nullable().optional(),
  address: opt(300), city: opt(80), phone: opt(40),
}).strict();
const CreateSchema = SiteSchema.extend({ withCash: z.boolean().default(true) });

/**
 * Sites de l'entreprise (magasins, succursales, dépôts) : chacun a ses entrepôts, ses caisses et ses employés ;
 * ventes, achats et documents de stock lui sont rattachés. Le site choisi dans l'en-tête filtre toute l'application.
 */
@ApiTags('Sites')
@Controller('company/sites')
export class SitesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly sites: SitesService) {}

  private async site(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Site');
    const s = await trx.selectFrom('site').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!s) throw notFound('Site');
    return s;
  }

  /** Sites visibles par l'utilisateur, avec ce qui leur est rattaché. */
  @Permission(null) @AllowWhenReadOnly()
  @Get()
  list(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const sites = await trx.selectFrom('site').selectAll().$if(!!t.allowedSiteIds, (q) => q.where('id', 'in', t.allowedSiteIds!.length ? t.allowedSiteIds! : ['00000000-0000-0000-0000-000000000000']))
        .orderBy('archived_at', 'desc').orderBy('is_default', 'desc').orderBy('code').execute();
      const count = async (table: 'warehouse' | 'treasury_account' | 'employee', extra?: (q: any) => any) => {
        let q: any = trx.selectFrom(table).select((eb) => ['site_id', eb.fn.countAll<string>().as('n')]).groupBy('site_id');
        if (extra) q = extra(q);
        return new Map(((await q.execute()) as { site_id: string; n: string }[]).map((r) => [r.site_id, Number(r.n)]));
      };
      const warehouses = await count('warehouse', (q) => q.where('archived_at', 'is', null));
      const accounts = await count('treasury_account', (q) => q.where('archived_at', 'is', null));
      const employees = await count('employee', (q) => q.where((eb: any) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', today())])));
      return sites.map((s) => ({
        id: s.id, code: s.code, name: s.name, address: s.address, city: s.city, phone: s.phone, isDefault: s.is_default, archived: !!s.archived_at,
        warehouses: warehouses.get(s.id) ?? 0, accounts: accounts.get(s.id) ?? 0, employees: employees.get(s.id) ?? 0,
      }));
    });
  }

  /** Nouveau site, avec son entrepôt et (au choix) sa caisse. */
  @Permission('settings.admin')
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.sites.create(t, parse(CreateSchema, body));
  }

  @Permission('settings.admin')
  @Patch(':id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(SiteSchema.partial().extend({ isDefault: z.literal(true).optional(), archived: z.boolean().optional() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const s = await this.site(trx, id);
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'address', 'city', 'phone'] as const) if (input[k] !== undefined) patch[k] = input[k];
      if (input.code && input.code !== s.code) {
        if (await trx.selectFrom('site').select('id').where('code', '=', input.code).executeTakeFirst()) throw conflict(`Le code ${input.code} est déjà utilisé par un autre site.`, 'duplicate_code');
        patch.code = input.code;
      }
      if (input.archived !== undefined && input.archived !== !!s.archived_at) {
        if (input.archived) {
          if (s.is_default) throw conflict("Le site principal ne peut pas être archivé : désignez d'abord un autre site principal.", 'default_site');
          const busy = await trx.selectFrom('warehouse').select('name').where('site_id', '=', id).where('archived_at', 'is', null).executeTakeFirst()
            ?? await trx.selectFrom('treasury_account').select('name').where('site_id', '=', id).where('archived_at', 'is', null).executeTakeFirst();
          if (busy) throw conflict(`« ${busy.name} » est encore actif sur ce site : archivez ou rattachez ailleurs ses entrepôts et ses caisses d'abord.`, 'site_in_use');
          const staff = await trx.selectFrom('employee').select('id').where('site_id', '=', id).where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', today())])).executeTakeFirst();
          if (staff) throw conflict('Des employés travaillent encore sur ce site : affectez-les à un autre site d’abord.', 'site_in_use');
        }
        patch.archived_at = input.archived ? new Date() : null;
      }
      if (input.isDefault && !s.is_default) {
        if (s.archived_at && input.archived !== false) throw conflict('Un site archivé ne peut pas devenir le site principal.', 'site_archived');
        await trx.updateTable('site').set({ is_default: false }).where('is_default', '=', true).execute();
        patch.is_default = true;
      }
      if (Object.keys(patch).length) await trx.updateTable('site').set(patch).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'site.updated', entityType: 'site', entityId: id, data: { code: s.code, fields: Object.keys(patch) } });
      return { ok: true };
    });
  }

  /** Site affiché (null : tous les sites autorisés) ; mémorisé dans la session. */
  @Permission(null) @AllowWhenReadOnly() @HttpCode(200)
  @Post('active')
  async setActive(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const { siteId } = parse(z.object({ siteId: z.string().uuid().nullable() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      if (siteId) {
        const s = await trx.selectFrom('site').select(['id', 'archived_at']).where('id', '=', siteId).executeTakeFirst();
        if (!s || s.archived_at || (t.allowedSiteIds && !t.allowedSiteIds.includes(siteId))) throw notFound('Site');
      } else if (t.allowedSiteIds?.length === 1) {
        throw badRequest('Vous êtes rattaché à un seul site.', undefined, 'single_site');
      }
      await sql`update user_session set active_site_id = ${siteId} where user_id = ${t.ctx.userId} and active_company_id = ${t.companyId} and revoked_at is null`.execute(trx);
      return { siteId };
    });
  }

  /**
   * Comparatif des sites sur une période : ventes, encaissements, achats, restes dus, trésorerie, stock, effectif
   * et résultat des écritures rattachées au site. La paie et les opérations diverses restent communes à l'entreprise.
   */
  @Permission('sales.read') @AllowWhenReadOnly()
  @Get('overview')
  overview(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = parse(z.object({ from: isoDate, to: isoDate }), query);
    if (f.from > f.to) throw badRequest('La date de début est postérieure à la date de fin.', undefined, 'bad_period');
    const scope = siteScope(t);
    return this.db.tenant(t.ctx, async (trx) => {
      const sites = await trx.selectFrom('site').select(['id', 'code', 'name', 'city', 'is_default']).where('archived_at', 'is', null)
        .$if(!!scope, (q) => q.where('id', 'in', scope!.length ? scope! : ['00000000-0000-0000-0000-000000000000'])).orderBy('is_default', 'desc').orderBy('code').execute();
      const ids = sites.map((s) => s.id);
      const byId = <T>(rows: (T & { site_id: string | null })[]) => new Map(rows.map((r) => [r.site_id ?? '', r]));
      const sales = byId(await trx.selectFrom('sales_document').where('status', 'not in', ['draft', 'cancelled']).where('type', 'in', ['invoice', 'credit_note'])
        .where('issue_date', '>=', f.from).where('issue_date', '<=', f.to)
        .select(['site_id', sql<string>`sum(case when type = 'invoice' then total_ht else -total_ht end)`.as('ht'), sql<string>`count(*) filter (where type = 'invoice')`.as('n')])
        .groupBy('site_id').execute());
      const receivable = byId(await trx.selectFrom('sales_document').where('type', '=', 'invoice').where('status', 'not in', ['draft', 'cancelled'])
        .select(['site_id', sql<string>`sum(greatest(0, total_ttc - paid_amount - credited_amount + refunded_amount))`.as('due')]).groupBy('site_id').execute());
      const collected = byId(await trx.selectFrom('sales_payment as p').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'p.document_id').onRef('d.company_id', '=', 'p.company_id'))
        .where('p.paid_on', '>=', f.from).where('p.paid_on', '<=', f.to).select(['d.site_id', sql<string>`sum(p.amount)`.as('amount')]).groupBy('d.site_id').execute());
      const purchases = byId(await trx.selectFrom('purchase_document').where('type', '=', 'invoice').where('status', 'not in', ['draft', 'cancelled'])
        .where('issue_date', '>=', f.from).where('issue_date', '<=', f.to).select(['site_id', sql<string>`sum(total_ht)`.as('ht')]).groupBy('site_id').execute());
      const payable = byId(await trx.selectFrom('purchase_document').where('type', '=', 'invoice').where('status', 'not in', ['draft', 'cancelled'])
        .select(['site_id', sql<string>`sum(greatest(0, total_ttc - paid_amount))`.as('due')]).groupBy('site_id').execute());
      const cash = byId(await trx.selectFrom('treasury_account as a').where('a.archived_at', 'is', null)
        .select(['a.site_id', sql<string>`sum(a.opening_balance + coalesce((select sum(case when m.direction = 'in' then m.amount else -m.amount end) from treasury_movement m
          where m.company_id = a.company_id and m.account_id = a.id and m.date >= a.opening_date and m.date <= ${f.to}), 0))`.as('balance')]).groupBy('a.site_id').execute());
      const stock = byId(await trx.selectFrom('stock_level as l').innerJoin('warehouse as w', (j) => j.onRef('w.id', '=', 'l.warehouse_id').onRef('w.company_id', '=', 'l.company_id'))
        .innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
        .select(['w.site_id', sql<string>`sum(l.quantity * p.avg_cost)`.as('value')]).groupBy('w.site_id').execute());
      const staff = byId(await trx.selectFrom('employee').where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', today())]))
        .select((eb) => ['site_id', eb.fn.countAll<string>().as('n')]).groupBy('site_id').execute());
      const result = byId(await trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
        .where('e.status', '=', 'posted').where('e.date', '>=', f.from).where('e.date', '<=', f.to).where('e.source_type', '!=', 'year_closing')
        .where((eb) => eb.or([eb('l.account_code', 'like', '6%'), eb('l.account_code', 'like', '7%')]))
        .select(['e.site_id', sql<string>`sum(l.credit - l.debit)`.as('result')]).groupBy('e.site_id').execute());
      const n = (v: unknown) => Math.round(Number(v ?? 0));
      const rows = sites.map((s) => ({
        id: s.id, code: s.code, name: s.name, city: s.city, isDefault: s.is_default,
        salesHt: n(sales.get(s.id)?.ht), invoices: n(sales.get(s.id)?.n), collected: n(collected.get(s.id)?.amount), receivable: n(receivable.get(s.id)?.due),
        purchasesHt: n(purchases.get(s.id)?.ht), payable: n(payable.get(s.id)?.due), cash: n(cash.get(s.id)?.balance), stockValue: n(stock.get(s.id)?.value),
        employees: n(staff.get(s.id)?.n), result: n(result.get(s.id)?.result),
      }));
      // Charges et produits communs (paie, opérations diverses) : visibles seulement sans limite de site.
      const common = scope ? null : n(result.get('')?.result);
      return { from: f.from, to: f.to, sites: rows.filter((r) => ids.includes(r.id)), common };
    });
  }
}
