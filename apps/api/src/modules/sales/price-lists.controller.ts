import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, notFound } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { customerTariff, PRICE_LISTS } from './price-lists';

const HeadSchema = z.object({
  name: z.string().trim().min(2, { message: 'Le nom doit contenir au moins 2 caractères' }).max(60),
  discountPct: z.coerce.number().min(0).max(99.99, { message: 'La remise doit être inférieure à 100 %' }).optional(),
  notes: z.string().trim().max(1000).transform((v) => v || null).nullable().optional(),
}).strict();
const ItemsSchema = z.object({ items: z.array(z.object({
  productId: z.string().uuid({ message: 'Article invalide' }),
  unitId: z.string().uuid({ message: 'Unité invalide' }).nullable().optional(),
  minQuantity: z.coerce.number().positive({ message: 'Le palier doit être positif' }).max(1e9).default(1),
  price: z.coerce.number().min(0, { message: 'Le prix ne peut pas être négatif' }).max(1e13).transform((v) => Math.round(v * 100) / 100),
}).strict()).max(2000) }).strict();

/** Listes de prix (grossiste, demi-gros, détail) et leurs prix par article et palier de quantité. */
@ApiTags('Listes de prix')
@Controller('company/price-lists')
export class PriceListsController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private async list(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Liste de prix');
    const l = await trx.selectFrom('price_list').selectAll().where('id', '=', id).executeTakeFirst();
    if (!l) throw notFound('Liste de prix');
    return l;
  }

  @Permission('sales.read') @RequireFeature(PRICE_LISTS) @AllowWhenReadOnly()
  @Get()
  index(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => (await trx.selectFrom('price_list as l')
      .select((eb) => ['l.id', 'l.name', 'l.discount_pct', 'l.notes', 'l.archived_at',
        eb.selectFrom('price_list_item as i').whereRef('i.list_id', '=', 'l.id').select(eb.fn.countAll<string>().as('n')).as('items'),
        eb.selectFrom('contact as c').whereRef('c.price_list_id', '=', 'l.id').where('c.archived_at', 'is', null).select(eb.fn.countAll<string>().as('n')).as('customers')])
      .orderBy(sql`l.archived_at is not null`).orderBy('l.name').execute())
      .map((l) => ({ id: l.id, name: l.name, discountPct: Number(l.discount_pct), notes: l.notes, archivedAt: l.archived_at, items: Number(l.items), customers: Number(l.customers) })));
  }

  @Permission('sales.read') @RequireFeature(PRICE_LISTS) @AllowWhenReadOnly()
  @Get(':id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.list(trx, id);
      const items = await trx.selectFrom('price_list_item as i').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'i.product_id').onRef('p.company_id', '=', 'i.company_id'))
        .leftJoin('product_unit as u', (j) => j.onRef('u.id', '=', 'i.unit_id').onRef('u.company_id', '=', 'i.company_id'))
        .select(['i.id', 'i.product_id', 'i.unit_id', 'i.min_quantity', 'i.price', 'p.code', 'p.name', 'p.unit', 'p.sale_price', 'u.name as unit_name', 'u.factor', 'u.sale_price as unit_sale_price'])
        .where('i.list_id', '=', id).orderBy('p.name').orderBy('i.unit_id').orderBy('i.min_quantity').execute();
      const customers = await trx.selectFrom('contact').select(['id', 'code', 'name']).where('price_list_id', '=', id).where('archived_at', 'is', null).orderBy('name').execute();
      return {
        id: l.id, name: l.name, discountPct: Number(l.discount_pct), notes: l.notes, archivedAt: l.archived_at, customers,
        items: items.map((i) => {
          const catalogue = i.unit_id ? (i.unit_sale_price !== null ? Number(i.unit_sale_price) : Math.round(Number(i.sale_price) * Number(i.factor))) : Number(i.sale_price);
          return { id: i.id, productId: i.product_id, unitId: i.unit_id, code: i.code, name: i.name, unit: i.unit_name ?? i.unit, minQuantity: Number(i.min_quantity), price: Number(i.price), catalogue };
        }),
      };
    });
  }

  /** Liste du client pour l'éditeur de documents ({ tariff: null } : prix des articles). */
  @Permission('sales.read') @RequireFeature(PRICE_LISTS) @AllowWhenReadOnly()
  @Get('for-contact/:contactId')
  forContact(@Tenant() t: TenantInfo, @Param('contactId') contactId: string) {
    if (!isUuid(contactId)) throw notFound('Contact');
    return this.db.tenant(t.ctx, async (trx) => ({ tariff: await customerTariff(trx, contactId) }));
  }

  @Permission('products.update') @RequireFeature(PRICE_LISTS)
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(HeadSchema, body);
    return this.db.tenant(t.ctx, async (trx) => {
      if (await trx.selectFrom('price_list').select('id').where('name', 'ilike', input.name).executeTakeFirst()) throw conflict(`Une liste s'appelle déjà « ${input.name} ».`, 'duplicate_name');
      const l = await trx.insertInto('price_list').values({ company_id: t.companyId, name: input.name, discount_pct: input.discountPct ?? 0, notes: input.notes ?? null }).returning('id').executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'price_list.created', entityType: 'price_list', entityId: l.id, data: input });
      return { id: l.id };
    });
  }

  @Permission('products.update') @RequireFeature(PRICE_LISTS)
  @Patch(':id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(HeadSchema.partial().extend({ archived: z.boolean().optional() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.list(trx, id);
      if (input.name && input.name.toLowerCase() !== l.name.toLowerCase() && await trx.selectFrom('price_list').select('id').where('name', 'ilike', input.name).executeTakeFirst()) {
        throw conflict(`Une liste s'appelle déjà « ${input.name} ».`, 'duplicate_name');
      }
      const patch: Record<string, unknown> = {};
      if (input.name) patch.name = input.name;
      if (input.discountPct !== undefined) patch.discount_pct = input.discountPct;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.archived !== undefined) {
        // Une liste archivée ne s'applique plus : ses clients reviennent aux prix des articles.
        patch.archived_at = input.archived ? new Date() : null;
        if (input.archived) await trx.updateTable('contact').set({ price_list_id: null }).where('price_list_id', '=', id).execute();
      }
      if (Object.keys(patch).length) await trx.updateTable('price_list').set(patch).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'price_list.updated', entityType: 'price_list', entityId: id, data: { name: l.name, ...input } });
      return { ok: true };
    });
  }

  /** Remplace les prix de la liste (un prix par article, unité et palier de quantité). */
  @Permission('products.update') @RequireFeature(PRICE_LISTS) @HttpCode(200)
  @Put(':id/items')
  setItems(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const { items } = parse(ItemsSchema, body);
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.list(trx, id);
      if (l.archived_at) throw conflict('Cette liste est archivée.', 'price_list_archived');
      const keys = items.map((i) => `${i.productId}|${i.unitId ?? ''}|${i.minQuantity}`);
      if (new Set(keys).size !== keys.length) throw badRequest('Deux prix portent sur le même article, la même unité et le même palier.', undefined, 'duplicate_tier');
      const productIds = [...new Set(items.map((i) => i.productId))];
      if (productIds.length) {
        const found = await trx.selectFrom('product').select('id').where('id', 'in', productIds).execute();
        if (found.length !== productIds.length) throw badRequest('Un ou plusieurs articles sont introuvables.', undefined, 'unknown_product');
      }
      const unitIds = [...new Set(items.map((i) => i.unitId).filter((x): x is string => !!x))];
      if (unitIds.length) {
        const us = await trx.selectFrom('product_unit').select(['id', 'product_id']).where('id', 'in', unitIds).execute();
        for (const i of items) if (i.unitId && us.find((u) => u.id === i.unitId)?.product_id !== i.productId) throw badRequest("Une unité n'appartient pas à l'article de sa ligne.", undefined, 'unknown_unit');
      }
      await trx.deleteFrom('price_list_item').where('list_id', '=', id).execute();
      if (items.length) {
        await trx.insertInto('price_list_item').values(items.map((i) => ({ company_id: t.companyId, list_id: id, product_id: i.productId, unit_id: i.unitId ?? null, min_quantity: i.minQuantity, price: i.price }))).execute();
      }
      await this.audit.tenant(trx, t.ctx, { action: 'price_list.items_updated', entityType: 'price_list', entityId: id, data: { name: l.name, items: items.length } });
      return { ok: true, items: items.length };
    });
  }
}
