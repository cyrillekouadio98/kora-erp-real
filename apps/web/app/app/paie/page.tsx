'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { LOT_STATES } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';
import { ChartCard, ColumnChart, fcfa, monthLong, monthTick } from '@/components/charts';

const count = (n: number) => n.toLocaleString('fr-FR');
const yearTick = (c: string) => c;
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Tableau de bord de la paie : avertissements, derniers lots, notes de l'équipe, coût employeur, effectifs. */
export default function PayrollDashboard() {
  const { can, ctx } = useSession();
  const router = useRouter();
  const writable = !ctx?.readOnly;
  const [d, setD] = useState<any>(null);
  const [costYearly, setCostYearly] = useState(false);
  const [staffYearly, setStaffYearly] = useState(false);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api('/company/payroll/dashboard').then(setD), []);
  useEffect(() => { if (can('payroll.salaries')) load(); }, [load]); // eslint-disable-line

  if (!can('payroll.salaries')) return <Alert kind="info">Le tableau de bord de la paie est réservé aux personnes disposant de la permission sensible « voir les salaires et bulletins ». Les <Link href="/app/paie/contrats">contrats</Link> et les <Link href="/app/paie/prestations">prestations</Link> restent consultables.</Alert>;
  if (!d) return null;
  const warnings = d.warnings.filter((w: any) => w.count > 0);
  const cost = costYearly ? d.cost.yearly : d.cost.monthly;
  const staff = staffYearly ? d.headcount.yearly : d.headcount.monthly;
  const moves = staffYearly ? d.moves.yearly : d.moves.monthly;
  const tick = (yearly: boolean) => (yearly ? yearTick : monthTick);
  const long = (yearly: boolean) => (yearly ? (c: string) => `année ${c}` : monthLong);
  const costSeries = [
    { key: 'net', label: 'Net versé aux salariés', color: 'var(--series-1)', values: cost.map((c: any) => c.net) },
    { key: 'charges', label: 'Cotisations, impôts et taxes', color: 'var(--series-2)', values: cost.map((c: any) => c.charges) },
  ];
  const month = thisMonth();
  const canPrepare = can('payroll.create') && writable && !d.lots.some((l: any) => l.period === month);

  return (
    <>
      <Alert>{error}</Alert>
      <div className="payroll-dash">
        <section className="card pd-warnings">
          <header><h2>Avertissements</h2></header>
          {warnings.length ? <div className="pd-list">{warnings.map((w: any) => (
            <Link key={w.key} href={w.href} className="pd-row"><b className="pd-count">{count(w.count)}</b><span>{w.label}</span></Link>))}</div>
            : <p className="muted" style={{ margin: 0 }}>✓ Aucun point à signaler : fiches complètes et salaires payés.</p>}
        </section>

        <section className="card pd-lots">
          <header><h2>Lots</h2><Link href="/app/paie/fiches">Tous</Link></header>
          {d.lots.length ? <div className="pd-list">{d.lots.map((l: any) => (
            <Link key={l.id} href={`/app/paie/fiches/${l.id}`} className="pd-row" style={{ justifyContent: 'space-between' }}>
              <Pill tone={LOT_STATES[l.state][1]}>{LOT_STATES[l.state][0]}</Pill>
              <span style={{ textAlign: 'right' }}><span style={{ textTransform: 'capitalize' }}>{l.label}</span> ({l.period.slice(5, 7)}/{l.period.slice(0, 4)})
                <div className="small muted">{l.payslips} fiche(s) de paie</div></span>
            </Link>))}</div> : <p className="muted" style={{ margin: 0 }}>Aucune paie préparée pour l'instant.</p>}
          {canPrepare && <div><button className="btn primary sm" disabled={busy} onClick={() => run(async () => { const r = await api('/company/payroll/runs', { body: { period: month } }); router.push(`/app/paie/fiches/${r.id}`); })}>
            Préparer la paie de {monthLong(month)}</button></div>}
        </section>

        <Notes initial={d.notes} editable={can('payroll.update') && writable} />

        <ChartCard title="Coût pour l'employeur" subtitle={costYearly ? 'par année' : 'par mois, 6 derniers mois'}
          legend={costSeries.map((s) => ({ label: s.label, color: s.color, kind: 'box' as const }))}
          table={{ head: [costYearly ? 'Année' : 'Mois', 'Net versé', 'Cotisations, impôts et taxes', 'Coût employeur'], rows: cost.map((c: any) => [long(costYearly)(c.period), fcfa(c.net), fcfa(c.charges), fcfa(c.employerCost)]) }}>
          <Toggle yearly={costYearly} onChange={setCostYearly} />
          <ColumnChart stacked categories={cost.map((c: any) => c.period)} series={costSeries} tick={tick(costYearly)} long={long(costYearly)} height={200} />
          {cost.some((c: any) => c.draft) && <p className="small muted" style={{ margin: 0 }}>Les périodes dont la paie est encore en brouillon sont des estimations.</p>}
        </ChartCard>

        <ChartCard title="Tendance des employés" subtitle={staffYearly ? 'effectif en fin d’année' : 'effectif en fin de mois'}
          table={{ head: [staffYearly ? 'Année' : 'Mois', 'Effectif'], rows: staff.map((s: any) => [long(staffYearly)(s.period), count(s.count)]) }}>
          <Toggle yearly={staffYearly} onChange={setStaffYearly} />
          <div className="small" style={{ display: 'grid', gap: 2 }}>
            <Link href="/app/paie/contrats?statut=running">{count(moves.arrivals)} nouvel(aux) employé(s) {staffYearly ? 'cette année' : 'ce mois-ci'}</Link>
            <Link href="/app/paie/contrats?statut=ended">{count(moves.departures)} départ(s) {staffYearly ? 'cette année' : 'ce mois-ci'}</Link>
          </div>
          <ColumnChart categories={staff.map((s: any) => s.period)} series={[{ key: 'count', label: 'Effectif', color: 'var(--series-1)', values: staff.map((s: any) => s.count) }]}
            tick={tick(staffYearly)} long={long(staffYearly)} format={(n) => `${count(n)} employé(s)`} height={200} />
        </ChartCard>
      </div>
    </>
  );
}

/** Interrupteur « Annuel / Mensuel ». */
function Toggle({ yearly, onChange }: { yearly: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="pd-toggle small">
      <span>Annuel</span>
      <button type="button" role="switch" aria-checked={!yearly} aria-label="Vue mensuelle" className="switch" onClick={() => onChange(!yearly)}><span /></button>
      <span>Mensuel</span>
    </div>
  );
}

/**
 * Notes de l'équipe paie, en onglets. Une ligne « [ ] … » ou « [x] … » devient une case à cocher,
 * une adresse web devient un lien. Les notes sont partagées par toute l'équipe paie.
 */
function Notes({ initial, editable }: { initial: any[]; editable: boolean }) {
  const [notes, setNotes] = useState<any[]>(initial.length ? initial : [{ title: 'Note', body: '' }]);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState('');
  const { busy, error, run } = useAction();
  const note = notes[Math.min(active, notes.length - 1)];
  const save = (next: any[]) => run(async () => { setNotes(await api('/company/payroll/notes', { method: 'PUT', body: { notes: next } })); setSaved('Enregistré'); setTimeout(() => setSaved(''), 1500); });
  const update = (patch: any) => setNotes(notes.map((n, i) => (i === active ? { ...n, ...patch } : n)));
  const toggleLine = (k: number) => {
    const lines = note.body.split('\n');
    lines[k] = lines[k].replace(/^(\s*)\[( |x)\]/i, (_: string, sp: string, c: string) => `${sp}[${c === ' ' ? 'x' : ' '}]`);
    const next = notes.map((n, i) => (i === active ? { ...n, body: lines.join('\n') } : n));
    setNotes(next); save(next);
  };
  return (
    <section className="card pd-notes">
      <div className="pd-tabs" role="tablist">
        {notes.map((n, i) => (
          <span key={n.id ?? i} className="pd-tab" aria-selected={i === active}>
            <button type="button" role="tab" aria-selected={i === active} onClick={() => { setActive(i); setEditing(false); }}>{n.title}</button>
            {editable && notes.length > 1 && <button type="button" aria-label={`Supprimer la note ${n.title}`} onClick={() => { if (window.confirm(`Supprimer la note « ${n.title} » ?`)) { const next = notes.filter((_, j) => j !== i); setActive(0); save(next); } }}>✕</button>}
          </span>))}
        {editable && notes.length < 10 && <button type="button" className="pd-add" aria-label="Ajouter une note" onClick={() => { setNotes([...notes, { title: `Note ${notes.length + 1}`, body: '' }]); setActive(notes.length); setEditing(true); }}>+</button>}
      </div>
      <Alert>{error}</Alert>
      {editing ? <>
        <input className="input" aria-label="Titre de la note" maxLength={40} value={note.title} onChange={(e) => update({ title: e.target.value })} />
        <textarea className="input" rows={14} maxLength={5000} aria-label="Contenu de la note" value={note.body} onChange={(e) => update({ body: e.target.value })}
          placeholder={'Ex.\nPoints à suivre :\n[ ] Relancer la CNPS pour les nouveaux employés\n[ ] Revoir la grille des catégories'} />
        <div className="row"><button className="btn primary sm" disabled={busy || !note.title.trim()} onClick={() => { save(notes); setEditing(false); }}>Enregistrer</button>
          <button className="btn sm" onClick={() => setEditing(false)}>Fermer</button>
          <span className="small muted">« [ ] » en début de ligne crée une case à cocher.</span></div>
      </> : <>
        <div className="pd-note-body" onDoubleClick={() => editable && setEditing(true)}>
          {note.body.trim() ? note.body.split('\n').map((line: string, k: number) => {
            const box = line.match(/^\s*\[( |x)\]\s?(.*)$/i);
            if (box) return <label key={k} className="pd-check"><input type="checkbox" checked={box[1].toLowerCase() === 'x'} disabled={!editable || busy} onChange={() => toggleLine(k)} /><span>{linkify(box[2])}</span></label>;
            return <p key={k}>{line ? linkify(line) : ' '}</p>;
          }) : <p className="muted">Notez ici les points à suivre de l'équipe paie : rappels, décisions, liens utiles.</p>}
        </div>
        {editable && <div className="row"><button className="btn sm" onClick={() => setEditing(true)}>Modifier</button><span className="small muted">{saved}</span></div>}
      </>}
    </section>
  );
}

function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part));
}
