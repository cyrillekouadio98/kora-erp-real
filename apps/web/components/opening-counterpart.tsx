import { OPENING_COUNTERPARTS } from '@/lib/format';

/** Liste « Origine des fonds » : contrepartie comptable d'un solde d'ouverture (stock initial, caisse, banque). */
export function CounterpartSelect({ value, onChange, label = 'Origine (contrepartie comptable)', exclude }: { value: string; onChange: (v: string) => void; label?: string; exclude?: string }) {
  return (
    <label className="field">{label}
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {OPENING_COUNTERPARTS.filter(([c]) => c !== exclude).map(([c, name, hint]) => <option key={c} value={c}>{c} · {name} — {hint}</option>)}
      </select>
    </label>
  );
}
