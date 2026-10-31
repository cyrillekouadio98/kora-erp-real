'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

/** Entrepôts, dépôts et magasins : chacun a son propre stock ; le coût moyen reste commun. */
export default function WarehousesPage() {
  const { can, ctx } = useSession();
  const admin = can('stock.admin') && !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [modal, setModal] = useState<any>(null);
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => api('/company/stock/warehouses').then(setRows), []);
  useEffect(() => { load(); }, [load]);
  const open = (m: any) => { setError(''); setModal(m); };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setModal({ ...modal, [k]: e.target.value });
  const patch = (id: string, body: any) => run(async () => { await api(`/company/stock/warehouses/${id}`, { method: 'PATCH', body }); await load(); });
  const save = () => run(async () => {
    const body = { name: modal.name, address: modal.address || null };
    if (modal.id) await api(`/company/stock/warehouses/${modal.id}`, { method: 'PATCH', body });
    else await api('/company/stock/warehouses', { body: { ...body, code: modal.code } });
    setModal(null); await load();
  });

  return (
    <>
      <div className="page-head"><h1>Entrepôts</h1>
        {admin && <button className="btn primary" onClick={() => open({ code: '', name: '', address: '' })}>+ Nouvel entrepôt</button>}</div>
      <p className="small muted" style={{ margin: 0 }}>Dépôt, magasin, boutique, véhicule de livraison… Chaque vente sort de l'entrepôt choisi sur la facture, chaque achat entre dans celui choisi sur la facture fournisseur ; sans choix, c'est l'entrepôt par défaut.</p>
      <Alert>{!modal && error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Nom</th><th>Adresse</th><th className="n">Articles en stock</th><th className="n">Valeur</th><th></th></tr></thead>
        <tbody>
          {rows?.map((w) => (
            <tr key={w.id} style={{ opacity: w.archived ? 0.6 : 1 }}>
              <td><b>{w.code}</b></td>
              <td>{w.name} {w.isDefault && <Pill tone="ok">Par défaut</Pill>}{w.archived && <Pill>Archivé</Pill>}</td>
              <td className="small">{w.address ?? ''}</td>
              <td className="n">{w.products}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(w.value)}</td>
              <td className="n">{admin && <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                {!w.archived && <button className="btn sm" onClick={() => open({ id: w.id, code: w.code, name: w.name, address: w.address ?? '' })}>Modifier</button>}
                {!w.archived && !w.isDefault && <button className="btn sm" disabled={busy} onClick={() => patch(w.id, { isDefault: true })}>Par défaut</button>}
                {!w.isDefault && <button className="btn sm" disabled={busy} onClick={() => patch(w.id, { archived: !w.archived })}>{w.archived ? 'Réactiver' : 'Archiver'}</button>}
              </div>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: 'min(460px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{modal.id ? `Entrepôt ${modal.code}` : 'Nouvel entrepôt'}</h2>
            <Alert>{error}</Alert>
            {!modal.id && <Field label="Code (court, unique)" required maxLength={12} pattern="[A-Za-z0-9\-]{1,12}" placeholder="Ex. MAG2" value={modal.code} onChange={set('code')} />}
            <Field label="Nom" required minLength={2} placeholder="Ex. Magasin de Treichville" value={modal.name} onChange={set('name')} />
            <Field label="Adresse (facultatif)" value={modal.address} onChange={set('address')} />
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
