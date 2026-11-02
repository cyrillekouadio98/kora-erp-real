'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { LOT_STATES, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';
import { ChartCard, ColumnChart, fcfa, LineChart, monthLong } from '@/components/charts';

const count = (n: number) => n.toLocaleString('fr-FR');
const thisMonth = () => new Date().toISOString().slice(0, 7);
/** Gravité des points à vérifier : ce qui touche l'argent ou la loi passe en premier. */
const SEVERITY: Record<string, 'crit' | 'warn' | 'mute'> = { unpaid: 'crit', below_smig: 'crit', missing_from_run: 'warn', ending_soon: 'warn', cdd_no_end: 'warn' };

/** Vue d'ensemble de la paie : chiffres clés, déroulé de la paie du mois, points à vérifier, pense-bête, historique et tendances. */
export default function PayrollOverview() {
  const { can, ctx } = useSession();
  const router = useRouter();
  const writable = !ctx?.readOnly;
  const [d, setD] = useState<any>(null);
  const [span, setSpan] = useState<'months' | 'years'>('months');
  const { busy, error, run } = useAction();
  const load = useCallback(() => api('/company/payroll/dashboard').then(setD), []);
  useEffect(() => { if (can('payroll.salaries')) load(); }, [load]); // eslint-disable-line

  if (!can('payroll.salaries')) return <Alert kind="info">La vue d'ensemble de la paie est réservée aux personnes disposant de la permission sensible « voir les salaires et bulletins ». Les <Link href="/app/paie/contrats">contrats</Link> et les <Link href="/app/paie/prestations">temps et absences</Link> restent consultables.</Alert>;
  if (!d) return null;
  const yearly = span === 'years';
  const month = thisMonth();
  const current = d.lots.find((l: any) => l.period === month);
  const [last, previous] = d.lots;
  const checks = d.warnings.filter((w: any) => w.count > 0).sort((a: any, b: any) => (SEVERITY[a.key] === 'crit' ? 0 : 1) - (SEVERITY[b.key] === 'crit' ? 0 : 1));
  const staffNow = d.headcount.monthly.at(-1)?.count ?? 0;
  const cost = yearly ? d.cost.yearly : d.cost.monthly;
  const staff = yearly ? d.headcount.yearly : d.headcount.monthly;
  const long = yearly ? (c: string) => `année ${c}` : monthLong;
  const tick = yearly ? (c: string) => c : undefined;
  const costSeries = [
    { key: 'net', label: 'Net versé', color: 'var(--series-1)', values: cost.map((c: any) => c.net) },
    { key: 'charges', label: 'Cotisations, impôts et taxes', color: 'var(--series-2)', values: cost.map((c: any) => c.charges) },
  ];
  const prepare = () => run(async () => { const r = await api('/company/payroll/runs', { body: { period: month } }); router.push(`/app/paie/fiches/${r.id}`); });

  // Déroulé de la paie du mois : chaque étape est faite, en cours ou à venir.
  const steps = [
    { label: 'Préparer', hint: 'bulletins de tous les salariés présents', done: !!current },
    { label: 'Contrôler', hint: 'absences, heures sup. et primes', done: !!current && current.state !== 'draft', href: '/app/paie/prestations' },
    { label: 'Valider', hint: 'bulletins figés et comptabilisés', done: !!current && current.state !== 'draft' },
    { label: 'Payer', hint: current && current.state !== 'draft' ? `${current.paid}/${current.payslips} salaire(s) payé(s)` : 'depuis la caisse, la banque ou le mobile money', done: current?.state === 'paid' },
  ];
  const active = steps.findIndex((s) => !s.done);

  return (
    <>
      <div className="page-head"><h1>Paie</h1>
        <div className="seg" role="group" aria-label="Période des graphiques">
          <button aria-pressed={!yearly} onClick={() => setSpan('months')}>6 mois</button>
          <button aria-pressed={yearly} onClick={() => setSpan('years')}>3 ans</button>
        </div></div>
      <Alert>{error}</Alert>

      <div className="kpis">
        <div className="card kpi"><div className="l">Coût employeur</div><div className="v">{money(last?.employerCost ?? 0)}</div>
          <div className="small muted">{last ? <>paie de {last.label}{previous && previous.employerCost ? (() => { const pct = Math.round(((last.employerCost - previous.employerCost) / previous.employerCost) * 100);
            return <> · {pct === 0 ? 'stable' : `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)} %`} vs {previous.label}</>; })() : null}</> : 'aucune paie'}</div></div>
        <div className="card kpi"><div className="l">Net à verser</div><div className="v">{money(last?.net ?? 0)}</div>
          <div className="small muted">{last ? `${last.paid}/${last.payslips} salaire(s) payé(s)` : '—'}</div></div>
        <Link className="card kpi" href="/app/paie/contrats" style={{ textDecoration: 'none', color: 'inherit' }}><div className="l">Effectif</div><div className="v">{count(staffNow)}</div>
          <div className="small muted">{d.moves.monthly.arrivals || d.moves.monthly.departures ? `+${d.moves.monthly.arrivals} arrivée(s) · −${d.moves.monthly.departures} départ(s) ce mois-ci` : 'aucune arrivée ni départ ce mois-ci'}</div></Link>
        <div className="card kpi"><div className="l">Points à vérifier</div><div className="v" style={{ color: checks.length ? 'var(--warn)' : 'var(--ok)' }}>{count(checks.reduce((s: number, w: any) => s + w.count, 0))}</div>
          <div className="small muted">{checks.length ? `${checks.length} sujet(s)` : 'tout est en ordre'}</div></div>
      </div>

      <section className="card">
        <header><h2>Paie de {monthLong(month)}</h2>{current && <Link href={`/app/paie/fiches/${current.id}`}>Ouvrir la paie →</Link>}</header>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.label} className={s.done ? 'done' : i === active ? 'current' : ''}>
              <span className="dot" aria-hidden="true">{s.done ? '✓' : i + 1}</span>
              <div><b>{s.href && i === active ? <Link href={s.href}>{s.label}</Link> : s.label}</b><div className="small muted">{s.hint}</div></div>
            </li>))}
        </ol>
        {!current && can('payroll.create') && writable && <div><button className="btn primary" disabled={busy} onClick={prepare}>Préparer la paie de {monthLong(month)}</button></div>}
      </section>

      <div className="dash-grid">
        <section className="card">
          <header><h2>À vérifier</h2><span className="small muted">{checks.length ? `${checks.length} point(s)` : ''}</span></header>
          {checks.length ? <div style={{ display: 'grid', gap: 8 }}>{checks.map((w: any) => (
            <Link key={w.key} href={w.href} className="row" style={{ justifyContent: 'space-between', textDecoration: 'none', color: 'var(--ink)', padding: '6px 0', borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
              <span><Pill tone={SEVERITY[w.key] ?? 'mute'}>{SEVERITY[w.key] === 'crit' ? 'Urgent' : SEVERITY[w.key] === 'warn' ? 'À surveiller' : 'À compléter'}</Pill> {w.label}</span>
              <b style={{ whiteSpace: 'nowrap' }}>{count(w.count)} →</b>
            </Link>))}</div> : <p className="muted" style={{ margin: 0 }}>✓ Fiches complètes, contrats à jour et salaires payés.</p>}
        </section>
        <Checklist notes={d.notes} editable={can('payroll.update') && writable} />
      </div>

      <div className="dash-grid">
        <ChartCard title="Coût employeur" subtitle={yearly ? 'par année' : 'par mois'} legend={costSeries.map((s) => ({ label: s.label, color: s.color, kind: 'box' as const }))}
          table={{ head: [yearly ? 'Année' : 'Mois', 'Net versé', 'Cotisations, impôts et taxes', 'Coût employeur'], rows: cost.map((c: any) => [long(c.period), fcfa(c.net), fcfa(c.charges), fcfa(c.employerCost)]) }}>
          <ColumnChart stacked categories={cost.map((c: any) => c.period)} series={costSeries} long={long} {...(tick ? { tick } : {})} height={200} />
        </ChartCard>
        <ChartCard title="Effectif" subtitle={yearly ? 'salariés présents en fin d’année' : 'salariés présents en fin de mois'}
          table={{ head: [yearly ? 'Année' : 'Mois', 'Effectif'], rows: staff.map((s: any) => [long(s.period), count(s.count)]) }}>
          <LineChart categories={staff.map((s: any) => s.period)} values={staff.map((s: any) => s.count)} color="var(--series-1)" label="Effectif"
            long={long} format={(n) => `${count(n)} salarié(s)`} {...(tick ? { tick } : {})} height={200} />
        </ChartCard>
      </div>

      <section className="card">
        <header><h2>Historique des paies</h2><Link href="/app/paie/fiches">Toutes les paies →</Link></header>
        {d.lots.length ? <div className="table-wrap"><table>
          <thead><tr><th>Mois</th><th className="n">Salariés</th><th className="n">Net à payer</th><th className="n">Coût employeur</th><th>État</th></tr></thead>
          <tbody>{d.lots.map((l: any) => (
            <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/app/paie/fiches/${l.id}`)}>
              <td><Link href={`/app/paie/fiches/${l.id}`} style={{ textTransform: 'capitalize' }}>{l.label}</Link></td><td className="n">{l.payslips}</td>
              <td className="n">{money(l.net)}</td><td className="n">{money(l.employerCost)}</td><td><Pill tone={LOT_STATES[l.state][1]}>{LOT_STATES[l.state][0]}</Pill></td></tr>))}</tbody>
        </table></div> : <p className="muted" style={{ margin: 0 }}>Aucune paie pour l'instant.</p>}
      </section>
    </>
  );
}

/**
 * Pense-bête de l'équipe paie : une liste de tâches partagée (cocher, ajouter, retirer).
 * Stocké comme une note dont chaque ligne « [ ] » ou « [x] » est une tâche.
 */
function Checklist({ notes, editable }: { notes: any[]; editable: boolean }) {
  const [body, setBody] = useState<string>(notes[0]?.body ?? '');
  const [task, setTask] = useState('');
  const { busy, error, run } = useAction();
  const lines = body.split('\n').filter((l) => l.trim());
  const save = (next: string[]) => {
    const text = next.join('\n');
    setBody(text);
    run(async () => { await api('/company/payroll/notes', { method: 'PUT', body: { notes: [{ ...(notes[0] ?? {}), title: notes[0]?.title ?? 'Pense-bête', body: text }, ...notes.slice(1)] } }); });
  };
  const parse = (l: string) => { const m = l.match(/^\s*\[( |x)\]\s?(.*)$/i); return m ? { done: m[1].toLowerCase() === 'x', text: m[2] } : { done: null, text: l }; };
  const open = lines.filter((l) => parse(l).done === false).length;
  return (
    <section className="card">
      <header><h2>Pense-bête</h2><span className="small muted">{open ? `${open} tâche(s) à faire` : 'partagé avec l’équipe paie'}</span></header>
      <Alert>{error}</Alert>
      <ul className="todo">
        {lines.map((l, k) => {
          const t = parse(l);
          return (
            <li key={k} className={t.done ? 'done' : ''}>
              {t.done === null ? <span className="muted">{t.text}</span> : <label><input type="checkbox" checked={t.done} disabled={!editable || busy}
                onChange={() => save(lines.map((x, j) => (j === k ? `[${t.done ? ' ' : 'x'}] ${t.text}` : x)))} /> <span>{t.text}</span></label>}
              {editable && <button type="button" className="btn sm" aria-label={`Retirer « ${t.text} »`} disabled={busy} onClick={() => save(lines.filter((_, j) => j !== k))}>✕</button>}
            </li>);
        })}
        {!lines.length && <li className="muted">Aucune tâche. Notez ici les rappels de l'équipe : relance CNPS, contrat à renouveler…</li>}
      </ul>
      {editable && <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); if (task.trim()) { save([...lines, `[ ] ${task.trim()}`]); setTask(''); } }}>
        <input className="input" placeholder="Nouvelle tâche…" maxLength={200} value={task} onChange={(e) => setTask(e.target.value)} aria-label="Nouvelle tâche" />
        <button className="btn" disabled={busy || !task.trim()}>Ajouter</button></form>}
    </section>
  );
}
