import type { TenantTrx } from '../../db/database.service';

/** Fonctionnalité « Listes de prix » (V1.2), activée entreprise par entreprise. */
export const PRICE_LISTS = 'price_lists';

export interface Tariff { id: string; name: string; discountPct: number; items: { productId: string; unitId: string | null; minQuantity: number; price: number }[] }

/** Liste de prix active d'un client (null : prix des articles). */
export async function customerTariff(trx: TenantTrx, contactId: string | null | undefined): Promise<Tariff | null> {
  if (!contactId) return null;
  const c = await trx.selectFrom('contact as c').innerJoin('price_list as l', (j) => j.onRef('l.id', '=', 'c.price_list_id').onRef('l.company_id', '=', 'c.company_id'))
    .select(['l.id', 'l.name', 'l.discount_pct']).where('c.id', '=', contactId).where('l.archived_at', 'is', null).executeTakeFirst();
  if (!c) return null;
  const items = await trx.selectFrom('price_list_item').select(['product_id', 'unit_id', 'min_quantity', 'price']).where('list_id', '=', c.id).execute();
  return { id: c.id, name: c.name, discountPct: Number(c.discount_pct), items: items.map((i) => ({ productId: i.product_id, unitId: i.unit_id, minQuantity: Number(i.min_quantity), price: Number(i.price) })) };
}

/**
 * Prix d'un client pour une quantité : le palier le plus élevé atteint pour l'article (et l'unité),
 * sinon le prix catalogue diminué de la remise générale de la liste, sinon le prix catalogue.
 * Même règle que l'éditeur de documents de l'interface.
 */
export function tariffPrice(tariff: Tariff | null, productId: string, unitId: string | null, quantity: number, catalogue: number) {
  if (!tariff) return catalogue;
  const tiers = tariff.items.filter((i) => i.productId === productId && (i.unitId ?? null) === (unitId ?? null) && i.minQuantity <= quantity);
  if (tiers.length) return tiers.reduce((a, b) => (b.minQuantity > a.minQuantity ? b : a)).price;
  return tariff.discountPct ? Math.round(catalogue * (1 - tariff.discountPct / 100)) : catalogue;
}
