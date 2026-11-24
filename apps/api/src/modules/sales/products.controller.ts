import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { OPENING_COUNTERPARTS } from '../accounting/accounting.service';
import { isoDate } from './sales.controller';
import { productUnits, UNITS } from './units';
import { RequireFeature } from '../../common/features';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { assertSiteAccess, siteScope } from '../../common/sites';
import { nextNumber, peekNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { StockService } from '../stock/stock.service';

/** Taux de TVA applicables en Côte d'Ivoire : normal, réduit, exonéré. */
export const VAT_RATES = [18, 9, 0];

const money = z.coerce.number().min(0, { message: 'Le montant ne peut pas être négatif' }).max(1e13);
const ProductSchema = z.object({
  kind: z.enum(['good', 'service']).optional(),
  name: z.string().trim().min(2, { message: 'Le nom doit contenir au moins 2 caractères' }).max(160),
  description: z.string().trim().max(2000).transform((v) => v || null).nullable().optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  salePrice: money,
  purchasePrice: money.nullable().optional(),
  vatRate: z.coerce.number().refine((v) => VAT_RATES.includes(v), { message: 'Taux de TVA : 18 %, 9 % ou 0 %' }),
  /** Site de l'article (null = tous les sites). */
  siteId: z.string().uuid({ message: 'Site inconnu' }).nullable().optional(),
  barcode: z.string().trim().max(40).regex(/^[A-Za-z0-9._-]*$/, { message: 'Code-barres : chiffres et lettres uniquement, sans espace' }).transform((v) => v || null).nullable().optional(),
}).strict();

/** Stock initial saisi avec l'article (quantité, coût unitaire HT, entrepôt). */
const OpeningStockSchema = z.object({
  quantity: z.coerce.number().positive({ message: 'La quantité en stock doit être positive' }).max(1e9),
  unitCost: money.optional(),
  warehouseId: z.string().uuid({ message: 'Entrepôt inconnu' }).nullable().optional(),
  counterpart: z.enum(OPENING_COUNTERPARTS, { message: 'Compte de contrepartie non proposé' }).optional(),
  lotNumber: z.string().trim().max(60).transform((v) => v || null).nullable().optional(), expiryDate: isoDate.nullable().optional(),
  /** Date du stock initial (reprise d'un autre logiciel) ; aujourd'hui par défaut. */
  date: isoDate.optional(),
}).strict();

const COLUMNS = { kind: 'kind', name: 'name', description: 'description', unit: 'unit', salePrice: 'sale_price', purchasePrice: 'purchase_price', vatRate: 'vat_rate', barcode: 'barcode', siteId: 'site_id' } as const;
const SELECT = ['id', 'code', 'kind', 'name', 'description', 'unit', 'sale_price as salePrice', 'purchase_price as purchasePrice', 'vat_rate as vatRate', 'archived_at as archivedAt',
  'track_stock as trackStock', 'track_lots as trackLots', 'stock_qty as stockQty', 'barcode', 'site_id as siteId'] as const;

const toNumbers = <T extends { salePrice: string; purchasePrice: string | null; vatRate: string; stockQty: string }>(p: T) =>
  ({ ...p, salePrice: Number(p.salePrice), purchasePrice: p.purchasePrice === null ? null : Number(p.purchasePrice), vatRate: Number(p.vatRate), stockQty: Number(p.stockQty) });

@ApiTags('Articles')
@Controller('company/products')
export class ProductsController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly stock: StockService) {}

  /** Site d'un article : actif, et permis à l'utilisateur. */
  private async assertSite(trx: TenantTrx, t: TenantInfo, siteId: string | null | undefined) {
    if (!siteId) return;
    if (!(await trx.selectFrom('site').select('id').where('id', '=', siteId).where('archived_at', 'is', null).executeTakeFirst())) throw badRequest('Site introuvable.', undefined, 'unknown_site');
    assertSiteAccess(t, siteId);
  }

  /** Code d'un nouvel article, toujours attribué par N° de séquence (ART-00001…) ; un code déjà pris (ancienne saisie manuelle) est sauté. */
  private async nextCode(trx: TenantTrx, t: TenantInfo, siteId: string | null | undefined) {
    const taken = async (c: string) => !!(await trx.selectFrom('product').select('id').where('code', '=', c).executeTakeFirst());
    const seq = await this.codeSequence(trx, siteId);
    for (;;) {
      const next = await nextNumber(trx, t.companyId, seq.docType, seq.prefix);
      if (!(await taken(next))) return next;
    }
  }

  /** Un code-barres désigne un seul article : la caisse doit savoir lequel vendre. */
  private async assertBarcodeFree(trx: TenantTrx, barcode: string | null | undefined, exceptId?: string) {
    if (!barcode) return;
    const other = await trx.selectFrom('product').select(['code', 'name']).where('barcode', '=', barcode).$if(!!exceptId, (q) => q.where('id', '!=', exceptId!)).executeTakeFirst();
    if (other) throw conflict(`Le code-barres ${barcode} est déjà celui de ${other.code} « ${other.name} ».`, 'barcode_taken');
  }

  /** Code que recevra le prochain article (aperçu du formulaire, rien n'est réservé). */
  @Permission('products.read') @AllowWhenReadOnly()
  @Get('next-code')
  nextCodePreview(@Tenant() t: TenantInfo, @Query('siteId') siteId?: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const seq = await this.codeSequence(trx, siteId && isUuid(siteId) ? siteId : null);
      return { code: await peekNumber(trx, seq.docType, seq.prefix) };
    });
  }

  /** Séquence des codes : une par site (ART-S02-00001…), et une pour les articles communs (ART-00001…). */
  private async codeSequence(trx: TenantTrx, siteId: string | null | undefined) {
    const site = siteId ? await trx.selectFrom('site').select(['id', 'code']).where('id', '=', siteId).executeTakeFirst() : undefined;
    if (!site) return { docType: 'product', prefix: 'ART' };
    return { docType: `product_site_${site.id}`, prefix: `ART-${site.code.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SITE'}` };
  }

  @Permission('products.read') @AllowWhenReadOnly()
  @Get()
  async index(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), archived: z.enum(['false', 'true', 'all']).default('false') }), query);
    const rows = await this.db.tenant(t.ctx, (trx) => {
      let qb = trx.selectFrom('product').select(SELECT).orderBy('name').limit(1000);
      // Site affiché : ses articles et les articles communs à tous les sites.
      const scope = siteScope(t);
      if (scope) qb = qb.where((eb) => eb.or([eb('site_id', 'is', null), ...(scope.length ? [eb('site_id', 'in', scope)] : [])]));
      if (q.archived === 'false') qb = qb.where('archived_at', 'is', null);
      if (q.archived === 'true') qb = qb.where('archived_at', 'is not', null);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        qb = qb.where((eb) => eb.or([eb('name', 'ilike', like), eb('code', 'ilike', like), eb('description', 'ilike', like), eb('barcode', '=', q.q!)]));
      }
      return qb.execute();
    });
    // Unités de mesure (fonctionnalité activée) : autres unités de chaque article, pour les éditeurs.
    const units = t.features.has(UNITS) ? await this.db.tenant(t.ctx, (trx) => productUnits(trx)) : null;
    return rows.map((r) => ({ ...toNumbers(r), ...(units ? { units: units.get(r.id) ?? [] } : {}) }));
  }

  /** Autres unités d'un article (sac, carton…) avec leur coefficient vers l'unité de l'article. */
  @Permission('products.read') @RequireFeature(UNITS) @AllowWhenReadOnly()
  @Get(':id/units')
  units(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Article');
    return this.db.tenant(t.ctx, async (trx) => (await productUnits(trx, [id])).get(id) ?? []);
  }

  /**
   * Remplace les unités d'un article. Une unité retirée est archivée : les documents qui l'utilisent
   * gardent son nom et son coefficient. Le coefficient d'une unité existante ne change pas
   * (créez une nouvelle unité) : les lignes déjà saisies resteraient sinon fausses.
   */
  @Permission('products.update') @RequireFeature(UNITS) @HttpCode(200)
  @Put(':id/units')
  setUnits(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Article');
    const price = z.coerce.number().min(0, { message: 'Le prix ne peut pas être négatif' }).max(1e13).transform((v) => Math.round(v * 100) / 100).nullable().optional();
    const { units } = parse(z.object({ units: z.array(z.object({
      id: z.string().uuid().optional(),
      name: z.string().trim().min(1, { message: "Indiquez le nom de l'unité" }).max(20),
      factor: z.coerce.number().positive({ message: 'Le coefficient doit être positif' }).max(1e6),
      salePrice: price, purchasePrice: price,
    }).strict()).max(20) }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await trx.selectFrom('product').select(['id', 'name', 'unit', 'kind']).where('id', '=', id).executeTakeFirst();
      if (!p) throw notFound('Article');
      const names = units.map((u) => u.name.toLowerCase());
      if (new Set(names).size !== names.length) throw badRequest('Deux unités portent le même nom.', undefined, 'duplicate_unit');
      if (p.unit && names.includes(p.unit.toLowerCase())) throw badRequest(`« ${p.unit} » est déjà l'unité de l'article.`, undefined, 'duplicate_unit');
      const current = await trx.selectFrom('product_unit').selectAll().where('product_id', '=', id).execute();
      for (const u of units) {
        const prev = u.id ? current.find((c) => c.id === u.id) : current.find((c) => c.name.toLowerCase() === u.name.toLowerCase());
        if (prev && Number(prev.factor) !== u.factor && !u.id) throw conflict(`L'unité « ${u.name} » a déjà existé avec un autre coefficient : donnez-lui un autre nom.`, 'unit_factor_locked');
        if (prev && Number(prev.factor) !== u.factor) throw conflict(`Le coefficient de « ${prev.name} » ne peut pas changer : créez une nouvelle unité.`, 'unit_factor_locked');
        if (prev) {
          await trx.updateTable('product_unit').set({ name: u.name, sale_price: u.salePrice ?? null, purchase_price: u.purchasePrice ?? null, archived_at: null }).where('id', '=', prev.id).execute();
        } else {
          await trx.insertInto('product_unit').values({ company_id: t.companyId, product_id: id, name: u.name, factor: u.factor, sale_price: u.salePrice ?? null, purchase_price: u.purchasePrice ?? null }).execute();
        }
      }
      const kept = new Set(units.map((u) => (u.id ?? current.find((c) => c.name.toLowerCase() === u.name.toLowerCase())?.id)).filter(Boolean));
      for (const c of current) if (!kept.has(c.id) && !c.archived_at) await trx.updateTable('product_unit').set({ archived_at: new Date() }).where('id', '=', c.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'product.units_updated', entityType: 'product', entityId: id, data: { name: p.name, units: units.map((u) => `${u.name} = ${u.factor} ${p.unit ?? ''}`.trim()) } });
      return (await productUnits(trx, [id])).get(id) ?? [];
    });
  }

  @Permission('products.create')
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const { openingStock, ...input } = parse(ProductSchema.extend({ openingStock: OpeningStockSchema.optional() }), body);
    if (openingStock) {
      if (!t.permissions.has('stock.admin')) throw forbidden("Saisir un stock initial demande la permission d'administrer les stocks.");
      if ((input.kind ?? 'good') !== 'good') throw badRequest('Un service ne se stocke pas.', undefined, 'service_not_stockable');
    }
    return this.db.tenant(t.ctx, async (trx) => {
      await this.assertBarcodeFree(trx, input.barcode);
      // Site : celui choisi ; à défaut, celui de l'entrepôt qui reçoit le stock initial ; sans stock, tous les sites.
      const wh = openingStock ? await this.stock.warehouseFor(trx, t, openingStock.warehouseId, input.siteId ?? undefined) : null;
      // Une entreprise à un seul site n'a que des articles communs.
      const multiSite = Number((await trx.selectFrom('site').select((eb) => eb.fn.countAll<string>().as('n')).where('archived_at', 'is', null).executeTakeFirstOrThrow()).n) > 1;
      if (input.siteId === undefined) input.siteId = wh && multiSite ? wh.site_id : null;
      await this.assertSite(trx, t, input.siteId);
      if (wh && input.siteId && wh.site_id !== input.siteId) throw badRequest(`L'entrepôt « ${wh.name} » n'est pas sur le site choisi pour l'article.`, undefined, 'warehouse_other_site');
      if (openingStock) openingStock.warehouseId = wh!.id;
      const code = await this.nextCode(trx, t, input.siteId);
      const values: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(COLUMNS)) if ((input as any)[k] !== undefined) values[col] = (input as any)[k];
      // Les biens sont suivis en stock dès leur création ; les services ne le sont jamais.
      const p = await trx.insertInto('product').values({ ...values, code, company_id: t.companyId, created_by: t.ctx.userId, track_stock: (input.kind ?? 'good') === 'good' } as any).returning(SELECT).executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'product.created', entityType: 'product', entityId: p.id, data: { code, name: p.name, salePrice: Number(p.salePrice) } });
      if (openingStock) {
        // Coût unitaire non saisi : prix d'achat de l'article.
        await this.stock.recordOpening(trx, t, p.id, { ...openingStock, unitCost: openingStock.unitCost ?? input.purchasePrice ?? 0 });
        return toNumbers(await trx.selectFrom('product').select(SELECT).where('id', '=', p.id).executeTakeFirstOrThrow());
      }
      return toNumbers(p);
    });
  }

  @Permission('products.update')
  @Patch(':id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Article');
    const { openingStock, ...input } = parse(ProductSchema.partial().extend({ openingStock: OpeningStockSchema.optional() }), body);
    if (openingStock && !t.permissions.has('stock.admin')) throw forbidden("Saisir un stock initial demande la permission d'administrer les stocks.");
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await trx.selectFrom('product').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Article');
      if (before.archived_at) throw conflict('Cet article est archivé : restaurez-le avant de le modifier.', 'product_archived');
      await this.assertBarcodeFree(trx, input.barcode, id);
      if (input.siteId !== undefined) await this.assertSite(trx, t, input.siteId);
      const patch: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(COLUMNS)) if ((input as any)[k] !== undefined) patch[col] = (input as any)[k];
      // Un bien est suivi en stock, un service jamais : changer de type n'est possible qu'à stock vide.
      if (input.kind && input.kind !== before.kind) {
        if (Number(before.stock_qty) !== 0) throw conflict(`« ${before.name} » a encore ${Number(before.stock_qty).toLocaleString('fr-FR')} en stock : soldez-le par un inventaire avant de changer son type.`, 'stock_not_empty');
        patch.track_stock = input.kind === 'good';
      }
      if (Object.keys(patch).length) {
        const after = await trx.updateTable('product').set(patch).where('id', '=', id).returning(SELECT).executeTakeFirstOrThrow();
        const changes = Object.fromEntries(Object.keys(patch).filter((c) => String((before as any)[c]) !== String(patch[c])).map((c) => [c, { from: (before as any)[c], to: patch[c] }]));
        await this.audit.tenant(trx, t.ctx, { action: 'product.updated', entityType: 'product', entityId: id, data: { code: after.code, changes } });
      }
      // Stock initial saisi après coup (article encore sans mouvement) : même règle de site qu'à la création.
      if (openingStock) {
        if ((input.kind ?? before.kind) !== 'good') throw badRequest('Un service ne se stocke pas.', undefined, 'service_not_stockable');
        const site = input.siteId !== undefined ? input.siteId : before.site_id;
        const wh = await this.stock.warehouseFor(trx, t, openingStock.warehouseId, site ?? undefined);
        if (site && wh.site_id !== site) throw badRequest(`L'entrepôt « ${wh.name} » n'est pas sur le site de l'article.`, undefined, 'warehouse_other_site');
        const cost = input.purchasePrice !== undefined ? input.purchasePrice : before.purchase_price === null ? null : Number(before.purchase_price);
        await this.stock.recordOpening(trx, t, id, { ...openingStock, warehouseId: wh.id, unitCost: openingStock.unitCost ?? cost ?? 0 });
      }
      return toNumbers(await trx.selectFrom('product').select(SELECT).where('id', '=', id).executeTakeFirstOrThrow());
    });
  }

  /**
   * Suppression définitive d'un article jamais utilisé (créé par erreur, en double…). Dès qu'il figure dans un
   * devis, une facture, un achat, un bon ou un mouvement de stock (stock initial compris), il s'archive à la place :
   * l'historique et la comptabilité restent intacts.
   */
  @Permission('products.cancel') @HttpCode(200)
  @Delete(':id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Article');
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await trx.selectFrom('product').select(['id', 'code', 'name', 'stock_qty']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw notFound('Article');
      const used = async (table: 'sales_document_line' | 'purchase_document_line' | 'stock_movement' | 'stock_document_line') =>
        !!(await trx.selectFrom(table).select('product_id').where('product_id', '=', id).limit(1).executeTakeFirst());
      const uses = [
        (await used('sales_document_line')) && 'des devis ou factures',
        (await used('purchase_document_line')) && 'des achats',
        ((await used('stock_movement')) || (await used('stock_document_line'))) && 'des mouvements de stock',
      ].filter(Boolean) as string[];
      if (uses.length) {
        throw conflict(`« ${p.name} » figure déjà dans ${uses.join(', ').replace(/, ([^,]*)$/, ' et $1')} : il ne peut pas être supprimé sans effacer cet historique. Archivez-le : il disparaîtra des listes et des ventes.`, 'product_in_use');
      }
      await trx.deleteFrom('stock_level').where('product_id', '=', id).execute();
      await trx.deleteFrom('product').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'product.deleted', entityType: 'product', entityId: id, data: { code: p.code, name: p.name } });
      return { ok: true };
    });
  }

  @Permission('products.cancel') @HttpCode(200)
  @Post(':id/archive')
  archive(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.setArchived(t, id, true); }

  @Permission('products.cancel') @HttpCode(200)
  @Post(':id/restore')
  restore(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.setArchived(t, id, false); }

  private setArchived(t: TenantInfo, id: string, archived: boolean) {
    if (!isUuid(id)) throw notFound('Article');
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await trx.updateTable('product').set({ archived_at: archived ? new Date() : null })
        .where('id', '=', id).where('archived_at', archived ? 'is' : 'is not', null).returning(SELECT).executeTakeFirst();
      if (!p) throw notFound('Article');
      await this.audit.tenant(trx, t.ctx, { action: archived ? 'product.archived' : 'product.restored', entityType: 'product', entityId: id, data: { code: p.code, name: p.name } });
      return toNumbers(p);
    });
  }
}
