'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, JOURNALS, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${today().slice(0, 4)}-01-01`;
const TABS = [['entries', 'Écritures'], ['ledger', 'Grand livre'], ['balance', 'Balance'], ['sheet', 'Bilan'], ['sig', 'Soldes de gestion'], ['result', 'Compte de résultat'],
  ['vat', 'TVA'], ['closing', 'Clôture d\u2019exercice'], ['chart', 'Plan comptable']] as const;
type Tab = (typeof TABS)[number][0];
const num = (n: number) => (n ? money(n) : '');

/** Charge une donnée et ignore les réponses arrivées après un changement de filtre (sinon une réponse ancienne écrase la bonne). */
function useLatest<T>(url: string | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!url) return;
    let current = true;
    const h = setTimeout(() => api<T>(url).then((d) => { if (current) { setData(d); setError(''); } }, (e) => { if (current) setError(e.message); }), 200);
    return () => { current = false; clearTimeout(h); };
  }, [url, ...deps]); // eslint-disable-line
  return { data, error };
}

export default function AccountingPage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [tab, setTab] = useState<Tab>('entries');
  const [status, setStatus] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [period, setPeriod] = useState({ from: yearStart(), to: today() });
  const [modal, setModal] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const { busy, error, run, setError } = useAction();

  const loadStatus = useCallback(() => api('/company/accounting/status').then(setStatus), []);
  useEffect(() => { loadStatus(); api('/company/accounting/accounts').then(setAccounts); }, [loadStatus, version]);
  const changed = () => setVersion((v) => v + 1);
  const accountName = (code: string) => accounts.find((a) => a.code === code)?.name ?? '';

  return (
    <>
      <div className="page-head"><h1>Comptabilité</h1>
        <div className="row">
          {status?.lockedUntil && <Pill tone="mute">Clôturée jusqu'au {date(status.lockedUntil)}</Pill>}
          {can('accounting.export') && <a className="btn" href={`/api/company/accounting/entries/export?from=${period.from}&to=${period.to}`}>Exporter les écritures</a>}
          {can('accounting.close') && writable && <button className="btn" onClick={() => { setError(''); setModal({ type: 'lock', until: '' }); }}>Clôturer une période</button>}
          {can('accounting.create') && writable && <button className="btn primary" onClick={() => { setError(''); setModal({ type: 'entry', journal: 'OD', date: today(), label: '', reference: '', lines: [{ account: '', label: '', debit: '', credit: '' }, { account: '', label: '', debit: '', credit: '' }] }); }}>Nouvelle écriture</button>}
        </div>
      </div>
      <Alert>{!modal && error}</Alert>
      {status?.pending > 0 && (
        <Alert kind="warn">{status.pending} opération{status.pending > 1 ? 's' : ''} saisie{status.pending > 1 ? 's' : ''} avant l'activation de la comptabilité {status.pending > 1 ? 'ne sont' : "n'est"} pas encore comptabilisée{status.pending > 1 ? 's' : ''}.
          {can('accounting.admin') && writable && <> <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api('/company/accounting/sync', { body: {} }); changed(); })}>Comptabiliser maintenant</button></>}</Alert>
      )}
      <p className="small muted" style={{ margin: 0 }}>Les factures, avoirs, règlements et mouvements de trésorerie sont comptabilisés automatiquement selon le plan SYSCOHADA révisé. Saisissez ici les opérations diverses (reclassements, amortissements, salaires…).</p>

      <div className="row" role="tablist" style={{ gap: 6 }}>
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn sm${tab === k ? ' primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        {!['chart', 'vat', 'sheet', 'closing'].includes(tab) && <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          <Field label="Du" type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
          <Field label="Au" type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
        </div>}
      </div>

      {tab === 'entries' && <Entries period={period} version={version} onEdit={(e) => { setError(''); setModal({ type: 'entry', ...e, reference: e.reference ?? '', lines: e.lines.map((l: any) => ({ ...l, debit: l.debit || '', credit: l.credit || '' })) }); }} onReverse={(e) => { setError(''); setModal({ type: 'reverse', entry: e, reason: '' }); }} changed={changed} />}
      {tab === 'ledger' && <Ledger period={period} accounts={accounts} version={version} />}
      {tab === 'balance' && <TrialBalance period={period} version={version} />}
      {tab === 'vat' && <Vat version={version} />}
      {tab === 'result' && <IncomeStatement period={period} version={version} />}
      {tab === 'sheet' && <BalanceSheet version={version} />}
      {tab === 'sig' && <ManagementBalances period={period} version={version} />}
      {tab === 'closing' && <Closing version={version} changed={changed} />}
      {tab === 'chart' && <Chart accounts={accounts} changed={changed} />}

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            // Le bouton qui a déclenché l'envoi dit s'il faut aussi valider l'écriture.
            const post = (e.nativeEvent as SubmitEvent).submitter?.dataset.post === 'true';
            run(async () => {
              if (modal.type === 'lock') await api('/company/accounting/lock', { body: { until: modal.until } });
              if (modal.type === 'reverse') await api(`/company/accounting/entries/${modal.entry.id}/reverse`, { body: { reason: modal.reason } });
              if (modal.type === 'entry') {
                const body = { date: modal.date, label: modal.label, reference: modal.reference || null,
                  lines: modal.lines.filter((l: any) => l.account).map((l: any) => ({ account: l.account, label: l.label || modal.label, debit: Number(l.debit || 0), credit: Number(l.credit || 0) })) };
                const saved = modal.id ? await api(`/company/accounting/entries/${modal.id}`, { method: 'PATCH', body }) : await api('/company/accounting/entries', { body: { ...body, journal: modal.journal } });
                if (post) await api(`/company/accounting/entries/${saved.id}/post`, { body: {} });
              }
              setModal(null); changed();
            });
          }}>
            {modal.type === 'lock' && <>
              <h2>Clôturer une période</h2>
              <p className="small" style={{ margin: 0 }}>Après clôture, plus aucune écriture ne pourra être passée à cette date ou avant, y compris par les factures et la trésorerie. <b>Une clôture est définitive.</b></p>
              <Alert>{error}</Alert>
              <Field label="Clôturer jusqu'au (inclus)" type="date" required max={today()} value={modal.until} onChange={(e) => setModal({ ...modal, until: e.target.value })} />
            </>}
            {modal.type === 'reverse' && <>
              <h2>Contre-passer {modal.entry.number}</h2>
              <p className="small muted" style={{ margin: 0 }}>Une écriture inverse sera passée à la date du jour ; l'écriture d'origine reste au journal.</p>
              <Alert>{error}</Alert>
              <Field label="Motif" required minLength={3} value={modal.reason} onChange={(e) => setModal({ ...modal, reason: e.target.value })} />
            </>}
            {modal.type === 'entry' && <EntryEditor modal={modal} setModal={setModal} accounts={accounts} accountName={accountName} error={error} />}
            <div className="row">
              {modal.type === 'entry' && can('accounting.validate') && <button className="btn primary" disabled={busy} data-post="true">Enregistrer et valider</button>}
              <button className={`btn${modal.type === 'entry' ? '' : ' primary'}`} disabled={busy}>{modal.type === 'entry' ? 'Enregistrer en brouillon' : 'Confirmer'}</button>
              <button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

/** Saisie d'une écriture d'opérations diverses, avec contrôle de l'équilibre en direct. */
function EntryEditor({ modal, setModal, accounts, accountName, error }: { modal: any; setModal: (m: any) => void; accounts: any[]; accountName: (c: string) => string; error: string }) {
  const setLine = (i: number, patch: any) => setModal({ ...modal, lines: modal.lines.map((l: any, j: number) => (j === i ? { ...l, ...patch } : l)) });
  const d = modal.lines.reduce((s: number, l: any) => s + Number(l.debit || 0), 0);
  const c = modal.lines.reduce((s: number, l: any) => s + Number(l.credit || 0), 0);
  return <>
    <h2>{modal.id ? 'Modifier le brouillon' : 'Nouvelle écriture'}</h2>
    <Alert>{error}</Alert>
    <div className="grid2">
      {!modal.id && <label className="field">Journal<select className="input" value={modal.journal} onChange={(e) => setModal({ ...modal, journal: e.target.value })}><option value="OD">OD — Opérations diverses</option><option value="AN">AN — À-nouveaux</option></select></label>}
      <Field label="Date" type="date" required value={modal.date} onChange={(e) => setModal({ ...modal, date: e.target.value })} />
      <Field label="Libellé" required minLength={2} placeholder="Ex. Dotation aux amortissements d'octobre" value={modal.label} onChange={(e) => setModal({ ...modal, label: e.target.value })} />
      <Field label="Pièce (facultatif)" value={modal.reference} onChange={(e) => setModal({ ...modal, reference: e.target.value })} />
    </div>
    <datalist id="chart">{accounts.filter((a) => !a.archivedAt).map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}</datalist>
    <div className="table-wrap"><table className="lines">
      <thead><tr><th>Compte</th><th>Libellé de la ligne</th><th className="n">Débit</th><th className="n">Crédit</th><th></th></tr></thead>
      <tbody>{modal.lines.map((l: any, i: number) => (
        <tr key={i}>
          <td><input className="input" list="chart" required={i < 2} value={l.account} onChange={(e) => setLine(i, { account: e.target.value.trim() })} aria-label={`Compte ligne ${i + 1}`} style={{ width: 110 }} />
            <div className="small muted" style={{ maxWidth: 180 }}>{accountName(l.account)}</div></td>
          <td><input className="input" value={l.label} placeholder={modal.label} onChange={(e) => setLine(i, { label: e.target.value })} aria-label={`Libellé ligne ${i + 1}`} /></td>
          <td><input className="input n" type="number" min="0" step="any" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} aria-label={`Débit ligne ${i + 1}`} style={{ width: 120 }} /></td>
          <td><input className="input n" type="number" min="0" step="any" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} aria-label={`Crédit ligne ${i + 1}`} style={{ width: 120 }} /></td>
          <td>{modal.lines.length > 2 && <button type="button" className="btn sm danger" onClick={() => setModal({ ...modal, lines: modal.lines.filter((_: any, j: number) => j !== i) })} aria-label={`Supprimer la ligne ${i + 1}`}>✕</button>}</td>
        </tr>))}</tbody>
      <tfoot><tr><td colSpan={2}><button type="button" className="btn sm" onClick={() => setModal({ ...modal, lines: [...modal.lines, { account: '', label: '', debit: '', credit: '' }] })}>+ Ligne</button></td>
        <td className="n"><b>{money(d)}</b></td><td className="n"><b>{money(c)}</b></td><td></td></tr></tfoot>
    </table></div>
    {d !== c ? <Alert kind="warn">Écriture déséquilibrée : écart de {money(Math.abs(d - c))}. Elle peut être enregistrée en brouillon, mais pas validée.</Alert> : d > 0 && <Alert kind="ok">Écriture équilibrée.</Alert>}
  </>;
}

function Entries({ period, version, onEdit, onReverse, changed }: { period: any; version: number; onEdit: (e: any) => void; onReverse: (e: any) => void; changed: () => void }) {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [f, setF] = useState({ journal: '', q: '', status: '' });
  const { busy, error, run } = useAction();
  const params = new URLSearchParams(Object.entries({ ...period, ...f }).filter(([, v]) => v) as [string, string][]).toString();
  const { data: rows } = useLatest<any[]>(`/company/accounting/entries?${params}`, [version]);
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field" style={{ minWidth: 200 }}>Journal<select className="input" value={f.journal} onChange={(e) => setF({ ...f, journal: e.target.value })}>
          <option value="">Tous les journaux</option>{Object.entries(JOURNALS).map(([k, v]) => <option key={k} value={k}>{k} — {v}</option>)}</select></label>
        <label className="field" style={{ minWidth: 140 }}>État<select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Tous</option><option value="posted">Validées</option><option value="draft">Brouillons</option></select></label>
        <div style={{ flex: 1, minWidth: 200 }}><Field label="Rechercher" type="search" placeholder="Libellé, numéro, pièce…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
      </div>
      <Alert>{error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>N°</th><th>Compte</th><th>Libellé</th><th className="n">Débit</th><th className="n">Crédit</th></tr></thead>
        {rows?.map((e) => (
          <tbody key={e.id} style={{ borderTop: '2px solid var(--line)', opacity: e.reversedBy ? 0.6 : 1 }}>
            <tr style={{ background: 'var(--surface-2)' }}>
              <td style={{ whiteSpace: 'nowrap' }}>{date(e.date)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{e.number ?? <Pill tone="warn">Brouillon</Pill>}</td>
              <td colSpan={2}><b>{e.label}</b>{e.reference && <span className="small muted"> · pièce {e.reference}</span>}{e.reversedBy && <> <Pill>Contre-passée</Pill></>}</td>
              <td colSpan={2} className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                {e.status === 'draft' && writable && can('accounting.update') && <button className="btn sm" onClick={() => api(`/company/accounting/entries/${e.id}`).then(onEdit)}>Modifier</button>}
                {e.status === 'draft' && writable && can('accounting.validate') && <button className="btn sm primary" disabled={busy} onClick={() => run(async () => { await api(`/company/accounting/entries/${e.id}/post`, { body: {} }); changed(); })}>Valider</button>}
                {e.status === 'draft' && writable && can('accounting.cancel') && <button className="btn sm danger" disabled={busy} onClick={() => run(async () => { await api(`/company/accounting/entries/${e.id}`, { method: 'DELETE' }); changed(); })}>Supprimer</button>}
                {e.status === 'posted' && e.sourceType === 'manual' && !e.reversedBy && writable && can('accounting.reverse') && <button className="btn sm" onClick={() => onReverse(e)}>Contre-passer</button>}
              </div></td>
            </tr>
            {e.lines.map((l: any, i: number) => (
              <tr key={i}><td></td><td></td><td style={{ whiteSpace: 'nowrap' }}><code className="k">{l.account}</code></td>
                <td className="small">{l.label}{l.contactName && <span className="muted"> · {l.contactName}</span>}</td>
                <td className="n" style={{ whiteSpace: 'nowrap' }}>{num(l.debit)}</td><td className="n" style={{ whiteSpace: 'nowrap' }}>{num(l.credit)}</td></tr>
            ))}
          </tbody>
        ))}
        {rows && !rows.length && <tbody><tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucune écriture sur cette période.</td></tr></tbody>}
      </table></div>
    </div>
  );
}

function Ledger({ period, accounts, version }: { period: any; accounts: any[]; version: number }) {
  const [account, setAccount] = useState('411000');
  const { data, error } = useLatest<any>(/^\d{2,}$/.test(account) ? `/company/accounting/ledger?account=${account}&from=${period.from}&to=${period.to}` : null, [version]);
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field" style={{ minWidth: 320 }}>Compte
          <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.filter((a) => a.used || a.code === account).map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
          </select></label>
        <span className="small muted">Un compte inclut ses sous-comptes (ex. 571000 regroupe toutes les caisses : 571100, 571200…).</span>
      </div>
      <Alert>{error}</Alert>
      {data && <>
        <p className="small" style={{ margin: '0 0 8px' }}>Solde d'ouverture : <b>{money(data.opening)}</b> · solde de clôture : <b>{money(data.closing)}</b> {data.closing >= 0 ? '(débiteur)' : '(créditeur)'}</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Écriture</th><th>Libellé</th><th className="n">Débit</th><th className="n">Crédit</th><th className="n">Solde</th></tr></thead>
          <tbody>{data.lines.map((l: any) => (
            <tr key={l.id}><td style={{ whiteSpace: 'nowrap' }}>{date(l.date)}</td><td style={{ whiteSpace: 'nowrap' }} className="small">{l.number}{l.account !== data.account.code && <div className="muted">{l.account}</div>}</td>
              <td className="small">{l.label}{l.contactName && <span className="muted"> · {l.contactName}</span>}</td>
              <td className="n">{num(l.debit)}</td><td className="n">{num(l.credit)}</td><td className="n" style={{ whiteSpace: 'nowrap' }}>{money(l.balance)}</td></tr>))}
            {!data.lines.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun mouvement sur cette période.</td></tr>}</tbody>
          <tfoot><tr><td colSpan={3}><b>Totaux de la période</b></td><td className="n"><b>{money(data.totalDebit)}</b></td><td className="n"><b>{money(data.totalCredit)}</b></td><td></td></tr></tfoot>
        </table></div>
      </>}
    </div>
  );
}

function TrialBalance({ period, version }: { period: any; version: number }) {
  const { data } = useLatest<any>(`/company/accounting/trial-balance?from=${period.from}&to=${period.to}`, [version]);
  if (!data) return null;
  const cols = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'];
  return (
    <div className="card">
      <header><h2>Balance générale</h2>{data.balanced ? <Pill tone="ok">Équilibrée</Pill> : <Pill tone="crit">Déséquilibrée</Pill>}</header>
      <div className="table-wrap"><table>
        <thead>
          <tr><th rowSpan={2}>Compte</th><th rowSpan={2}>Intitulé</th><th colSpan={2} style={{ textAlign: 'center' }}>Soldes à l'ouverture</th><th colSpan={2} style={{ textAlign: 'center' }}>Mouvements</th><th colSpan={2} style={{ textAlign: 'center' }}>Soldes de clôture</th></tr>
          <tr>{cols.map((c, i) => <th key={c} className="n">{i % 2 ? 'Crédit' : 'Débit'}</th>)}</tr>
        </thead>
        <tbody>{data.accounts.map((a: any) => (
          <tr key={a.account}><td><code className="k">{a.account}</code></td><td className="small">{a.name}</td>{cols.map((c) => <td key={c} className="n" style={{ whiteSpace: 'nowrap' }}>{num(a[c])}</td>)}</tr>))}</tbody>
        <tfoot><tr><td colSpan={2}><b>Totaux</b></td>{cols.map((c) => <td key={c} className="n" style={{ whiteSpace: 'nowrap' }}><b>{money(data.totals[c])}</b></td>)}</tr></tfoot>
      </table></div>
    </div>
  );
}

function Vat({ version }: { version: number }) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [y, m] = month.split('-').map(Number);
  const { data } = useLatest<any>(month ? `/company/accounting/vat?from=${month}-01&to=${new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)}` : null, [version]);
  return (
    <div className="card">
      <header><h2>Déclaration de TVA</h2><Field label="Mois" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></header>
      {data && <>
        <div className="kpis">
          <div className="card kpi"><div className="l">Chiffre d'affaires HT</div><div className="v">{money(data.revenueHt)}</div></div>
          <div className="card kpi"><div className="l">TVA facturée (443100)</div><div className="v">{money(data.collected)}</div>
            <div className="small muted">{data.collectedByRate.map((r: any) => `${r.rate} % : ${money(r.amount)}`).join(' · ')}</div></div>
          <div className="card kpi"><div className="l">TVA récupérable (445…)</div><div className="v">{money(data.deductible)}</div></div>
          <div className="card kpi"><div className="l">{data.credit ? 'Crédit de TVA' : 'TVA à payer'}</div><div className="v" style={{ color: data.due ? 'var(--crit)' : 'var(--ok)' }}>{money(data.due || data.credit)}</div></div>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>Montants issus des écritures validées du mois. À reporter sur la déclaration mensuelle de la DGI (e-impôts) ; un crédit de TVA se reporte sur le mois suivant.</p>
      </>}
    </div>
  );
}

function IncomeStatement({ period, version }: { period: any; version: number }) {
  const { data } = useLatest<any>(`/company/accounting/income-statement?from=${period.from}&to=${period.to}`, [version]);
  if (!data) return null;
  const block = (kind: string, title: string, total: number) => (
    <div className="card" style={{ flex: 1, minWidth: 300 }}>
      <header><h2>{title}</h2><b>{money(total)}</b></header>
      <table><tbody>{data.lines.filter((l: any) => l.kind === kind).map((l: any) => <tr key={l.code}><td><code className="k">{l.code}</code></td><td>{l.label}</td><td className="n">{money(l.amount)}</td></tr>)}</tbody></table>
    </div>
  );
  return <>
    <div className="row" style={{ alignItems: 'stretch' }}>{block('income', 'Produits', data.income)}{block('charge', 'Charges', data.charges)}</div>
    <div className="card"><header><h2>Résultat de la période</h2><b style={{ fontSize: 22, color: data.result >= 0 ? 'var(--ok)' : 'var(--crit)' }}>{data.result >= 0 ? 'Bénéfice' : 'Perte'} : {money(Math.abs(data.result))}</b></header>
      <p className="small muted" style={{ margin: 0 }}>Résultat avant écritures d'inventaire (stocks, amortissements, provisions) et impôt sur les bénéfices.</p></div>
  </>;
}

function Chart({ accounts, changed }: { accounts: any[]; changed: () => void }) {
  const { can, ctx } = useSession();
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ code: '', name: '' });
  const { busy, error, run } = useAction();
  const shown = accounts.filter((a) => !q || a.code.startsWith(q) || a.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card">
      {can('accounting.admin') && !ctx?.readOnly && (
        <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/company/accounting/accounts', { body: form }); setForm({ code: '', name: '' }); changed(); }); }}>
          <div style={{ width: 140 }}><Field label="Nouveau sous-compte" required inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} title="6 chiffres, ex. 601100" placeholder="Ex. 601100" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div style={{ flex: 1, minWidth: 220 }}><Field label="Intitulé" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <button className="btn" disabled={busy} style={{ alignSelf: 'flex-end' }}>Ajouter</button>
        </form>
      )}
      <Alert>{error}</Alert>
      <Field label="Rechercher" type="search" placeholder="Numéro ou intitulé" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap" style={{ marginTop: 12 }}><table>
        <thead><tr><th>Compte</th><th>Intitulé</th><th>Classe</th><th></th></tr></thead>
        <tbody>{shown.map((a) => (
          <tr key={a.code}><td><code className="k">{a.code}</code></td><td style={{ paddingLeft: 12 + (a.code.length - 3) * 14 }}>{a.name}</td>
            <td className="small muted">{['', 'Ressources durables', 'Actif immobilisé', 'Stocks', 'Tiers', 'Trésorerie', 'Charges', 'Produits', 'Autres charges et produits'][Number(a.code[0])]}</td>
            <td>{a.used && <Pill tone="ok">Mouvementé</Pill>}{!a.isSystem && <> <Pill>Ajouté</Pill></>}</td></tr>))}</tbody>
      </table></div>
    </div>
  );
}

/** Bilan à une date : actif (brut, amortissements, net) et passif, avec le détail des comptes de chaque rubrique. */
function BalanceSheet({ version }: { version: number }) {
  const [date, setDate] = useState(today());
  const [open, setOpen] = useState<string | null>(null);
  const { data } = useLatest<any>(`/company/accounting/balance-sheet?date=${date}`, [version]);
  const side = (title: string, sections: any[], total: number, isAssets: boolean) => (
    <div className="card" style={{ flex: 1, minWidth: 340 }}>
      <header><h2>{title}</h2><b>{money(total)}</b></header>
      <table className="vat" style={{ width: '100%' }}>
        {isAssets && <thead><tr><th></th><th className="n">Brut</th><th className="n">Amort./dépréc.</th><th className="n">Net</th></tr></thead>}
        {sections.map((s: any) => (
          <tbody key={s.section}>
            <tr><td colSpan={isAssets ? 3 : 1}><b>{s.section}</b></td><td className="n"><b>{money(s.total)}</b></td></tr>
            {s.rows.filter((r: any) => r.net || r.gross).map((r: any) => [
              <tr key={r.key} style={{ cursor: r.accounts?.length ? 'pointer' : undefined }} onClick={() => setOpen(open === r.key ? null : r.key)}>
                <td style={{ paddingLeft: 18 }}>{r.label}{r.accounts?.length ? <span className="muted small"> {open === r.key ? '▾' : '▸'}</span> : null}</td>
                {isAssets && <><td className="n">{r.gross !== undefined ? money(r.gross) : ''}</td><td className="n">{r.depreciation ? money(r.depreciation) : ''}</td></>}
                <td className="n" style={{ color: r.net < 0 ? 'var(--crit)' : undefined }}>{money(r.net)}</td></tr>,
              ...(open === r.key ? r.accounts.map((a: any) => <tr key={`${r.key}-${a.code}`} className="small muted"><td style={{ paddingLeft: 32 }}><code className="k">{a.code}</code> {a.name}</td>{isAssets && <><td></td><td></td></>}<td className="n">{money(a.amount)}</td></tr>) : []),
            ])}
          </tbody>
        ))}
      </table>
    </div>
  );
  return (
    <>
      <div className="row no-print"><Field label="Bilan arrêté au" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} />
        {data && (data.balanced ? <Pill tone="ok">Actif = passif</Pill> : <Pill tone="crit">Bilan déséquilibré</Pill>)}
        <button className="btn sm" onClick={() => window.print()}>Imprimer / PDF</button></div>
      {data && <div className="row" style={{ alignItems: 'flex-start' }}>{side('Actif', data.assets, data.totalAssets, true)}{side('Passif', data.liabilities, data.totalLiabilities, false)}</div>}
      <p className="small muted" style={{ margin: 0 }}>Présentation simplifiée du système normal SYSCOHADA révisé. Les comptes de tiers et de trésorerie figurent à l'actif ou au passif selon le sens de leur solde. Les états officiels (DSF) restent établis par votre expert-comptable.</p>
    </>
  );
}

/** Soldes significatifs de gestion SYSCOHADA. */
function ManagementBalances({ period, version }: { period: any; version: number }) {
  const { data } = useLatest<any>(`/company/accounting/management-balances?from=${period.from}&to=${period.to}`, [version]);
  if (!data) return null;
  const strong = ['revenue', 'addedValue', 'ebitda', 'operatingResult', 'netResult'];
  return (
    <div className="card">
      <header><h2>Soldes significatifs de gestion</h2><span className="small muted">du {date(data.from)} au {date(data.to)}</span></header>
      <table className="vat" style={{ width: '100%' }}><tbody>
        {data.lines.map((l: any) => (
          <tr key={l.key}><td>{strong.includes(l.key) ? <b>{l.label}</b> : l.label}
            {l.plus || l.minus ? <div className="small muted">{[l.plus ? `produits ${money(l.plus)}` : '', l.minus ? `charges ${money(l.minus)}` : ''].filter(Boolean).join(' · ')}</div> : null}</td>
            <td className="n" style={{ color: l.value < 0 ? 'var(--crit)' : undefined, fontWeight: strong.includes(l.key) ? 700 : 400 }}>{money(l.value)}</td></tr>))}
      </tbody></table>
      <p className="small muted" style={{ marginBottom: 0 }}>Marge commerciale = ventes de marchandises − achats de marchandises ± variation de stock. Valeur ajoutée = chiffre d'affaires et autres produits − consommations (60 à 65). EBE = valeur ajoutée − charges de personnel.</p>
    </div>
  );
}

/** Clôture d'exercice : liste de contrôle, puis détermination du résultat et verrouillage. */
function Closing({ version, changed }: { version: number; changed: () => void }) {
  const { can, ctx } = useSession();
  const { data: years } = useLatest<any[]>('/company/accounting/fiscal-years', [version]);
  const [year, setYear] = useState<number | null>(null);
  const [ack, setAck] = useState(false);
  const { busy, error, run } = useAction();
  const selected = year ?? years?.find((y) => !y.closed && y.year < Number(today().slice(0, 4)))?.year ?? years?.[0]?.year ?? null;
  const { data: c } = useLatest<any>(selected ? `/company/accounting/fiscal-years/${selected}/checklist` : null, [version, selected]);
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ minWidth: 220 }}><header><h2>Exercices</h2></header>
        <div style={{ display: 'grid', gap: 6 }}>{years?.map((y) => (
          <button key={y.year} className={`btn sm${y.year === selected ? ' primary' : ''}`} style={{ justifyContent: 'space-between' }} onClick={() => { setYear(y.year); setAck(false); }}>
            {y.year} {y.closed ? <Pill tone="ok">Clôturé</Pill> : <Pill tone="warn">Ouvert</Pill>}</button>))}</div></div>
      {c && (
        <div className="card" style={{ flex: 1, minWidth: 320, display: 'grid', gap: 12 }}>
          <header><h2>Exercice {c.year}</h2><span className="small muted">du 01/01/{c.year} au 31/12/{c.year}</span></header>
          {c.closed ? <>
            <Alert kind="ok">Exercice clôturé le {date(c.closed.closedAt)} — {c.closed.result >= 0 ? 'bénéfice' : 'perte'} de <b>{money(Math.abs(c.closed.result))}</b>, porté au compte {c.closed.result >= 0 ? '131000' : '139000'}.</Alert>
            <p className="small muted" style={{ margin: 0 }}>Après l'assemblée qui approuve les comptes, passez l'affectation du résultat par une écriture d'OD (ex. 131000 vers 111000 réserve légale, 121000 report à nouveau ou 465000 dividendes).</p>
          </> : <>
            <div className="kpis"><div className="card kpi"><div className="l">Résultat provisoire</div><div className="v" style={{ color: c.result < 0 ? 'var(--crit)' : 'var(--ok)' }}>{money(c.result)}</div></div></div>
            {c.blocking.length > 0 && <Alert>{c.blocking.map((b: string) => <div key={b}>✕ {b}</div>)}</Alert>}
            {c.warnings.length > 0 && <Alert kind="warn">{c.warnings.map((w: string) => <div key={w}>⚠ {w}</div>)}</Alert>}
            {!c.blocking.length && !c.warnings.length && <Alert kind="ok">Tous les contrôles sont satisfaits.</Alert>}
            <Alert>{error}</Alert>
            {can('accounting.close') && !ctx?.readOnly && !c.blocking.length && <>
              {c.warnings.length > 0 && <label className="row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> J'ai pris connaissance des points ci-dessus et je clôture malgré tout.</label>}
              <div><button className="btn primary" disabled={busy || (c.warnings.length > 0 && !ack)} onClick={() => {
                if (window.confirm(`Clôturer l'exercice ${c.year} ? Le résultat sera porté au bilan et plus aucune écriture ne pourra être passée sur cet exercice. Cette opération est définitive.`)) {
                  run(async () => { await api(`/company/accounting/fiscal-years/${c.year}/close`, { body: { acknowledgeWarnings: ack } }); changed(); });
                }
              }}>Clôturer l'exercice {c.year}</button></div>
            </>}
            <p className="small muted" style={{ margin: 0 }}>La clôture solde les comptes de charges et de produits (classes 6, 7 et 8) dans le résultat (131000 ou 139000), puis verrouille l'exercice. La comptabilité étant continue, les soldes de clôture deviennent les soldes d'ouverture de l'exercice suivant.</p>
          </>}
        </div>
      )}
    </div>
  );
}
