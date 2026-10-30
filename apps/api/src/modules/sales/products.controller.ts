import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';

/** Taux de TVA applicables en Côte d'Ivoire : normal, réduit, exonéré. */
export const VAT_RATES = [18, 9, 0];

const money = z.coerce.number().min(0, { message: 'Le montant ne peut pas être négatif' }).max(1e13);
const ProductSchema = z.object({
  kind: z.enum(['good', 'service']).optional(),
  name: z.string().trim().min(2, { message: 'Le nom doit contenir au moins 2 caractères' }).max(160),
  code: z.string().trim().max(30).regex(/^[A-Za-z0-9._-]*$/, { message: 'Le code ne contient que lettres, chiffres, points, tirets' }).transform((v) => v.toUpperCase() || null).nullable().optional(),
  description: z.string().trim().max(2000).transform((v) => v || null).nullable().optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  salePrice: money,
  purchasePrice: money.nullable().optional(),
  vatRate: z.coerce.number().refine((v) => VAT_RATES.includes(v), { message: 'Taux de TVA : 18 %, 9 % ou 0 %' }),
}).strict();

const COLUMNS = { kind: 'kind', name: 'name', code: 'code', description: 'description', unit: 'unit', salePrice: 'sale_price', purchasePrice: 'purchase_price', vatRate: 'vat_rate' } as const;
const SELECT = ['id', 'code', 'kind', 'name', 'description', 'unit', 'sale_price as salePrice', 'purchase_price as purchasePrice', 'vat_rate as vatRate', 'archived_at as archivedAt'] as const;

const toNumbers = <T extends { salePrice: string; purchasePrice: string | null; vatRate: string }>(p: T) =>
  ({ ...p, salePrice: Number(p.salePrice), purchasePrice: p.purchasePrice === null ? null : Number(p.purchasePrice), vatRate: Number(p.vatRate) });

@ApiTags('Articles')
@Controller('company/products')
export class ProductsController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private async resolveCode(trx: TenantTrx, t: TenantInfo, code: string | null | undefined, exceptId?: string) {
    const taken = async (c: string) => !!(await trx.selectFrom('product').select('id').where('code', '=', c)
      .$if(!!exceptId, (qb) => qb.where('id', '!=', exceptId!)).executeTakeFirst());
    if (code) {
      if (await taken(code)) throw conflict(`Le code ${code} est déjà utilisé par un autre article.`, 'product_code_taken');
      return code;
    }
    for (;;) {
      const next = await nextNumber(trx, t.companyId, 'product', 'ART');
      if (!(await taken(next))) return next;
    }
  }

  @Permission('products.read') @AllowWhenReadOnly()
  @Get()
  async index(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), archived: z.enum(['false', 'true', 'all']).default('false') }), query);
    const rows = await this.db.tenant(t.ctx, (trx) => {
      let qb = trx.selectFrom('product').select(SELECT).orderBy('name').limit(1000);
      if (q.archived === 'false') qb = qb.where('archived_at', 'is', null);
      if (q.archived === 'true') qb = qb.where('archived_at', 'is not', null);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        qb = qb.where((eb) => eb.or([eb('name', 'ilike', like), eb('code', 'ilike', like), eb('description', 'ilike', like)]));
      }
      return qb.execute();
    });
    return rows.map(toNumbers);
  }

  @Permission('products.create')
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(ProductSchema, body);
    return this.db.tenant(t.ctx, async (trx) => {
      const code = await this.resolveCode(trx, t, input.code);
      const values: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(COLUMNS)) if ((input as any)[k] !== undefined) values[col] = (input as any)[k];
      const p = await trx.insertInto('product').values({ ...values, code, company_id: t.companyId, created_by: t.ctx.userId } as any).returning(SELECT).executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'product.created', entityType: 'product', entityId: p.id, data: { code, name: p.name, salePrice: Number(p.salePrice) } });
      return toNumbers(p);
    });
  }

  @Permission('products.update')
  @Patch(':id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Article');
    const input = parse(ProductSchema.partial(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await trx.selectFrom('product').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Article');
      if (before.archived_at) throw conflict('Cet article est archivé : restaurez-le avant de le modifier.', 'product_archived');
      const patch: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(COLUMNS)) if ((input as any)[k] !== undefined) patch[col] = (input as any)[k];
      if (input.code !== undefined) patch.code = await this.resolveCode(trx, t, input.code, id);
      if (!Object.keys(patch).length) return toNumbers(await trx.selectFrom('product').select(SELECT).where('id', '=', id).executeTakeFirstOrThrow());
      const after = await trx.updateTable('product').set(patch).where('id', '=', id).returning(SELECT).executeTakeFirstOrThrow();
      const changes = Object.fromEntries(Object.keys(patch).filter((c) => String((before as any)[c]) !== String(patch[c])).map((c) => [c, { from: (before as any)[c], to: patch[c] }]));
      await this.audit.tenant(trx, t.ctx, { action: 'product.updated', entityType: 'product', entityId: id, data: { code: after.code, changes } });
      return toNumbers(after);
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
