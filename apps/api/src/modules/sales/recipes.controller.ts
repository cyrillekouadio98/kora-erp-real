import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, notFound } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';

const FEATURE = 'recipes';
const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Fiches techniques : ingrédients d'un plat pour une portion, coût de revient au coût moyen des ingrédients
 * et marge sur le prix de vente HT. La sortie de stock des ingrédients se fait à la vente (StockService).
 */
@ApiTags('Articles')
@Controller('company/recipes')
export class RecipesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private async recipes(trx: TenantTrx, productIds?: string[]) {
    let q = trx.selectFrom('product_recipe as r').innerJoin('product as i', (j) => j.onRef('i.id', '=', 'r.ingredient_id').onRef('i.company_id', '=', 'r.company_id'))
      .select(['r.product_id', 'r.ingredient_id', 'r.quantity', 'r.position', 'i.code', 'i.name', 'i.unit', 'i.avg_cost', 'i.purchase_price', 'i.stock_qty']);
    if (productIds) q = q.where('r.product_id', 'in', productIds);
    return q.orderBy('r.position').execute();
  }

  private out(p: { id: string; code: string; name: string; unit: string; sale_price: string; vat_rate: string; kind: string }, rows: Awaited<ReturnType<RecipesController['recipes']>>) {
    const ingredients = rows.filter((r) => r.product_id === p.id).map((r) => {
      // Coût unitaire : coût moyen du stock, à défaut le prix d'achat de la fiche article.
      const unitCost = n(r.avg_cost) || n(r.purchase_price);
      return { ingredientId: r.ingredient_id, code: r.code, name: r.name, unit: r.unit, quantity: n(r.quantity), unitCost, cost: round(n(r.quantity) * unitCost), stock: n(r.stock_qty),
        portions: Math.floor(n(r.stock_qty) / n(r.quantity) + 1e-9) };
    });
    const cost = round(ingredients.reduce((s, i) => s + i.cost, 0));
    const price = n(p.sale_price);
    return { productId: p.id, code: p.code, name: p.name, unit: p.unit, kind: p.kind, salePrice: price, vatRate: n(p.vat_rate), ingredients, cost,
      margin: round(price - cost), costRate: price ? Math.round((cost / price) * 1000) / 10 : null, portions: ingredients.length ? Math.min(...ingredients.map((i) => i.portions)) : null };
  }

  /** Plats qui ont une fiche, avec leur coût de revient, leur marge et les portions que permet le stock. */
  @Permission('products.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get()
  list(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.recipes(trx);
      const ids = [...new Set(rows.map((r) => r.product_id))];
      if (!ids.length) return [];
      const products = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'sale_price', 'vat_rate', 'kind']).where('id', 'in', ids).orderBy('name').execute();
      return products.map((p) => this.out(p, rows));
    });
  }

  @Permission('products.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get(':productId')
  get(@Tenant() t: TenantInfo, @Param('productId') productId: string) {
    if (!isUuid(productId)) throw notFound('Article');
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'sale_price', 'vat_rate', 'kind']).where('id', '=', productId).executeTakeFirst();
      if (!p) throw notFound('Article');
      return this.out(p, await this.recipes(trx, [productId]));
    });
  }

  /** Remplace la fiche du plat ; une liste vide la supprime (le plat ne sort plus d'ingrédients). */
  @Permission('products.update') @RequireFeature(FEATURE)
  @Put(':productId')
  save(@Tenant() t: TenantInfo, @Param('productId') productId: string, @Body() body: unknown) {
    if (!isUuid(productId)) throw notFound('Article');
    const input = parse(z.object({
      ingredients: z.array(z.object({
        ingredientId: z.string().uuid({ message: 'Ingrédient introuvable' }),
        quantity: z.coerce.number().positive({ message: 'La quantité doit être positive' }).max(1e6).transform((v) => Math.round(v * 10000) / 10000),
      }).strict()).max(60, { message: '60 ingrédients au plus' }),
    }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'sale_price', 'vat_rate', 'kind', 'archived_at']).where('id', '=', productId).executeTakeFirst();
      if (!p) throw notFound('Article');
      const ids = input.ingredients.map((i) => i.ingredientId);
      if (new Set(ids).size !== ids.length) throw badRequest('Chaque ingrédient ne figure qu’une fois sur la fiche : additionnez les quantités.', undefined, 'duplicate_ingredient');
      if (ids.includes(productId)) throw badRequest('Un plat ne peut pas être son propre ingrédient.', undefined, 'self_ingredient');
      if (ids.length) {
        if (await trx.selectFrom('product_recipe').select('product_id').where('ingredient_id', '=', productId).executeTakeFirst()) {
          throw badRequest(`« ${p.name} » est l'ingrédient d'une autre fiche : il ne peut pas avoir sa propre fiche.`, undefined, 'nested_recipe');
        }
        const ing = await trx.selectFrom('product').select(['id', 'name', 'kind', 'track_stock', 'archived_at']).where('id', 'in', ids).execute();
        for (const id of ids) {
          const i = ing.find((x) => x.id === id);
          if (!i || i.archived_at) throw badRequest('Un ingrédient est introuvable ou archivé.', undefined, 'unknown_ingredient');
          if (!i.track_stock) throw badRequest(`« ${i.name} » n'est pas suivi en stock : seul un bien stocké peut être un ingrédient.`, undefined, 'ingredient_not_stocked');
        }
        const nested = await trx.selectFrom('product_recipe').select('product_id').where('product_id', 'in', ids).executeTakeFirst();
        if (nested) throw badRequest('Un ingrédient a lui-même une fiche technique : choisissez ses propres ingrédients.', undefined, 'nested_recipe');
      }
      await trx.deleteFrom('product_recipe').where('product_id', '=', productId).execute();
      if (ids.length) await trx.insertInto('product_recipe').values(input.ingredients.map((i, k) => ({ company_id: t.companyId, product_id: productId, ingredient_id: i.ingredientId, quantity: i.quantity, position: k }))).execute();
      await this.audit.tenant(trx, t.ctx, { action: ids.length ? 'recipe.saved' : 'recipe.deleted', entityType: 'product', entityId: productId, data: { name: p.name, ingredients: ids.length } });
      return this.out(p, await this.recipes(trx, [productId]));
    });
  }
}
