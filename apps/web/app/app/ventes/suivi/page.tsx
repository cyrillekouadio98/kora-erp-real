'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const STAGES: [string, string, number][] = [['new', 'Nouveau', 10], ['qualified', 'Qualifié', 30], ['quote', 'Devis envoyé', 50], ['negotiation', 'Négociation', 75], ['won', 'Gagné', 100], ['lost', 'Perdu', 0]];
const STAGE = Object.fromEntries(STAGES.map(([k, l]) => [k, l]));
const KINDS: Record<string, string> = { call: 'Appel', meeting: 'Rendez-vous', email: 'E-mail', note: 'Note', task: 'À faire' };
const DOC: Record<string, string> = { quote: 'Devis', order: 'Commande', invoice: 'Facture' };
const today = () => new Date().toISOString().slice(0, 10);

/** Suivi commercial : opportunités sur un tableau par étapes, du prospect au devis gagné. */
export default function PipelinePage() {
  const { has, can, ctx, me } = useSession();
  const [data, setData] = useState<any>(null);
  const [contacts, setContacts] = useState<any[]>([]);
  const [owner, setOwner] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [act, setAct] = useState({ kind: 'call', note: '', dueDate: '' });
  const { busy, error, run } = useAction();
  const write = can('sales.update') && !ctx?.readOnly;
  const load = useCallback(async () => setData(await api(`/company/opportunities?${new URLSearchParams({ ...(owner ? { ownerId: owner } : {}), ...(q.trim() ? { q: q.trim() } : {}) })}`)), [owner, q]);
  useEffect(() => { if (has('crm')) { const h = setTimeout(() => run(load), 250); return () => clearTimeout(h); } }, [load]); // eslint-disable-line
  useEffect(() => { if (has('crm')) api<any[]>('/company/contacts?kind=customer').then(setContacts, () => {}); }, []); // eslint-disable-line
  if (!has('crm')) return <Alert kind="warn">Le suivi commercial n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;

  const open = (id: string) => run(async () => { setAct({ kind: 'call', note: '', dueDate: '' }); setDetail(await api(`/company/opportunities/${id}`)); });
  const refresh = async (id?: string) => { await load(); if (id) setDetail(await api(`/company/opportunities/${id}`)); };
  const patch = (body: any) => run(async () => { await api(`/company/opportunities/${detail.id}`, { method: 'PATCH', body }); await refresh(detail.id); });
  const move = (stage: string) => {
    if (stage === 'lost') { const reason = window.prompt('Pourquoi cette affaire est-elle perdue ? (prix, concurrent, plus de besoin…)'); if (!reason) return; patch({ stage, lostReason: reason }); } else patch({ stage });
  };
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<any>('/company/opportunities', { body: { title: form.title, amount: Number(form.amount || 0), source: form.source || null, expectedClose: form.expectedClose || null,
        ...(form.contactId ? { contactId: form.contactId } : { prospectName: form.prospectName, prospectPhone: form.prospectPhone || null, prospectEmail: form.prospectEmail || '' }) } });
      setForm(null); await load(); open(r.id);
    });
  };
  const addActivity = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => { await api(`/company/opportunities/${detail.id}/activities`, { body: { kind: act.kind, note: act.note, ...(act.dueDate ? { dueDate: act.dueDate } : {}) } }); setAct({ kind: 'call', note: '', dueDate: '' }); await refresh(detail.id); });
  };
  const s = data?.summary;
  return (
    <>
      <div className="page-head"><h1>Suivi commercial</h1>
        {can('sales.create') && !ctx?.readOnly && <button className="btn primary" onClick={() => setForm({ title: '', contactId: '', prospectName: '', prospectPhone: '', prospectEmail: '', amount: '', source: '', expectedClose: '' })}>+ Nouvelle opportunité</button>}</div>
      <Alert>{error}</Alert>
      {s && <div className="kpis">
        <div className="card kpi"><div className="l">Affaires en cours</div><div className="v">{s.open}</div><div className="small muted">{money(s.pipeline)} espérés</div></div>
        <div className="card kpi"><div className="l">Montant pondéré</div><div className="v">{money(s.weighted)}</div><div className="small muted">selon l&apos;étape de chaque affaire</div></div>
        <div className="card kpi"><div className="l">Gagnées ce mois</div><div className="v" style={{ color: 'var(--ok)' }}>{money(s.wonThisMonth.amount)}</div><div className="small muted">{s.wonThisMonth.count} gagnée(s), {s.lostThisMonth} perdue(s)</div></div>
        <div className="card kpi"><div className="l">Relances en retard</div><div className="v" style={{ color: s.overdue ? 'var(--crit)' : undefined }}>{s.overdue}</div></div>
      </div>}
      <div className="row">
        <input className="input" style={{ maxWidth: 280 }} placeholder="Rechercher (client, intitulé, n°)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher" />
        <select className="input" style={{ width: 220 }} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Commercial">
          <option value="">Tous les commerciaux</option>{data?.members.map((m: any) => <option key={m.id} value={m.id}>{m.name}{m.id === me.user.id ? ' (moi)' : ''}</option>)}</select>
      </div>
      {data && <div style={{ overflowX: 'auto' }}><div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(210px, 1fr))', gap: 10, minWidth: 1300 }}>
        {STAGES.map(([k, l, p]) => {
          const items = data.opportunities.filter((o: any) => o.stage === k);
          return <div key={k} style={{ display: 'grid', gap: 8, alignContent: 'start', background: 'var(--surface-2, transparent)', borderRadius: 10 }}>
            <div className="small" style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}><span>{l} <span className="muted">({items.length})</span></span><span className="muted">{p} %</span></div>
            <div className="small muted">{money(items.reduce((x: number, o: any) => x + o.amount, 0))}</div>
            {items.map((o: any) => (
              <button key={o.id} type="button" className="card" onClick={() => open(o.id)} style={{ textAlign: 'left', cursor: 'pointer', display: 'grid', gap: 4, padding: 12 }}>
                <b style={{ fontSize: 14 }}>{o.title}</b>
                <span className="small">{o.customer}{o.prospect && <> <Pill>Prospect</Pill></>}</span>
                <span className="small"><b>{money(o.amount)}</b>{o.expectedClose && <span className="muted"> · {date(o.expectedClose)}</span>}</span>
                {o.nextAction && <span className="small" style={{ color: o.overdue ? 'var(--crit)' : 'var(--muted)' }}>⏰ {o.nextAction.note} · {date(o.nextAction.dueDate)}</span>}
                {o.owner && <span className="small muted">{o.owner}</span>}
              </button>
            ))}
          </div>;
        })}
      </div></div>}

      {form && <div className="modal-back" onClick={() => setForm(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={create} style={{ display: 'grid', gap: 10 }}>
        <h2>Nouvelle opportunité</h2>
        <Field label="Intitulé" required minLength={2} placeholder="Ex. Approvisionnement mensuel en aliment" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <label className="field">Client<select className="input" value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
          <option value="">Nouveau prospect (pas encore client)</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label>
        {!form.contactId && <div className="grid2">
          <Field label="Nom du prospect" required value={form.prospectName} onChange={(e) => setForm({ ...form, prospectName: e.target.value })} />
          <Field label="Téléphone" value={form.prospectPhone} onChange={(e) => setForm({ ...form, prospectPhone: e.target.value })} />
          <Field label="E-mail" type="email" value={form.prospectEmail} onChange={(e) => setForm({ ...form, prospectEmail: e.target.value })} />
        </div>}
        <div className="grid2">
          <Field label="Montant espéré HT (FCFA)" type="number" min={0} step="any" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <Field label="Conclusion prévue" type="date" value={form.expectedClose} onChange={(e) => setForm({ ...form, expectedClose: e.target.value })} />
          <Field label="Origine" placeholder="Ex. recommandation, salon, appel entrant" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
        </div>
        <div className="row"><button className="btn primary" disabled={busy}>Créer</button><button type="button" className="btn" onClick={() => setForm(null)}>Annuler</button></div>
      </form></div>}

      {detail && <div className="modal-back" onClick={() => setDetail(null)}><div className="modal" onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gap: 12, maxWidth: 760 }}>
        <header className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{detail.code} · {detail.title}</h2><Pill tone={detail.stage === 'won' ? 'ok' : detail.stage === 'lost' ? 'crit' : undefined}>{STAGE[detail.stage]}</Pill></header>
        {write && <div className="row" style={{ gap: 6 }}>{STAGES.map(([k, l]) => <button key={k} type="button" className={`btn sm${detail.stage === k ? ' primary' : ''}`} disabled={busy || detail.stage === k} onClick={() => move(k)}>{l}</button>)}</div>}
        {detail.stage === 'lost' && detail.lostReason && <p className="small" style={{ margin: 0 }}>Motif de perte : <b>{detail.lostReason}</b></p>}
        <div className="grid2">
          <label className="field">Client<select className="input" disabled={!write} value={detail.contactId ?? ''} onChange={(e) => e.target.value && patch({ contactId: e.target.value })}>
            {!detail.contactId && <option value="">Prospect : {detail.prospectName}</option>}{contacts.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select>
            {!detail.contactId && <span className="small muted">{[detail.prospectPhone, detail.prospectEmail].filter(Boolean).join(' · ')} — devenu client ? <Link href="/app/contacts">Créez sa fiche</Link> puis choisissez-le ici.</span>}</label>
          <label className="field">Commercial<select className="input" disabled={!write} value={detail.ownerId ?? ''} onChange={(e) => patch({ ownerId: e.target.value || null })}>
            <option value="">Personne</option>{data?.members.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <Field label="Montant espéré HT (FCFA)" type="number" min={0} disabled={!write} defaultValue={detail.amount} onBlur={(e) => Number(e.target.value) !== detail.amount && patch({ amount: Number(e.target.value || 0) })} />
          <Field label="Conclusion prévue" type="date" disabled={!write} value={detail.expectedClose ?? ''} onChange={(e) => patch({ expectedClose: e.target.value || null })} />
          {detail.contactId && <label className="field">Devis lié<select className="input" disabled={!write} value={detail.quoteId ?? ''} onChange={(e) => patch({ quoteId: e.target.value || null })}>
            <option value="">Aucun</option>{detail.quotes.map((d: any) => <option key={d.id} value={d.id}>{DOC[d.type]} {d.number ?? '(brouillon)'} · {money(d.total)}</option>)}</select>
            <span className="small muted">{detail.quoteId ? <Link href={`/app/ventes/${detail.quoteId}`}>Ouvrir le document</Link> : <Link href={`/app/ventes/nouveau?type=quote`}>Établir un devis</Link>}</span></label>}
        </div>
        <h3 style={{ margin: 0 }}>Actions</h3>
        {write && <form onSubmit={addActivity} className="row" style={{ gap: 6, alignItems: 'end' }}>
          <label className="field" style={{ width: 140 }}>Type<select className="input" value={act.kind} onChange={(e) => setAct({ ...act, kind: e.target.value })}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <div style={{ flex: 1, minWidth: 200 }}><Field label="Compte rendu ou action à faire" required value={act.note} onChange={(e) => setAct({ ...act, note: e.target.value })} /></div>
          <Field label="À faire le (relance)" type="date" min={today()} value={act.dueDate} onChange={(e) => setAct({ ...act, dueDate: e.target.value })} style={{ width: 160 }} />
          <button className="btn" disabled={busy}>Ajouter</button></form>}
        <div style={{ display: 'grid', gap: 6, maxHeight: 280, overflowY: 'auto' }}>{detail.activities.length ? detail.activities.map((a: any) => (
          <div key={a.id} className="row small" style={{ gap: 8, alignItems: 'baseline' }}>
            <Pill tone={!a.doneAt ? (a.dueDate < today() ? 'crit' : 'warn') : undefined}>{KINDS[a.kind]}</Pill>
            <span style={{ flex: 1 }}>{a.note}{!a.doneAt && a.dueDate && <b> — pour le {date(a.dueDate)}</b>}<span className="muted"> · {a.user ?? ''}, {date(a.createdAt)}</span></span>
            {!a.doneAt && write && <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api(`/company/opportunities/activities/${a.id}/done`, { body: {} }); await refresh(detail.id); })}>Fait</button>}
          </div>)) : <p className="small muted" style={{ margin: 0 }}>Aucune action pour l&apos;instant.</p>}</div>
        <div><button className="btn" onClick={() => setDetail(null)}>Fermer</button></div>
      </div></div>}
    </>
  );
}
