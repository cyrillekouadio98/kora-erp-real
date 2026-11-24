/**
 * Amortissement linéaire SYSCOHADA au prorata temporis (en jours, à partir de la mise en service) :
 * annuité = coût × 12 / durée en mois ; la dernière période solde exactement le coût.
 */
export interface AssetBasis { cost: number; inServiceDate: string; durationMonths: number }

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const yearDays = (y: number) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);

/** Dernier jour de la durée d'utilisation (mise en service + durée − 1 jour). */
export function endOfLife(a: AssetBasis) {
  const d = new Date(ms(a.inServiceDate));
  d.setUTCMonth(d.getUTCMonth() + a.durationMonths);
  return iso(d.getTime() - 86_400_000);
}

/** Amortissements cumulés au soir d'une date (francs entiers, plafonnés au coût). */
export function cumulative(a: AssetBasis, at: string) {
  if (at < a.inServiceDate) return 0;
  const end = endOfLife(a);
  if (at >= end) return Math.round(a.cost);
  const annual = (a.cost * 12) / a.durationMonths;
  let total = 0;
  for (let y = Number(a.inServiceDate.slice(0, 4)); y <= Number(at.slice(0, 4)); y++) {
    const from = Math.max(ms(a.inServiceDate), ms(`${y}-01-01`));
    const to = Math.min(ms(at), ms(`${y}-12-31`));
    if (to >= from) total += (annual * ((to - from) / 86_400_000 + 1)) / yearDays(y);
  }
  return Math.min(Math.round(a.cost), Math.round(total));
}

/** Plan d'amortissement par exercice civil : dotation, cumul et valeur nette en fin d'année. */
export function schedule(a: AssetBasis) {
  const rows: { year: number; dotation: number; cumulative: number; netValue: number }[] = [];
  const last = Number(endOfLife(a).slice(0, 4));
  let prev = 0;
  for (let y = Number(a.inServiceDate.slice(0, 4)); y <= last; y++) {
    const cum = cumulative(a, `${y}-12-31`);
    rows.push({ year: y, dotation: cum - prev, cumulative: cum, netValue: Math.round(a.cost) - cum });
    prev = cum;
  }
  return rows;
}
