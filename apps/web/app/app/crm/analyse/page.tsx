'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { ChartCard, ColumnChart, fcfa, monthLong } from '@/components/charts';
import { Alert, useAction } from '@/components/ui';

const PERIODS: [string, string, number][] = [['3', '3 mois', 3], ['6', '6 mois', 6], ['12', '12 mois', 12]];
const startOf = (months: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - months + 1); return d.toISOString().slice(0, 10); };
const pct = (n: number | null) => (n === null ? '—' : `${n} %`);

/** CRM — Analyse : affaires gagnées et perdues, taux de réussite, motifs de perte, résultats par commercial et par origine. */
export default function CrmAnalysisPage() {
  const { has } = useSession();
  const [period, setPeriod] = useState('12');
  const [s, setS] = useState<any>(null);
  const { error, run } = useAction();
  useEffect(() => {
    if (!has('crm')) return;
    const months = PERIODS.find(([k]) => k === period)![2];
    run(async () => setS(await api(`/company/opportunities/stats?from=${startOf(months)}`)));
  }, [period]); // eslint-disable-line
  if (!has('crm')) return <Alert kind="warn">Le CRM n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;

  const table = (title: string, rows: any[], first: string) => (
    <section className="card" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {rows.length ? <div className="table-wrap"><table>
        <thead><tr><th>{first}</th><th className="n">Gagnées</th><th className="n">Perdues</th><th className="n">Réussite</th><th className="n">Montant gagné</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="n">{r.won}</td><td className="n">{r.lost}</td><td className="n">{pct(r.rate)}</td><td className="n">{money(r.wonAmount)}</td></tr>)}</tbody>
      </table></div> : <p className="small muted" style={{ margin: 0 }}>Aucune affaire conclue sur la période.</p>}
    </section>
  );
  return (
    <>
      <div className="page-head"><h1>Analyse commerciale</h1>
        <div className="seg" role="group" aria-label="Période">{PERIODS.map(([k, l]) => <button key={k} aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div></div>
      <Alert>{error}</Alert>
      {s && <>
        <div className="kpis">
          <div className="card kpi"><div className="l">Affaires gagnées</div><div className="v" style={{ color: 'var(--ok)' }}>{money(s.won.amount)}</div><div className="small muted">{s.won.count} affaire(s){s.averageWon !== null && <> · {money(s.averageWon)} en moyenne</>}</div></div>
          <div className="card kpi"><div className="l">Taux de réussite</div><div className="v">{pct(s.rate)}</div><div className="small muted">gagnées sur affaires conclues</div></div>
          <div className="card kpi"><div className="l">Affaires perdues</div><div className="v">{s.lost.count}</div><div className="small muted">{money(s.lost.amount)} espérés</div></div>
          <div className="card kpi"><div className="l">Durée d&apos;une affaire gagnée</div><div className="v">{s.cycleDays === null ? '—' : `${s.cycleDays} j`}</div><div className="small muted">{s.created} opportunité(s) créée(s)</div></div>
        </div>
        <ChartCard title="Affaires gagnées par mois" subtitle="Montant HT des opportunités passées à « Gagné »"
          table={{ head: ['Mois', 'Gagnées', 'Montant gagné', 'Perdues'], rows: s.months.map((m: any) => [monthLong(m.month), m.won, fcfa(m.wonAmount), m.lost]) }}>
          <ColumnChart categories={s.months.map((m: any) => m.month)} series={[{ key: 'won', label: 'Montant gagné', color: 'var(--series-1)', values: s.months.map((m: any) => m.wonAmount) }]} />
        </ChartCard>
        {table('Par commercial', s.byOwner, 'Commercial')}
        {table('Par origine', s.bySource, 'Origine')}
        <section className="card" style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Motifs de perte</h2>
          {s.lostReasons.length ? <div className="table-wrap"><table>
            <thead><tr><th>Motif</th><th className="n">Affaires</th><th className="n">Part</th></tr></thead>
            <tbody>{s.lostReasons.map((r: any) => <tr key={r.reason}><td>{r.reason}</td><td className="n">{r.count}</td><td className="n">{Math.round((r.count / s.lost.count) * 100)} %</td></tr>)}</tbody>
          </table></div> : <p className="small muted" style={{ margin: 0 }}>Aucune affaire perdue sur la période.</p>}
        </section>
      </>}
    </>
  );
}
