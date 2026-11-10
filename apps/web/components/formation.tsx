'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);

const FORMS: Record<string, string> = {
  SA: 'SA — Société anonyme', SAS: 'SAS — Société par actions simplifiée', SASU: 'SASU — SAS unipersonnelle', SARL: 'SARL — Société à responsabilité limitée',
  SARLU: 'SARLU — SARL unipersonnelle', SNC: 'SNC — Société en nom collectif', SCS: 'SCS — Société en commandite simple', GIE: 'GIE — Groupement d’intérêt économique', other: 'Autre forme',
};
const FULL = ['SARL', 'SARLU'];
const QUARTER = ['SA', 'SAS', 'SASU'];

const STEPS: Record<string, { title: string; help: string }> = {
  subscription: { title: 'Souscription', help: 'Promesse d’apport : les apporteurs deviennent débiteurs du capital qu’ils ont souscrit.' },
  call: { title: 'Appel du capital', help: 'Les apports en nature et la part libérée du numéraire sont appelés ; on constate en même temps que ce capital est appelé.' },
  contribution: { title: 'Réalisation des apports', help: 'Les biens apportés entrent à l’actif et le numéraire est versé, en banque ou chez le notaire. Le capital devient appelé et versé.' },
  release: { title: 'Déblocage des fonds par le notaire', help: 'Après l’immatriculation au RCCM, le notaire vire les fonds sur le compte bancaire : le compte 4711 est soldé par la banque.' },
  uncalled: { title: 'Capital non appelé', help: 'Le numéraire non libéré est porté au compte 109 en attendant son appel.' },
  fees: { title: 'Frais de constitution', help: 'En SYSCOHADA révisé, ils sont passés en charges (on ne les immobilise plus) : honoraires, droits d’enregistrement, annonces légales, greffe.' },
  balance_call: { title: 'Appel du solde du capital', help: 'Plus tard, appel de tout ou partie du capital non appelé : on reprend l’appel en soldant le compte 109.' },
  balance_payment: { title: 'Versement du capital appelé', help: 'Les apporteurs versent en banque le solde appelé : le capital devient appelé et versé.' },
};
const FEE_PRESETS = [
  { account: '632400', label: 'Honoraires (notaire, conseil)' }, { account: '646000', label: 'Droits d’enregistrement' },
  { account: '627000', label: 'Annonces légales' }, { account: '632500', label: 'Frais de greffe et formalités' },
];
const JOURNAL_NAME: Record<string, string> = { OD: 'Opérations diverses', TR: 'Trésorerie' };

/** Constitution de la société : la fiche, puis chaque étape et ses écritures (journaux OD et TR). */
export function Formation({ accounts, changed }: { accounts: any[]; changed: () => void }) {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [banks, setBanks] = useState<any[]>([]);
  const { busy, error, run } = useAction();

  const load = useCallback(() => api<any>('/company/accounting/formation').then((d) => {
    setData(d);
    const f = d.formation;
    setForm(f ? { ...f, capital: String(f.capital), cashPaid: String(f.cashPaid), nature: f.nature.map((n: any) => ({ ...n, amount: String(n.amount) })) }
      : { legalForm: 'SA', date: today(), capital: '', nature: [], cashPaid: '', deposit: 'bank', bankAccountId: '' });
  }), []);
  useEffect(() => { run(load); api<any[]>('/company/treasury/accounts').then((a) => setBanks(a.filter((x) => !x.archivedAt)), () => {}); }, [load]); // eslint-disable-line
  const refresh = async () => { await load(); changed(); };

  if (!data || !form) return <div className="card muted">Chargement…</div>;
  const started = data.steps.some((s: any) => s.key !== 'fees' && s.done.length);
  const editable = writable && can('accounting.create') && !started;
  const natureTotal = form.nature.reduce((s: number, n: any) => s + Number(n.amount || 0), 0);
  const cash = Math.max(0, Number(form.capital || 0) - natureTotal);
  const full = FULL.includes(form.legalForm);
  const assets = accounts.filter((a) => /^[23]/.test(a.code) && !a.archivedAt && !/^28|^29|^39/.test(a.code));
  const setNature = (i: number, patch: any) => setForm({ ...form, nature: form.nature.map((n: any, j: number) => (j === i ? { ...n, ...patch } : n)) });
  const bank = banks.find((b) => b.id === form.bankAccountId);

  const save = () => run(async () => {
    await api('/company/accounting/formation', { method: 'PUT', body: {
      legalForm: form.legalForm, date: form.date, capital: Number(form.capital), cashPaid: full ? cash : Number(form.cashPaid || 0), deposit: form.deposit,
      bankAccountId: form.bankAccountId || null, nature: form.nature.filter((n: any) => n.account && Number(n.amount) > 0).map((n: any) => ({ account: n.account, label: n.label, amount: Number(n.amount) })),
    } });
    await refresh();
  });
  const fig = data.figures;

  return (
    <div className="stack" style={{ display: 'grid', gap: 16 }}>
      <section className="card">
        <header className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Fiche de constitution</h2>
          {started && <Pill tone="ok">Écritures passées : fiche verrouillée</Pill>}
        </header>
        <p className="small muted">Renseignez la forme juridique, le capital et la répartition des apports : Kora prépare les écritures de chaque étape selon le SYSCOHADA révisé.
          Les écritures sans mouvement de banque vont au journal des opérations diverses (OD), les versements et les frais réglés en banque au journal de trésorerie (TR).</p>
        <Alert>{error}</Alert>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          <div className="grid2">
            <label className="field">Forme juridique
              <select className="input" value={form.legalForm} onChange={(e) => setForm({ ...form, legalForm: e.target.value })}>{Object.entries(FORMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <Field label="Date de constitution" type="date" required max={today()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <Field label="Capital social (FCFA)" type="number" min={1} step="any" required value={form.capital} onChange={(e) => setForm({ ...form, capital: e.target.value })} placeholder="10 000 000" />
          </div>

          <div>
            <b>Apports en nature</b> <span className="small muted">— biens apportés (matériel, véhicule, local, marchandises)</span>
            {form.nature.length > 0 && <div className="table-wrap"><table className="lines">
              <thead><tr><th>Compte</th><th>Désignation</th><th className="n">Valeur d’apport</th><th></th></tr></thead>
              <tbody>{form.nature.map((n: any, i: number) => (
                <tr key={i}>
                  <td><select className="input" value={n.account} onChange={(e) => setNature(i, { account: e.target.value })} aria-label={`Compte de l’apport ${i + 1}`}>
                    <option value="">Choisir…</option>{assets.map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}</select></td>
                  <td><input className="input" value={n.label} placeholder="Ex. Matériel informatique" onChange={(e) => setNature(i, { label: e.target.value })} aria-label={`Désignation de l’apport ${i + 1}`} /></td>
                  <td><input className="input n" type="number" min="0" step="any" value={n.amount} onChange={(e) => setNature(i, { amount: e.target.value })} aria-label={`Valeur de l’apport ${i + 1}`} style={{ width: 140 }} /></td>
                  <td>{editable && <button type="button" className="btn sm danger" onClick={() => setForm({ ...form, nature: form.nature.filter((_: any, j: number) => j !== i) })} aria-label={`Retirer l’apport ${i + 1}`}>✕</button>}</td>
                </tr>))}</tbody>
            </table></div>}
            {editable && <div><button type="button" className="btn sm" onClick={() => setForm({ ...form, nature: [...form.nature, { account: '244000', label: '', amount: '' }] })}>+ Apport en nature</button></div>}
          </div>

          <dl className="stock-meta small" style={{ margin: 0 }}>
            <dt>Apports en nature</dt><dd>{money(natureTotal)}</dd>
            <dt>Apports en numéraire</dt><dd><b>{money(cash)}</b></dd>
          </dl>

          {cash > 0 && <div className="grid2">
            {full ? <p className="small" style={{ margin: 0, alignSelf: 'end' }}>En {form.legalForm}, le capital est <b>entièrement libéré</b> à la constitution : {money(cash)} versés.</p>
              : <Field label={`Numéraire libéré à la constitution${QUARTER.includes(form.legalForm) ? ` (au moins ${money(Math.ceil(cash / 4))})` : ''}`} type="number" min={0} max={cash} step="any" required
                value={form.cashPaid} onChange={(e) => setForm({ ...form, cashPaid: e.target.value })} />}
            <label className="field">Dépôt des fonds
              <select className="input" value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })}>
                <option value="bank">Compte bancaire (compte bloqué)</option><option value="notary">Chez le notaire (compte 4711, puis déblocage)</option></select></label>
            <label className="field">Compte bancaire de la société
              <select className="input" value={form.bankAccountId ?? ''} onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}>
                <option value="">Choisir…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.ledgerCode})</option>)}</select></label>
          </div>}
        </fieldset>
        {editable && <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={busy} onClick={save}>Enregistrer la fiche</button></div>}
      </section>

      {fig && <section className="card">
        <h2 style={{ marginTop: 0 }}>Situation du capital</h2>
        <dl className="stock-meta small" style={{ margin: 0 }}>
          <dt>Capital souscrit</dt><dd><b>{money(data.formation.capital)}</b> ({FORMS[data.formation.legalForm]?.split(' — ')[0]})</dd>
          <dt>Appelé à la constitution</dt><dd>{money(fig.called)}</dd>
          <dt>Non appelé (109)</dt><dd>{money(fig.remainingToCall)}{fig.balanceCalled > 0 && <span className="muted"> — {money(fig.balanceCalled)} appelés depuis</span>}</dd>
          {fig.calledUnpaid > 0 && <><dt>Appelé, non versé</dt><dd>{money(fig.calledUnpaid)}</dd></>}
        </dl>
      </section>}

      {data.steps.filter((s: any) => !(s.blocker?.startsWith('Sans objet') && !s.done.length)).map((s: any, i: number) => <Step key={s.key} n={i + 1} s={s} bank={bank} banks={banks} accounts={accounts} formation={data.formation} figures={fig} onDone={refresh} />)}
    </div>
  );
}

function Preview({ ops, bank }: { ops: any[]; bank?: any }) {
  if (!ops.length) return null;
  return <>{ops.map((o, k) => (
    <div key={k} className="table-wrap" style={{ marginTop: 8 }}><table>
      <thead><tr><th colSpan={5}><Pill>{o.journal}</Pill> {JOURNAL_NAME[o.journal]} — {o.label}</th></tr>
        <tr><th>Compte</th><th>Intitulé</th><th className="n">Débit</th><th className="n">Crédit</th></tr></thead>
      <tbody>{o.lines.map((l: any, j: number) => (
        <tr key={j}><td><code className="k">{l.account === 'banque' ? bank?.ledgerCode ?? '52…' : l.account}</code></td>
          <td>{l.account === 'banque' ? bank?.name ?? 'Banque' : l.name || l.label}</td>
          <td className="n">{l.debit ? money(l.debit) : ''}</td><td className="n">{l.credit ? money(l.credit) : ''}</td></tr>))}</tbody>
    </table></div>))}</>;
}

function Step({ n, s, bank, banks, accounts, formation, figures, onDone }: { n: number; s: any; bank?: any; banks: any[]; accounts: any[]; formation: any; figures: any; onDone: () => Promise<void> }) {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const meta = STEPS[s.key];
  const [d, setD] = useState(formation?.date ?? today());
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [fees, setFees] = useState<any[]>(FEE_PRESETS.map((p) => ({ ...p, amount: '' })));
  const { busy, error, run } = useAction();
  useEffect(() => { if (formation?.date) setD(s.key.startsWith('balance') || s.key === 'fees' || s.key === 'release' ? today() : formation.date); }, [formation?.date, s.key]);
  const charges = accounts.filter((a) => a.code.startsWith('6') && !a.archivedAt);
  const isNa = s.blocker?.startsWith('Sans objet');
  if (isNa && !s.done.length) return null;

  const max = s.key === 'balance_call' ? figures?.remainingToCall : s.key === 'balance_payment' ? figures?.calledUnpaid : 0;
  const canPass = writable && can('accounting.validate') && !s.blocker;
  const pass = () => run(async () => {
    const body: any = { date: d };
    if (s.key === 'balance_call' || s.key === 'balance_payment') body.amount = Number(amount || max);
    if (s.key === 'fees') { body.fees = fees.filter((f) => f.account && Number(f.amount) > 0).map((f) => ({ account: f.account, label: f.label, amount: Number(f.amount) })); body.accountId = accountId || formation?.bankAccountId || null; }
    await api(`/company/accounting/formation/steps/${s.key}`, { body });
    setAmount(''); setFees(FEE_PRESETS.map((p) => ({ ...p, amount: '' })));
    await onDone();
  });
  const cancel = (id: string) => run(async () => { await api(`/company/accounting/formation/steps/${id}/cancel`, { body: {} }); await onDone(); });
  const feeBank = banks.find((b) => b.id === (accountId || formation?.bankAccountId));
  const feePreview = fees.filter((f) => f.account && Number(f.amount) > 0).map((f) => ({ journal: 'TR', label: `Frais de constitution — ${f.label}`, lines: [
    { account: f.account, name: accounts.find((a) => a.code === f.account)?.name, debit: Number(f.amount), credit: 0 }, { account: 'banque', debit: 0, credit: Number(f.amount) }] }));
  const repeatable = ['fees', 'balance_call', 'balance_payment'].includes(s.key);

  return (
    <section className="card">
      <header className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{n}. {meta.title}</h2>
        {s.done.length > 0 ? <Pill tone="ok">Passée</Pill> : s.blocker ? <Pill>En attente</Pill> : <Pill tone="warn">À passer</Pill>}
      </header>
      <p className="small muted" style={{ marginTop: 6 }}>{meta.help}</p>
      <Alert>{error}</Alert>

      {s.done.map((x: any) => (
        <div key={x.id} className="row small" style={{ gap: 8, padding: '6px 0', borderTop: '1px solid var(--line, #e5e7eb)' }}>
          <span>Passée le <b>{date(x.date)}</b>{repeatable && <> · {money(x.amount)}</>}</span>
          {x.entries.map((e: any) => <code key={e.id} className="k" title={JOURNAL_NAME[e.journal]}>{e.number}</code>)}
          {x.cancellable && writable && can('accounting.reverse') && <button className="btn sm danger" style={{ marginLeft: 'auto' }} disabled={busy}
            onClick={() => { if (confirm('Annuler cette étape ? Ses écritures et ses mouvements de trésorerie seront contre-passés.')) cancel(x.id); }}>Annuler l’étape</button>}
        </div>
      ))}

      {s.done.length > 0 && !repeatable && s.preview.length > 0 && <details className="small"><summary style={{ cursor: 'pointer' }}>Voir les écritures</summary><Preview ops={s.preview} bank={bank} /></details>}

      {s.blocker && !isNa && (!s.done.length || repeatable) && <p className="small muted" style={{ margin: 0 }}>{s.blocker}</p>}

      {!s.blocker && (!s.done.length || repeatable) && <>
        {s.key === 'fees' ? <>
          <div className="table-wrap"><table className="lines">
            <thead><tr><th>Compte de charge</th><th>Libellé</th><th className="n">Montant</th><th></th></tr></thead>
            <tbody>{fees.map((f, i) => (
              <tr key={i}>
                <td><select className="input" value={f.account} onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))} aria-label={`Compte du frais ${i + 1}`}>
                  <option value="">Choisir…</option>{charges.map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}</select></td>
                <td><input className="input" value={f.label} onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={`Libellé du frais ${i + 1}`} /></td>
                <td><input className="input n" type="number" min="0" step="any" value={f.amount} placeholder="0" onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={`Montant du frais ${i + 1}`} style={{ width: 130 }} /></td>
                <td><button type="button" className="btn sm danger" onClick={() => setFees(fees.filter((_, j) => j !== i))} aria-label={`Retirer le frais ${i + 1}`}>✕</button></td>
              </tr>))}</tbody>
            <tfoot><tr><td colSpan={2}><button type="button" className="btn sm" onClick={() => setFees([...fees, { account: '', label: '', amount: '' }])}>+ Frais</button></td>
              <td className="n"><b>{money(fees.reduce((t, f) => t + Number(f.amount || 0), 0))}</b></td><td></td></tr></tfoot>
          </table></div>
          <Preview ops={feePreview} bank={feeBank} />
        </> : <Preview ops={s.preview} bank={bank} />}
        {(s.key === 'balance_call' || s.key === 'balance_payment') && <p className="small muted" style={{ margin: '6px 0 0' }}>Aperçu pour le montant restant ({money(max)}).</p>}

        {canPass && <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div style={{ width: 170 }}><Field label="Date de l’écriture" type="date" max={today()} value={d} onChange={(e) => setD(e.target.value)} /></div>
          {(s.key === 'balance_call' || s.key === 'balance_payment') && <div style={{ width: 180 }}><Field label="Montant" type="number" min={1} max={max} step="any" placeholder={String(max)} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}
          {s.key === 'fees' && <label className="field" style={{ minWidth: 220 }}>Payés depuis
            <select className="input" value={accountId || formation?.bankAccountId || ''} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choisir…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.ledgerCode})</option>)}</select></label>}
          <button className="btn primary" disabled={busy || (s.key === 'fees' && !feePreview.length)} onClick={pass}>Passer l’écriture</button>
        </div>}
      </>}
    </section>
  );
}
