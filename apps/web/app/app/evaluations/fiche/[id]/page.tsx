'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, dateTime, EVAL_STATUS, money, periodLabel, RATINGS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Score, scoreText, Stars } from '@/components/evaluations';
import { Alert, Avatar, Pill, useAction } from '@/components/ui';

const TEXTS: [string, string, string][] = [
  ['strengths', 'Points forts', 'Ce que la personne réussit particulièrement'],
  ['improvements', 'Axes de progrès', 'Ce qui doit progresser, et comment l’accompagner'],
  ['goals', 'Objectifs pour la prochaine période', 'Objectifs concrets et mesurables'],
  ['comment', 'Commentaire général', ''],
];
/** Mois proposés pour une prime ou une augmentation : ce mois-ci et les douze suivants. */
const months = (keep?: string | null) => {
  const out: string[] = [];
  const d = new Date(); d.setUTCDate(1);
  for (let i = 0; i < 13; i++) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return keep && !out.includes(keep) ? [keep, ...out] : out;
};
const seniority = (hire: string) => {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(hire)) / (30.44 * 86400_000)));
  return m < 12 ? `${m} mois` : `${Math.floor(m / 12)} an${m >= 24 ? 's' : ''}${m % 12 ? ` ${m % 12} mois` : ''}`;
};
const weighted = (criteria: any[], scores: Record<string, any>) => {
  let s = 0, w = 0;
  for (const c of criteria) { const v = scores[c.key]?.score; if (v) { s += v * c.weight; w += c.weight; } }
  return w ? Math.round((s / w) * 100) / 100 : null;
};
const ratingOf = (s: number | null) => (s === null ? null : s >= 4.25 ? 'excellent' : s >= 3.5 ? 'very_good' : s >= 2.5 ? 'good' : s >= 1.75 ? 'improve' : 'insufficient');
const toForm = (v: any) => ({
  scores: v.scores ?? {}, strengths: v.strengths ?? '', improvements: v.improvements ?? '', goals: v.goals ?? '', comment: v.comment ?? '',
  bonusAmount: v.bonusAmount ? String(v.bonusAmount) : '', bonusPeriod: v.bonusPeriod ?? '', newBaseSalary: v.newBaseSalary ? String(v.newBaseSalary) : '', raisePeriod: v.raisePeriod ?? '',
  evaluatorId: v.evaluator?.id ?? '', note: '',
});

/** Fiche d'évaluation : notation par critère, appréciations, proposition de prime ou d'augmentation, décision. */
export default function EvaluationSheet() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, ctx } = useSession();
  const [v, setV] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const show = (x: any) => { setV(x); setF(toForm(x)); };
  const load = useCallback(() => run(async () => show(await api(`/company/evaluations/${id}`))), [id]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (can('evaluations.create')) api('/company/evaluations/people').then(setPeople).catch(() => {}); }, [can]);
  if (!v || !f) return <><div className="page-head"><h1>Évaluation</h1></div><Alert>{error || null}</Alert></>;

  const salaries = can('payroll.salaries');
  const write = !ctx?.readOnly;
  const edit = write && v.canEdit;
  const moneyEditable = salaries && write && (v.canEdit || v.canDecide);
  const score = weighted(v.criteria, f.scores);
  const base = v.employee.baseSalary as number | undefined;
  const newBase = Number(f.newBaseSalary) || 0;
  const pct = base && newBase ? Math.round(((newBase - base) / base) * 1000) / 10 : null;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const setScore = (key: string, patch: object) => setF({ ...f, scores: { ...f.scores, [key]: { score: null, ...f.scores[key], ...patch } } });
  const proposal = () => (moneyEditable ? {
    bonusAmount: Number(f.bonusAmount) || 0, bonusPeriod: Number(f.bonusAmount) ? f.bonusPeriod || null : null,
    newBaseSalary: newBase || null, raisePeriod: newBase ? f.raisePeriod || null : null,
  } : {});
  const body = () => ({
    scores: Object.fromEntries(Object.entries(f.scores).map(([k, s]: [string, any]) => [k, { score: s.score ?? null, comment: s.comment || null }])),
    strengths: f.strengths || null, improvements: f.improvements || null, goals: f.goals || null, comment: f.comment || null,
    ...(people.length && f.evaluatorId !== (v.evaluator?.id ?? '') ? { evaluatorId: f.evaluatorId || null } : {}), ...proposal(),
  });
  const save = (then?: 'submit') => run(async () => {
    let x = await api(`/company/evaluations/${id}`, { method: 'PATCH', body: body() });
    if (then === 'submit') { x = await api(`/company/evaluations/${id}/submit`, { body: {} }); setNotice('Évaluation soumise : elle attend maintenant la décision d’un responsable.'); }
    else setNotice('Évaluation enregistrée.');
    show(x);
  });
  const decide = (approve: boolean) => run(async () => {
    if (v.canEdit) await api(`/company/evaluations/${id}`, { method: 'PATCH', body: body() });
    show(await api(`/company/evaluations/${id}/decide`, { body: { approve, note: f.note || null, ...(approve ? proposal() : {}) } }));
    setNotice(approve ? 'Évaluation approuvée. La prime rejoint la paie du mois choisi ; l’augmentation s’applique à la fiche à partir de son mois d’effet.' : 'Évaluation refusée.');
  });
  const quick = (p: number) => base && setF({ ...f, newBaseSalary: String(Math.ceil((base * (1 + p / 100)) / 1000) * 1000), raisePeriod: f.raisePeriod || months()[1] });

  return (
    <>
      <div className="page-head">
        <div><div className="small"><Link href="/app/evaluations">Évaluations</Link> › <Link href={`/app/evaluations/${v.campaignId}`}>{v.campaignName}</Link></div>
          <h1>Évaluation de {v.employee.name} <Pill tone={EVAL_STATUS[v.status][1]}>{EVAL_STATUS[v.status][0]}</Pill></h1></div>
        <div className="row" style={{ gap: 6 }}>
          {edit && <button className="btn" disabled={busy} onClick={() => save()}>Enregistrer</button>}
          {edit && v.status === 'draft' && <button className="btn primary" disabled={busy || v.criteria.some((c: any) => !f.scores[c.key]?.score)}
            title={v.criteria.some((c: any) => !f.scores[c.key]?.score) ? 'Notez tous les critères pour soumettre' : undefined} onClick={() => save('submit')}>Soumettre</button>}
          {write && v.canReopen && <button className="btn" disabled={busy} onClick={() => run(async () => { show(await api(`/company/evaluations/${id}/reopen`, { body: {} })); setNotice('Décision annulée : l’évaluation attend une nouvelle décision.'); })}>Rouvrir la décision</button>}
          {write && can('evaluations.cancel') && v.status !== 'approved' && <button className="btn danger" disabled={busy} onClick={() => {
            if (confirm(`Retirer ${v.employee.name} de la campagne ?`)) run(async () => { await api(`/company/evaluations/${id}`, { method: 'DELETE' }); router.push(`/app/evaluations/${v.campaignId}`); });
          }}>Retirer</button>}
        </div>
      </div>
      <Alert kind="ok">{notice}</Alert>
      <Alert>{error}</Alert>
      {v.mine && <Alert kind="info">C&apos;est votre propre évaluation : vous la consultez sans pouvoir la remplir ni en décider.</Alert>}

      <div className="ev-layout">
        <div className="ev-main">
          <div className="card"><header><h2>Critères</h2><span className="small muted">Notes de 1 (insuffisant) à 5 (excellent), pondérées par leur coefficient</span></header>
            <div className="ev-criteria">{v.criteria.map((c: any) => {
              const s = f.scores[c.key] ?? {};
              return <div key={c.key} className="ev-criterion">
                <div className="ev-crit-head"><b>{c.label}</b>{c.weight > 1 && <span className="vg-badge">× {c.weight}</span>}
                  <span className="ev-crit-stars">{edit ? <Stars value={s.score ?? null} onChange={(n) => setScore(c.key, { score: n })} label={c.label} /> : <Stars value={s.score ?? null} />}
                    <span className="small muted ev-crit-label">{s.score ? RATINGS[ratingOf(s.score)!] : 'Non noté'}</span></span></div>
                {edit ? <input className="input" placeholder="Commentaire (facultatif)" aria-label={`Commentaire : ${c.label}`} value={s.comment ?? ''} onChange={(e) => setScore(c.key, { comment: e.target.value })} />
                  : s.comment && <div className="small">{s.comment}</div>}
              </div>;
            })}</div>
          </div>
          <div className="card"><header><h2>Appréciations</h2></header>
            {TEXTS.map(([k, label, hint]) => (edit
              ? <label key={k} className="field">{label}<textarea className="input" rows={3} placeholder={hint} value={f[k]} onChange={set(k)} /></label>
              : f[k] && <div key={k} className="ev-text"><div className="small muted">{label}</div><p>{f[k]}</p></div>))}
            {!edit && !TEXTS.some(([k]) => f[k]) && <p className="muted small">Aucune appréciation écrite.</p>}
          </div>
        </div>

        <aside className="ev-side">
          <div className="card ev-person">
            <div className="ev-photo"><Avatar e={v.employee} /></div>
            <div><b>{v.employee.name}</b><div className="small muted">{[v.employee.jobTitle, v.employee.department].filter(Boolean).join(' · ')}</div>
              <div className="small muted">{v.employee.number} · {seniority(v.employee.hireDate)} d&apos;ancienneté</div>
              {base !== undefined && <div className="small">Salaire de base : <b>{money(base)}</b></div>}</div>
          </div>

          <div className="card ev-total">
            <div className="small muted">Note globale</div>
            {score === null ? <div className="muted">Aucun critère noté</div> : <>
              <div className="ev-big">{scoreText(score)}<span>/5</span></div><Stars value={score} />
              <div className={`ev-rating r-${ratingOf(score)}`}>{RATINGS[ratingOf(score)!]}</div></>}
            <div className="small muted" style={{ marginTop: 8 }}>Période du {date(v.periodStart)} au {date(v.periodEnd)}</div>
            {people.length > 0 && edit ? <label className="field small">Évaluateur<select className="input" value={f.evaluatorId} onChange={set('evaluatorId')}>
              <option value="">— À désigner —</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              : <div className="small">Évaluateur : {v.evaluator?.name ?? '—'}</div>}
            {v.submittedAt && <div className="small muted">Soumise le {dateTime(v.submittedAt)}</div>}
          </div>

          {(salaries || v.hasBonus || v.hasRaise) && <div className="card"><header><h2>Prime et augmentation</h2></header>
            {!salaries ? <p className="small muted" style={{ margin: 0 }}>{[v.hasBonus && 'Une prime', v.hasRaise && 'une augmentation'].filter(Boolean).join(' et ')} {v.status === 'approved' ? 'décidée(s)' : 'proposée(s)'}. Les montants sont réservés aux personnes qui voient les salaires.</p>
              : moneyEditable ? <div className="ev-money">
                <div className="grid2">
                  <label className="field">Prime (FCFA)<input className="input n" inputMode="numeric" placeholder="0" value={f.bonusAmount} onChange={(e) => setF({ ...f, bonusAmount: e.target.value.replace(/\D/g, ''), bonusPeriod: f.bonusPeriod || months()[0] })} /></label>
                  <label className="field">Paie de<select className="input" value={f.bonusPeriod} disabled={!Number(f.bonusAmount)} onChange={set('bonusPeriod')}>
                    <option value="">—</option>{months(f.bonusPeriod).map((m) => <option key={m} value={m}>{periodLabel(m)}</option>)}</select></label>
                </div>
                <div className="grid2">
                  <label className="field">Nouveau salaire de base<input className="input n" inputMode="numeric" value={f.newBaseSalary} onChange={(e) => setF({ ...f, newBaseSalary: e.target.value.replace(/\D/g, ''), raisePeriod: f.raisePeriod || months()[1] })} /></label>
                  <label className="field">À partir de<select className="input" value={f.raisePeriod} disabled={!newBase} onChange={set('raisePeriod')}>
                    <option value="">—</option>{months(f.raisePeriod).map((m) => <option key={m} value={m}>{periodLabel(m)}</option>)}</select></label>
                </div>
                <div className="row small" style={{ gap: 6 }}>
                  {[3, 5, 10].map((p) => <button key={p} type="button" className="btn sm" onClick={() => quick(p)}>+{p} %</button>)}
                  {newBase > 0 && <button type="button" className="btn sm" onClick={() => setF({ ...f, newBaseSalary: '', raisePeriod: '' })}>Sans augmentation</button>}
                  {pct !== null && <span style={pct > 0 ? undefined : { color: 'var(--crit)' }}>{pct > 0 ? '+' : ''}{String(pct).replace('.', ',')} % · {pct > 0 ? '+' : ''}{money(newBase - base!)} / mois</span>}
                </div>
              </div>
              : <dl className="site-kpis">
                <dt>Prime</dt><dd>{v.bonusAmount ? <>{money(v.bonusAmount)} · {periodLabel(v.bonusPeriod)}</> : '—'}</dd>
                <dt>Augmentation</dt><dd>{v.newBaseSalary !== null ? <>+{String(v.raisePercent).replace('.', ',')} % → {money(v.newBaseSalary)} dès {periodLabel(v.raisePeriod)}{v.raiseApplied ? ' (appliquée)' : ''}</> : '—'}</dd>
              </dl>}
          </div>}

          {write && v.canDecide && <div className="card ev-decide"><header><h2>Décision</h2></header>
            <label className="field">Note de décision (facultative)<textarea className="input" rows={2} value={f.note} onChange={set('note')} /></label>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn primary" disabled={busy} onClick={() => decide(true)}>Approuver{salaries && (Number(f.bonusAmount) || newBase) ? ' avec ' + [Number(f.bonusAmount) && 'prime', newBase && 'augmentation'].filter(Boolean).join(' et ') : ''}</button>
              <button className="btn danger" disabled={busy} onClick={() => decide(false)}>Refuser</button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Approuvée, la prime est ajoutée au bulletin du mois choisi (aussitôt si sa paie est en brouillon) et l&apos;augmentation devient le salaire de base à partir de son mois d&apos;effet. L&apos;employé est prévenu par e-mail s&apos;il a un espace.</p>
          </div>}
          {(v.status === 'approved' || v.status === 'refused') && <div className="card small">
            <b>{v.status === 'approved' ? 'Approuvée' : 'Refusée'}</b> par {v.decidedBy} le {dateTime(v.decidedAt)}{v.decisionNote && <p style={{ margin: '4px 0 0' }}>« {v.decisionNote} »</p>}</div>}

          {v.history.length > 0 && <div className="card"><header><h2>Évaluations précédentes</h2></header>
            <ul className="ev-history">{v.history.map((h: any) => <li key={h.id}><Link href={`/app/evaluations/fiche/${h.id}`}>{h.campaignName}</Link><Score score={h.score} rating={h.rating} /></li>)}</ul></div>}
        </aside>
      </div>
    </>
  );
}
