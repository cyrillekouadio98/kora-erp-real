'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { KIND_FOR_METHOD, money } from '@/lib/format';

/**
 * Choix du compte de trésorerie d'un paiement. Vide = compte par défaut du mode de paiement,
 * dont le nom est affiché pour que l'utilisateur sache où l'argent sera inscrit.
 */
export function AccountSelect({ method, value, onChange, label = 'Compte de trésorerie' }: { method: string; value: string; onChange: (v: string) => void; label?: string }) {
  const [accounts, setAccounts] = useState<any[] | null>(null);
  useEffect(() => { api('/company/treasury/accounts').then(setAccounts, () => setAccounts([])); }, []);
  if (accounts && !accounts.length) return null; // sans droit de lecture sur la trésorerie, le compte par défaut s'applique
  const fallback = accounts?.find((a) => a.kind === KIND_FOR_METHOD[method]);
  return (
    <label className="field">{label}
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{fallback ? `Par défaut : ${fallback.name}` : 'Compte par défaut'}</option>
        {accounts?.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance)})</option>)}
      </select>
    </label>
  );
}
