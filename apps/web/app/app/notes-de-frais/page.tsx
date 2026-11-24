'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, EXPENSE_CATEGORIES, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const CATEGORIES = ['transport', 'fuel', 'telecom', 'supplies', 'maintenance', 'other_expense'];
const STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | undefined]> = { submitted: ['À valider', 'warn'], approved: ['Validée, à rembourser', undefined], rejected: ['Refusée', 'crit'], paid: ['Remboursée', 'ok'] };
const today = () => new Date().toISOString().slice(0, 10);

/** Réduit la photo d'un ticket (1 600 px au plus, JPEG) ; un PDF passe tel quel. */
function readReceipt(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.type === 'application/pdf') {
      if (file.size > 700_000) return reject(new Error('PDF trop lourd (700 Ko au plus).'));
      const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Fichier illisible.')); r.readAsDataURL(file); return;
    }
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      const g = canvas.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); g.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src); resolve(canvas.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => reject(new Error('Photo illisible : JPEG, PNG ou PDF.'));
    img.src = URL.createObjectURL(file);
  });
}

/** Notes de frais : je déclare mes dépenses ; un responsable les valide et les rembourse. */
export default function ExpensesPage() {
  const { has, ctx } = useSession();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [notice, setNotice] = useState('');
  const { busy, error, run, setError } = useAction();
  const load = useCallback(async () => setData(await api(`/company/expenses?scope=${scope}`)), [scope]);
  useEffect(() => { if (has('expenses')) run(load); }, [load]); // eslint-disable-line
  if (!has('expenses')) return <Alert kind="warn">Les notes de frais ne sont pas activées pour votre entreprise. Contactez Kora ERP pour les activer.</Alert>;
  const act = (fn: () => Promise<unknown>, msg: string) => run(async () => { await fn(); setNotice(msg); await load(); });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<any>('/company/expenses', { body: { date: form.date, category: form.category, label: form.label, amount: Number(form.amount), receipt: form.receipt ?? null } });
      setForm(null); setNotice(`Note ${r.code} envoyée pour validation.`); await load();
    });
  };
  const openPay = (c: any) => run(async () => { if (!accounts.length) setAccounts((await api<any[]>('/company/treasury/accounts')).filter((a) => !a.archivedAt)); setPay({ claim: c, accountId: '', date: today() }); });
  const write = !ctx?.readOnly;
  return (
    <>
      <div className="page-head"><h1>Notes de frais</h1>
        <div className="row">
          {data?.manager && <><button className={`btn sm${scope === 'mine' ? ' primary' : ''}`} onClick={() => setScope('mine')}>Mes notes</button><button className={`btn sm${scope === 'all' ? ' primary' : ''}`} onClick={() => setScope('all')}>Toutes (à valider)</button></>}
          {write && <button className="btn primary" onClick={() => { setNotice(''); setForm({ date: today(), category: 'transport', label: '', amount: '', receipt: null, file: '' }); }}>+ Nouvelle note de frais</button>}
        </div></div>
      <p className="muted" style={{ margin: 0 }}>Déclarez ici les dépenses avancées de votre poche pour l&apos;entreprise (taxi, carburant, crédit téléphone…), avec la photo du ticket. Un responsable la valide, puis vous rembourse ; le remboursement est enregistré en trésorerie.</p>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      {data && <div className="kpis">
        <div className="card kpi"><div className="l">À valider</div><div className="v">{money(data.totals.submitted)}</div></div>
        <div className="card kpi"><div className="l">Validées, à rembourser</div><div className="v">{money(data.totals.approved)}</div></div>
        <div className="card kpi"><div className="l">Remboursées</div><div className="v">{money(data.totals.paid)}</div></div>
      </div>}
      {data && <div className="table-wrap"><table>
        <thead><tr><th>N°</th>{scope === 'all' && <th>Déclarée par</th>}<th>Date</th><th>Dépense</th><th className="n">Montant</th><th>Justificatif</th><th>État</th><th /></tr></thead>
        <tbody>{data.claims.length ? data.claims.map((c: any) => (
          <tr key={c.id}><td>{c.code}</td>{scope === 'all' && <td>{c.user}</td>}<td>{date(c.date)}</td>
            <td>{c.label}<div className="small muted">{EXPENSE_CATEGORIES[c.category] ?? c.category}</div></td><td className="n">{money(c.amount)}</td>
            <td>{c.receipt ? <a href={`/api${c.receipt}`} target="_blank" rel="noreferrer">Voir</a> : <span className="small muted">aucun</span>}</td>
            <td><Pill tone={STATUS[c.status][1]}>{STATUS[c.status][0]}</Pill>{c.rejectReason && <div className="small muted">{c.rejectReason}</div>}{c.decidedBy && c.status !== 'submitted' && <div className="small muted">par {c.decidedBy}</div>}</td>
            <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
              {write && scope === 'mine' && c.status === 'submitted' && <button className="btn sm danger" disabled={busy} onClick={() => act(() => api(`/company/expenses/${c.id}`, { method: 'DELETE' }), `Note ${c.code} retirée.`)}>Retirer</button>}
              {write && data.manager && scope === 'all' && c.status === 'submitted' && <>
                <button className="btn sm primary" disabled={busy} onClick={() => act(() => api(`/company/expenses/${c.id}/approve`, { body: {} }), `Note ${c.code} validée.`)}>Valider</button>
                <button className="btn sm" disabled={busy} onClick={() => { const reason = window.prompt(`Motif du refus de ${c.code} :`); if (reason) act(() => api(`/company/expenses/${c.id}/reject`, { body: { reason } }), `Note ${c.code} refusée.`); }}>Refuser</button></>}
              {write && data.manager && scope === 'all' && c.status === 'approved' && <button className="btn sm primary" disabled={busy} onClick={() => openPay(c)}>Rembourser</button>}
            </div></td></tr>
        )) : <tr><td colSpan={8} className="muted">{scope === 'all' ? 'Aucune note de frais.' : "Vous n'avez déclaré aucune note de frais."}</td></tr>}</tbody>
      </table></div>}

      {form && <div className="modal-back" onClick={() => setForm(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <h2>Nouvelle note de frais</h2>
        <div className="grid2">
          <Field label="Date de la dépense" type="date" required max={today()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <label className="field">Catégorie<select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((k) => <option key={k} value={k}>{EXPENSE_CATEGORIES[k]}</option>)}</select></label>
          <Field label="Description" required minLength={2} placeholder="Ex. taxi livraison client Cocody" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <Field label="Montant TTC (FCFA)" type="number" min={1} step="any" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <label className="field">Justificatif (photo du ticket ou PDF)
          <input className="input" type="file" accept="image/*,application/pdf" capture="environment" onChange={async (e) => {
            const f = e.target.files?.[0]; if (!f) return setForm({ ...form, receipt: null });
            try { setForm({ ...form, receipt: await readReceipt(f) }); setError(''); } catch (err) { setError((err as Error).message); }
          }} /></label>
        {form.receipt?.startsWith('data:image') && <img src={form.receipt} alt="Justificatif" style={{ maxHeight: 160, objectFit: 'contain', alignSelf: 'start' }} />}
        <div className="row"><button className="btn primary" disabled={busy}>Envoyer pour validation</button><button type="button" className="btn" onClick={() => setForm(null)}>Annuler</button></div>
      </form></div>}

      {pay && <div className="modal-back" onClick={() => setPay(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); act(async () => { await api(`/company/expenses/${pay.claim.id}/pay`, { body: { accountId: pay.accountId, date: pay.date } }); setPay(null); }, `Note ${pay.claim.code} remboursée.`); }} style={{ display: 'grid', gap: 10 }}>
        <h2>Rembourser {pay.claim.code} — {money(pay.claim.amount)}</h2>
        <p className="small muted" style={{ margin: 0 }}>{pay.claim.user} · {pay.claim.label}. La dépense est enregistrée sur le compte choisi, dans la catégorie « {EXPENSE_CATEGORIES[pay.claim.category]} ».</p>
        <label className="field">Payée depuis<select className="input" required value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })}>
          <option value="">— Choisir —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance)})</option>)}</select></label>
        <Field label="Date du remboursement" type="date" required max={today()} value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
        <div className="row"><button className="btn primary" disabled={busy}>Rembourser</button><button type="button" className="btn" onClick={() => setPay(null)}>Annuler</button></div>
      </form></div>}
    </>
  );
}
