'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, EVAL_STATUS, money, periodLabel } from '@/lib/format';
import { useSession } from '@/components/session';
import { Distribution, Score } from '@/components/evaluations';
import { Alert, Avatar, Pill, useAction } from '@/components/ui';

const FILTERS: [string, string][] = [['all', 'Toutes'], ['draft', 'À remplir'], ['submitted', 'À approuver'], ['approved', 'Approuvées'], ['refused', 'Refusées']];

/** Une campagne : avancement, répartition des notes, et la liste des employés avec leur évaluation. */
export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, ctx, me } = useSession();
  const [c, setC] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [add, setAdd] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => run(async () => setC(await api(`/company/evaluations/campaigns/${id}`))), [id]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  if (!c) return <><div className="page-head"><h1>Évaluations</h1></div><Alert>{error || null}</Alert></>;

  const salaries = can('payroll.salaries');
  const write = !ctx?.readOnly;
  const rows = c.evaluations.filter((v: any) => (filter === 'all' || v.status === filter)
    && (!q || `${v.employee.name} ${v.employee.jobTitle ?? ''} ${v.employee.department ?? ''} ${v.evaluator?.name ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const mineToFill = c.evaluations.filter((v: any) => v.status === 'draft' && v.evaluator?.id === me.user.id).length;
  const patch = (body: object, done: string) => run(async () => { setC({ ...c, ...(await api(`/company/evaluations/campaigns/${id}`, { method: 'PATCH', body })) }); setNotice(done); });

  const openAdd = () => run(async () => {
    const [emps, people] = await Promise.all([api('/company/employees'), api('/company/evaluations/people')]);
    const inside = new Set(c.evaluations.map((v: any) => v.employee.id));
    setAdd({ employees: emps.filter((e: any) => e.active && !inside.has(e.id)), people, ids: [] as string[], evaluatorId: me.user.id });
  });

  return (
    <>
      <div className="page-head">
        <div><div className="small"><Link href="/app/evaluations">Évaluations</Link></div>
          <h1>{c.name} {c.status === 'closed' ? <Pill>Close</Pill> : <Pill tone="ok">En cours</Pill>}</h1>
          <div className="small muted">{date(c.periodStart)} – {date(c.periodEnd)}{c.dueDate ? ` · à rendre le ${date(c.dueDate)}` : ''}</div></div>
        <div className="row" style={{ gap: 6 }}>
          {can('evaluations.export') && <a className="btn" href={`/api/company/evaluations/campaigns/${id}/export`}>Exporter</a>}
          {write && c.status === 'open' && can('evaluations.create') && can('employees.read') && <button className="btn" disabled={busy} onClick={openAdd}>Ajouter des employés</button>}
          {write && can('evaluations.update') && (c.status === 'open'
            ? <button className="btn" disabled={busy} onClick={() => patch({ status: 'closed' }, 'Campagne close : les évaluations ne se modifient plus.')}>Clore</button>
            : <button className="btn" disabled={busy} onClick={() => patch({ status: 'open' }, 'Campagne rouverte.')}>Rouvrir</button>)}
          {write && can('evaluations.cancel') && !c.approved && <button className="btn danger" disabled={busy} onClick={() => {
            if (confirm(`Supprimer la campagne « ${c.name} » et ses ${c.total} évaluation(s) ?`)) run(async () => { await api(`/company/evaluations/campaigns/${id}`, { method: 'DELETE' }); router.push('/app/evaluations'); });
          }}>Supprimer</button>}
        </div>
      </div>
      <Alert kind="ok">{notice}</Alert>
      <Alert>{!add && error}</Alert>
      {mineToFill > 0 && <Alert kind="info">{mineToFill} évaluation(s) vous attendent : ouvrez-les dans la liste ci-dessous (filtre « À remplir »).</Alert>}

      <div className="kpis">
        <div className="card kpi"><div className="l">Terminées</div><div className="v">{c.approved + c.refused} / {c.total}</div>
          <div className="small muted">{c.submitted} à approuver · {c.draft} à remplir</div></div>
        <div className="card kpi"><div className="l">Note moyenne</div><div className="v">{c.average === null ? '—' : <Score score={c.average} rating={c.averageRating} />}</div></div>
        {salaries && <>
          <div className="card kpi"><div className="l">Primes approuvées</div><div className="v">{money(c.bonusTotal)}</div><div className="small muted">versées avec la paie du mois choisi</div></div>
          <div className="card kpi"><div className="l">Augmentations</div><div className="v">+{money(c.raiseTotal)}</div><div className="small muted">de salaire de base par mois</div></div>
        </>}
      </div>
      <div className="card"><header><h2>Répartition des appréciations</h2></header><Distribution d={c.distribution} legend /></div>

      <div className="card">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="seg" role="group" aria-label="Statut">{FILTERS.map(([k, l]) => {
            const n = k === 'all' ? c.total : c.evaluations.filter((v: any) => v.status === k).length;
            return <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} {n}</button>;
          })}</div>
          <input className="input" style={{ maxWidth: 260 }} type="search" placeholder="Employé, poste, service, évaluateur" aria-label="Rechercher" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="table-wrap"><table className="ev-table">
          <thead><tr><th>Employé</th><th>Évaluateur</th><th>Note</th>{salaries && <><th className="n">Prime</th><th className="n">Augmentation</th></>}<th>Statut</th></tr></thead>
          <tbody>{rows.map((v: any) => (
            <tr key={v.id} className="clickable" onClick={() => router.push(`/app/evaluations/fiche/${v.id}`)}>
              <td><div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><div className="vg-mini"><Avatar e={v.employee} /></div>
                <div><Link href={`/app/evaluations/fiche/${v.id}`} onClick={(e) => e.stopPropagation()}><b>{v.employee.name}</b></Link>
                  <div className="small muted">{[v.employee.jobTitle, v.employee.department].filter(Boolean).join(' · ') || v.employee.number}</div></div></div></td>
              <td>{v.evaluator?.name ?? <span className="muted">À désigner</span>}</td>
              <td><Score score={v.score} rating={v.rating} /></td>
              {salaries && <>
                <td className="n">{v.bonusAmount ? <>{money(v.bonusAmount)}<div className="small muted">{periodLabel(v.bonusPeriod)}</div></> : '—'}</td>
                <td className="n">{v.newBaseSalary !== null ? <>+{String(v.raisePercent).replace('.', ',')} %<div className="small muted">{money(v.newBaseSalary)} dès {periodLabel(v.raisePeriod)}</div></> : '—'}</td>
              </>}
              <td><Pill tone={EVAL_STATUS[v.status][1]}>{EVAL_STATUS[v.status][0]}</Pill>
                {v.status === 'approved' && !salaries && (v.hasBonus || v.hasRaise) && <div className="small muted">{[v.hasBonus && 'prime', v.hasRaise && 'augmentation'].filter(Boolean).join(' et ')}</div>}</td>
            </tr>))}
            {!rows.length && <tr><td colSpan={salaries ? 6 : 4} className="muted" style={{ textAlign: 'center' }}>Aucune évaluation.</td></tr>}</tbody>
        </table></div>
      </div>

      {add && (
        <div className="modal-back" onClick={() => setAdd(null)}>
          <form className="modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { setC(await api(`/company/evaluations/campaigns/${id}/employees`, { body: { employeeIds: add.ids, evaluatorId: add.evaluatorId || null } })); setNotice(`${add.ids.length} employé(s) ajouté(s).`); setAdd(null); });
          }}>
            <h2>Ajouter des employés</h2>
            <Alert>{error}</Alert>
            {!add.employees.length ? <p className="muted">Tous les employés présents sont déjà dans la campagne.</p> : <div className="ev-pick">
              {add.employees.map((e: any) => <label key={e.id} className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={add.ids.includes(e.id)} onChange={(x) => setAdd({ ...add, ids: x.target.checked ? [...add.ids, e.id] : add.ids.filter((i: string) => i !== e.id) })} />
                {e.fullName}<span className="muted">{[e.jobTitle, e.department].filter(Boolean).join(' · ')}</span></label>)}
            </div>}
            <label className="field">Évaluateur<select className="input" value={add.evaluatorId} onChange={(e) => { setError(''); setAdd({ ...add, evaluatorId: e.target.value }); }}>
              <option value="">— À désigner ensuite —</option>{add.people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <div className="row"><button className="btn primary" disabled={busy || !add.ids.length}>Ajouter</button><button type="button" className="btn" onClick={() => setAdd(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
