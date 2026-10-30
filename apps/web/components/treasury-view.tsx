'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { ACCOUNT_KINDS, date, EXPENSE_CATEGORIES, INCOME_CATEGORIES, money, MOVEMENT_CATEGORIES } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
export type TreasuryKind = 'cash' | 'bank' | 'mobile_money';
/** Une page par type de compte : la caisse (espèces), les banques et le mobile money ne se mélangent pas. */
export const KIND_PAGES: Record<TreasuryKind, { title: string; href: string; add: string; empty: string; transferTo: TreasuryKind }> = {
  cash: { title: 'Caisse', href: '/app/tresorerie/caisse', add: '+ Ajouter une caisse', empty: 'Aucune caisse : ajoutez-en une pour suivre les espèces.', transferTo: 'bank' },
  bank: { title: 'Banque', href: '/app/tresorerie/banque', add: '+ Ajouter un compte bancaire', empty: 'Aucun compte bancaire : ajoutez votre compte (SGCI, Ecobank, SIB…).', transferTo: 'cash' },
  mobile_money: { title: 'Mobile money', href: '/app/tresorerie/mobile-money', add: '+ Ajouter un compte mobile money', empty: 'Aucun compte mobile money : ajoutez votre numéro marchand (Orange Money, Wave, MTN MoMo…).', transferTo: 'bank' },
};

/** Sans « kind » : vue d'ensemble de la trésorerie, totaux par type et journal de tous les comptes. */
export default function TreasuryView({ kind }: { kind?: TreasuryKind }) {
  const page = kind ? KIND_PAGES[kind] : null;
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [accounts, setAccounts] = useState<any[]>([]);
  const [journal, setJournal] = useState<any>(null);
  const [filters, setFilters] = useState({ accountId: '', kind: kind ?? '', from: `${today().slice(0, 7)}-01`, to: '', category: '', q: '' });
  const [modal, setModal] = useState<any>(null);
  const [result, setResult] = useState('');
  const { busy, error, run, setError } = useAction();

  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const loadAccounts = useCallback(() => api('/company/treasury/accounts').then(setAccounts), []);
  const loadJournal = useCallback(() => api(`/company/treasury/movements?${params}`).then(setJournal), [params]);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  // Un seul compte de ce type : on l'ouvre directement, pour afficher le solde progressif.
  const picked = useRef(false);
  const shown = kind ? accounts.filter((a) => a.kind === kind) : accounts;
  useEffect(() => {
    if (!kind || picked.current || !accounts.length) return;
    picked.current = true;
    const mine = accounts.filter((a) => a.kind === kind);
    if (mine.length === 1) setFilters((f) => ({ ...f, accountId: mine[0].id }));
  }, [kind, accounts]);
  useEffect(() => { const h = setTimeout(loadJournal, 250); return () => clearTimeout(h); }, [loadJournal]);
  const refresh = async () => { await Promise.all([loadAccounts(), loadJournal()]); };
  const open = (m: any) => { setError(''); setModal(m); };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setModal({ ...modal, [k]: e.target.value });

  const submit = () => run(async () => {
    const m = modal;
    if (m.type === 'expense' || m.type === 'income') {
      await api('/company/treasury/movements', { body: { kind: m.type, accountId: m.accountId, amount: Number(m.amount), category: m.category, label: m.label, date: m.date, reference: m.reference || null } });
    } else if (m.type === 'transfer') {
      await api('/company/treasury/transfers', { body: { fromAccountId: m.fromAccountId, toAccountId: m.toAccountId, amount: Number(m.amount), date: m.date, label: m.label || null, reference: m.reference || null } });
    } else if (m.type === 'count') {
      const r = await api(`/company/treasury/accounts/${m.accountId}/count`, { body: { counted: Number(m.counted), note: m.note || null } });
      setResult(r.difference === 0 ? 'Arrêté de caisse : aucun écart. 👍' : `Arrêté de caisse : écart de ${money(r.difference)} enregistré (attendu ${money(r.expected)}, compté ${money(r.counted)}).`);
    } else if (m.type === 'account') {
      const body = { name: m.name, bankName: m.bankName || null, accountNumber: m.accountNumber || null, openingBalance: Number(m.openingBalance || 0), openingDate: m.openingDate };
      if (m.id) await api(`/company/treasury/accounts/${m.id}`, { method: 'PATCH', body }); else await api('/company/treasury/accounts', { body: { ...body, kind: m.kind } });
    } else if (m.type === 'reverse') {
      await api(`/company/treasury/movements/${m.movement.id}/reverse`, { body: { reason: m.reason } });
    }
    setModal(null); await refresh();
  });

  const first = (k: string) => shown.find((a) => a.kind === k)?.id ?? shown[0]?.id ?? accounts[0]?.id ?? '';
  const total = shown.reduce((s, a) => s + a.balance, 0);
  const from = first(kind ?? 'cash');
  const transferTo = accounts.find((a) => a.id !== from && a.kind === KIND_PAGES[kind ?? 'cash'].transferTo)?.id ?? accounts.find((a) => a.id !== from)?.id ?? '';
  const plural = (n: number) => `${n} compte${n > 1 ? 's' : ''} actif${n > 1 ? 's' : ''}`;

  return (
    <>
      <div className="page-head"><h1>{page?.title ?? 'Trésorerie'}</h1>
        <div className="row">
          {can('cash.create') && writable && <>
            <button className="btn" onClick={() => open({ type: 'income', accountId: from, category: 'capital', amount: '', label: '', date: today(), reference: '' })}>Recette</button>
            <button className="btn" onClick={() => open({ type: 'transfer', fromAccountId: from, toAccountId: transferTo, amount: '', label: '', date: today(), reference: '' })}>Virement interne</button>
            <button className="btn primary" onClick={() => open({ type: 'expense', accountId: from, category: 'fuel', amount: '', label: '', date: today(), reference: '' })}>Dépense</button>
          </>}
        </div>
      </div>
      <Alert kind="ok">{result}</Alert>
      <Alert>{!modal && error}</Alert>
      {shown.some((a) => a.kind !== 'cash' && a.balance < 0 && a.openingBalance === 0) && (
        <Alert kind="warn">Un compte affiche un solde négatif alors que son solde d'ouverture est à 0 : renseignez le solde réel du compte à sa date d'ouverture (bouton « Paramétrer »).</Alert>
      )}

      <div className="kpis">
        <div className="card kpi"><div className="l">{page ? `Total ${page.title.toLowerCase()}` : 'Trésorerie totale'}</div><div className="v">{money(total)}</div><div className="small muted">{plural(shown.length)}</div></div>
        {!kind && (Object.keys(KIND_PAGES) as TreasuryKind[]).map((k) => {
          const mine = accounts.filter((a) => a.kind === k);
          return (
            <div key={k} className="card kpi" style={{ display: 'grid', gap: 4 }}>
              <div className="l">{KIND_PAGES[k].title}</div>
              <div className="v" style={{ color: mine.reduce((s, a) => s + a.balance, 0) < 0 ? 'var(--crit)' : undefined }}>{money(mine.reduce((s, a) => s + a.balance, 0))}</div>
              <div className="small muted">{mine.length ? plural(mine.length) : 'aucun compte'} · ce mois : +{money(mine.reduce((s, a) => s + a.monthIn, 0))} / −{money(mine.reduce((s, a) => s + a.monthOut, 0))}</div>
              <div><Link className="small" href={KIND_PAGES[k].href}>ouvrir</Link></div>
            </div>
          );
        })}
        {kind && shown.map((a) => (
          <div key={a.id} className="card kpi" style={{ display: 'grid', gap: 4 }}>
            <div className="l">{a.name}</div>
            <div className="v" style={{ color: a.balance < 0 ? 'var(--crit)' : undefined }}>{money(a.balance)}</div>
            {a.bankName && <div className="small muted">{[a.bankName, a.accountNumber].filter(Boolean).join(' · ')}</div>}
            <div className="small muted">ce mois : +{money(a.monthIn)} / −{money(a.monthOut)}</div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={() => setFilters({ ...filters, accountId: a.id })}>Journal</button>
              {a.kind === 'cash' && can('cash.validate') && writable && <button className="btn sm" onClick={() => open({ type: 'count', accountId: a.id, name: a.name, expected: a.balance, counted: '', note: '' })}>Arrêté</button>}
              {can('cash.admin') && writable && <button className="btn sm" onClick={() => open({ type: 'account', ...a, bankName: a.bankName ?? '', accountNumber: a.accountNumber ?? '' })}>Paramétrer</button>}
            </div>
          </div>
        ))}
      </div>
      {kind && accounts.length > 0 && !shown.length && <p className="muted" style={{ margin: 0 }}>{page!.empty}</p>}
      {can('cash.admin') && writable && <div><button className="btn sm" onClick={() => open({ type: 'account', kind: kind ?? 'bank', name: '', bankName: '', accountNumber: '', openingBalance: 0, openingDate: today() })}>{page?.add ?? '+ Ajouter un compte (banque, caisse, mobile money)'}</button></div>}

      <div className="card">
        <header><h2>{page ? `Journal — ${page.title.toLowerCase()}` : 'Journal de trésorerie'}</h2>
          {can('cash.export') && <a className="btn sm" href={`/api/company/treasury/movements/export?${params}`}>Exporter (CSV)</a>}</header>
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="field" style={{ flex: 1, minWidth: 160 }}>Compte
            <select className="input" value={filters.accountId} onChange={(e) => setFilters({ ...filters, accountId: e.target.value })}>
              <option value="">Tous les comptes</option>{shown.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
          <div style={{ flex: 1, minWidth: 140 }}><Field label="Du" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></div>
          <div style={{ flex: 1, minWidth: 140 }}><Field label="Au" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></div>
          <label className="field" style={{ flex: 1, minWidth: 160 }}>Catégorie
            <select className="input" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
              <option value="">Toutes</option>{Object.entries(MOVEMENT_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          <div style={{ flex: 1.5, minWidth: 180 }}><Field label="Rechercher" type="search" placeholder="Libellé, référence, tiers…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /></div>
        </div>
        {journal?.opening !== null && journal?.opening !== undefined && <p className="small" style={{ margin: '0 0 8px' }}>Solde au début de la période : <b>{money(journal.opening)}</b> · solde en fin de période : <b>{money(journal.closing)}</b></p>}
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Libellé</th>{!filters.accountId && <th>Compte</th>}<th>Catégorie</th><th className="n">Entrée</th><th className="n">Sortie</th>{journal?.opening !== null && <th className="n">Solde</th>}<th></th></tr></thead>
          <tbody>
            {journal?.movements.map((m: any) => (
              <tr key={m.id} style={m.reversedBy ? { opacity: .55 } : undefined}>
                <td style={{ whiteSpace: 'nowrap' }}>{date(m.date)}</td>
                <td>{m.label}{m.reversedBy && <> <Pill>Contre-passé</Pill></>}<div className="small muted">{[m.contactName, m.reference, m.by].filter(Boolean).join(' · ')}</div></td>
                {!filters.accountId && <td className="small">{m.accountName}{!kind && m.accountName !== ACCOUNT_KINDS[m.accountKind] && <div className="muted">{ACCOUNT_KINDS[m.accountKind]}</div>}</td>}
                <td className="small">{MOVEMENT_CATEGORIES[m.category] ?? m.category}</td>
                <td className="n" style={{ whiteSpace: 'nowrap', color: 'var(--ok)' }}>{m.direction === 'in' ? money(m.amount) : ''}</td>
                <td className="n" style={{ whiteSpace: 'nowrap' }}>{m.direction === 'out' ? money(m.amount) : ''}</td>
                {journal.opening !== null && <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(m.balanceAfter)}</td>}
                <td className="n">{['expense', 'income', 'transfer'].includes(m.sourceType) && !m.reversedBy && can('cash.cancel') && writable &&
                  <button className="btn sm" onClick={() => open({ type: 'reverse', movement: m, reason: '' })}>Contre-passer</button>}</td>
              </tr>
            ))}
            {journal && !journal.movements.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun mouvement sur cette période.</td></tr>}
          </tbody>
        </table></div>
      </div>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {(modal.type === 'expense' || modal.type === 'income') && <>
              <h2>{modal.type === 'expense' ? 'Nouvelle dépense' : 'Nouvelle recette'}</h2>
              <Alert>{error}</Alert>
              <label className="field">Catégorie
                <select className="input" value={modal.category} onChange={set('category')}>{Object.entries(modal.type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <Field label="Libellé" required minLength={2} placeholder={modal.type === 'expense' ? 'Ex. Facture CIE de septembre' : "Ex. Apport de l'exploitant"} value={modal.label} onChange={set('label')} />
              <div className="grid2">
                <Field label="Montant (FCFA)" type="number" min={1} required value={modal.amount} onChange={set('amount')} />
                <label className="field">{modal.type === 'expense' ? 'Payé depuis' : 'Encaissé sur'}
                  <select className="input" value={modal.accountId} onChange={set('accountId')}>{shown.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance)})</option>)}</select></label>
                <Field label="Date" type="date" required max={today()} value={modal.date} onChange={set('date')} />
                <Field label="Référence (facultatif)" value={modal.reference} onChange={set('reference')} />
              </div>
            </>}
            {modal.type === 'transfer' && <>
              <h2>Virement interne</h2>
              <p className="small muted" style={{ margin: 0 }}>Ex. dépôt des espèces de la caisse à la banque, ou retrait.</p>
              <Alert>{error}</Alert>
              <div className="grid2">
                <label className="field">De<select className="input" value={modal.fromAccountId} onChange={set('fromAccountId')}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance)})</option>)}</select></label>
                <label className="field">Vers<select className="input" value={modal.toAccountId} onChange={set('toAccountId')}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <Field label="Montant (FCFA)" type="number" min={1} required value={modal.amount} onChange={set('amount')} />
                <Field label="Date" type="date" required max={today()} value={modal.date} onChange={set('date')} />
              </div>
              <Field label="Libellé (facultatif)" placeholder="Ex. Dépôt des recettes de la semaine" value={modal.label} onChange={set('label')} />
              <Field label="Référence (bordereau de versement…)" value={modal.reference} onChange={set('reference')} />
            </>}
            {modal.type === 'count' && <>
              <h2>Arrêté de caisse — {modal.name}</h2>
              <p className="small muted" style={{ margin: 0 }}>Comptez les espèces présentes dans la caisse. Le solde théorique est de <b>{money(modal.expected)}</b> ; tout écart sera enregistré.</p>
              <Alert>{error}</Alert>
              <Field label="Montant compté (FCFA)" type="number" min={0} required value={modal.counted} onChange={set('counted')} />
              {modal.counted !== '' && Number(modal.counted) !== modal.expected && <Alert kind="warn">Écart de {money(Number(modal.counted) - modal.expected)}.</Alert>}
              <Field label="Commentaire (facultatif)" placeholder="Ex. erreur de rendu de monnaie" value={modal.note} onChange={set('note')} />
            </>}
            {modal.type === 'account' && <>
              <h2>{modal.id ? `Paramétrer « ${modal.name} »` : 'Nouveau compte de trésorerie'}</h2>
              <Alert>{error}</Alert>
              <div className="grid2">
                {!modal.id && !kind && <label className="field">Type<select className="input" value={modal.kind} onChange={set('kind')}>{Object.entries(ACCOUNT_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
                <Field label="Nom du compte" required minLength={2} placeholder="Ex. SGCI, Orange Money, Caisse boutique" value={modal.name} onChange={set('name')} />
                {modal.kind !== 'cash' && <Field label={modal.kind === 'bank' ? 'Banque' : 'Opérateur'} placeholder={modal.kind === 'bank' ? 'Ex. Ecobank Côte d’Ivoire' : 'Ex. Orange Money, Wave, MTN MoMo'} value={modal.bankName} onChange={set('bankName')} />}
                {modal.kind !== 'cash' && <Field label={modal.kind === 'bank' ? 'N° de compte / RIB' : 'Numéro marchand'} value={modal.accountNumber} onChange={set('accountNumber')} />}
                <Field label="Solde d'ouverture (FCFA)" type="number" min={modal.kind === 'cash' ? 0 : undefined} value={modal.openingBalance} onChange={set('openingBalance')} />
                <Field label="Date d'ouverture" type="date" required max={today()} value={modal.openingDate} onChange={set('openingDate')} />
              </div>
              <p className="small muted" style={{ margin: 0 }}>Le solde d'ouverture est le montant réellement présent sur le compte à la date d'ouverture, avant tout mouvement saisi dans Kora.</p>
              {modal.id && <div><button type="button" className="btn sm danger" disabled={busy} onClick={() => run(async () => { await api(`/company/treasury/accounts/${modal.id}/archive`, { body: {} }); setModal(null); await refresh(); })}>Archiver ce compte</button></div>}
            </>}
            {modal.type === 'reverse' && <>
              <h2>Contre-passer un mouvement</h2>
              <p className="small" style={{ margin: 0 }}>{modal.movement.label} · <b>{money(modal.movement.amount)}</b> du {date(modal.movement.date)}</p>
              <p className="small muted" style={{ margin: 0 }}>Un mouvement inverse sera inscrit à la date du jour ; l'original reste visible dans le journal.{modal.movement.transferId ? ' Les deux côtés du virement seront annulés.' : ''}</p>
              <Alert>{error}</Alert>
              <Field label="Motif" required minLength={3} placeholder="Ex. saisi en double" value={modal.reason} onChange={set('reason')} />
            </>}
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
