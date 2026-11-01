'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { CONTRACTS, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill } from '@/components/ui';

const KINDS: [string, string][] = [['annual', 'Congés payés'], ['sick', 'Maladie'], ['maternity', 'Maternité'], ['family_event', 'Permissions'], ['unpaid', 'Sans solde'], ['other', 'Autres']];
const days = (n?: number | null) => (n ? n.toLocaleString('fr-FR') : '');

/**
 * Prestations du mois : jours ouvrables au contrat, absences validées par nature (module Congés),
 * jours travaillés, et éléments variables repris dans la paie du mois.
 */
export default function WorkEntriesPage() {
  const { can } = useSession();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { setError(''); api(`/company/payroll/work-entries?period=${period}`).then(setD, (e) => setError(e.message)); }, [period]);
  const salaries = can('payroll.salaries');
  const used = KINDS.filter(([k]) => d?.rows.some((r: any) => r.leave[k]));
  const total = (f: (r: any) => number) => (d?.rows ?? []).reduce((s: number, r: any) => s + (f(r) || 0), 0);

  return (
    <>
      <div className="page-head"><h1>Prestations</h1>
        <input className="input" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Mois" style={{ width: 170 }} /></div>
      <Alert>{error}</Alert>
      {d && <>
        <div className="kpis">
          <div className="card kpi"><div className="l">Jours ouvrables</div><div className="v">{d.workingDays}</div><div className="small muted"><span style={{ textTransform: 'capitalize', display: 'inline-block' }}>{d.label}</span>, hors dimanches et fériés</div></div>
          <div className="card kpi"><div className="l">Jours travaillés</div><div className="v">{days(total((r) => r.worked)) || 0}</div><div className="small muted">{d.rows.length} employé(s)</div></div>
          <div className="card kpi"><div className="l">Jours d'absence</div><div className="v">{days(total((r) => r.contractDays - r.worked)) || 0}</div><div className="small muted"><Link href="/app/conges">congés et absences validés</Link></div></div>
          <div className="card kpi"><div className="l">Paie du mois</div><div className="v" style={{ fontSize: 18, paddingTop: 6 }}>{d.run ? <Link href={`/app/paie/fiches/${d.run.id}`}>{d.run.status === 'draft' ? <Pill tone="warn">Brouillon</Pill> : <Pill tone="ok">Validée</Pill>}</Link> : <Pill>Pas encore préparée</Pill>}</div>
            <div className="small muted">{d.run ? 'éléments variables ci-dessous' : <Link href="/app/paie/fiches">préparer la paie</Link>}</div></div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Employé</th><th className="n" title="Jours ouvrables couverts par le contrat ce mois-ci">Au contrat</th>{used.map(([k, l]) => <th key={k} className="n">{l}</th>)}<th className="n">Travaillés</th>
            {d.run && <><th className="n" title="Jours d'absence non rémunérés retenus sur le bulletin">Retenus en paie</th>{salaries && <><th className="n">Heures sup.</th><th className="n">Primes</th></>}</>}</tr></thead>
          <tbody>
            {d.rows.map((r: any) => (
              <tr key={r.employeeId}>
                <td><b>{r.name}</b><div className="small muted">{r.number} · {CONTRACTS[r.contractType]}{r.department ? ` · ${r.department}` : ''}</div></td>
                <td className="n">{r.contractDays}</td>
                {used.map(([k]) => <td key={k} className="n">{days(r.leave[k])}</td>)}
                <td className="n"><b>{r.worked}</b></td>
                {d.run && <><td className="n">{r.inPayroll ? days(r.absenceDays) || '0' : <span className="small muted">absent de la paie</span>}</td>
                  {salaries && <><td className="n">{r.overtime ? money(r.overtime) : ''}</td><td className="n">{r.bonus ? money(r.bonus) : ''}</td></>}</>}
              </tr>))}
            {!d.rows.length && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun employé sous contrat ce mois-ci.</td></tr>}
          </tbody>
        </table></div>
        <p className="small muted" style={{ margin: 0 }}>Les absences viennent des demandes validées dans <Link href="/app/conges">Congés</Link> ; les congés sans solde sont repris automatiquement comme absences lors de la préparation de la paie. Heures supplémentaires et primes se saisissent dans la paie du mois (« Éléments variables »).</p>
      </>}
    </>
  );
}
