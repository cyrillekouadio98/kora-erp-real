'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { date, LEAVE_STATUS, LEAVE_TYPES } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const dayList = (month: string) => {
  const n = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // lundi = 0
/** Numéro de semaine ISO 8601. */
const isoWeek = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 3 - weekday(d));
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t.getTime() - jan4.getTime()) / 86400_000 - 3 + weekday(iso(jan4))) / 7);
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** Teinte de chaque type d'absence, dans un ordre fixe. */
const TYPE_HUE: Record<string, number> = { annual: 152, sick: 210, maternity: 330, family_event: 32, unpaid: 270, other: 55 };
const STATUS_RANK: Record<string, number> = { approved: 0, pending: 1, refused: 2 };
const plural = (n: number, w: string) => `${n.toLocaleString('fr-FR')} ${w}${Math.abs(n) > 1 ? 's' : ''}`;

type DayInfo = { leaves: any[]; holiday?: string };

/** Un mois du calendrier annuel : semaines du lundi au dimanche, jours d'absence en bandes colorées. */
function MonthCal({ month, info, onPick }: { month: string; info: Map<string, DayInfo>; onPick: (d: string) => void }) {
  const days = dayList(month);
  const weeks: (string | null)[][] = [];
  let week: (string | null)[] = Array(weekday(days[0])).fill(null);
  for (const d of days) { week.push(d); if (week.length === 7) { weeks.push(week); week = []; } }
  if (week.length) weeks.push([...week, ...Array(7 - week.length).fill(null)]);
  const key = (d: string | null) => { const l = d && info.get(d)?.leaves[0]; return l ? `${l.status}:${l.type}` : ''; };
  const now = today();
  return (
    <div className="lv-month">
      <h3>{MONTHS[Number(month.slice(5)) - 1]} {month.slice(0, 4)}</h3>
      <table><thead><tr><th aria-label="Semaine" />{['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => <th key={i}>{d}</th>)}</tr></thead>
        <tbody>{weeks.map((w, i) => (
          <tr key={i}><td className="lv-wk">{isoWeek(w.find(Boolean)!)}</td>{w.map((d, j) => {
            if (!d) return <td key={j} />;
            const di = info.get(d), l = di?.leaves[0], k = key(d);
            const cls = ['lv-day', l && l.status, j === 6 && 'off', di?.holiday && 'holiday', d === now && 'today',
              l && key(w[j - 1] ?? null) === k && 'join-l', l && key(w[j + 1] ?? null) === k && 'join-r'].filter(Boolean).join(' ');
            const title = [di?.holiday, ...(di?.leaves ?? []).map((x) => `${x.employeeName} — ${LEAVE_TYPES[x.type]} (${LEAVE_STATUS[x.status][0].toLowerCase()})`)].filter(Boolean).join('\n');
            return <td key={j}><button type="button" className={cls} title={title || undefined} style={l ? { '--h': TYPE_HUE[l.type] } as React.CSSProperties : undefined}
              onClick={() => onPick(d)}>{Number(d.slice(8))}{(di?.leaves.length ?? 0) > 1 && <i>{di!.leaves.length}</i>}</button></td>;
          })}</tr>))}</tbody></table>
    </div>
  );
}

/** Congés : demandes à valider, soldes, planning du mois. */
export default function LeavePage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [pending, setPending] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [mode, setMode] = useState<'year' | 'month'>('year');
  const [cursor, setCursor] = useState(today().slice(0, 7)); // mois affiché ; son année en vue annuelle
  const year = Number(cursor.slice(0, 4)), month = cursor;
  const [yearLeaves, setYearLeaves] = useState<any[]>([]);
  const [holidays, setHolidays] = useState<{ date: string; label: string }[]>([]);
  const [employee, setEmployee] = useState('');
  const [types, setTypes] = useState<Set<string>>(() => new Set(Object.keys(LEAVE_TYPES)));
  const [modal, setModal] = useState<any>(null);
  const { busy, error, run, setError } = useAction();
  const load = useCallback(async () => {
    setPending(await api('/company/leave?status=pending'));
    setBalances(await api('/company/leave/balances'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api(`/company/leave?year=${year}`).then(setYearLeaves); }, [year, pending]);
  useEffect(() => { api(`/company/leave/holidays?year=${year}`).then(setHolidays, () => setHolidays([])); }, [year]);
  const move = (n: number) => { const d = new Date(Date.UTC(year, Number(cursor.slice(5)) - 1 + (mode === 'year' ? 12 * n : n), 1)); setCursor(iso(d).slice(0, 7)); };
  const decide = (id: string, approve: boolean) => run(async () => { await api(`/company/leave/${id}/${approve ? 'approve' : 'refuse'}`, { body: {} }); await load(); });
  // Absences affichées : filtre employé et types ; les demandes annulées n'apparaissent pas.
  const shown = useMemo(() => yearLeaves.filter((l) => l.status !== 'cancelled' && types.has(l.type) && (!employee || l.employeeId === employee)), [yearLeaves, types, employee]);
  const info = useMemo(() => {
    const m = new Map<string, DayInfo>();
    for (const h of holidays) m.set(h.date, { leaves: [], holiday: h.label });
    for (const l of shown) for (let d = new Date(`${l.startDate}T00:00:00Z`); iso(d) <= l.endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = iso(d); if (!m.has(k)) m.set(k, { leaves: [] }); m.get(k)!.leaves.push(l);
    }
    for (const v of m.values()) v.leaves.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    return m;
  }, [shown, holidays]);
  const days = dayList(month);
  const monthLeaves = shown.filter((l) => l.startDate <= days[days.length - 1] && l.endDate >= days[0]);
  const people = [...new Set(monthLeaves.filter((l) => ['approved', 'pending'].includes(l.status)).map((l) => l.employeeName))].sort();
  const now = today();
  const absentToday = new Set(yearLeaves.filter((l) => l.status === 'approved' && l.startDate <= now && l.endDate >= now && (!employee || l.employeeId === employee)).map((l) => l.employeeId)).size;
  const chosen = balances.find((b) => b.employeeId === employee);
  const available = chosen ? chosen.available : balances.reduce((t, b) => t + Number(b.available), 0);
  const pendingShown = pending.filter((r) => !employee || r.employeeId === employee);
  const takenThisYear = shown.filter((l) => l.status === 'approved' && l.type === 'annual').reduce((t, l) => t + Number(l.days), 0);

  return (
    <>
      <div className="page-head"><h1>Congés</h1>
        {can('leave.create') && writable && <button className="btn primary" onClick={() => { setError(''); setModal({ type: 'request', employeeId: employee || balances[0]?.employeeId || '', leaveType: 'annual', startDate: today(), endDate: today(), reason: '' }); }}>Saisir une absence</button>}</div>
      <Alert>{!modal && error}</Alert>

      <div className="lv-bar">
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => move(-1)} aria-label="Période précédente">←</button>
          <button className="btn sm" onClick={() => move(1)} aria-label="Période suivante">→</button>
          <div className="seg" role="group" aria-label="Période affichée">
            <button type="button" aria-pressed={mode === 'year'} onClick={() => setMode('year')}>Année</button>
            <button type="button" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>Mois</button></div>
          <button className="btn sm" onClick={() => setCursor(now.slice(0, 7))}>Aujourd'hui</button>
          <b style={{ fontSize: 18, marginLeft: 6 }}>{mode === 'year' ? year : `${MONTHS[Number(month.slice(5)) - 1]} ${year}`}</b>
        </div>
        <select className="input" style={{ width: 'auto' }} value={employee} onChange={(e) => setEmployee(e.target.value)} aria-label="Employé">
          <option value="">Tous les employés</option>{balances.map((b) => <option key={b.employeeId} value={b.employeeId}>{b.name}</option>)}</select>
      </div>

      <div className="lv-summary">
        <div className="card lv-tile"><div className="l">Congés payés{chosen ? ` — ${chosen.name}` : ''}</div>
          <div className="v">{Number(available).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}</div>
          <div className="small muted">{chosen ? 'jours disponibles' : `jours disponibles pour ${plural(balances.length, 'employé')}`} au {date(now)}</div></div>
        <div className="card lv-tile"><div className="l">Demandes en attente</div><div className="v">{pendingShown.length}</div>
          {pendingShown.length ? <a className="small" href="#demandes">Traiter les demandes</a> : <div className="small muted">Rien à valider</div>}</div>
        <div className="card lv-tile"><div className="l">Absents aujourd'hui</div><div className="v">{absentToday}</div><div className="small muted">absence validée en cours</div></div>
        <div className="card lv-tile"><div className="l">Congés payés pris en {year}</div><div className="v">{takenThisYear.toLocaleString('fr-FR')}</div><div className="small muted">jours ouvrables validés</div></div>
      </div>

      <div className="lv-layout">
        <div className="card" style={{ minWidth: 0 }}>
          {mode === 'year' ? (
            <div className="lv-year">{Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).map((m) => (
              <MonthCal key={m} month={m} info={info} onPick={(d) => { setCursor(d.slice(0, 7)); setMode('month'); }} />))}</div>
          ) : people.length ? <div style={{ overflowX: 'auto' }}><table className="planning" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr><th style={{ textAlign: 'left', minWidth: 140 }}></th>{days.map((d) => <th key={d} title={info.get(d)?.holiday} style={{ padding: '2px 3px', color: weekday(d) === 6 || info.get(d)?.holiday ? 'var(--muted)' : undefined }}>{Number(d.slice(8))}</th>)}</tr></thead>
            <tbody>{people.map((p) => (
              <tr key={p}><td style={{ whiteSpace: 'nowrap', paddingRight: 8 }}>{p}</td>{days.map((d) => {
                const l = monthLeaves.find((x) => x.employeeName === p && ['approved', 'pending'].includes(x.status) && x.startDate <= d && x.endDate >= d);
                return <td key={d} title={l ? `${LEAVE_TYPES[l.type]} — ${LEAVE_STATUS[l.status][0]}` : info.get(d)?.holiday} className={`lv-cell${l ? ` ${l.status}` : ''}${weekday(d) === 6 || info.get(d)?.holiday ? ' off' : ''}`}
                  style={l ? { '--h': TYPE_HUE[l.type] } as React.CSSProperties : undefined} />;
              })}</tr>))}</tbody></table></div>
            : <p className="small muted" style={{ margin: 0 }}>Personne n'est absent ce mois-ci.</p>}
        </div>

        <aside className="card lv-side">
          <h3>Types d'absence</h3>
          {Object.entries(LEAVE_TYPES).map(([k, v]) => (
            <label key={k} className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={types.has(k)} onChange={() => { const n = new Set(types); if (n.has(k)) n.delete(k); else n.add(k); setTypes(n); }} />
              <span className="lv-swatch approved" style={{ '--h': TYPE_HUE[k] } as React.CSSProperties} />{v}</label>))}
          <h3>Légende</h3>
          <div className="row small" style={{ gap: 8 }}><span className="lv-swatch approved" style={{ '--h': 152 } as React.CSSProperties} />Validé</div>
          <div className="row small" style={{ gap: 8 }}><span className="lv-swatch pending" style={{ '--h': 152 } as React.CSSProperties} />En attente de validation</div>
          <div className="row small" style={{ gap: 8 }}><span className="lv-swatch refused" style={{ '--h': 152 } as React.CSSProperties} />Refusé</div>
          <div className="row small" style={{ gap: 8 }}><span className="lv-swatch off" />Dimanche ou jour férié</div>
          <h3>Jours fériés {year}</h3>
          <ul className="lv-holidays">{holidays.map((h) => <li key={h.date}><b>{date(h.date)}</b> : {h.label}</li>)}</ul>
          <p className="small muted" style={{ margin: 0 }}>Les fêtes musulmanes (Ramadan, Tabaski, Maouloud, Nuit du destin) dépendent de l'annonce officielle de chaque année : elles ne sont pas comptées automatiquement.</p>
        </aside>
      </div>

      <div className="card" id="demandes"><header><h2>Demandes à traiter</h2><Pill tone={pending.length ? 'warn' : 'ok'}>{pending.length}</Pill></header>
        {pending.length ? <div className="table-wrap"><table><tbody>{pending.map((r) => (
          <tr key={r.id}><td><b>{r.employeeName}</b><div className="small muted">{LEAVE_TYPES[r.type]}{r.reason ? ` · ${r.reason}` : ''}</div></td>
            <td style={{ whiteSpace: 'nowrap' }}>du {date(r.startDate)} au {date(r.endDate)}</td><td className="n">{r.days} j</td>
            <td className="n">{can('leave.validate') && writable && <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
              <button className="btn sm" disabled={busy} onClick={() => decide(r.id, false)}>Refuser</button>
              <button className="btn sm primary" disabled={busy} onClick={() => decide(r.id, true)}>Valider</button></div>}</td></tr>))}</tbody></table></div>
          : <p className="small muted" style={{ margin: 0 }}>Aucune demande en attente.</p>}
      </div>

      <div className="card"><header><h2>Soldes de congés payés</h2><span className="small muted">jours ouvrables</span></header>
        <div className="table-wrap"><table>
          <thead><tr><th>Employé</th><th className="n">Report</th><th className="n">Acquis</th><th className="n">Pris</th><th className="n">En attente</th><th className="n">Disponible</th><th></th></tr></thead>
          <tbody>{balances.map((b) => (
            <tr key={b.employeeId}><td><b>{b.name}</b> {b.linked ? <Pill tone="ok">Espace activé</Pill> : <Pill>Sans espace</Pill>}<div className="small muted">{b.number} · {b.months} mois de service</div></td>
              <td className="n">{b.opening}</td><td className="n">{b.accrued}</td><td className="n">{b.taken}</td><td className="n">{b.pending}</td><td className="n"><b>{b.available}</b></td>
              <td className="n">{can('leave.admin') && writable && <button className="btn sm" onClick={() => { setError(''); setModal({ type: 'opening', employee: b, balance: b.opening, date: '' }); }}>Report</button>}</td></tr>))}</tbody>
        </table></div></div>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (modal.type === 'request') await api('/company/leave', { body: { employeeId: modal.employeeId, type: modal.leaveType, startDate: modal.startDate, endDate: modal.endDate, reason: modal.reason || null } });
              else await api(`/company/leave/balances/${modal.employee.employeeId}`, { method: 'PATCH', body: { balance: Number(modal.balance), date: modal.date || null } });
              setModal(null); await load();
            });
          }}>
            {modal.type === 'request' ? <>
              <h2>Saisir une absence</h2><Alert>{error}</Alert>
              <label className="field">Employé<select className="input" value={modal.employeeId} onChange={(e) => setModal({ ...modal, employeeId: e.target.value })}>{balances.map((b) => <option key={b.employeeId} value={b.employeeId}>{b.name}</option>)}</select></label>
              <label className="field">Type<select className="input" value={modal.leaveType} onChange={(e) => setModal({ ...modal, leaveType: e.target.value })}>{Object.entries(LEAVE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <div className="grid2"><Field label="Du" type="date" required value={modal.startDate} onChange={(e) => setModal({ ...modal, startDate: e.target.value })} />
                <Field label="Au (inclus)" type="date" required min={modal.startDate} value={modal.endDate} onChange={(e) => setModal({ ...modal, endDate: e.target.value })} /></div>
              <Field label="Motif (facultatif)" value={modal.reason} onChange={(e) => setModal({ ...modal, reason: e.target.value })} />
              <p className="small muted" style={{ margin: 0 }}>La demande est créée en attente ; elle doit ensuite être validée. Un congé sans solde validé est repris comme absence dans la paie du mois.</p>
            </> : <>
              <h2>Report de congés — {modal.employee.name}</h2><Alert>{error}</Alert>
              <p className="small muted" style={{ margin: 0 }}>Jours de congés encore dus à l'employé au moment où vous commencez à utiliser Kora, et date à partir de laquelle Kora calcule l'acquisition (vide : date d'embauche).</p>
              <Field label="Jours reportés" type="number" min={0} step={0.5} required value={modal.balance} onChange={(e) => setModal({ ...modal, balance: e.target.value })} />
              <Field label="Acquisition calculée à partir du" type="date" value={modal.date} onChange={(e) => setModal({ ...modal, date: e.target.value })} />
            </>}
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
