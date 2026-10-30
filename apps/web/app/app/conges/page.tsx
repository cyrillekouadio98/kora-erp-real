'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, LEAVE_STATUS, LEAVE_TYPES } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const dayList = (month: string) => {
  const n = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};

/** Congés : demandes à valider, soldes, planning du mois. */
export default function LeavePage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [pending, setPending] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [monthLeaves, setMonthLeaves] = useState<any[]>([]);
  const [modal, setModal] = useState<any>(null);
  const { busy, error, run, setError } = useAction();
  const load = useCallback(async () => {
    setPending(await api('/company/leave?status=pending'));
    setBalances(await api('/company/leave/balances'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api(`/company/leave?month=${month}`).then(setMonthLeaves); }, [month, pending]);
  const decide = (id: string, approve: boolean) => run(async () => { await api(`/company/leave/${id}/${approve ? 'approve' : 'refuse'}`, { body: {} }); await load(); });
  const days = dayList(month);
  const people = [...new Set(monthLeaves.filter((l) => ['approved', 'pending'].includes(l.status)).map((l) => l.employeeName))].sort();

  return (
    <>
      <div className="page-head"><h1>Congés</h1>
        {can('leave.create') && writable && <button className="btn primary" onClick={() => { setError(''); setModal({ type: 'request', employeeId: balances[0]?.employeeId ?? '', leaveType: 'annual', startDate: today(), endDate: today(), reason: '' }); }}>Saisir une absence</button>}</div>
      <Alert>{!modal && error}</Alert>

      <div className="card"><header><h2>Demandes à traiter</h2><Pill tone={pending.length ? 'warn' : 'ok'}>{pending.length}</Pill></header>
        {pending.length ? <div className="table-wrap"><table><tbody>{pending.map((r) => (
          <tr key={r.id}><td><b>{r.employeeName}</b><div className="small muted">{LEAVE_TYPES[r.type]}{r.reason ? ` · ${r.reason}` : ''}</div></td>
            <td style={{ whiteSpace: 'nowrap' }}>du {date(r.startDate)} au {date(r.endDate)}</td><td className="n">{r.days} j</td>
            <td className="n">{can('leave.validate') && writable && <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
              <button className="btn sm" disabled={busy} onClick={() => decide(r.id, false)}>Refuser</button>
              <button className="btn sm primary" disabled={busy} onClick={() => decide(r.id, true)}>Valider</button></div>}</td></tr>))}</tbody></table></div>
          : <p className="small muted" style={{ margin: 0 }}>Aucune demande en attente.</p>}
      </div>

      <div className="card"><header><h2>Planning des absences</h2><Field label="Mois" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></header>
        {people.length ? <div style={{ overflowX: 'auto' }}><table className="planning" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr><th style={{ textAlign: 'left', minWidth: 140 }}></th>{days.map((d) => <th key={d} style={{ padding: '2px 3px', color: new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? 'var(--muted)' : undefined }}>{Number(d.slice(8))}</th>)}</tr></thead>
          <tbody>{people.map((p) => (
            <tr key={p}><td style={{ whiteSpace: 'nowrap', paddingRight: 8 }}>{p}</td>{days.map((d) => {
              const l = monthLeaves.find((x) => x.employeeName === p && ['approved', 'pending'].includes(x.status) && x.startDate <= d && x.endDate >= d);
              return <td key={d} title={l ? `${LEAVE_TYPES[l.type]} — ${LEAVE_STATUS[l.status][0]}` : ''} style={{ width: 22, height: 22, border: '1px solid var(--line)',
                background: l ? (l.status === 'approved' ? 'var(--accent)' : 'var(--warn-bg)') : new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? 'var(--surface-2)' : undefined }} />;
            })}</tr>))}</tbody></table></div>
          : <p className="small muted" style={{ margin: 0 }}>Personne n'est absent ce mois-ci.</p>}
        <p className="small muted" style={{ marginBottom: 0 }}><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--accent)' }} /> validé · <span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--warn-bg)', border: '1px solid var(--warn)' }} /> en attente</p>
      </div>

      <div className="card"><header><h2>Soldes de congés payés</h2><span className="small muted">jours ouvrables</span></header>
        <div className="table-wrap"><table>
          <thead><tr><th>Employé</th><th className="n">Report</th><th className="n">Acquis</th><th className="n">Pris</th><th className="n">En attente</th><th className="n">Disponible</th><th></th></tr></thead>
          <tbody>{balances.map((b) => (
            <tr key={b.employeeId}><td><b>{b.name}</b> {b.linked ? <Pill tone="ok">Espace activé</Pill> : <Pill>Sans espace</Pill>}<div className="small muted">{b.number} · {b.months} mois de service</div></td>
              <td className="n">{b.opening}</td><td className="n">{b.accrued}</td><td className="n">{b.taken}</td><td className="n">{b.pending}</td><td className="n"><b>{b.available}</b></td>
              <td className="n">{can('leave.admin') && writable && <button className="btn sm" onClick={() => { setError(''); setModal({ type: 'opening', employee: b, balance: b.opening, date: '' }); }}>Report</button>}</td></tr>))}</tbody>
        </table></div></div>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (modal.type === 'request') await api('/company/leave', { body: { employeeId: modal.employeeId, type: modal.leaveType, startDate: modal.startDate, endDate: modal.endDate, reason: modal.reason || null } });
              else await api(`/company/leave/balances/${modal.employee.employeeId}`, { method: 'PATCH', body: { balance: Number(modal.balance), date: modal.date || null } });
              setModal(null); await load();
            });
          }}>
            {modal.type === 'request' ? <>
              <h2>Saisir une absence</h2><Alert>{error}</Alert>
              <label className="field">Employé<select className="input" value={modal.employeeId} onChange={(e) => setModal({ ...modal, employeeId: e.target.value })}>{balances.map((b) => <option key={b.employeeId} value={b.employeeId}>{b.name}</option>)}</select></label>
              <label className="field">Type<select className="input" value={modal.leaveType} onChange={(e) => setModal({ ...modal, leaveType: e.target.value })}>{Object.entries(LEAVE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <div className="grid2"><Field label="Du" type="date" required value={modal.startDate} onChange={(e) => setModal({ ...modal, startDate: e.target.value })} />
                <Field label="Au (inclus)" type="date" required min={modal.startDate} value={modal.endDate} onChange={(e) => setModal({ ...modal, endDate: e.target.value })} /></div>
              <Field label="Motif (facultatif)" value={modal.reason} onChange={(e) => setModal({ ...modal, reason: e.target.value })} />
              <p className="small muted" style={{ margin: 0 }}>La demande est créée en attente ; elle doit ensuite être validée. Un congé sans solde validé est repris comme absence dans la paie du mois.</p>
            </> : <>
              <h2>Report de congés — {modal.employee.name}</h2><Alert>{error}</Alert>
              <p className="small muted" style={{ margin: 0 }}>Jours de congés encore dus à l'employé au moment où vous commencez à utiliser Kora, et date à partir de laquelle Kora calcule l'acquisition (vide : date d'embauche).</p>
              <Field label="Jours reportés" type="number" min={0} step={0.5} required value={modal.balance} onChange={(e) => setModal({ ...modal, balance: e.target.value })} />
              <Field label="Acquisition calculée à partir du" type="date" value={modal.date} onChange={(e) => setModal({ ...modal, date: e.target.value })} />
            </>}
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
