'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert } from '@/components/ui';
import { ChartCard, ColumnChart, fcfa, monthLong } from '@/components/charts';

const month = (n = 0) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const MEASURES: [string, string][] = [['gross', 'Brut'], ['employeeCharges', 'Retenues salariales'], ['net', 'Net à payer'], ['employerCharges', 'Charges patronales'], ['employerCost', 'Coût employeur']];
const GROUPS: Record<string, [string, (s: any) => string]> = {
  period: ['Mois', (s) => s.period], employee: ['Employé', (s) => s.name], department: ['Service', (s) => s.department || 'Sans service'],
};

/** Analyse de la masse salariale : évolution mensuelle et tableau croisé par mois, employé ou service. */
export default function PayrollAnalysisPage() {
  const { can } = useSession();
  const [range, setRange] = useState({ from: month(-11), to: month() });
  const [group, setGroup] = useState('period');
  const [validatedOnly, setValidatedOnly] = useState(true);
  const [slips, setSlips] = useState<any[] | null>(null);
  useEffect(() => { if (can('payroll.salaries')) api(`/company/payroll/payslips?from=${range.from}&to=${range.to}`).then(setSlips); }, [range]); // eslint-disable-line

  if (!can('payroll.salaries')) return <Alert kind="info">L'analyse de la paie est réservée aux personnes disposant de la permission sensible « voir les salaires et bulletins ».</Alert>;
  const rows = (slips ?? []).filter((s) => !validatedOnly || s.runStatus === 'validated');
  // Tous les mois de la plage, même sans paie, pour une échelle de temps régulière.
  const months: string[] = [];
  for (let p = range.from; p <= range.to && months.length < 36; p = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 1)).toISOString().slice(0, 7)) months.push(p);
  const byMonth = (k: string) => months.map((m) => rows.filter((s) => s.period === m).reduce((t, s) => t + s[k], 0));
  const net = byMonth('net'), cost = byMonth('employerCost');
  const series = [
    { key: 'net', label: 'Net versé aux salariés', color: 'var(--series-1)', values: net },
    { key: 'charges', label: 'Cotisations, impôts et taxes', color: 'var(--series-2)', values: cost.map((c, i) => c - net[i]) },
  ];
  const [, keyOf] = GROUPS[group];
  const groups = [...new Set(rows.map(keyOf))].sort((a, b) => (group === 'period' ? (a < b ? 1 : -1) : a.localeCompare(b)));
  const agg = (list: any[]): Record<string, number> => ({ ...Object.fromEntries(MEASURES.map(([k]) => [k, list.reduce((t, s) => t + s[k], 0)])), count: new Set(list.map((s) => s.employeeId)).size, slips: list.length });
  const table = groups.map((g) => ({ g, ...agg(rows.filter((s) => keyOf(s) === g)) }));
  const total = agg(rows);
  const label = (g: string) => (group === 'period' ? monthLong(g) : g);

  return (
    <>
      <div className="page-head"><h1>Analyse de la paie</h1>
        <div className="row">
          <label className="field">Du<input className="input" type="month" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} /></label>
          <label className="field">Au<input className="input" type="month" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} /></label>
        </div>
      </div>
      <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={validatedOnly} onChange={(e) => setValidatedOnly(e.target.checked)} /> Paies validées uniquement (sans les brouillons)</label>
      {slips && <>
        <div className="kpis">
          <div className="card kpi"><div className="l">Masse salariale brute</div><div className="v">{money(total.gross)}</div></div>
          <div className="card kpi"><div className="l">Net versé</div><div className="v">{money(total.net)}</div></div>
          <div className="card kpi"><div className="l">Coût employeur</div><div className="v">{money(total.employerCost)}</div>
            <div className="small muted">{total.gross ? `${Math.round((total.employerCost / total.gross) * 100)} % du brut` : ''}</div></div>
          <div className="card kpi"><div className="l">Salariés payés</div><div className="v">{total.count}</div><div className="small muted">{total.slips} fiche(s)</div></div>
        </div>
        <ChartCard title="Coût pour l'employeur" subtitle="par mois : net versé, puis cotisations, impôts et taxes"
          legend={series.map((s) => ({ label: s.label, color: s.color, kind: 'box' as const }))}
          table={{ head: ['Mois', 'Net versé', 'Cotisations, impôts et taxes', 'Coût employeur'], rows: months.map((m, i) => [monthLong(m), fcfa(net[i]), fcfa(cost[i] - net[i]), fcfa(cost[i])]) }}>
          <ColumnChart stacked categories={months} series={series} />
        </ChartCard>
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <header style={{ marginBottom: 0 }}><h2>Détail</h2>
            <div className="seg" role="group" aria-label="Regrouper par">{Object.entries(GROUPS).map(([k, [l]]) => <button key={k} aria-pressed={group === k} onClick={() => setGroup(k)}>{l}</button>)}</div></header>
          <div className="table-wrap"><table>
            <thead><tr><th>{GROUPS[group][0]}</th>{group !== 'employee' && <th className="n">Salariés</th>}{MEASURES.map(([k, l]) => <th key={k} className="n">{l}</th>)}</tr></thead>
            <tbody>{table.map((r: any) => (
              <tr key={r.g}><td style={{ textTransform: group === 'period' ? 'capitalize' : undefined }}><b>{label(r.g)}</b></td>{group !== 'employee' && <td className="n">{r.count}</td>}
                {MEASURES.map(([k]) => <td key={k} className="n" style={{ whiteSpace: 'nowrap' }}>{money(r[k])}</td>)}</tr>))}
              {!table.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucune fiche de paie sur cette période.</td></tr>}</tbody>
            {table.length > 1 && <tfoot><tr><td><b>Total</b></td>{group !== 'employee' && <td className="n"><b>{total.count}</b></td>}{MEASURES.map(([k]) => <td key={k} className="n" style={{ whiteSpace: 'nowrap' }}><b>{money((total as any)[k])}</b></td>)}</tr></tfoot>}
          </table></div>
        </div>
      </>}
    </>
  );
}
