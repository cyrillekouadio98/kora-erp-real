'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { date, money, SETUP_STATUS } from '@/lib/format';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const COMPANY: [string, string, string?][] = [
  ['name', 'Raison sociale'], ['legalForm', 'Forme juridique', 'SARL, SA, SAS…'], ['rccm', 'RCCM'], ['taxId', 'Numéro de compte contribuable (NCC)'],
  ['taxRegime', 'Régime fiscal', 'Réel normal, réel simplifié…'], ['address', 'Adresse'], ['city', 'Ville'], ['phone', 'Téléphone'], ['email', 'E-mail de contact'],
];
const KINDS: Record<string, string> = { cash: 'Caisse', bank: 'Banque', mobile_money: 'Mobile money' };
const MODULES: Record<string, string> = { contacts: 'Contacts', sales: 'Ventes et stocks', cash: 'Trésorerie', purchases: 'Achats', bank: 'Banque', accounting: 'Comptabilité', hr: 'Ressources humaines', payroll: 'Paie' };
const SECTIONS: [string, string][] = [['company', 'Fiche'], ['subscription', 'Formule'], ['sites', 'Sites'], ['treasury', 'Trésorerie'], ['people', 'Utilisateurs'], ['handover', 'Remise au client']];

/** Paramétrage d'une entreprise préparée pour un client, puis remise. */
export default function PreparationPage() {
  const { id } = useParams<{ id: string }>();
  const [s, setS] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [tab, setTab] = useState('company');
  const [company, setCompany] = useState<any>({});
  const [plan, setPlan] = useState<any>({});
  const [people, setPeople] = useState<any>({ owner: { name: '', email: '' }, users: [], notes: '' });
  const [accounts, setAccounts] = useState<Record<string, any>>({});
  const [sites, setSites] = useState<Record<string, any>>({});
  const [newSite, setNewSite] = useState({ name: '', city: '', withCash: true });
  const [newAccount, setNewAccount] = useState({ kind: 'mobile_money', name: '', bankName: '', accountNumber: '', siteId: '' });
  const [links, setLinks] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run, setError } = useAction();

  const show = (x: any) => {
    setS(x);
    if (x.company && x.status === 'preparing') {
      setCompany(Object.fromEntries(COMPANY.map(([k]) => [k, x.company[k] ?? ''])));
      setPlan({ planCode: x.subscription.planCode, billingCycle: x.subscription.billingCycle, trialDays: x.subscription.trialDays });
      setPeople({ owner: x.owner ?? { name: '', email: '' }, users: x.users.map((u: any) => ({ ...u, siteId: u.siteIds?.[0] ?? '' })), notes: x.notes ?? '' });
      setAccounts(Object.fromEntries(x.accounts.map((a: any) => [a.id, { name: a.name, bankName: a.bankName ?? '', accountNumber: a.accountNumber ?? '' }])));
      setSites(Object.fromEntries(x.sites.map((t: any) => [t.id, { name: t.name, city: t.city ?? '', address: t.address ?? '', phone: t.phone ?? '' }])));
    }
  };
  const load = useCallback(() => run(async () => show(await api(`/platform/setup/${id}`))), [id]); // eslint-disable-line
  useEffect(() => { load(); api('/plans').then((p) => setPlans(p.filter((x: any) => x.priceMonthly > 0)), () => {}); }, [load]);
  const go = (k: string) => { setTab(k); setNotice(''); setError(''); };
  const save = (path: string, body: object, done: string, method = 'PATCH') => run(async () => { show(await api(`/platform/setup/${id}${path}`, { method, body })); setNotice(done); });
  if (!s) return <><div className="page-head"><h1>Préparation</h1></div><Alert>{error || null}</Alert></>;

  const head = (
    <div className="page-head">
      <div><div className="small"><Link href="/console/preparation">Préparer une entreprise</Link></div>
        <h1>{s.company.name} <Pill tone={SETUP_STATUS[s.status][1]}>{SETUP_STATUS[s.status][0]}</Pill></h1>
        <div className="small muted">Formule {s.subscription.planName} · {s.subscription.billingCycle === 'yearly' ? 'annuelle' : 'mensuelle'}</div></div>
    </div>
  );

  // Remise faite : plus aucun accès au contenu, seulement l'invitation du propriétaire.
  if (s.status !== 'preparing') {
    return (
      <>
        {head}
        <Alert kind="ok">{notice}</Alert><Alert>{error}</Alert>
        <div className="card">
          <p style={{ margin: 0 }}>{s.status === 'active'
            ? <>Le propriétaire <b>{s.owner?.name}</b> ({s.owner?.email}) a pris la main sur l&apos;entreprise.</>
            : <>Entreprise remise le {date(s.handedOverAt)}. Une invitation de propriétaire a été envoyée à <b>{s.owner?.name}</b> ({s.owner?.email}).</>}</p>
          <p className="small muted">L&apos;entreprise appartient désormais au client : la console n&apos;en voit plus le contenu. Pour l&apos;aider ensuite, demandez-lui un accès depuis la liste des clients.</p>
          {s.status === 'handed_over' && <button className="btn" disabled={busy} onClick={() => run(async () => { const r = await api(`/platform/setup/${id}/resend-owner`, { body: {} }); setLinks({ owner: r, users: [] }); setNotice(`Nouvelle invitation envoyée à ${r.email} ; l'ancien lien ne fonctionne plus.`); })}>Renvoyer l&apos;invitation du propriétaire</button>}
        </div>
        {links && <InviteLinks links={links} />}
      </>
    );
  }

  const seats = (people.owner.email ? 1 : 0) + people.users.length;
  const quota = s.subscription.userQuota;
  return (
    <>
      {head}
      <div className="prep-layout">
        <div className="prep-main">
          <div className="seg prep-tabs" role="tablist">{SECTIONS.map(([k, l]) => {
            const item = s.checklist.find((c: any) => c.key === (k === 'people' ? 'owner' : k));
            return <button key={k} type="button" role="tab" aria-pressed={tab === k} onClick={() => go(k)}>{item?.done ? '✓ ' : ''}{l}</button>;
          })}</div>
          <Alert kind="ok">{notice}</Alert><Alert>{error}</Alert>

          {tab === 'company' && <form className="card form" onSubmit={(e) => { e.preventDefault(); save('/company', company, 'Fiche enregistrée.'); }}>
            <header><h2>Fiche de l&apos;entreprise</h2><span className="small muted">Elle figure sur les devis et les factures</span></header>
            <div className="grid2">{COMPANY.map(([k, label, ph]) => <Field key={k} label={label} placeholder={ph} required={k === 'name'} type={k === 'email' ? 'email' : 'text'} value={company[k] ?? ''} onChange={(e) => setCompany({ ...company, [k]: e.target.value })} />)}</div>
            <div><button className="btn primary" disabled={busy}>Enregistrer</button></div>
          </form>}

          {tab === 'subscription' && <form className="card form" onSubmit={(e) => { e.preventDefault(); save('/subscription', { ...plan, trialDays: Number(plan.trialDays) }, 'Formule enregistrée.'); }}>
            <header><h2>Formule</h2></header>
            <div className="prep-plans">{plans.map((p) => (
              <label key={p.code} className={`card prep-plan${plan.planCode === p.code ? ' on' : ''}`}>
                <input type="radio" name="plan" checked={plan.planCode === p.code} onChange={() => setPlan({ ...plan, planCode: p.code })} />
                <b>{p.name}</b><span>{money(p.priceMonthly)} / mois</span>
                <span className="small muted">{p.entitlements.quotas.users === null ? 'Utilisateurs illimités' : `${p.entitlements.quotas.users} utilisateurs`}</span>
                <span className="small muted">{p.entitlements.modules.map((m: string) => MODULES[m] ?? m).join(', ')}</span>
              </label>))}</div>
            <div className="grid2">
              <label className="field">Facturation<select className="input" value={plan.billingCycle} onChange={(e) => setPlan({ ...plan, billingCycle: e.target.value })}>
                <option value="monthly">Mensuelle</option><option value="yearly">Annuelle (2 mois offerts)</option></select></label>
              <Field label="Durée de l'essai (jours)" type="number" min={0} max={90} value={plan.trialDays} onChange={(e) => setPlan({ ...plan, trialDays: e.target.value })} />
            </div>
            <p className="small muted" style={{ margin: 0 }}>L&apos;essai démarre le jour de la remise au client, pas aujourd&apos;hui.</p>
            <div><button className="btn primary" disabled={busy}>Enregistrer</button></div>
          </form>}

          {tab === 'sites' && <div className="card">
            <header><h2>Sites</h2><span className="small muted">Magasins, succursales, dépôts : chacun a son entrepôt et sa caisse</span></header>
            {s.sites.map((t: any) => <form key={t.id} className="prep-row" onSubmit={(e) => { e.preventDefault(); save(`/sites/${t.id}`, sites[t.id], `Site « ${sites[t.id].name} » enregistré.`); }}>
              <span className="small muted prep-code">{t.code}{t.isDefault && <div>principal</div>}</span>
              {(['name', 'city', 'address', 'phone'] as const).map((k) => <input key={k} className="input" aria-label={{ name: 'Nom', city: 'Ville', address: 'Adresse', phone: 'Téléphone' }[k]}
                placeholder={{ name: 'Nom', city: 'Ville', address: 'Adresse', phone: 'Téléphone' }[k]} required={k === 'name'} value={sites[t.id]?.[k] ?? ''} onChange={(e) => setSites({ ...sites, [t.id]: { ...sites[t.id], [k]: e.target.value } })} />)}
              <button className="btn sm" disabled={busy}>Enregistrer</button>
            </form>)}
            <form className="prep-add" onSubmit={(e) => { e.preventDefault(); save('/sites', newSite, `Site « ${newSite.name} » ajouté, avec son entrepôt${newSite.withCash ? ' et sa caisse' : ''}.`, 'POST'); setNewSite({ name: '', city: '', withCash: true }); }}>
              <input className="input" placeholder="Nouveau site" aria-label="Nom du nouveau site" required minLength={2} value={newSite.name} onChange={(e) => setNewSite({ ...newSite, name: e.target.value })} />
              <input className="input" placeholder="Ville" aria-label="Ville du nouveau site" value={newSite.city} onChange={(e) => setNewSite({ ...newSite, city: e.target.value })} />
              <label className="row small"><input type="checkbox" checked={newSite.withCash} onChange={(e) => setNewSite({ ...newSite, withCash: e.target.checked })} /> avec sa caisse</label>
              <button className="btn" disabled={busy}>Ajouter le site</button>
            </form>
          </div>}

          {tab === 'treasury' && <div className="card">
            <header><h2>Comptes de trésorerie</h2><span className="small muted">Caisses, banques et mobile money, chacun rattaché à un site</span></header>
            {s.accounts.map((a: any) => <form key={a.id} className="prep-row" onSubmit={(e) => { e.preventDefault(); save(`/accounts/${a.id}`, { name: accounts[a.id].name, ...(a.kind === 'bank' ? { bankName: accounts[a.id].bankName, accountNumber: accounts[a.id].accountNumber } : {}) }, `Compte « ${accounts[a.id].name} » enregistré.`); }}>
              <span className="small muted prep-code">{KINDS[a.kind]}<div>{s.sites.find((t: any) => t.id === a.siteId)?.name}</div></span>
              <input className={`input${a.kind === 'bank' ? '' : ' prep-span4'}`} aria-label="Nom du compte" required minLength={2} value={accounts[a.id]?.name ?? ''} onChange={(e) => setAccounts({ ...accounts, [a.id]: { ...accounts[a.id], name: e.target.value } })} />
              {a.kind === 'bank' ? <>
                <input className="input" placeholder="Banque" aria-label="Banque" value={accounts[a.id]?.bankName ?? ''} onChange={(e) => setAccounts({ ...accounts, [a.id]: { ...accounts[a.id], bankName: e.target.value } })} />
                <input className="input prep-wide" placeholder="Numéro de compte (RIB)" aria-label="Numéro de compte" value={accounts[a.id]?.accountNumber ?? ''} onChange={(e) => setAccounts({ ...accounts, [a.id]: { ...accounts[a.id], accountNumber: e.target.value } })} />
              </> : null}
              <button className="btn sm" disabled={busy}>Enregistrer</button>
            </form>)}
            <form className="prep-add" onSubmit={(e) => {
              e.preventDefault();
              save('/accounts', { kind: newAccount.kind, name: newAccount.name, siteId: newAccount.siteId || null, ...(newAccount.kind === 'bank' ? { bankName: newAccount.bankName, accountNumber: newAccount.accountNumber } : {}) }, `Compte « ${newAccount.name} » ajouté.`, 'POST');
              setNewAccount({ kind: 'mobile_money', name: '', bankName: '', accountNumber: '', siteId: '' });
            }}>
              <select className="input" aria-label="Type de compte" value={newAccount.kind} onChange={(e) => setNewAccount({ ...newAccount, kind: e.target.value })}>{Object.entries(KINDS).filter(([k]) => k !== 'bank' || s.subscription.modules.includes('bank')).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input className="input" placeholder="Nom du compte" aria-label="Nom du nouveau compte" required minLength={2} value={newAccount.name} onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })} />
              {newAccount.kind === 'bank' && <input className="input" placeholder="Banque" aria-label="Banque du nouveau compte" value={newAccount.bankName} onChange={(e) => setNewAccount({ ...newAccount, bankName: e.target.value })} />}
              {s.sites.length > 1 && <select className="input" aria-label="Site" value={newAccount.siteId} onChange={(e) => setNewAccount({ ...newAccount, siteId: e.target.value })}>
                <option value="">Site principal</option>{s.sites.filter((t: any) => !t.isDefault).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
              <button className="btn" disabled={busy}>Ajouter le compte</button>
            </form>
          </div>}

          {tab === 'people' && <form className="card form" onSubmit={(e) => {
            e.preventDefault();
            save('/people', { owner: people.owner.email ? people.owner : null, notes: people.notes, users: people.users.map((u: any) => ({ name: u.name, email: u.email, roleKey: u.roleKey, siteIds: u.siteId ? [u.siteId] : null })) }, 'Utilisateurs enregistrés. Rien n’est envoyé avant la remise.', 'PUT');
          }}>
            <header><h2>Propriétaire</h2><span className="small muted">Il recevra l&apos;entreprise et en aura tous les droits</span></header>
            <div className="grid2">
              <Field label="Nom" required minLength={2} value={people.owner.name} onChange={(e) => setPeople({ ...people, owner: { ...people.owner, name: e.target.value } })} />
              <Field label="E-mail" type="email" required value={people.owner.email} onChange={(e) => setPeople({ ...people, owner: { ...people.owner, email: e.target.value } })} />
            </div>
            <header><h2>Collaborateurs</h2><span className="small muted" style={quota !== null && seats > quota ? { color: 'var(--crit)' } : undefined}>{seats}{quota !== null ? ` / ${quota}` : ''} utilisateur(s), propriétaire compris</span></header>
            {people.users.map((u: any, i: number) => {
              const set = (patch: object) => setPeople({ ...people, users: people.users.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
              return <div key={i} className="prep-row">
                <input className="input" placeholder="Nom" aria-label="Nom du collaborateur" required minLength={2} value={u.name} onChange={(e) => set({ name: e.target.value })} />
                <input className="input" type="email" placeholder="E-mail" aria-label="E-mail du collaborateur" required value={u.email} onChange={(e) => set({ email: e.target.value })} />
                <select className="input" aria-label="Rôle" value={u.roleKey} onChange={(e) => set({ roleKey: e.target.value })}>{s.roles.map((r: any) => <option key={r.key} value={r.key}>{r.name}</option>)}</select>
                {s.sites.length > 1 ? <select className="input" aria-label="Site" value={u.siteId} onChange={(e) => set({ siteId: e.target.value })}>
                  <option value="">Tous les sites</option>{s.sites.map((t: any) => <option key={t.id} value={t.id}>{t.name} seulement</option>)}</select> : <span />}
                <button type="button" className="btn sm" onClick={() => setPeople({ ...people, users: people.users.filter((_: any, j: number) => j !== i) })}>Retirer</button>
              </div>;
            })}
            <div><button type="button" className="btn sm" onClick={() => setPeople({ ...people, users: [...people.users, { name: '', email: '', roleKey: s.roles.find((r: any) => r.key === 'sales_rep')?.key ?? s.roles[0].key, siteId: '' }] })}>Ajouter un collaborateur</button></div>
            <label className="field">Notes internes (non envoyées au client)<textarea className="input" rows={2} value={people.notes} onChange={(e) => setPeople({ ...people, notes: e.target.value })} /></label>
            <div><button className="btn primary" disabled={busy}>Enregistrer</button></div>
          </form>}

          {tab === 'handover' && <div className="card">
            <header><h2>Remise au client</h2></header>
            <ul className="prep-check">{s.checklist.map((c: any) => <li key={c.key} className={c.done ? 'done' : c.required ? 'missing' : ''}>
              <span aria-hidden>{c.done ? '✓' : c.required ? '!' : '—'}</span><span><b>{c.label}</b>{c.required && !c.done ? ' · obligatoire' : ''}<div className="small muted">{c.hint}</div></span></li>)}</ul>
            <p className="small">À la remise : le propriétaire{s.users.length ? ` et ${s.users.length} collaborateur(s)` : ''} reçoivent leur invitation par e-mail (valable 30 jours), l&apos;essai de {s.subscription.trialDays} jours démarre, et la console perd l&apos;accès au contenu de l&apos;entreprise.</p>
            <button className="btn primary" disabled={busy || !s.canHandOver} onClick={() => {
              if (confirm(`Remettre « ${s.company.name} » à ${s.owner.name} (${s.owner.email}) ? Vous ne pourrez plus la modifier.`)) run(async () => { const r = await api(`/platform/setup/${id}/hand-over`, { body: {} }); setLinks(r.links); show(r); setNotice('Entreprise remise au client : les invitations sont parties.'); });
            }}>Remettre au client</button>
            {!s.canHandOver && <p className="small muted">{s.owner ? 'La formule ne couvre pas tous les utilisateurs prévus.' : 'Indiquez d’abord le propriétaire (onglet Utilisateurs).'}</p>}
          </div>}
        </div>

        <aside className="card prep-side">
          <h2>Avancement</h2>
          <ul className="prep-check">{s.checklist.map((c: any) => <li key={c.key} className={c.done ? 'done' : c.required ? 'missing' : ''}><span aria-hidden>{c.done ? '✓' : c.required ? '!' : '—'}</span><span>{c.label}</span></li>)}</ul>
          <div className="small muted">{money(s.subscription.billingCycle === 'yearly' ? s.subscription.priceYearly : s.subscription.priceMonthly)} / {s.subscription.billingCycle === 'yearly' ? 'an' : 'mois'} après {s.subscription.trialDays} jours d&apos;essai</div>
          <button className="btn" onClick={() => go('handover')}>Préparer la remise</button>
        </aside>
      </div>
    </>
  );
}

/** Liens d'invitation, à transmettre aussi par un autre canal (WhatsApp…). */
function InviteLinks({ links }: { links: { owner: { email: string; inviteUrl: string }; users: { email: string; inviteUrl: string }[] } }) {
  const all = [{ ...links.owner, owner: true }, ...links.users];
  return <div className="card"><header><h2>Liens d&apos;invitation</h2><span className="small muted">Déjà envoyés par e-mail ; vous pouvez aussi les transmettre autrement</span></header>
    <ul className="prep-links">{all.map((l: any) => <li key={l.email}><div className="row" style={{ gap: 6 }}><b>{l.email}</b>{l.owner && <Pill tone="ok">propriétaire</Pill>}</div>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><input className="input" readOnly value={l.inviteUrl} aria-label={`Lien pour ${l.email}`} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(l.inviteUrl)}>Copier</button></div></li>)}</ul></div>;
}
