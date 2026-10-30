'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Graphiques du tableau de bord, dessinés en SVG.
 * Règles suivies : un seul axe, traits fins (barres ≤ 24 px, bouts arrondis côté valeur,
 * carrés côté ligne de base, 2 px d'écart), légende dès deux séries, texte jamais dans la
 * couleur des données, infobulle au survol et au clavier, vue en tableau pour chaque graphique.
 */

const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
export const fcfa = (n: number) => `${full.format(Math.round(n))} FCFA`;
const axisLabel = (n: number) => (Math.abs(n) >= 10_000 ? compact.format(n) : full.format(n));

/** « 2026-10 » → « oct. » (avec l'année sur janvier et sur le premier mois affiché). */
export function monthTick(p: string, first: boolean) {
  const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1, 1));
  const m = d.toLocaleDateString('fr-FR', { month: 'short', timeZone: 'UTC' });
  return first || p.endsWith('-01') ? `${m} ${p.slice(2, 4)}` : m;
}
export const monthLong = (p: string) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Graduations « rondes » de 0 au maximum (et au minimum s'il est négatif). */
function niceScale(min: number, max: number, ticks = 4) {
  const lo = Math.min(0, min), hi = Math.max(0, max);
  if (lo === hi) return { lo: 0, hi: 1, steps: [0, 1] };
  const raw = (hi - lo) / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const steps = [];
  for (let v = a; v <= b + step / 2; v += step) steps.push(Math.round(v));
  return { lo: a, hi: b, steps };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Rectangle à bout arrondi côté valeur, carré sur la ligne de base. */
function barPath(x: number, w: number, yBase: number, yVal: number) {
  const h = Math.abs(yBase - yVal);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (yVal < yBase) return `M${x},${yBase} V${yVal + r} Q${x},${yVal} ${x + r},${yVal} H${x + w - r} Q${x + w},${yVal} ${x + w},${yVal + r} V${yBase} Z`;
  return `M${x},${yBase} V${yVal - r} Q${x},${yVal} ${x + r},${yVal} H${x + w - r} Q${x + w},${yVal} ${x + w},${yVal - r} V${yBase} Z`;
}

export interface Series { key: string; label: string; color: string; values: (number | null)[] }

/** Enveloppe commune : titre, légende, bascule graphique / tableau. */
export function ChartCard({ title, subtitle, legend, table, children }: {
  title: string; subtitle?: string; legend?: { label: string; color: string; kind: 'box' | 'line' }[];
  table: { head: string[]; rows: (string | number)[][] }; children: React.ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="card" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignContent: 'start', gap: 10 }}>
      <header style={{ marginBottom: 0 }}>
        <div><h2>{title}</h2>{subtitle && <div className="small muted">{subtitle}</div>}</div>
        <button className="btn sm" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>{asTable ? 'Graphique' : 'Tableau'}</button>
      </header>
      {legend && legend.length > 1 && !asTable && (
        <div className="legend">{legend.map((l) => <span key={l.label}><span className={l.kind === 'box' ? 'sw' : 'ln'} style={{ background: l.color }} />{l.label}</span>)}</div>
      )}
      {asTable ? (
        <div className="table-wrap"><table>
          <thead><tr>{table.head.map((h, i) => <th key={h} className={i ? 'n' : undefined}>{h}</th>)}</tr></thead>
          <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'n' : undefined}>{c}</td>)}</tr>)}</tbody>
        </table></div>
      ) : children}
    </figure>
  );
}

/** Colonnes groupées par mois (une à trois séries comparées sur un même axe). */
export function ColumnChart({ categories, series, height = 220 }: { categories: string[]; series: Series[]; height?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 8, right: 4, bottom: 24, left: 44 };
  const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const { lo, hi, steps } = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const y = (v: number) => m.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const band = plotW / categories.length;
  const barW = Math.max(3, Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length));
  const groupW = barW * series.length + 2 * (series.length - 1);
  const every = band < 34 ? 2 : 1;
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(' et ') + ' par mois'}>
        {steps.map((s) => <g key={s}><line x1={m.left} x2={width - m.right} y1={y(s)} y2={y(s)} stroke={s === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'} strokeWidth={1} />
          <text x={m.left - 6} y={y(s) + 4} textAnchor="end">{axisLabel(s)}</text></g>)}
        {categories.map((c, i) => {
          const x0 = m.left + i * band + (band - groupW) / 2;
          return <g key={c}>
            {hover === i && <rect x={m.left + i * band} y={m.top} width={band} height={plotH} fill="var(--surface-2)" opacity={0.6} />}
            {series.map((s, k) => s.values[i] ? <path key={s.key} d={barPath(x0 + k * (barW + 2), barW, y(0), y(s.values[i]!))} fill={s.color} /> : null)}
            {i % every === 0 && <text x={m.left + i * band + band / 2} y={height - 6} textAnchor="middle">{monthTick(c, i === 0)}</text>}
            {/* Zone de survol : toute la colonne du mois, pas seulement les barres */}
            <rect x={m.left + i * band} y={m.top} width={band} height={plotH} fill="transparent" tabIndex={0}
              aria-label={`${monthLong(c)} : ${series.map((s) => `${s.label} ${fcfa(s.values[i] ?? 0)}`).join(', ')}`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
          </g>;
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(width - 244, Math.max(0, m.left + hover * band + band / 2 - 120)), top: 0 }}>
          <div className="t">{monthLong(categories[hover])}</div>
          {series.map((s) => <div key={s.key} className="r"><span><span className="k" style={{ background: s.color }} />{s.label}</span><b>{fcfa(s.values[hover] ?? 0)}</b></div>)}
        </div>
      )}
    </div>
  );
}

/** Courbe d'une seule série (fond léger), avec réticule qui se cale sur le mois le plus proche. */
export function LineChart({ categories, values, color, label, height = 200 }: { categories: string[]; values: (number | null)[]; color: string; label: string; height?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 12, right: 12, bottom: 24, left: 44 };
  const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
  const known = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  const { lo, hi, steps } = niceScale(Math.min(0, ...known.map((p) => p.v)), Math.max(0, ...known.map((p) => p.v)));
  const x = (i: number) => m.left + (categories.length === 1 ? plotW / 2 : (i / (categories.length - 1)) * plotW);
  const y = (v: number) => m.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const line = known.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.v)}`).join(' ');
  const area = known.length ? `${line} L${x(known[known.length - 1].i)},${y(0)} L${x(known[0].i)},${y(0)} Z` : '';
  const last = known[known.length - 1];
  const every = plotW / categories.length < 34 ? 2 : 1;
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const px = e.clientX - (e.currentTarget.ownerSVGElement!.getBoundingClientRect().left);
    const i = Math.round(((px - m.left) / plotW) * (categories.length - 1));
    setHover(Math.max(0, Math.min(categories.length - 1, i)));
  };
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={label}>
        {steps.map((s) => <g key={s}><line x1={m.left} x2={width - m.right} y1={y(s)} y2={y(s)} stroke={s === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'} strokeWidth={1} />
          <text x={m.left - 6} y={y(s) + 4} textAnchor="end">{axisLabel(s)}</text></g>)}
        {categories.map((c, i) => i % every === 0 && <text key={c} x={x(i)} y={height - 6} textAnchor="middle">{monthTick(c, i === 0)}</text>)}
        <path d={area} fill={color} opacity={0.1} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + plotH} stroke="var(--chart-axis)" strokeWidth={1} />}
        {[hover !== null && values[hover] !== null ? hover : null, last?.i].filter((i): i is number => i !== null && i !== undefined).map((i) => (
          <circle key={i} cx={x(i)} cy={y(values[i]!)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />))}
        <rect x={m.left} y={m.top} width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} />
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(width - 244, Math.max(0, x(hover) - 120)), top: 0 }}>
          <div className="t">fin {monthLong(categories[hover])}</div>
          <div className="r"><span><span className="k" style={{ background: color }} />{label}</span><b>{values[hover] === null ? '—' : fcfa(values[hover]!)}</b></div>
        </div>
      )}
    </div>
  );
}

/** Barres horizontales classées, une seule teinte, valeur au bout de la barre. */
export function RankedBars({ items }: { items: { label: string; value: number; detail?: string }[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="ranked">
      {items.map((i) => (
        <div key={i.label} className="row2" title={`${i.label} : ${fcfa(i.value)}`}>
          <div className="lbl"><span>{i.label}{i.detail && <span className="muted small"> · {i.detail}</span>}</span><b>{fcfa(i.value)}</b></div>
          <div className="track"><div className="bar" style={{ width: `${(i.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
