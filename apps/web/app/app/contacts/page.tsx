'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const KIND: Record<string, [string, 'ok' | 'warn' | 'mute']> = { customer: ['Client', 'ok'], supplier: ['Fournisseur', 'warn'], both: ['Client et fournisseur', 'mute'] };
const EMPTY = { kind: 'customer', legalType: 'company', name: '', code: '', taxId: '', rccm: '', email: '', phone: '', address: '', city: '', countryCode: 'CI', paymentTermsDays: 0, notes: '' };
const FIELDS = Object.keys(EMPTY) as (keyof typeof EMPTY)[];

export default function ContactsPage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [archived, setArchived] = useState('false');
  const [edit, setEdit] = useState<any>(null);
  const { busy, error, run } = useAction();
  const params = new URLSearchParams({ archived, ...(q.trim() ? { q: q.trim() } : {}), ...(kind ? { kind } : {}) }).toString();

  const load = useCallback(() => run(async () => setRows(await api(`/company/contacts?${params}`))), [params]); // eslint-disable-line
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);

  const save = () => run(async () => {
    const body = Object.fromEntries(FIELDS.map((k) => [k, edit[k]]));
    if (edit.id) await api(`/company/contacts/${edit.id}`, { method: 'PATCH', body }); else await api('/company/contacts', { body });
    setEdit(null); await load();
  });
  const toggleArchive = (c: any) => run(async () => { await api(`/company/contacts/${c.id}/${c.archivedAt ? 'restore' : 'archive'}`, { body: {} }); await load(); });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <>
      <div className="page-head">
        <h1>Clients et fournisseurs</h1>
        <div className="row">
          {can('contacts.export') && <a className="btn" href={`/api/company/contacts/export?${params}`}>Exporter (CSV)</a>}
          {can('contacts.create') && writable && <button className="btn primary" onClick={() => setEdit({ ...EMPTY })}>Nouveau contact</button>}
        </div>
      </div>
      <Alert>{!edit && error}</Alert>
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder="Nom, code, téléphone, NCC, ville…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="field" style={{ flex: 1, minWidth: 130 }}>Type
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Tous</option><option value="customer">Clients</option><option value="supplier">Fournisseurs</option></select>
        </label>
        <label className="field" style={{ flex: 1, minWidth: 130 }}>Affichage
          <select className="input" value={archived} onChange={(e) => setArchived(e.target.value)}><option value="false">Actifs</option><option value="true">Archivés</option><option value="all">Tous</option></select>
        </label>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Nom</th><th>Type</th><th>Téléphone</th><th>Ville</th><th className="n">Délai de paiement</th><th></th></tr></thead>
        <tbody>
          {rows?.map((c) => (
            <tr key={c.id} style={c.archivedAt ? { opacity: .6 } : undefined}>
              <td style={{ whiteSpace: 'nowrap' }}><code className="k">{c.code}</code></td>
              <td><b>{c.name}</b>{c.archivedAt && <> <Pill>Archivé</Pill></>}<div className="small muted">{[c.email, c.taxId && `NCC ${c.taxId}`].filter(Boolean).join(' · ')}</div></td>
              <td><Pill tone={KIND[c.kind][1]}>{KIND[c.kind][0]}</Pill></td>
              <td style={{ whiteSpace: 'nowrap' }}>{c.phone ?? '—'}</td>
              <td>{c.city ?? '—'}</td>
              <td className="n">{c.paymentTermsDays ? `${c.paymentTermsDays} j` : 'Comptant'}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {writable && can('contacts.update') && !c.archivedAt && <button className="btn sm" onClick={() => setEdit(Object.fromEntries(FIELDS.map((k) => [k, c[k] ?? EMPTY[k]]).concat([['id', c.id]])))}>Modifier</button>}
                {writable && can('contacts.cancel') && <button className={`btn sm${c.archivedAt ? '' : ' danger'}`} disabled={busy} onClick={() => toggleArchive(c)}>{c.archivedAt ? 'Restaurer' : 'Archiver'}</button>}
              </div></td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
            {q || kind || archived !== 'false' ? 'Aucun contact ne correspond à ces critères.' : 'Aucun contact pour l’instant. Ajoutez vos premiers clients et fournisseurs.'}
          </td></tr>}
        </tbody>
      </table></div>
      {rows && rows.length > 0 && <p className="small muted" style={{ margin: 0 }}>{rows.length} contact{rows.length > 1 ? 's' : ''}</p>}

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `Modifier ${edit.code}` : 'Nouveau contact'}</h2>
            <Alert>{error}</Alert>
            <div className="grid2">
              <label className="field">Type de tiers
                <select className="input" value={edit.kind} onChange={set('kind')}><option value="customer">Client</option><option value="supplier">Fournisseur</option><option value="both">Client et fournisseur</option></select>
              </label>
              <label className="field">Forme
                <select className="input" value={edit.legalType} onChange={set('legalType')}><option value="company">Entreprise</option><option value="individual">Particulier</option></select>
              </label>
              <Field label="Nom ou raison sociale" required minLength={2} value={edit.name} onChange={set('name')} />
              <Field label="Code (laisser vide : automatique)" value={edit.code} onChange={set('code')} placeholder={edit.kind === 'supplier' ? 'FRS-00001' : edit.kind === 'both' ? 'TIE-00001' : 'CLI-00001'} />
              <Field label="Téléphone" type="tel" value={edit.phone} onChange={set('phone')} placeholder="+225 07 00 00 00 00" />
              <Field label="E-mail" type="email" value={edit.email} onChange={set('email')} />
              <Field label="N° compte contribuable (NCC)" value={edit.taxId} onChange={set('taxId')} />
              <Field label="RCCM" value={edit.rccm} onChange={set('rccm')} placeholder="CI-ABJ-…" />
              <Field label="Adresse" value={edit.address} onChange={set('address')} />
              <Field label="Ville" value={edit.city} onChange={set('city')} />
              <Field label="Pays (code ISO)" maxLength={2} value={edit.countryCode} onChange={set('countryCode')} />
              <Field label="Délai de paiement (jours, 0 = comptant)" type="number" min={0} max={365} value={edit.paymentTermsDays} onChange={set('paymentTermsDays')} />
            </div>
            <label className="field">Notes<textarea className="input" rows={3} value={edit.notes} onChange={set('notes')} /></label>
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
