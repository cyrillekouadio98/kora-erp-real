/**
 * Jours ouvrables ivoiriens : du lundi au samedi, hors jours fériés à date fixe et fêtes liées à Pâques.
 * Les fêtes musulmanes (Ramadan, Tabaski, Maouloud, Nuit du destin) dépendent d'une annonce officielle
 * chaque année : elles ne sont pas déduites automatiquement.
 */
const FIXED_HOLIDAYS = ['01-01', '05-01', '08-07', '08-15', '11-01', '11-15', '12-25'];

/** Dimanche de Pâques (algorithme grégorien de Meeus/Jones/Butcher). */
export function easter(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

export function publicHolidays(year: number): Set<string> {
  const e = easter(year);
  return new Set([...FIXED_HOLIDAYS.map((md) => `${year}-${md}`), iso(plus(e, 1)), iso(plus(e, 39)), iso(plus(e, 50))]);
}

/** Nombre de jours ouvrables entre deux dates incluses. */
export function workingDays(start: string, end: string): number {
  let count = 0;
  const holidays = new Map<number, Set<string>>();
  for (let d = new Date(`${start}T00:00:00Z`); iso(d) <= end; d = plus(d, 1)) {
    const y = d.getUTCFullYear();
    if (!holidays.has(y)) holidays.set(y, publicHolidays(y));
    if (d.getUTCDay() !== 0 && !holidays.get(y)!.has(iso(d))) count++;
  }
  return count;
}

/** Mois de service complets entre deux dates (base de l'acquisition des congés). */
export function fullMonths(from: string, to: string): number {
  if (to < from) return 0;
  const [y1, m1, d1] = from.split('-').map(Number), [y2, m2, d2] = to.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}
