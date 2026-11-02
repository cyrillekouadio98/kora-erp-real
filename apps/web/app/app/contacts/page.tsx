'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { money } from '@/lib/format';
import { Alert, Field, hue, Pill, shrinkImage, useAction } from '@/components/ui';

const KIND: Record<string, [string, 'ok' | 'warn' | 'mute']> = { customer: ['Client', 'ok'], supplier: ['Fournisseur', 'warn'], both: ['Client et fournisseur', 'mute'] };
const EMPTY = { kind: 'customer', legalType: 'company', name: '', code: '', taxId: '', rccm: '', email: '', phone: '', address: '', city: '', countryCode: 'CI', paymentTermsDays: 0, notes: '' };
const FIELDS = Object.keys(EMPTY) as (keyof typeof EMPTY)[];
const hueVar = (text: string) => ({ '--h': hue(text) } as React.CSSProperties);

/** Logo de l'entreprise ou photo du particulier ; à défaut, un immeuble ou les initiales. */
function Logo({ c, src = c.logo && `/api${c.logo}` }: { c: any; src?: string | null }) {
  if (src) return <img className="vg-photo" src={src} alt="" loading="lazy" style={{ objectFit: c.legalType === 'company' ? 'contain' : 'cover', background: '#fff' }} />;
  if (c.legalType === 'company') return (
    <div className="vg-photo vg-initials" style={hueVar(c.name || '?')} aria-hidden>
      <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor"><path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5h3a1 1 0 0 1 1 1v11h-6v-4h-4v4H4Zm3-15v2h2V6H7Zm4 0v2h2V6h-2Zm-4 4v2h2v-2H7Zm4 0v2h2v-2h-2Zm-4 4v2h2v-2H7Zm4 0v2h2v-2h-2Zm6-1v2h1v-2h-1Z" /></svg>
    </div>);
  const words = (c.name || '?').trim().split(/\s+/);
  return <div className="vg-photo vg-initials" style={hueVar(c.name || '?')} aria-hidden>{`${words[0][0] ?? ''}${words.length > 1 ? words[words.length - 1][0] : ''}`.toUpperCase()}</div>;
}

/** Vignette d'un contact : logo, coordonnées, et ce qu'il doit ou ce qu'on lui doit. */
function ContactCard({ c, onOpen, action }: { c: any; onOpen?: () => void; action?: React.ReactNode }) {
  const buys = c.kind !== 'supplier', sells = c.kind !== 'customer';
  const body = <>
    <Logo c={c} />
    <div className="vg-body">
      <b>{c.name}</b>
      <span className="muted">{[c.legalType === 'company' ? 'Entreprise' : 'Particulier', c.city].filter(Boolean).join(' · ')}</span>
      {c.email && <span className="muted" title={c.email}>✉ {c.email}</span>}
      {c.phone && <span className="muted">☎ {c.phone}</span>}
      <div className="vg-tags">
        <span className="vg-badge">{c.code}</span>
        <Pill tone={KIND[c.kind][1]}>{KIND[c.kind][0]}</Pill>
        {c.archivedAt && <Pill>Archivé</Pill>}
      </div>
      <div className="vg-stats">
        {buys && <span title="Factures clients émises et montant restant à encaisser"><span>{c.salesInvoices ?? 0} facture{c.salesInvoices > 1 ? 's' : ''} client</span>{c.receivable ? <b className="due">À recevoir {money(c.receivable)}</b> : <span>Rien à recevoir</span>}</span>}
        {sells && <span title="Factures fournisseur reçues et montant restant à payer"><span>{c.purchaseInvoices ?? 0} facture{c.purchaseInvoices > 1 ? 's' : ''} fourn.</span>{c.payable ? <b className="due">À payer {money(c.payable)}</b> : <span>Rien à payer</span>}</span>}
        {action}
      </div>
    </div>
  </>;
  const cls = `vg-card${c.archivedAt ? ' left' : ''}`;
  return onOpen ? <button type="button" className={cls} onClick={onOpen}>{body}</button> : <div className={cls}>{body}</div>;
}

export default function ContactsPage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [archived, setArchived] = useState('false');
  const [edit, setEdit] = useState<any>(null);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<'cards' | 'list'>(() => { try { return localStorage.getItem('kora.contacts.vue') === 'list' ? 'list' : 'cards'; } catch { return 'cards'; } });
  const pickView = (v: 'cards' | 'list') => { setView(v); try { localStorage.setItem('kora.contacts.vue', v); } catch { /* sans stockage */ } };
  const { busy, error, run } = useAction();
  const params = new URLSearchParams({ archived, ...(q.trim() ? { q: q.trim() } : {}), ...(kind ? { kind } : {}) }).toString();

  const load = useCallback(() => run(async () => setRows(await api(`/company/contacts?${params}`))), [params]); // eslint-disable-line
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);

  const save = () => run(async () => {
    const body = Object.fromEntries(FIELDS.map((k) => [k, edit[k]]));
    const saved = edit.id ? await api(`/company/contacts/${edit.id}`, { method: 'PATCH', body }) : await api('/company/contacts', { body });
    if (logo !== undefined) await api(`/company/contacts/${saved.id}/logo`, { method: 'PUT', body: { logo } });
    setEdit(null); await load();
  });
  const toggleArchive = (c: any) => run(async () => { await api(`/company/contacts/${c.id}/${c.archivedAt ? 'restore' : 'archive'}`, { body: {} }); await load(); });
  const open = (c: any) => { setLogo(undefined); setEdit(c.id ? Object.fromEntries(FIELDS.map((k) => [k, c[k] ?? EMPTY[k]]).concat([['id', c.id], ['logo', c.logo]])) : c); };
  const editable = writable && can('contacts.update');
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <>
      <div className="page-head">
        <h1>Clients et fournisseurs</h1>
        <div className="row">
          {can('contacts.export') && <a className="btn" href={`/api/company/contacts/export?${params}`}>Exporter (CSV)</a>}
          {can('contacts.create') && writable && <button className="btn primary" onClick={() => open({ ...EMPTY })}>Nouveau contact</button>}
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
        <div className="seg" style={{ alignSelf: 'flex-end' }} role="group" aria-label="Affichage des contacts">
          <button type="button" aria-pressed={view === 'cards'} onClick={() => pickView('cards')}>Vignettes</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => pickView('list')}>Liste</button></div>
      </div>
      {view === 'cards' ? (
        <div className="vg-grid">
          {rows?.map((c) => <ContactCard key={c.id} c={c} onOpen={editable && !c.archivedAt ? () => open(c) : undefined}
            action={c.archivedAt && writable && can('contacts.cancel') ? <button className="btn sm" disabled={busy} onClick={() => toggleArchive(c)}>Restaurer</button> : undefined} />)}
          {rows && !rows.length && <p className="muted">{q || kind || archived !== 'false' ? 'Aucun contact ne correspond à ces critères.' : 'Aucun contact pour l’instant. Ajoutez vos premiers clients et fournisseurs.'}</p>}
        </div>
      ) : <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Nom</th><th>Type</th><th>Téléphone</th><th>Ville</th><th className="n">Délai de paiement</th><th></th></tr></thead>
        <tbody>
          {rows?.map((c) => (
            <tr key={c.id} style={c.archivedAt ? { opacity: .6 } : undefined}>
              <td style={{ whiteSpace: 'nowrap' }}><code className="k">{c.code}</code></td>
              <td><div className="row" style={{ flexWrap: 'nowrap' }}><span className="vg-mini"><Logo c={c} /></span><div><b>{c.name}</b>{c.archivedAt && <> <Pill>Archivé</Pill></>}<div className="small muted">{[c.email, c.taxId && `NCC ${c.taxId}`].filter(Boolean).join(' · ')}</div></div></div></td>
              <td><Pill tone={KIND[c.kind][1]}>{KIND[c.kind][0]}</Pill></td>
              <td style={{ whiteSpace: 'nowrap' }}>{c.phone ?? '—'}</td>
              <td>{c.city ?? '—'}</td>
              <td className="n">{c.paymentTermsDays ? `${c.paymentTermsDays} j` : 'Comptant'}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {writable && can('contacts.update') && !c.archivedAt && <button className="btn sm" onClick={() => open(c)}>Modifier</button>}
                {writable && can('contacts.cancel') && <button className={`btn sm${c.archivedAt ? '' : ' danger'}`} disabled={busy} onClick={() => toggleArchive(c)}>{c.archivedAt ? 'Restaurer' : 'Archiver'}</button>}
              </div></td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
            {q || kind || archived !== 'false' ? 'Aucun contact ne correspond à ces critères.' : 'Aucun contact pour l’instant. Ajoutez vos premiers clients et fournisseurs.'}
          </td></tr>}
        </tbody>
      </table></div>}
      {rows && rows.length > 0 && <p className="small muted" style={{ margin: 0 }}>{rows.length} contact{rows.length > 1 ? 's' : ''}</p>}

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `Modifier ${edit.code}` : 'Nouveau contact'}</h2>
            <Alert>{error}</Alert>
            <div className="vg-avatar-edit">
              <Logo c={edit} src={logo === undefined ? edit.logo && `/api${edit.logo}` : logo} />
              <div className="row">
                <label className="btn sm">{(logo === undefined ? edit.logo : logo) ? 'Changer' : 'Ajouter'} {edit.legalType === 'company' ? 'le logo' : 'la photo'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(ev) => { const f = ev.target.files?.[0]; if (f) run(async () => setLogo(await shrinkImage(f))); ev.target.value = ''; }} /></label>
                {(logo === undefined ? edit.logo : logo) && <button type="button" className="btn sm" onClick={() => setLogo(null)}>Retirer</button>}
              </div>
            </div>
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
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button>
              {edit.id && can('contacts.cancel') && <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => run(async () => { await api(`/company/contacts/${edit.id}/archive`, { body: {} }); setEdit(null); await load(); })}>Archiver</button>}</div>
          </form>
        </div>
      )}
    </>
  );
}
