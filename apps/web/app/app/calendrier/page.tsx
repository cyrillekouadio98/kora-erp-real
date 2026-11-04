'use client';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

type View = 'month' | 'week' | 'day' | 'list';
const KINDS: Record<string, [string, number]> = {
  meeting: ['Réunion', 210], call: ['Appel', 152], visit: ['Visite client', 28], delivery: ['Livraison', 275], other: ['Autre', 48],
};
const REMINDERS: [string, string][] = [['', 'Aucun rappel'], ['10', '10 min avant'], ['30', '30 min avant'], ['60', '1 heure avant'], ['120', '2 heures avant'], ['1440', 'La veille']];
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const HOUR_PX = 48;

// Dates locales : « AAAA-MM-JJ » et « HH:MM » dans le fuseau du navigateur.
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const at = (day: string, time = '00:00') => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return new Date(y, m - 1, d, h, mi); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const sameDay = (a: Date, b: Date) => ymd(a) === ymd(b);
const longDay = (d: Date) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const hueVar = (kind: string) => ({ '--h': KINDS[kind]?.[1] ?? 48 } as React.CSSProperties);

/** Plage chargée pour la vue : semaines complètes du mois, semaine, jour ou 30 jours à venir. */
function range(view: View, cursor: Date): [Date, Date] {
  if (view === 'month') { const first = monday(new Date(cursor.getFullYear(), cursor.getMonth(), 1)); return [first, addDays(first, 42)]; }
  if (view === 'week') { const m = monday(cursor); return [m, addDays(m, 7)]; }
  if (view === 'day') return [cursor, addDays(cursor, 1)];
  return [cursor, addDays(cursor, 30)];
}

/** Disposition des rendez-vous d'une journée : ceux qui se chevauchent se partagent la largeur. */
function layout(items: any[], day: Date) {
  const start = at(ymd(day)).getTime();
  const evs = items.map((a) => ({ a, s: Math.max(0, (new Date(a.start).getTime() - start) / 60000), e: Math.min(1440, (new Date(a.end).getTime() - start) / 60000) }))
    .map((x) => ({ ...x, e: Math.max(x.e, x.s + 20) })).sort((x, y) => x.s - y.s || y.e - x.e);
  const out: { a: any; s: number; e: number; col: number; cols: number }[] = [];
  let cluster: typeof out = [], ends: number[] = [], clusterEnd = -1;
  const flush = () => { const n = ends.length; for (const c of cluster) c.cols = n; cluster = []; ends = []; };
  for (const x of evs) {
    if (x.s >= clusterEnd) flush();
    let col = ends.findIndex((end) => end <= x.s);
    if (col < 0) { col = ends.length; ends.push(x.e); } else ends[col] = x.e;
    const item = { ...x, col, cols: 1 };
    cluster.push(item); out.push(item); clusterEnd = Math.max(clusterEnd, x.e);
  }
  flush();
  return out;
}

export default function CalendarPage() { return <Suspense><Calendar /></Suspense>; }

/** Calendrier : rendez-vous de l'équipe par mois, semaine, jour ou en liste ; création d'un clic sur un jour ou une heure. */
function Calendar() {
  const { can, ctx, me } = useSession();
  const params = useSearchParams();
  const writable = !ctx?.readOnly;
  const [view, setView] = useState<View>(() => { try { return (localStorage.getItem('kora.calendrier.vue') as View) || 'week'; } catch { return 'week'; } });
  const [cursor, setCursor] = useState(() => at(ymd(new Date())));
  const [who, setWho] = useState<string>('all');
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(Object.keys(KINDS)));
  const [showCancelled, setShowCancelled] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [people, setPeople] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [modal, setModal] = useState<any>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const { busy, error, run, setError } = useAction();
  const [from, to] = range(view, cursor);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem('kora.calendrier.vue', v); } catch { /* sans stockage */ } };

  const load = useCallback(() => api(`/company/calendar/appointments?from=${from.toISOString()}&to=${to.toISOString()}${who !== 'all' ? `&userId=${who === 'mine' ? me.user.id : who}` : ''}${showCancelled ? '&includeCancelled=true' : ''}`).then(setRows),
    [from.getTime(), to.getTime(), who, showCancelled]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api('/company/calendar/people').then(setPeople, () => {});
    if (can('contacts.read')) api('/company/contacts').then(setContacts, () => {});
  }, []); // eslint-disable-line

  // Ouverture directe : ?rdv=… (lien des e-mails) ou ?nouveau=1&contact=… (depuis un contact)
  useEffect(() => {
    const id = params.get('rdv');
    if (id) api(`/company/calendar/appointments/${id}`).then((a) => { setCursor(at(ymd(new Date(a.start)))); openEdit(a); }, () => {});
    else if (params.get('nouveau')) openNew(at(ymd(new Date())), '09:00', params.get('contact') ?? '');
  }, []); // eslint-disable-line

  const shown = useMemo(() => rows.filter((a) => kinds.has(a.kind)), [rows, kinds]);
  const onDay = (d: Date) => shown.filter((a) => ymd(new Date(a.start)) <= ymd(d) && ymd(new Date(a.end)) >= ymd(d));
  const move = (n: number) => setCursor(view === 'month' ? new Date(cursor.getFullYear(), cursor.getMonth() + n, 1) : addDays(cursor, n * (view === 'week' ? 7 : view === 'day' ? 1 : 30)));
  const title = view === 'month' ? cursor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    : view === 'week' ? `Semaine du ${from.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} au ${addDays(to, -1).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`
    : view === 'day' ? longDay(cursor) : `À partir du ${longDay(cursor)}`;

  const creatable = can('calendar.create') && writable;
  const openNew = (day: Date, time = '09:00', contactId = '') => {
    if (!creatable) return;
    setError(''); setNotice(null);
    const end = at(ymd(day), time); end.setHours(end.getHours() + 1);
    setModal({ title: '', kind: contactId ? 'visit' : 'meeting', allDay: false, day: ymd(day), endDay: ymd(day), startTime: time, endTime: hm(end), location: '', contactId,
      attendeeIds: [me.user.id], reminder: '30', notes: '' });
  };
  const openEdit = (a: any) => {
    setError(''); setNotice(null);
    const s = new Date(a.start), e = new Date(a.end);
    setModal({ ...a, day: ymd(s), endDay: ymd(e), startTime: hm(s), endTime: hm(e), location: a.location ?? '', contactId: a.contact?.id ?? '', notes: a.notes ?? '',
      attendeeIds: a.attendees.map((p: any) => p.id), reminder: a.reminderMinutes === null ? '' : String(a.reminderMinutes) });
  };

  const save = () => run(async () => {
    const m = modal;
    const start = m.allDay ? at(m.day) : at(m.day, m.startTime);
    const end = m.allDay ? at(m.endDay, '23:59') : at(m.allDay ? m.endDay : m.day, m.endTime);
    const body = { title: m.title, kind: m.kind, allDay: m.allDay, start: start.toISOString(), end: end.toISOString(), location: m.location || null, notes: m.notes || null,
      contactId: m.contactId || null, attendeeIds: m.attendeeIds, reminderMinutes: m.reminder === '' ? null : Number(m.reminder) };
    const r = m.id ? await api(`/company/calendar/appointments/${m.id}`, { method: 'PATCH', body }) : await api('/company/calendar/appointments', { body });
    setModal(null); await load();
    setNotice(r.conflicts?.length
      ? { kind: 'warn', text: `Rendez-vous enregistré, mais attention : ${r.conflicts.map((c: any) => `${c.person} a déjà « ${c.title} » de ${hm(new Date(c.start))} à ${hm(new Date(c.end))}`).join(' ; ')}.` }
      : { kind: 'ok', text: `« ${r.title} » est enregistré${r.attendees.length > 1 ? ' ; les autres participants sont prévenus par e-mail' : ''}.` });
  });
  const setStatus = (status: string) => run(async () => {
    const r = await api(`/company/calendar/appointments/${modal.id}/status`, { body: { status } });
    setModal(null); await load();
    setNotice({ kind: 'ok', text: status === 'cancelled' ? `« ${r.title} » est annulé ; les participants sont prévenus.` : status === 'done' ? `« ${r.title} » est marqué comme fait.` : `« ${r.title} » est de nouveau prévu.` });
  });
  const remove = () => run(async () => {
    if (!window.confirm('Supprimer définitivement ce rendez-vous ? (Pour prévenir les participants, annulez-le plutôt.)')) return;
    await api(`/company/calendar/appointments/${modal.id}`, { method: 'DELETE' }); setModal(null); await load();
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setModal({ ...modal, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  const chip = (a: any, withTime = true) => (
    <button key={a.id} type="button" className={`cal-chip ${a.status}`} style={hueVar(a.kind)} onClick={(e) => { e.stopPropagation(); openEdit(a); }}
      title={`${a.title}${a.contact ? ` — ${a.contact.name}` : ''}${a.location ? ` — ${a.location}` : ''}`}>
      {withTime && !a.allDay && <b>{hm(new Date(a.start))}</b>} {a.status === 'done' && '✓ '}{a.title}
    </button>
  );

  // Heures affichées en vue semaine ou jour : 7 h – 20 h, élargies aux rendez-vous hors de cette plage.
  const timed = shown.filter((a) => !a.allDay);
  const firstHour = Math.min(7, ...timed.map((a) => new Date(a.start).getHours()));
  const lastHour = Math.max(20, ...timed.map((a) => { const e = new Date(a.end); return e.getHours() + (e.getMinutes() ? 1 : 0); }));
  const hours = Array.from({ length: Math.min(24, lastHour) - firstHour }, (_, i) => firstHour + i);
  const columns = view === 'day' ? [cursor] : Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const now = new Date();
  const upcoming = shown.filter((a) => a.status === 'planned' && new Date(a.end) >= now).slice(0, 6);

  return (
    <>
      <div className="page-head"><h1>Calendrier</h1>
        {creatable && <button className="btn primary" onClick={() => openNew(view === 'month' || view === 'list' ? at(ymd(new Date())) : cursor, '09:00')}>Nouveau rendez-vous</button>}</div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      <Alert>{!modal && error}</Alert>

      <div className="lv-bar">
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => move(-1)} aria-label="Période précédente">←</button>
          <button className="btn sm" onClick={() => move(1)} aria-label="Période suivante">→</button>
          <button className="btn sm" onClick={() => setCursor(at(ymd(new Date())))}>Aujourd'hui</button>
          <b className="cal-title">{title}</b>
        </div>
        <div className="seg" role="group" aria-label="Affichage">
          {([['month', 'Mois'], ['week', 'Semaine'], ['day', 'Jour'], ['list', 'Liste']] as [View, string][]).map(([v, l]) => <button key={v} type="button" aria-pressed={view === v} onClick={() => pickView(v)}>{l}</button>)}
        </div>
      </div>

      <div className="lv-layout">
        <div className="card cal-main">
          {view === 'month' && (
            <div className="cal-month">
              {DAYS.map((d) => <div key={d} className="cal-dow">{d}</div>)}
              {Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((d) => {
                const items = onDay(d);
                return (
                  <div key={ymd(d)} className={`cal-cell${d.getMonth() !== cursor.getMonth() ? ' out' : ''}${sameDay(d, now) ? ' today' : ''}${d.getDay() === 0 ? ' sun' : ''}`}
                    onClick={() => openNew(d)} role={creatable ? 'button' : undefined} aria-label={creatable ? `Nouveau rendez-vous le ${longDay(d)}` : undefined}>
                    <button type="button" className="cal-daynum" onClick={(e) => { e.stopPropagation(); setCursor(d); pickView('day'); }}>{d.getDate()}</button>
                    {items.slice(0, 3).map((a) => chip(a))}
                    {items.length > 3 && <button type="button" className="cal-more" onClick={(e) => { e.stopPropagation(); setCursor(d); pickView('day'); }}>+ {items.length - 3} autre{items.length > 4 ? 's' : ''}</button>}
                  </div>);
              })}
            </div>
          )}

          {(view === 'week' || view === 'day') && (
            <div className="cal-grid" style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(${columns.length > 1 ? 86 : 0}px, 1fr))` }}>
              <div />
              {columns.map((d) => <button key={ymd(d)} type="button" className={`cal-colhead${sameDay(d, now) ? ' today' : ''}`} onClick={() => { setCursor(d); pickView('day'); }}>
                <span>{DAYS[(d.getDay() + 6) % 7]}</span> <b>{d.getDate()}</b></button>)}
              <div className="cal-allday-label">Journée</div>
              {columns.map((d) => <div key={ymd(d)} className="cal-allday">{onDay(d).filter((a) => a.allDay).map((a) => chip(a, false))}</div>)}
              <div className="cal-hours">{hours.map((h) => <div key={h} style={{ height: HOUR_PX }}>{pad(h)}:00</div>)}</div>
              {columns.map((d) => (
                <div key={ymd(d)} className={`cal-day${d.getDay() === 0 ? ' sun' : ''}`} style={{ height: hours.length * HOUR_PX }}>
                  {hours.map((h) => <div key={h} className="cal-slot" style={{ height: HOUR_PX }} onClick={() => openNew(d, `${pad(h)}:00`)}
                    role={creatable ? 'button' : undefined} aria-label={creatable ? `Nouveau rendez-vous ${longDay(d)} à ${h} h` : undefined} />)}
                  {layout(onDay(d).filter((a) => !a.allDay), d).map(({ a, s, e, col, cols }) => (
                    <button key={a.id} type="button" className={`cal-event ${a.status}`} onClick={() => openEdit(a)}
                      style={{ ...hueVar(a.kind), top: ((s - firstHour * 60) * HOUR_PX) / 60, height: Math.max(22, ((e - s) * HOUR_PX) / 60 - 2), left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)` }}>
                      <b>{a.status === 'done' && '✓ '}{a.title}</b>
                      <span>{hm(new Date(a.start))} – {hm(new Date(a.end))}{a.contact ? ` · ${a.contact.name}` : ''}{a.location ? ` · ${a.location}` : ''}</span>
                    </button>))}
                  {sameDay(d, now) && now.getHours() >= firstHour && now.getHours() < firstHour + hours.length &&
                    <div className="cal-now" style={{ top: ((now.getHours() - firstHour) * 60 + now.getMinutes()) * HOUR_PX / 60 }} />}
                </div>))}
            </div>
          )}

          {view === 'list' && (
            <div className="cal-list">
              {Array.from({ length: 30 }, (_, i) => addDays(cursor, i)).filter((d) => onDay(d).length).map((d) => (
                <section key={ymd(d)}>
                  <h3 style={{ textTransform: 'capitalize' }}>{longDay(d)}{sameDay(d, now) && <> <Pill tone="ok">Aujourd'hui</Pill></>}</h3>
                  {onDay(d).map((a) => (
                    <button key={a.id} type="button" className={`cal-row ${a.status}`} style={hueVar(a.kind)} onClick={() => openEdit(a)}>
                      <span className="cal-time">{a.allDay ? 'Journée' : `${hm(new Date(a.start))} – ${hm(new Date(a.end))}`}</span>
                      <span><b>{a.title}</b> <span className="small muted">· {KINDS[a.kind][0]}</span>
                        <span className="small muted" style={{ display: 'block' }}>{[a.contact?.name, a.location, a.attendees.map((p: any) => p.name).join(', ')].filter(Boolean).join(' · ')}</span></span>
                      {a.status !== 'planned' && <Pill tone={a.status === 'done' ? 'ok' : 'mute'}>{a.status === 'done' ? 'Fait' : 'Annulé'}</Pill>}
                    </button>))}
                </section>))}
              {!shown.length && <p className="muted" style={{ margin: 0 }}>Aucun rendez-vous dans les 30 jours à partir du {longDay(cursor)}.</p>}
            </div>
          )}
        </div>

        <aside className="card lv-side">
          <h3>Agenda de</h3>
          <select className="input" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Agenda affiché">
            <option value="all">Toute l'équipe</option><option value="mine">Moi seulement</option>
            {people.filter((p) => p.id !== me.user.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <h3>Types</h3>
          {Object.entries(KINDS).map(([k, [l]]) => (
            <label key={k} className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input type="checkbox" checked={kinds.has(k)} onChange={() => { const n = new Set(kinds); if (n.has(k)) n.delete(k); else n.add(k); setKinds(n); }} />
              <span className="lv-swatch approved" style={hueVar(k)} />{l}</label>))}
          <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Afficher les annulés</label>
          <h3>Prochains rendez-vous</h3>
          {upcoming.length ? upcoming.map((a) => (
            <button key={a.id} type="button" className="cal-next" onClick={() => openEdit(a)}>
              <span className="lv-swatch approved" style={{ ...hueVar(a.kind), width: 6, height: 28 }} />
              <span><b>{a.title}</b><span className="small muted" style={{ display: 'block' }}>{new Date(a.start).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}{a.allDay ? '' : ` · ${hm(new Date(a.start))}`}{a.contact ? ` · ${a.contact.name}` : ''}</span></span>
            </button>)) : <p className="small muted" style={{ margin: 0 }}>Rien de prévu sur la période affichée.</p>}
          {creatable && <p className="small muted" style={{ margin: 0 }}>Cliquez sur un jour ou une heure pour planifier un rendez-vous à ce moment-là.</p>}
        </aside>
      </div>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: 'min(620px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{modal.id ? modal.title : 'Nouveau rendez-vous'} {modal.status && modal.status !== 'planned' && <Pill tone={modal.status === 'done' ? 'ok' : 'mute'}>{modal.status === 'done' ? 'Fait' : 'Annulé'}</Pill>}</h2>
            <Alert>{error}</Alert>
            {(() => {
              const editable = writable && (modal.id ? can('calendar.update') && modal.status !== 'cancelled' : creatable);
              return <>
                <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
                  <div className="grid2">
                    <Field label="Titre" required maxLength={160} placeholder="Ex. Visite du client, livraison…" value={modal.title} onChange={set('title')} />
                    <label className="field">Type<select className="input" value={modal.kind} onChange={set('kind')}>{Object.entries(KINDS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
                  </div>
                  <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={modal.allDay} onChange={set('allDay')} /> Toute la journée</label>
                  {modal.allDay
                    ? <div className="grid2"><Field label="Du" type="date" required value={modal.day} onChange={(e) => setModal({ ...modal, day: e.target.value, endDay: modal.endDay < e.target.value ? e.target.value : modal.endDay })} />
                      <Field label="Au (inclus)" type="date" required min={modal.day} value={modal.endDay} onChange={set('endDay')} /></div>
                    : <div className="cal-when"><Field label="Date" type="date" required value={modal.day} onChange={set('day')} />
                      <Field label="De" type="time" required step={300} value={modal.startTime} onChange={(e) => {
                        // L'heure de fin suit le début en gardant la durée.
                        const dur = at(modal.day, modal.endTime).getTime() - at(modal.day, modal.startTime).getTime();
                        const end = new Date(at(modal.day, e.target.value).getTime() + Math.max(dur, 15 * 60000));
                        setModal({ ...modal, startTime: e.target.value, endTime: sameDay(end, at(modal.day)) ? hm(end) : '23:59' });
                      }} />
                      <Field label="À" type="time" required step={300} min={modal.startTime} value={modal.endTime} onChange={set('endTime')} /></div>}
                  <div className="grid2">
                    <Field label="Lieu" placeholder="Adresse, magasin, visioconférence…" value={modal.location} onChange={set('location')} />
                    {contacts.length > 0 || modal.contact ? <label className="field">Client ou fournisseur<select className="input" value={modal.contactId} onChange={set('contactId')}>
                      <option value="">— Aucun —</option>
                      {modal.contact && !contacts.some((c) => c.id === modal.contact.id) && <option value={modal.contact.id}>{modal.contact.name}</option>}
                      {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label> : <div />}
                  </div>
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small muted" style={{ marginBottom: 6, fontWeight: 600 }}>Participants</legend>
                    <div className="row" style={{ gap: '6px 14px' }}>{people.map((p) => (
                      <label key={p.id} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={modal.attendeeIds.includes(p.id)}
                        onChange={(e) => setModal({ ...modal, attendeeIds: e.target.checked ? [...modal.attendeeIds, p.id] : modal.attendeeIds.filter((x: string) => x !== p.id) })} />
                        {p.name}{p.id === me.user.id ? ' (moi)' : ''}</label>))}</div>
                    <span className="small muted">Chaque participant reçoit un e-mail à l'invitation, au déplacement et à l'annulation.</span>
                  </fieldset>
                  <div className="grid2">
                    <label className="field">Rappel par e-mail<select className="input" value={modal.reminder} onChange={set('reminder')}>{REMINDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                    {modal.contact?.phone ? <div className="field" style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>Téléphone du contact<a className="btn sm" style={{ alignSelf: 'flex-start' }} href={`tel:${modal.contact.phone.replace(/\s/g, '')}`}>☎ {modal.contact.phone}</a></div> : <div />}
                  </div>
                  <label className="field">Notes<textarea className="input" rows={3} value={modal.notes} onChange={set('notes')} /></label>
                </fieldset>
                {modal.id && <p className="small muted" style={{ margin: 0 }}>Créé par {modal.createdByName ?? '—'}{(ctx?.sites.length ?? 0) > 1 ? ` · ${modal.siteName}` : ''}</p>}
                <div className="row">
                  {editable && <button className="btn primary" disabled={busy || !modal.attendeeIds.length}>Enregistrer</button>}
                  <button type="button" className="btn" onClick={() => setModal(null)}>{editable && !modal.id ? 'Annuler' : 'Fermer'}</button>
                  {modal.id && <a className="btn" href={`/api/company/calendar/appointments/${modal.id}/ics`} title="Fichier à ouvrir dans l'agenda du téléphone ou de la messagerie">Ajouter à mon agenda</a>}
                  {modal.id && writable && can('calendar.update') && <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
                    {modal.status === 'planned' && <button type="button" className="btn" disabled={busy} onClick={() => setStatus('done')}>Marquer fait</button>}
                    {modal.status === 'planned' && <button type="button" className="btn danger" disabled={busy} onClick={() => setStatus('cancelled')}>Annuler le rendez-vous</button>}
                    {modal.status !== 'planned' && <button type="button" className="btn" disabled={busy} onClick={() => setStatus('planned')}>Reprogrammer</button>}
                    {can('calendar.cancel') && <button type="button" className="btn danger" disabled={busy} onClick={remove}>Supprimer</button>}
                  </span>}
                </div>
              </>;
            })()}
          </form>
        </div>
      )}
    </>
  );
}
