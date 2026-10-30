'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { CONTRACTS, date, LEAVE_STATUS, LEAVE_TYPES, money, periodLabel } from '@/lib/format';
import { useSession } from '@/components/session';
import { Payslip } from '@/components/payslip';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);

/** Espace personnel du salarié : sa fiche, ses bulletins, ses congés. */
export default function MySpacePage() {
  const { can, ctx } = useSession();
  const [me, setMe] = useState<any>(null);
  const [slips, setSlips] = useState<any[]>([]);
  const [slip, setSlip] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => run(async () => {
    setMe(await api('/company/me'));
    if (ctx?.permissions.includes('payroll.self')) setSlips(await api('/company/me/payslips').catch(() => []));
  }), [ctx]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  if (!me) return <><div className="page-head"><h1>Mon espace</h1></div><Alert>{error || null}</Alert></>;
  const b = me.balance;
  return (
    <>
      <div className="page-head"><h1>Mon espace</h1>
        {can('leave.self') && <button className="btn primary" onClick={() => { setError(''); setForm({ type: 'annual', startDate: today(), endDate: today(), reason: '' }); }}>Demander un congé</button>}</div>
      <Alert>{!form && error}</Alert>
      <div className="card"><header><h2>{me.employee.name}</h2><span className="small muted">{me.employee.number}</span></header>
        <div className="small">{[me.employee.jobTitle, me.employee.department].filter(Boolean).join(' · ')} — {CONTRACTS[me.employee.contractType]}, entré(e) le {date(me.employee.hireDate)}{me.employee.cnpsNumber ? ` · CNPS ${me.employee.cnpsNumber}` : ''}</div></div>

      <div className="kpis">
        <div className="card kpi"><div className="l">Congés disponibles</div><div className="v">{b.available} j</div><div className="small muted">ouvrables</div></div>
        <div className="card kpi"><div className="l">Acquis</div><div className="v">{b.accrued} j</div><div className="small muted">{b.months} mois × {String(b.rate).replace('.', ',')} j{b.opening ? ` + report ${b.opening} j` : ''}</div></div>
        <div className="card kpi"><div className="l">Pris</div><div className="v">{b.taken} j</div></div>
        <div className="card kpi"><div className="l">En attente de validation</div><div className="v">{b.pending} j</div></div>
      </div>

      <div className="card"><header><h2>Mes demandes de congé</h2></header>
        <div className="table-wrap"><table>
          <thead><tr><th>Type</th><th>Du</th><th>Au</th><th className="n">Jours</th><th>Statut</th><th></th></tr></thead>
          <tbody>{me.requests.map((r: any) => (
            <tr key={r.id}><td>{LEAVE_TYPES[r.type]}{r.reason && <div className="small muted">{r.reason}</div>}</td><td>{date(r.startDate)}</td><td>{date(r.endDate)}</td><td className="n">{r.days}</td>
              <td><Pill tone={LEAVE_STATUS[r.status][1]}>{LEAVE_STATUS[r.status][0]}</Pill>{r.decisionNote && <div className="small muted">{r.decisionNote}</div>}</td>
              <td className="n">{r.status === 'pending' && can('leave.self') && <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api(`/company/me/leave/${r.id}/cancel`, { body: {} }); await load(); })}>Annuler</button>}</td></tr>))}
            {!me.requests.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center' }}>Aucune demande.</td></tr>}</tbody>
        </table></div></div>

      {can('payroll.self') && <div className="card"><header><h2>Mes bulletins de paie</h2></header>
        <div className="table-wrap"><table>
          <thead><tr><th>Mois</th><th className="n">Brut</th><th className="n">Net</th><th>Paiement</th><th></th></tr></thead>
          <tbody>{slips.map((s) => (
            <tr key={s.id}><td style={{ textTransform: 'capitalize' }}>{periodLabel(s.period)}</td><td className="n">{money(s.gross)}</td><td className="n"><b>{money(s.net)}</b></td>
              <td>{s.paidAt ? <Pill tone="ok">Payé le {date(s.paidAt)}</Pill> : <Pill tone="warn">À venir</Pill>}</td>
              <td className="n"><button className="btn sm" onClick={() => api(`/company/me/payslips/${s.id}`).then(setSlip)}>Voir</button></td></tr>))}
            {!slips.length && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center' }}>Aucun bulletin pour l'instant.</td></tr>}</tbody>
        </table></div></div>}

      {slip && <div className="modal-back" onClick={() => setSlip(null)}><div className="modal" style={{ width: 'min(820px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <Payslip slip={slip.slip} label={periodLabel(slip.period)} company={{ ...slip.company }} onClose={() => setSlip(null)} /></div></div>}

      {form && (
        <div className="modal-back" onClick={() => setForm(null)}>
          <form className="modal" style={{ width: 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { await api('/company/me/leave', { body: { ...form, reason: form.reason || null } }); setForm(null); await load(); });
          }}>
            <h2>Demander un congé</h2>
            <p className="small muted" style={{ margin: 0 }}>Solde disponible : <b>{b.available - b.pending} jour(s)</b> (demandes en attente déduites). Seuls les jours ouvrables (lundi à samedi, hors fériés) sont décomptés.</p>
            <Alert>{error}</Alert>
            <label className="field">Type<select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(LEAVE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <div className="grid2">
              <Field label="Du" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate < e.target.value ? e.target.value : form.endDate })} />
              <Field label="Au (inclus)" type="date" required min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </div>
            <Field label="Motif (facultatif)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            <div className="row"><button className="btn primary" disabled={busy}>Envoyer la demande</button><button type="button" className="btn" onClick={() => setForm(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
