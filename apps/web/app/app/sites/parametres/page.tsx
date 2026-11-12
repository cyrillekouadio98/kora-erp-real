'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const EMPTY = { name: '', code: '', city: '', address: '', phone: '', withCash: true };

/** Sites de l'entreprise : magasins, succursales, dépôts. Chacun a ses entrepôts, ses caisses et ses employés. */
export default function SitesSettings() {
  const { can, ctx, refresh } = useSession();
  const admin = can('settings.admin') && !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => api('/company/sites').then(setRows), []);
  useEffect(() => { load(); }, [load]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setEdit({ ...edit, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const patch = (s: any, body: object, done: string) => run(async () => { await api(`/company/sites/${s.id}`, { method: 'PATCH', body }); setNotice(done); await load(); await refresh(); });

  const save = () => run(async () => {
    const body = { name: edit.name, code: edit.code || null, city: edit.city || null, address: edit.address || null, phone: edit.phone || null };
    if (edit.id) await api(`/company/sites/${edit.id}`, { method: 'PATCH', body: { ...body, code: edit.code || undefined } });
    else {
      const s = await api('/company/sites', { body: { ...body, withCash: edit.withCash } });
      setNotice(`Site « ${s.name} » créé (${s.code}), avec son entrepôt${edit.withCash ? ' et sa caisse' : ''}. Choisissez-le dans l'en-tête pour travailler dessus.`);
    }
    setEdit(null); await load(); await refresh();
  });

  return (
    <>
      <div className="page-head"><h1>Sites et magasins</h1>
        {admin && <button className="btn primary" onClick={() => { setError(''); setEdit({ ...EMPTY }); }}>Nouveau site</button>}</div>
      <Alert kind="ok">{notice}</Alert>
      <Alert>{!edit && error}</Alert>
      <p className="small muted" style={{ margin: 0 }}>
        Un site est un magasin, une succursale ou un dépôt. Il a ses entrepôts, ses caisses et comptes, ses employés ; chaque vente, achat et document de stock lui appartient.
        Le site choisi dans l'en-tête filtre toute l'application. Les clients, fournisseurs, articles et la comptabilité sont communs. Pour déplacer de la marchandise d'un site à un autre,
        faites un <Link href="/app/stocks/operations">bon de transfert</Link> ; pour déplacer de l'argent, un <Link href="/app/tresorerie">virement entre comptes</Link>.
        Dans <Link href="/app/utilisateurs">Utilisateurs</Link>, limitez un gérant ou un caissier à son site.
      </p>
      <div className="vg-grid">
        {rows?.map((s) => (
          <div key={s.id} className="card site-card" style={s.archived ? { opacity: 0.6 } : undefined}>
            <header><div><b>{s.name}</b> {s.isDefault && <Pill tone="ok">Principal</Pill>} {s.archived && <Pill>Archivé</Pill>}
              <div className="small muted">{[s.code, s.city, s.phone].filter(Boolean).join(' · ')}</div>{s.address && <div className="small muted">{s.address}</div>}</div></header>
            <dl className="site-kpis">
              <dt><Link href="/app/stocks/entrepots">Entrepôts</Link></dt><dd>{s.warehouses}</dd>
              <dt><Link href="/app/tresorerie">Caisses et comptes</Link></dt><dd>{s.accounts}</dd>
              <dt><Link href="/app/employes">Employés</Link></dt><dd>{s.employees}</dd>
            </dl>
            {admin && <div className="row" style={{ gap: 6 }}>
              {!s.archived && <button className="btn sm" onClick={() => { setError(''); setEdit({ ...EMPTY, ...s, city: s.city ?? '', address: s.address ?? '', phone: s.phone ?? '' }); }}>Modifier</button>}
              {!s.archived && !s.isDefault && <button className="btn sm" disabled={busy} onClick={() => patch(s, { isDefault: true }, `« ${s.name} » est maintenant le site principal.`)}>Site principal</button>}
              {!s.isDefault && <button className={`btn sm${s.archived ? '' : ' danger'}`} disabled={busy}
                onClick={() => patch(s, { archived: !s.archived }, s.archived ? `« ${s.name} » est de nouveau actif.` : `« ${s.name} » est archivé.`)}>{s.archived ? 'Réactiver' : 'Archiver'}</button>}
            </div>}
          </div>))}
      </div>

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `Modifier ${edit.name}` : 'Nouveau site'}</h2>
            <Alert>{error}</Alert>
            <div className="grid2">
              <Field label="Nom" required minLength={2} placeholder="Magasin Cocody" value={edit.name} onChange={set('name')} />
              <Field label="Code (vide : automatique)" placeholder="S02" maxLength={20} value={edit.code} onChange={set('code')} />
              <Field label="Ville" value={edit.city} onChange={set('city')} />
              <Field label="Téléphone" type="tel" value={edit.phone} onChange={set('phone')} />
            </div>
            <Field label="Adresse" value={edit.address} onChange={set('address')} />
            {!edit.id && <>
              <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={edit.withCash} onChange={set('withCash')} /> Créer aussi la caisse du site</label>
              <p className="small muted" style={{ margin: 0 }}>Un entrepôt « Dépôt {edit.name || '…'} » est créé avec le site. Vous pourrez ajouter d'autres entrepôts, une banque ou un compte mobile money depuis Stocks et Trésorerie, en choisissant ce site dans l'en-tête.</p>
            </>}
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
