import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { PRICE_LISTS } from '../sales/price-lists';
import { isUuid } from '../../common/ids';
import { assertSiteAccess, siteScope } from '../../common/sites';
import { parseImage } from '../../common/images';
import { nextNumber, peekNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { toCsv } from '../exports/export.controller';

const opt = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const ContactSchema = z.object({
  kind: z.enum(['customer', 'supplier', 'both'], { message: 'Choisissez client, fournisseur ou les deux' }),
  legalType: z.enum(['company', 'individual']).optional(),
  name: z.string().trim().min(2, { message: 'Le nom doit contenir au moins 2 caractères' }).max(160),
  taxId: opt(40), rccm: opt(60), phone: opt(40), address: opt(300), city: opt(80), notes: opt(2000),
  email: z.string().trim().toLowerCase().email({ message: 'Adresse e-mail invalide' }).nullable().optional().or(z.literal('').transform(() => null)),
  countryCode: z.string().trim().length(2).transform((v) => v.toUpperCase()).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  /** Site du contact (null = tous les sites). */
  siteId: z.string().uuid({ message: 'Site inconnu' }).nullable().optional(),
  /** Liste de prix du client (fonctionnalité « Listes de prix ») ; null : prix des articles. */
  priceListId: z.string().uuid({ message: 'Liste de prix inconnue' }).nullable().optional(),
}).strict();

const COLUMNS = {
  kind: 'kind', legalType: 'legal_type', name: 'name', taxId: 'tax_id', rccm: 'rccm', email: 'email', phone: 'phone',
  address: 'address', city: 'city', notes: 'notes', countryCode: 'country_code', paymentTermsDays: 'payment_terms_days', siteId: 'site_id', priceListId: 'price_list_id',
} as const;

/** Préfixe de numérotation automatique selon le type de tiers. */
const PREFIX = { customer: 'CLI', supplier: 'FRS', both: 'TIE' } as const;

const SELECT = [
  'id', 'code', 'kind', 'legal_type as legalType', 'name', 'tax_id as taxId', 'rccm', 'email', 'phone', 'address', 'city',
  'country_code as countryCode', 'payment_terms_days as paymentTermsDays', 'notes', 'site_id as siteId', 'price_list_id as priceListId', 'archived_at as archivedAt', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['customer', 'supplier']).optional(),
  archived: z.enum(['false', 'true', 'all']).default('false'),
});

/** Champs obligatoires : une entreprise doit pouvoir être facturée (NCC, RCCM, délai), un particulier joint. */
const REQUIRED = {
  company: [['name', 'Raison sociale'], ['phone', 'Téléphone'], ['email', 'E-mail'], ['tax_id', 'NCC'], ['rccm', 'RCCM'], ['payment_terms_days', 'Délai de paiement']],
  individual: [['name', 'Nom'], ['phone', 'Téléphone']],
} as const;
const FIELD = { name: 'name', phone: 'phone', email: 'email', tax_id: 'taxId', rccm: 'rccm', payment_terms_days: 'paymentTermsDays' } as const;

function assertComplete(c: Record<string, unknown>) {
  const type = c.legal_type === 'individual' ? 'individual' : 'company';
  const missing = REQUIRED[type].filter(([col]) => c[col] === null || c[col] === undefined || c[col] === '');
  if (missing.length) {
    throw badRequest(`${type === 'company' ? 'Pour une entreprise' : 'Pour un particulier'}, renseignez : ${missing.map(([, l]) => l).join(', ')}.`,
      missing.map(([col, l]) => ({ field: FIELD[col], message: `${l} obligatoire` })), 'contact_incomplete');
  }
}

function toColumns(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(COLUMNS)) if (input[k] !== undefined) out[col] = input[k];
  return out;
}

@ApiTags('Contacts')
@Controller('company/contacts')
export class ContactsController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private list(trx: TenantTrx, t: TenantInfo, query: z.infer<typeof ListQuery>) {
    let q = trx.selectFrom('contact').select(SELECT).orderBy('name').limit(1000);
    // Site affiché : ses contacts et les contacts communs à tous les sites.
    const scope = siteScope(t);
    if (scope) q = q.where((eb) => eb.or([eb('site_id', 'is', null), ...(scope.length ? [eb('site_id', 'in', scope)] : [])]));
    if (query.archived === 'false') q = q.where('archived_at', 'is', null);
    if (query.archived === 'true') q = q.where('archived_at', 'is not', null);
    if (query.kind) q = q.where('kind', 'in', [query.kind, 'both']);
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) => eb.or(['name', 'code', 'email', 'phone', 'tax_id', 'city'].map((c) => eb(c as 'name', 'ilike', like))));
    }
    return q.execute();
  }

  /** Adresse du logo de chaque contact (null sans logo) ; la version dans l'adresse renouvelle le cache. */
  private async withLogo<T extends { id: string }>(trx: TenantTrx, rows: T[]) {
    const logos = rows.length ? await trx.selectFrom('contact_logo').select(['contact_id', 'updated_at']).where('contact_id', 'in', rows.map((r) => r.id)).execute() : [];
    const at = new Map(logos.map((l) => [l.contact_id, new Date(l.updated_at).getTime()]));
    return rows.map((r) => ({ ...r, logo: at.has(r.id) ? `/company/contacts/${r.id}/logo?v=${at.get(r.id)}` : null }));
  }

  /** Factures émises ou reçues et montant restant dû, par contact (vignettes de la liste). */
  private async stats(trx: TenantTrx, ids: string[]) {
    if (!ids.length) return new Map<string, { salesInvoices: number; receivable: number; purchaseInvoices: number; payable: number }>();
    const sales = await trx.selectFrom('sales_document').where('type', '=', 'invoice').where('status', 'not in', ['draft', 'cancelled']).where('contact_id', 'in', ids)
      .select((eb) => ['contact_id', eb.fn.countAll<string>().as('n'),
        sql<string>`coalesce(sum(greatest(0, total_ttc - paid_amount - credited_amount + refunded_amount)), 0)`.as('due')]).groupBy('contact_id').execute();
    const purchases = await trx.selectFrom('purchase_document').where('type', '=', 'invoice').where('status', 'not in', ['draft', 'cancelled']).where('contact_id', 'in', ids)
      .select((eb) => ['contact_id', eb.fn.countAll<string>().as('n'), sql<string>`coalesce(sum(greatest(0, total_ttc - paid_amount)), 0)`.as('due')]).groupBy('contact_id').execute();
    const out = new Map(ids.map((id) => [id, { salesInvoices: 0, receivable: 0, purchaseInvoices: 0, payable: 0 }]));
    for (const r of sales) Object.assign(out.get(r.contact_id)!, { salesInvoices: Number(r.n), receivable: Number(r.due) });
    for (const r of purchases) Object.assign(out.get(r.contact_id)!, { purchaseInvoices: Number(r.n), payable: Number(r.due) });
    return out;
  }

  /** Code attribué automatiquement selon le type de tiers : CLI-00001, FRS-00001, TIE-00001… */
  private async nextCode(trx: TenantTrx, t: TenantInfo, kind: keyof typeof PREFIX, siteId: string | null | undefined) {
    const taken = async (c: string) => !!(await trx.selectFrom('contact').select('id').where('code', '=', c).executeTakeFirst());
    const seq = await this.codeSequence(trx, kind, siteId);
    for (;;) {
      const next = await nextNumber(trx, t.companyId, seq.docType, seq.prefix);
      if (!(await taken(next))) return next;
    }
  }

  @Permission('contacts.read') @AllowWhenReadOnly()
  @Get()
  index(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.withLogo(trx, await this.list(trx, t, q));
      const stats = await this.stats(trx, rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, ...stats.get(r.id) }));
    });
  }

  /** Fichier CSV (séparateur point-virgule, UTF-8) ouvrable directement dans Excel. */
  @Permission('contacts.export') @AllowWhenReadOnly()
  @Get('export')
  async export(@Tenant() t: TenantInfo, @Query() query: unknown, @Res() res: Response) {
    const q = parse(ListQuery, query);
    const rows = await this.db.tenant(t.ctx, async (trx) => {
      const r = await this.list(trx, t, q);
      await this.audit.tenant(trx, t.ctx, { action: 'contact.exported', data: { count: r.length } });
      return r;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows as Record<string, unknown>[]));
  }

  /** Code que recevra un nouveau contact de ce type (aperçu du formulaire, rien n'est réservé). */
  @Permission('contacts.read') @AllowWhenReadOnly()
  @Get('next-code')
  nextCodePreview(@Tenant() t: TenantInfo, @Query('kind') kind: string, @Query('siteId') siteId?: string) {
    const k = parse(z.enum(['customer', 'supplier', 'both']), kind);
    return this.db.tenant(t.ctx, async (trx) => {
      const seq = await this.codeSequence(trx, k, siteId && isUuid(siteId) ? siteId : null);
      return { code: await peekNumber(trx, seq.docType, seq.prefix) };
    });
  }

  /** Séquence des codes : une par type et par site (CLI-S02-00001…), une par type pour les contacts communs (CLI-00001…). */
  private async codeSequence(trx: TenantTrx, kind: keyof typeof PREFIX, siteId: string | null | undefined) {
    const site = siteId ? await trx.selectFrom('site').select(['id', 'code']).where('id', '=', siteId).executeTakeFirst() : undefined;
    if (!site) return { docType: `contact_${kind}`, prefix: PREFIX[kind] };
    return { docType: `contact_${kind}_site_${site.id}`, prefix: `${PREFIX[kind]}-${site.code.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SITE'}` };
  }

  /** Site d'un contact : actif, et permis à l'utilisateur. */
  private async assertSite(trx: TenantTrx, t: TenantInfo, siteId: string | null | undefined) {
    if (!siteId) return;
    if (!(await trx.selectFrom('site').select('id').where('id', '=', siteId).where('archived_at', 'is', null).executeTakeFirst())) throw badRequest('Site introuvable.', undefined, 'unknown_site');
    assertSiteAccess(t, siteId);
  }

  @Permission('contacts.read') @AllowWhenReadOnly()
  @Get(':id')
  async get(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Contact');
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await trx.selectFrom('contact').select(SELECT).where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Contact');
      return (await this.withLogo(trx, [c]))[0];
    });
  }

  @Permission('contacts.read') @AllowWhenReadOnly()
  @Get(':id/logo')
  async logo(@Tenant() t: TenantInfo, @Param('id') id: string, @Res() res: Response) {
    if (!isUuid(id)) throw notFound('Logo');
    const l = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('contact_logo').select(['mime', 'data']).where('contact_id', '=', id).executeTakeFirst());
    if (!l) throw notFound('Logo');
    res.setHeader('Content-Type', l.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(l.data);
  }

  /** Logo d'une entreprise ou photo d'un particulier ; null le retire. */
  @Permission('contacts.update')
  @Put(':id/logo')
  setLogo(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Contact');
    const { logo } = parse(z.object({ logo: z.string().max(100_000, { message: 'Image trop lourde' }).nullable() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await trx.selectFrom('contact').select(SELECT).where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Contact');
      if (logo) {
        const { mime, data } = parseImage(logo);
        await trx.insertInto('contact_logo').values({ company_id: t.companyId, contact_id: id, mime, data })
          .onConflict((oc) => oc.columns(['company_id', 'contact_id']).doUpdateSet({ mime, data, updated_at: new Date() })).execute();
      } else {
        await trx.deleteFrom('contact_logo').where('contact_id', '=', id).execute();
      }
      await this.audit.tenant(trx, t.ctx, { action: logo ? 'contact.logo_updated' : 'contact.logo_removed', entityType: 'contact', entityId: id, data: { code: c.code } });
      return (await this.withLogo(trx, [c]))[0];
    });
  }

  /** Liste de prix d'un client : seulement si la fonctionnalité est activée, et liste active. */
  private async assertPriceList(trx: TenantTrx, t: TenantInfo, id: string | null | undefined) {
    if (!id) return;
    if (!t.features.has(PRICE_LISTS)) throw forbidden("Les listes de prix ne sont pas activées pour votre entreprise.", 'feature_not_enabled');
    const l = await trx.selectFrom('price_list').select(['id', 'archived_at']).where('id', '=', id).executeTakeFirst();
    if (!l || l.archived_at) throw badRequest('Liste de prix inconnue ou archivée.', undefined, 'unknown_price_list');
  }

  @Permission('contacts.create')
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(ContactSchema, body);
    assertComplete({ ...toColumns(input), legal_type: input.legalType ?? 'company' });
    return this.db.tenant(t.ctx, async (trx) => {
      // Site : celui choisi ; à défaut, le site affiché (entreprise multi-sites), sinon commun à tous les sites.
      if (input.siteId === undefined) {
        const sites = Number((await trx.selectFrom('site').select((eb) => eb.fn.countAll<string>().as('n')).where('archived_at', 'is', null).executeTakeFirstOrThrow()).n);
        input.siteId = sites > 1 ? t.siteId : null;
      }
      await this.assertSite(trx, t, input.siteId);
      await this.assertPriceList(trx, t, input.priceListId);
      const code = await this.nextCode(trx, t, input.kind, input.siteId);
      const created = await trx.insertInto('contact').values({
        ...toColumns(input), code, company_id: t.companyId, created_by: t.ctx.userId,
      } as any).returning(SELECT).executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'contact.created', entityType: 'contact', entityId: created.id, data: { code, name: created.name, kind: created.kind } });
      return created;
    });
  }

  @Permission('contacts.update')
  @Patch(':id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Contact');
    const input = parse(ContactSchema.partial(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await trx.selectFrom('contact').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Contact');
      if (before.archived_at) throw conflict('Ce contact est archivé : restaurez-le avant de le modifier.', 'contact_archived');
      const patch = toColumns(input);
      // Simple affectation à un site : pas d'exigence de fiche complète (anciens contacts incomplets).
      if (Object.keys(input).some((k) => k !== 'siteId' && k !== 'priceListId')) assertComplete({ ...before, ...patch });
      if (input.siteId !== undefined) await this.assertSite(trx, t, input.siteId);
      await this.assertPriceList(trx, t, input.priceListId);
      // Nouveau type de tiers : nouveau code avec le bon préfixe (les pièces déjà émises gardent l'ancien).
      if (input.kind && input.kind !== before.kind) patch.code = await this.nextCode(trx, t, input.kind, input.siteId !== undefined ? input.siteId : before.site_id);
      if (!Object.keys(patch).length) return trx.selectFrom('contact').select(SELECT).where('id', '=', id).executeTakeFirstOrThrow();
      const after = await trx.updateTable('contact').set(patch).where('id', '=', id).returning(SELECT).executeTakeFirstOrThrow();
      const changes = Object.fromEntries(Object.keys(patch).filter((c) => (before as any)[c] !== patch[c]).map((c) => [c, { from: (before as any)[c], to: patch[c] }]));
      await this.audit.tenant(trx, t.ctx, { action: 'contact.updated', entityType: 'contact', entityId: id, data: { code: after.code, changes } });
      return after;
    });
  }

  /** Archive (au lieu de supprimer) : le tiers disparaît des listes mais reste dans l'historique. */
  @Permission('contacts.cancel') @HttpCode(200)
  @Post(':id/archive')
  archive(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.setArchived(t, id, true); }

  @Permission('contacts.cancel') @HttpCode(200)
  @Post(':id/restore')
  restore(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.setArchived(t, id, false); }

  private setArchived(t: TenantInfo, id: string, archived: boolean) {
    if (!isUuid(id)) throw notFound('Contact');
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await trx.updateTable('contact').set({ archived_at: archived ? new Date() : null })
        .where('id', '=', id).where('archived_at', archived ? 'is' : 'is not', null).returning(SELECT).executeTakeFirst();
      if (!c) throw notFound('Contact');
      await this.audit.tenant(trx, t.ctx, { action: archived ? 'contact.archived' : 'contact.restored', entityType: 'contact', entityId: id, data: { code: c.code, name: c.name } });
      return c;
    });
  }
}
