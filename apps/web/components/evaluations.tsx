'use client';
import { RATINGS } from '@/lib/format';

const fmt = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Note de 1 à 5 en étoiles ; cliquable quand onChange est donné (un second clic sur la même note l'efface). */
export function Stars({ value, onChange, size = 'md', label }: { value: number | null; onChange?: (v: number | null) => void; size?: 'sm' | 'md'; label?: string }) {
  const v = value ?? 0;
  if (!onChange) {
    return <span className={`ev-stars ${size}`} role="img" aria-label={value ? `${fmt(value)} sur 5` : 'Non noté'}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={v >= i - 0.25 ? 'on' : v >= i - 0.75 ? 'half' : ''}>★</span>)}
    </span>;
  }
  return <span className={`ev-stars ${size} edit`} role="radiogroup" aria-label={label}>
    {[1, 2, 3, 4, 5].map((i) => (
      <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${i} sur 5`} title={['', 'Insuffisant', 'À améliorer', 'Satisfaisant', 'Très bien', 'Excellent'][i]}
        className={v >= i ? 'on' : ''} onClick={() => onChange(value === i ? null : i)}>★</button>))}
  </span>;
}

/** Note chiffrée et appréciation : « 4,25 / 5 · Excellent ». */
export function Score({ score, rating }: { score: number | null; rating: string | null }) {
  if (score === null) return <span className="muted small">Non notée</span>;
  return <span className="ev-score"><Stars value={score} size="sm" /> <b>{fmt(score)}</b><span className="muted">/5</span> <span className={`ev-rating r-${rating}`}>{RATINGS[rating!]}</span></span>;
}

/** Répartition des appréciations : barre empilée, de « Insuffisant » à « Excellent ». */
export function Distribution({ d, legend }: { d: Record<string, number>; legend?: boolean }) {
  const total = Object.values(d).reduce((s, n) => s + n, 0);
  return <div className="ev-dist">
    <div className="ev-bar" role="img" aria-label={Object.keys(RATINGS).map((k) => `${RATINGS[k]} : ${d[k] ?? 0}`).join(', ')}>
      {total ? Object.keys(RATINGS).filter((k) => d[k]).map((k) => <span key={k} className={`r-${k}`} style={{ flexGrow: d[k] }} title={`${RATINGS[k]} : ${d[k]}`} />) : <span className="empty" />}
    </div>
    {legend && <div className="ev-legend">{Object.keys(RATINGS).map((k) => <span key={k}><i className={`r-${k}`} />{RATINGS[k]} <b>{d[k] ?? 0}</b></span>)}</div>}
  </div>;
}

export const scoreText = fmt;
