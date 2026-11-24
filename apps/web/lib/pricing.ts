/** Liste de prix d'un client, telle que renvoyée par l'API (fonctionnalité « Listes de prix »). */
export interface Tariff { id: string; name: string; discountPct: number; items: { productId: string; unitId: string | null; minQuantity: number; price: number }[] }

/**
 * Prix d'un client pour une quantité : palier le plus élevé atteint pour l'article et l'unité,
 * sinon prix catalogue moins la remise générale de la liste, sinon prix catalogue.
 * Même règle que l'API (modules/sales/price-lists.ts).
 */
export function tariffPrice(tariff: Tariff | null, productId: string, unitId: string | null, quantity: number, catalogue: number) {
  if (!tariff) return catalogue;
  const tiers = tariff.items.filter((i) => i.productId === productId && (i.unitId ?? null) === (unitId ?? null) && i.minQuantity <= quantity);
  if (tiers.length) return tiers.reduce((a, b) => (b.minQuantity > a.minQuantity ? b : a)).price;
  return tariff.discountPct ? Math.round(catalogue * (1 - tariff.discountPct / 100)) : catalogue;
}
