import { badRequest, forbidden } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import type { TenantTrx } from '../../db/database.service';

/** Fonctionnalité « Unités de mesure » (V1.2), activée entreprise par entreprise. */
export const UNITS = 'units';

export interface LineUnit { productId: string; name: string; factor: number; salePrice: number | null; purchasePrice: number | null }

/**
 * Unités choisies sur des lignes de vente ou d'achat : chacune doit être active et appartenir
 * à l'article de sa ligne. Sans unité choisie, la ligne reste dans l'unité de l'article (coefficient 1).
 */
export async function resolveLineUnits(trx: TenantTrx, t: TenantInfo, lines: { productId?: string | null; unitId?: string | null }[]) {
  const ids = [...new Set(lines.map((l) => l.unitId).filter((x): x is string => !!x))];
  const out = new Map<string, LineUnit>();
  if (!ids.length) return out;
  if (!t.features.has(UNITS)) throw forbidden("Les unités de mesure ne sont pas activées pour votre entreprise.", 'feature_not_enabled');
  if (!ids.every(isUuid)) throw badRequest('Unité inconnue.', undefined, 'unknown_unit');
  const rows = await trx.selectFrom('product_unit').select(['id', 'product_id', 'name', 'factor', 'sale_price', 'purchase_price']).where('id', 'in', ids).where('archived_at', 'is', null).execute();
  for (const r of rows) out.set(r.id, { productId: r.product_id, name: r.name, factor: Number(r.factor), salePrice: r.sale_price === null ? null : Number(r.sale_price), purchasePrice: r.purchase_price === null ? null : Number(r.purchase_price) });
  for (const l of lines) {
    if (l.unitId && out.get(l.unitId)?.productId !== l.productId) throw badRequest("L'unité choisie n'appartient pas à l'article de la ligne.", undefined, 'unknown_unit');
  }
  return out;
}

/** Unités actives des articles (pour les listes d'articles et les éditeurs). */
export async function productUnits(trx: TenantTrx, productIds?: string[]) {
  let q = trx.selectFrom('product_unit').select(['id', 'product_id', 'name', 'factor', 'sale_price', 'purchase_price']).where('archived_at', 'is', null);
  if (productIds) { if (!productIds.length) return new Map<string, unknown[]>(); q = q.where('product_id', 'in', productIds); }
  const rows = await q.orderBy('factor').execute();
  const by = new Map<string, { id: string; name: string; factor: number; salePrice: number | null; purchasePrice: number | null }[]>();
  for (const r of rows) {
    by.set(r.product_id, [...(by.get(r.product_id) ?? []), { id: r.id, name: r.name, factor: Number(r.factor), salePrice: r.sale_price === null ? null : Number(r.sale_price), purchasePrice: r.purchase_price === null ? null : Number(r.purchase_price) }]);
  }
  return by;
}
