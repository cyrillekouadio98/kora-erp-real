'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Distribution, Score } from '@/components/evaluations';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const year = new Date().getFullYear();
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'critere';

/** Évaluations : campagnes (annuelle, fin de période d'essai…), avancement, notes et décisions de prime ou d'augmentation. */
export default function EvaluationsPage() {
  const { can, ctx, me } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<any[] | null>(null);
  const [form, setForm] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => run(async () => setRows(await api('/company/evaluations/campaigns'))), []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const salaries = can('payroll.salaries');

  const open = () => run(async () => {
    setError('');
    const [d, p, e] = await Promise.all([api('/company/evaluations/defaults'), api('/company/evaluations/people'),
      can('employees.read') ? api('/company/employees') : Promise.resolve([])]);
    setPeople(p); setEmployees(e.filter((x: any) => x.active));
    setForm({ name: `Évaluation annuelle ${year}`, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, dueDate: '', evaluatorId: me.user.id,
      criteria: d.criteria, all: true, employeeIds: [] as string[] });
  });
  const setCrit = (i: number, patch: object) => setForm({ ...form, criteria: form.criteria.map((c: any, j: number) => (j === i ? { ...c, ...patch } : c)) });
  const save = () => run(async () => {
    const criteria = form.criteria.map((c: any) => ({ key: c.key || slug(c.label), label: c.label, weight: Number(c.weight) }));
    const c = await api('/company/evaluations/campaigns', { body: {
      name: form.name, periodStart: form.periodStart, periodEnd: form.periodEnd, dueDate: form.dueDate || null, evaluatorId: form.evaluatorId || null, criteria,
      ...(form.all ? {} : { employeeIds: form.employeeIds }),
    } });
    router.push(`/app/evaluations/${c.id}`);
  });
  const departments = [...new Set(employees.map((e) => e.department ?? 'Sans service'))].sort();
  const toggle = (ids: string[], on: boolean) => setForm({ ...form, employeeIds: on ? [...new Set([...form.employeeIds, ...ids])] : form.employeeIds.filter((x: string) => !ids.includes(x)) });

  return (
    <>
      <div className="page-head"><h1>Évaluations</h1>
        {can('evaluations.create') && !ctx?.readOnly && <button className="btn primary" disabled={busy} onClick={open}>Nouvelle campagne</button>}</div>
      <Alert>{!form && error}</Alert>
      <p className="small muted" style={{ margin: 0 }}>
        Une campagne évalue les employés sur une période, critère par critère (notes de 1 à 5). L&apos;évaluateur remplit puis soumet ; un responsable approuve
        en décidant d&apos;une <b>prime</b>, ajoutée au bulletin du mois choisi, et/ou d&apos;une <b>augmentation</b> du salaire de base à partir du mois choisi.
      </p>

      {rows && !rows.length && <div className="card empty-state"><p>Aucune campagne pour l&apos;instant.</p>
        {can('evaluations.create') && <p className="small muted">Lancez « Évaluation annuelle {year} » : tous les employés présents y sont inscrits, avec une grille de critères que vous pouvez adapter.</p>}</div>}

      <div className="vg-grid">
        {rows?.map((c) => {
          const done = c.approved + c.refused;
          return (
            <Link key={c.id} href={`/app/evaluations/${c.id}`} className="card ev-campaign">
              <header><div><b>{c.name}</b><div className="small muted">{date(c.periodStart)} – {date(c.periodEnd)}{c.dueDate ? ` · à rendre le ${date(c.dueDate)}` : ''}</div></div>
                {c.status === 'closed' ? <Pill>Close</Pill> : <Pill tone="ok">En cours</Pill>}</header>
              <div className="ev-progress" role="progressbar" aria-valuenow={done} aria-valuemax={c.total} aria-label="Évaluations terminées">
                <span style={{ width: `${c.total ? (done / c.total) * 100 : 0}%` }} /><span className="sub" style={{ width: `${c.total ? (c.submitted / c.total) * 100 : 0}%` }} /></div>
              <div className="small"><b>{done}</b> / {c.total} terminée(s){c.submitted ? <> · <b>{c.submitted}</b> à approuver</> : null}{c.draft ? <> · {c.draft} à remplir</> : null}</div>
              <div><Score score={c.average} rating={c.averageRating} />
                {c.average !== null && <span className="small muted"> moyenne</span>}</div>
              <Distribution d={c.distribution} />
              {salaries && (c.bonusTotal > 0 || c.raiseTotal > 0) && <dl className="site-kpis">
                <dt>Primes approuvées</dt><dd>{money(c.bonusTotal)}</dd>
                <dt>Augmentations</dt><dd>+{money(c.raiseTotal)} / mois</dd>
              </dl>}
            </Link>);
        })}
      </div>

      {form && (
        <div className="modal-back" onClick={() => setForm(null)}>
          <form className="modal" style={{ width: 'min(680px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>Nouvelle campagne d&apos;évaluation</h2>
            <Alert>{error}</Alert>
            <Field label="Nom" required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="grid3">
              <Field label="Période du" type="date" required value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />
              <Field label="au" type="date" required min={form.periodStart} value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />
              <Field label="À rendre le (facultatif)" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </div>
            <label className="field">Évaluateur
              <select className="input" value={form.evaluatorId} onChange={(e) => setForm({ ...form, evaluatorId: e.target.value })}>
                <option value="">— À désigner ensuite —</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select><span className="small muted">Il reçoit un e-mail. Vous pourrez confier chaque évaluation à un autre responsable.</span></label>

            <fieldset className="ev-fieldset"><legend>Critères notés de 1 à 5, et leur coefficient</legend>
              {form.criteria.map((c: any, i: number) => (
                <div key={i} className="ev-crit-row">
                  <input className="input" aria-label="Critère" required minLength={2} value={c.label} onChange={(e) => setCrit(i, { label: e.target.value, key: c.key && c.label === e.target.value ? c.key : '' })} />
                  <select className="input" aria-label="Coefficient" value={c.weight} onChange={(e) => setCrit(i, { weight: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>× {w}</option>)}</select>
                  <button type="button" className="btn sm" aria-label={`Retirer ${c.label}`} disabled={form.criteria.length < 2}
                    onClick={() => setForm({ ...form, criteria: form.criteria.filter((_: any, j: number) => j !== i) })}>Retirer</button>
                </div>))}
              <button type="button" className="btn sm" onClick={() => setForm({ ...form, criteria: [...form.criteria, { key: '', label: '', weight: 1 }] })}>Ajouter un critère</button>
            </fieldset>

            <fieldset className="ev-fieldset"><legend>Employés évalués</legend>
              <label className="row small" style={{ gap: 8 }}><input type="radio" checked={form.all} onChange={() => setForm({ ...form, all: true })} /> Tous les employés présents sur la période</label>
              {employees.length > 0 && <label className="row small" style={{ gap: 8 }}><input type="radio" checked={!form.all} onChange={() => setForm({ ...form, all: false })} /> Choisir les employés</label>}
              {!form.all && <div className="ev-pick">
                {departments.map((d) => {
                  const list = employees.filter((e) => (e.department ?? 'Sans service') === d);
                  const ids = list.map((e) => e.id);
                  return <div key={d}>
                    <label className="row small" style={{ gap: 8, fontWeight: 600 }}><input type="checkbox" checked={ids.every((x) => form.employeeIds.includes(x))} onChange={(e) => toggle(ids, e.target.checked)} /> {d}</label>
                    {list.map((e) => <label key={e.id} className="row small" style={{ gap: 8, paddingLeft: 22 }}>
                      <input type="checkbox" checked={form.employeeIds.includes(e.id)} onChange={(x) => toggle([e.id], x.target.checked)} /> {e.fullName}<span className="muted">{e.jobTitle}</span></label>)}
                  </div>;
                })}
                <span className="small muted">{form.employeeIds.length} employé(s) choisi(s)</span>
              </div>}
            </fieldset>
            <div className="row"><button className="btn primary" disabled={busy || (!form.all && !form.employeeIds.length)}>Lancer la campagne</button>
              <button type="button" className="btn" onClick={() => setForm(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
