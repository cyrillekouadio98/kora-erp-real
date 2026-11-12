'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { date, LOT_STATES, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';

export default function PayslipsPage() {
  return <Suspense><Payslips /></Suspense>;
}

/** Fiches de paie : les lots (une paie par mois) et la liste de toutes les fiches, filtrable. */
function Payslips() {
  const { can, ctx } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const writable = !ctx?.readOnly;
  const [view, setView] = useState(params.get('vue') === 'fiches' ? 'slips' : 'lots');
  const [runs, setRuns] = useState<any[] | null>(null);
  const [slips, setSlips] = useState<any[] | null>(null);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [f, setF] = useState({ q: '', period: '', state: params.get('etat') ?? '' });
  const { busy, error, run } = useAction();
  const load = useCallback(() => {
    api('/company/payroll/runs').then(setRuns, () => setRuns([]));
    api('/company/payroll/payslips').then(setSlips, () => setSlips([]));
  }, []);
  useEffect(() => { if (can('payroll.salaries')) load(); }, [load]); // eslint-disable-line

  if (!can('payroll.salaries')) return <Alert kind="info">Les bulletins de paie sont réservés aux personnes disposant de la permission sensible « voir les salaires et bulletins ».</Alert>;
  const lotState = (r: any) => (r.status === 'draft' ? 'draft' : r.paid === r.employees ? 'paid' : r.paid ? 'partly_paid' : 'validated');
  const shown = (slips ?? []).filter((s) => (!f.period || s.period === f.period)
    && (!f.q || `${s.name} ${s.number} ${s.department ?? ''} ${s.jobTitle ?? ''}`.toLowerCase().includes(f.q.toLowerCase()))
    && (!f.state || (f.state === 'draft' ? s.runStatus === 'draft' : f.state === 'unpaid' ? s.runStatus === 'validated' && !s.paidAt : !!s.paidAt)));
  const sum = (k: string) => shown.reduce((t, s) => t + s[k], 0);
  const periods = [...new Set((slips ?? []).map((s) => s.period))];

  return (
    <>
      <div className="page-head"><h1>Bulletins de paie</h1>
        {can('payroll.create') && writable && <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api('/company/payroll/runs', { body: { period } }); router.push(`/app/paie/fiches/${r.id}`); }); }}>
          <input className="input" type="month" value={period} max={new Date().toISOString().slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} aria-label="Mois de paie" style={{ width: 170 }} />
          <button className="btn primary" disabled={busy}>Préparer la paie</button></form>}
      </div>
      <Alert>{error}</Alert>
      <div className="seg" role="group" aria-label="Affichage" style={{ alignSelf: 'flex-start' }}>
        <button aria-pressed={view === 'lots'} onClick={() => setView('lots')}>Paies mensuelles</button>
        <button aria-pressed={view === 'slips'} onClick={() => setView('slips')}>Tous les bulletins</button>
      </div>

      {view === 'lots' && <div className="table-wrap"><table>
        <thead><tr><th>Mois</th><th>État</th><th className="n">Bulletins</th><th className="n">Brut</th><th className="n">Net à payer</th><th className="n">Coût employeur</th></tr></thead>
        <tbody>
          {runs?.map((r) => (
            <tr key={r.id}><td><Link href={`/app/paie/fiches/${r.id}`}><b style={{ textTransform: 'capitalize' }}>{r.label}</b></Link></td>
              <td><Pill tone={LOT_STATES[lotState(r)][1]}>{LOT_STATES[lotState(r)][0]}</Pill>{r.status === 'validated' && r.paid < r.employees && r.paid > 0 && <span className="small muted"> {r.paid}/{r.employees} payée(s)</span>}</td>
              <td className="n">{r.employees}</td><td className="n">{money(r.gross)}</td><td className="n">{money(r.net)}</td><td className="n">{money(r.employerCost)}</td></tr>
          ))}
          {runs && !runs.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucune paie. Enregistrez vos <Link href="/app/employes">employés</Link>, puis préparez la paie du mois.</td></tr>}
        </tbody>
      </table></div>}

      {view === 'slips' && <>
        <div className="row">
          <input className="input" type="search" placeholder="Employé, matricule, service…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 260 }} aria-label="Rechercher" />
          <select className="input" style={{ width: 'auto' }} value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} aria-label="Mois">
            <option value="">Tous les mois</option>{periods.map((p) => <option key={p} value={p}>{slips!.find((s) => s.period === p).label}</option>)}</select>
          <select className="input" style={{ width: 'auto' }} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} aria-label="État">
            <option value="">Tous les états</option><option value="draft">Brouillon</option><option value="unpaid">Validée, à payer</option><option value="paid">Payée</option></select>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Employé</th><th>Mois</th><th>État</th><th className="n">Brut</th><th className="n">Retenues salariales</th><th className="n">Net à payer</th><th className="n">Coût employeur</th><th /></tr></thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b><div className="small muted">{s.number}{s.jobTitle ? ` · ${s.jobTitle}` : ''}{s.department ? ` · ${s.department}` : ''}</div></td>
                <td style={{ textTransform: 'capitalize', whiteSpace: 'nowrap' }}>{s.label}</td>
                <td>{s.runStatus === 'draft' ? <Pill tone="warn">Brouillon</Pill> : s.paidAt ? <Pill tone="ok">Payée le {date(s.paidAt)}</Pill> : <Pill>Validée, à payer</Pill>}</td>
                <td className="n">{money(s.gross)}</td><td className="n">{money(s.employeeCharges)}</td><td className="n"><b>{money(s.net)}</b></td><td className="n">{money(s.employerCost)}</td>
                <td className="n"><Link className="btn sm" href={`/app/paie/fiches/${s.runId}?fiche=${s.id}`}>Bulletin</Link></td>
              </tr>))}
            {slips && !shown.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun bulletin dans cette sélection.</td></tr>}
          </tbody>
          {shown.length > 1 && <tfoot><tr><td colSpan={3}><b>Total · {shown.length} bulletins</b></td><td className="n"><b>{money(sum('gross'))}</b></td><td className="n"><b>{money(sum('employeeCharges'))}</b></td>
            <td className="n"><b>{money(sum('net'))}</b></td><td className="n"><b>{money(sum('employerCost'))}</b></td><td /></tr></tfoot>}
        </table></div>
      </>}
    </>
  );
}
