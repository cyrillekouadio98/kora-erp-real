import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, notFound } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AccountingService, DEFAULT_OPENING_COUNTERPART, OPENING_COUNTERPARTS } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';
import { isoDate } from '../sales/sales.controller';
import { cumulative, endOfLife, schedule } from './depreciation';

const FEATURE = 'fixed_assets';
const today = () => new Date().toISOString().slice(0, 10);

/** Catégories SYSCOHADA : compte d'immobilisation, compte d'amortissement, dotation et durée usuelle. */
export const ASSET_CATEGORIES: Record<string, { label: string; asset: string; depreciation: string; expense: string; years: number }> = {
  software: { label: 'Logiciels et sites internet', asset: '213000', depreciation: '281300', expense: '681200', years: 3 },
  buildings: { label: 'Bâtiments', asset: '231000', depreciation: '283100', expense: '681300', years: 20 },
  equipment: { label: 'Matériel et outillage', asset: '241000', depreciation: '284100', expense: '681300', years: 5 },
  computers: { label: 'Matériel informatique', asset: '244000', depreciation: '284400', expense: '681300', years: 3 },
  furniture: { label: 'Mobilier et matériel de bureau', asset: '244000', depreciation: '284400', expense: '681300', years: 10 },
  vehicles: { label: 'Matériel de transport', asset: '245000', depreciation: '284500', expense: '681300', years: 4 },
};

const CreateSchema = z.object({
  name: z.string().trim().min(2, { message: 'Indiquez le nom du bien' }).max(120),
  category: z.enum(Object.keys(ASSET_CATEGORIES) as [string, ...string[]], { message: 'Catégorie inconnue' }),
  acquisitionDate: isoDate, inServiceDate: isoDate.optional(),
  cost: z.coerce.number().positive({ message: "Le coût d'acquisition doit être positif" }).max(1e13).transform((v) => Math.round(v)),
  durationMonths: z.coerce.number().int().min(1).max(1200, { message: 'Durée trop longue' }),
  /** Bien acquis avant Kora : amortissements déjà pratiqués. */
  priorDepreciation: z.coerce.number().min(0).max(1e13).transform((v) => Math.round(v)).default(0),
  /** none : déjà en comptabilité ; supplier : D 2x / C 481 ; opening : bien repris à l'ouverture (D 2x / C 28x et contrepartie). */
  posting: z.enum(['none', 'supplier', 'opening']).default('none'),
  counterpart: z.enum(OPENING_COUNTERPARTS).optional(),
  postingDate: isoDate.optional(),
  notes: z.string().trim().max(1000).transform((v) => v || null).nullable().optional(),
}).strict();

/** Immobilisations : registre, plan d'amortissement, dotations annuelles et sortie de l'actif (SYSCOHADA). */
@ApiTags('Immobilisations')
@Controller('company/assets')
export class AssetsController {
  constructor(private readonly db: DatabaseService, private readonly accounting: AccountingService, private readonly audit: AuditService) {}

  private basis(a: { cost: string; in_service_date: string; duration_months: number }) {
    return { cost: Number(a.cost), inServiceDate: a.in_service_date, durationMonths: a.duration_months };
  }

  private async posted(trx: TenantTrx, assetId?: string) {
    const rows = await trx.selectFrom('fixed_asset_depreciation').select(['asset_id', 'year', 'amount']).$if(!!assetId, (q) => q.where('asset_id', '=', assetId!)).execute();
    const by = new Map<string, { year: number; amount: number }[]>();
    for (const r of rows) by.set(r.asset_id, [...(by.get(r.asset_id) ?? []), { year: r.year, amount: Number(r.amount) }]);
    return by;
  }

  private view(a: any, rows: { year: number; amount: number }[] = [], at = today()) {
    const b = this.basis(a);
    const booked = Number(a.prior_depreciation) + rows.reduce((s, r) => s + r.amount, 0);
    const cat = ASSET_CATEGORIES[a.category];
    return {
      id: a.id, code: a.code, name: a.name, category: a.category, categoryLabel: cat?.label ?? a.category, assetAccount: a.asset_account, depreciationAccount: a.depreciation_account,
      acquisitionDate: a.acquisition_date, inServiceDate: a.in_service_date, cost: Number(a.cost), durationMonths: a.duration_months, endOfLife: endOfLife(b),
      priorDepreciation: Number(a.prior_depreciation), posting: a.posting, disposedOn: a.disposed_on, notes: a.notes,
      // Amortissements comptabilisés (antérieurs compris) et théoriques à la date du jour.
      booked, theoretical: cumulative(b, a.disposed_on ?? at), netBookValue: Number(a.cost) - booked,
    };
  }

  private async asset(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Immobilisation');
    const a = await trx.selectFrom('fixed_asset').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!a) throw notFound('Immobilisation');
    return a;
  }

  @Permission('accounting.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get()
  index(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const assets = await trx.selectFrom('fixed_asset').selectAll().orderBy('disposed_on', 'desc').orderBy('code').execute();
      const posted = await this.posted(trx);
      const items = assets.map((a) => this.view(a, posted.get(a.id)));
      const active = items.filter((a) => !a.disposedOn);
      return {
        categories: Object.entries(ASSET_CATEGORIES).map(([key, c]) => ({ key, ...c })),
        assets: items,
        totals: { cost: active.reduce((s, a) => s + a.cost, 0), booked: active.reduce((s, a) => s + a.booked, 0), netBookValue: active.reduce((s, a) => s + a.netBookValue, 0) },
      };
    });
  }

  @Permission('accounting.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get(':id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.asset(trx, id);
      const rows = (await this.posted(trx, a.id)).get(a.id) ?? [];
      const prior = Number(a.prior_depreciation);
      return {
        ...this.view(a, rows),
        // Plan théorique ; une année est « reprise » si couverte par les amortissements antérieurs, « comptabilisée » si sa dotation est passée.
        schedule: schedule(this.basis(a)).map((r) => ({ ...r, status: r.cumulative <= prior ? 'prior' : rows.some((x) => x.year === r.year) ? 'posted' : 'pending',
          posted: rows.find((x) => x.year === r.year)?.amount ?? 0 })),
      };
    });
  }

  @Permission('accounting.create') @RequireFeature(FEATURE)
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(CreateSchema, body);
    const inService = input.inServiceDate ?? input.acquisitionDate;
    if (inService < input.acquisitionDate) throw badRequest("La mise en service ne peut pas précéder l'acquisition.", undefined, 'in_service_before_acquisition');
    if (input.priorDepreciation > input.cost) throw badRequest('Les amortissements antérieurs dépassent le coût du bien.', undefined, 'prior_too_high');
    if (input.priorDepreciation && input.posting === 'supplier') throw badRequest("Un bien qui vient d'être acheté n'a pas d'amortissements antérieurs.", undefined, 'prior_with_supplier');
    const cat = ASSET_CATEGORIES[input.category];
    return this.db.tenant(t.ctx, async (trx) => {
      const code = await nextNumber(trx, t.companyId, 'fixed_asset', 'IMMO');
      const a = await trx.insertInto('fixed_asset').values({
        company_id: t.companyId, code, name: input.name, category: input.category, asset_account: cat.asset, depreciation_account: cat.depreciation, expense_account: cat.expense,
        acquisition_date: input.acquisitionDate, in_service_date: inService, cost: input.cost, duration_months: input.durationMonths, prior_depreciation: input.priorDepreciation,
        posting: input.posting, notes: input.notes ?? null, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      let entry: { id: string; number: string } | null = null;
      const label = `Acquisition ${code} — ${input.name}`;
      if (input.posting === 'supplier') {
        entry = await this.accounting.postEntry(trx, t, { journal: 'OD', date: input.postingDate ?? input.acquisitionDate, label, sourceType: 'fixed_asset', sourceId: a.id, lines: [
          { account: cat.asset, label, debit: input.cost }, { account: '481000', label, credit: input.cost }] });
      } else if (input.posting === 'opening') {
        const lbl = `Reprise ${code} — ${input.name}`;
        const net = input.cost - input.priorDepreciation;
        entry = await this.accounting.postEntry(trx, t, { journal: 'AN', date: input.postingDate ?? today(), label: lbl, sourceType: 'fixed_asset', sourceId: a.id, lines: [
          { account: cat.asset, label: lbl, debit: input.cost },
          ...(input.priorDepreciation ? [{ account: cat.depreciation, label: lbl, credit: input.priorDepreciation }] : []),
          ...(net ? [{ account: input.counterpart ?? DEFAULT_OPENING_COUNTERPART, label: lbl, credit: net }] : []),
        ] });
      }
      if (entry) await trx.updateTable('fixed_asset').set({ acquisition_entry_id: entry.id }).where('id', '=', a.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'fixed_asset.created', entityType: 'fixed_asset', entityId: a.id, data: { code, name: input.name, cost: input.cost, posting: input.posting, entry: entry?.number ?? null } });
      return { id: a.id, code, entry: entry?.number ?? null };
    });
  }

  /** Dotations à passer pour un exercice : cumul théorique au 31/12 moins amortissements déjà comptabilisés. */
  private async due(trx: TenantTrx, year: number) {
    const end = `${year}-12-31`;
    const assets = await trx.selectFrom('fixed_asset').selectAll().where('disposed_on', 'is', null).where('in_service_date', '<=', end).orderBy('code').execute();
    const posted = await this.posted(trx);
    return assets.map((a) => {
      const rows = posted.get(a.id) ?? [];
      const already = rows.some((r) => r.year === year);
      const amount = already ? 0 : Math.max(0, cumulative(this.basis(a), end) - Number(a.prior_depreciation) - rows.reduce((s, r) => s + r.amount, 0));
      return { asset: a, amount, already };
    });
  }

  @Permission('accounting.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get('depreciation/preview')
  preview(@Tenant() t: TenantInfo, @Query('year') year: string) {
    const y = parse(z.coerce.number().int().min(2000).max(2100), year);
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.due(trx, y);
      return { year: y, total: rows.reduce((s, r) => s + r.amount, 0), alreadyPosted: rows.filter((r) => r.already).length,
        lines: rows.filter((r) => r.amount > 0).map((r) => ({ id: r.asset.id, code: r.asset.code, name: r.asset.name, amount: r.amount, expenseAccount: r.asset.expense_account, depreciationAccount: r.asset.depreciation_account })) };
    });
  }

  /** Passe les dotations de l'exercice au 31/12 (D 681 / C 28x), une écriture d'OD pour tous les biens. */
  @Permission('accounting.validate') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('depreciation')
  depreciate(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const { year } = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100) }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = (await this.due(trx, year)).filter((r) => r.amount > 0);
      if (!rows.length) throw conflict(`Aucune dotation à passer pour ${year} : tout est déjà comptabilisé.`, 'nothing_to_post');
      const label = `Dotations aux amortissements ${year}`;
      const entry = await this.accounting.postEntry(trx, t, { journal: 'OD', date: `${year}-12-31`, label, sourceType: 'fixed_asset', lines: rows.flatMap((r) => {
        const l = `${label} — ${r.asset.code} ${r.asset.name}`;
        return [{ account: r.asset.expense_account, label: l, debit: r.amount }, { account: r.asset.depreciation_account, label: l, credit: r.amount }];
      }) });
      await trx.insertInto('fixed_asset_depreciation').values(rows.map((r) => ({ company_id: t.companyId, asset_id: r.asset.id, year, amount: r.amount, entry_id: entry.id }))).execute();
      const total = rows.reduce((s, r) => s + r.amount, 0);
      await this.audit.tenant(trx, t.ctx, { action: 'fixed_asset.depreciation_posted', entityType: 'journal_entry', entityId: entry.id, data: { year, total, assets: rows.length, number: entry.number } });
      return { number: entry.number, total, assets: rows.length };
    });
  }

  /**
   * Sortie de l'actif (cession, mise au rebut, vol) : dotation complémentaire jusqu'à la date, puis
   * D 28x (amortissements) et D 812 (valeur nette) / C 2x (coût). Le prix de cession éventuel s'enregistre en produit (822).
   */
  @Permission('accounting.validate') @RequireFeature(FEATURE) @HttpCode(200)
  @Post(':id/dispose')
  dispose(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ date: isoDate, reason: z.string().trim().min(3, { message: 'Indiquez le motif de la sortie' }).max(200) }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.asset(trx, id);
      if (a.disposed_on) throw conflict(`${a.code} est déjà sorti de l'actif.`, 'already_disposed');
      if (input.date < a.in_service_date) throw badRequest('La sortie ne peut pas précéder la mise en service.', undefined, 'disposal_before_service');
      const year = Number(input.date.slice(0, 4));
      const rows = (await this.posted(trx, a.id)).get(a.id) ?? [];
      if (rows.some((r) => r.year > year || (r.year === year && input.date < `${year}-12-31`))) throw conflict(`Les dotations de ${year} sont déjà passées : la sortie se date au 31/12/${year} ou après.`, 'year_already_posted');
      let booked = Number(a.prior_depreciation) + rows.reduce((s, r) => s + r.amount, 0);
      const extra = Math.max(0, cumulative(this.basis(a), input.date) - booked);
      const label = `Sortie ${a.code} — ${a.name} (${input.reason})`;
      if (extra > 0) {
        const dot = await this.accounting.postEntry(trx, t, { journal: 'OD', date: input.date, label: `Dotation complémentaire — ${a.code} ${a.name}`, reference: a.code, sourceType: 'fixed_asset', lines: [
          { account: a.expense_account, label, debit: extra }, { account: a.depreciation_account, label, credit: extra }] });
        await trx.insertInto('fixed_asset_depreciation').values({ company_id: t.companyId, asset_id: a.id, year, amount: extra, entry_id: dot.id }).execute();
        booked += extra;
      }
      const cost = Number(a.cost), net = cost - booked;
      // Une seule écriture rattachée au bien (son acquisition) : les suivantes portent son code en référence.
      const out = await this.accounting.postEntry(trx, t, { journal: 'OD', date: input.date, label, reference: a.code, sourceType: 'fixed_asset', lines: [
        ...(booked ? [{ account: a.depreciation_account, label, debit: booked }] : []),
        ...(net ? [{ account: '812000', label, debit: net }] : []),
        { account: a.asset_account, label, credit: cost },
      ] });
      await trx.updateTable('fixed_asset').set({ disposed_on: input.date, disposal_entry_id: out.id }).where('id', '=', a.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'fixed_asset.disposed', entityType: 'fixed_asset', entityId: a.id, data: { code: a.code, date: input.date, reason: input.reason, netBookValue: net, number: out.number } });
      return { number: out.number, complementary: extra, netBookValue: net };
    });
  }
}
