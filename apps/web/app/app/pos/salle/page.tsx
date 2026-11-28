'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { KitchenSlip, PosTicket, STATIONS, ttc } from '@/components/pos';
import { PayDialog, PosPayment } from '@/components/pos-pay';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const since = (v: string) => { const m = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const KEY = 'kora.salle.register';

/** Salle : plan des tables du site de la caisse ; une commande ouverte par table, complétée au fil du repas puis encaissée. */
export default function SallePage() {
  const { has, can, ctx } = useSession();
  const [registers, setRegisters] = useState<any[] | null>(null);
  const [registerId, setRegisterId] = useState('');
  const [floor, setFloor] = useState<any>(null);
  const [areaId, setAreaId] = useState('');
  const [catalog, setCatalog] = useState<any[]>([]);
  const [order, setOrder] = useState<any>(null);
  const [opening, setOpening] = useState<any>(null);
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [moving, setMoving] = useState(false);
  const [paying, setPaying] = useState(false);
  const [ticket, setTicket] = useState<any>(null);
  const [bill, setBill] = useState(false);
  const [cancel, setCancel] = useState<string | null>(null);
  const [slips, setSlips] = useState<any[] | null>(null);
  const { busy, error, run, setError } = useAction();
  const panel = useRef<HTMLElement>(null);
  const openId = useRef<string | null>(null);
  openId.current = order?.id ?? null;
  // Sur téléphone, la commande s'affiche sous le plan : on y descend dès qu'une table est choisie.
  useEffect(() => { if (order?.id && window.innerWidth < 900) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [order?.id]);
  const write = can('pos.create') && !ctx?.readOnly;
  const withCard = !!ctx?.entitlements.modules.includes('bank');

  useEffect(() => {
    if (!has('restaurant_tables')) return;
    run(async () => {
      const r = (await api<any[]>('/company/pos/registers')).filter((x) => !x.archivedAt);
      setRegisters(r);
      let saved = ''; try { saved = localStorage.getItem(KEY) ?? ''; } catch { /* navigation privée */ }
      setRegisterId(r.find((x) => x.id === saved)?.id ?? r[0]?.id ?? '');
    });
  }, []); // eslint-disable-line
  const register = registers?.find((r) => r.id === registerId);
  const loadFloor = useCallback(async () => {
    if (!registerId) return;
    const f = await api<any>(`/company/restaurant/floor?registerId=${registerId}`);
    setFloor(f);
    setAreaId((a) => (f.areas.some((x: any) => x.id === a) ? a : f.areas[0]?.id ?? ''));
  }, [registerId]);
  const loadRegisters = useCallback(async () => setRegisters((await api<any[]>('/company/pos/registers')).filter((x) => !x.archivedAt)), []);
  useEffect(() => {
    if (!registerId) return;
    try { localStorage.setItem(KEY, registerId); } catch { /* navigation privée */ }
    run(loadFloor);
    api<any[]>(`/company/pos/registers/${registerId}/catalog`).then(setCatalog, () => setCatalog([]));
    // Les autres serveurs prennent aussi des commandes : le plan se rafraîchit seul.
    const h = setInterval(() => {
      loadFloor().catch(() => {});
      // La commande ouverte suit aussi : un bon annoncé prêt en cuisine s'affiche sans rien toucher.
      if (openId.current) api<any>(`/company/restaurant/orders/${openId.current}`).then((o) => { if (o.id === openId.current && o.status === 'open') setOrder(o); }, () => {});
    }, 15000);
    return () => clearInterval(h);
  }, [registerId]); // eslint-disable-line

  const matches = useMemo(() => {
    const t = norm(q.trim());
    return (t ? catalog.filter((p) => norm(p.name).includes(t) || norm(p.code).includes(t) || (p.barcode && p.barcode.includes(q.trim()))) : catalog).slice(0, 60);
  }, [catalog, q]);

  if (!has('restaurant_tables')) return <Alert kind="warn">Le plan de salle n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;
  if (registers && !registers.length) return <><h1>Salle</h1><p className="muted">Créez d&apos;abord une caisse dans <Link href="/app/pos">Point de vente</Link>.</p></>;

  const area = floor?.areas.find((a: any) => a.id === areaId);
  // La salle ne montre que la partie utile du plan (une case libre autour des tables).
  const rows = Math.max(3, ...(area?.tables ?? []).map((x: any) => x.y + 2));
  const cols = Math.max(4, ...(area?.tables ?? []).map((x: any) => x.x + (x.shape === 'long' ? 2 : 1) + 1));
  const allTables = floor?.areas.flatMap((a: any) => a.tables.map((x: any) => ({ ...x, areaName: a.name }))) ?? [];

  const pick = (x: any) => {
    setError(''); setMoving(false); setNote('');
    if (x.order) run(async () => setOrder(await api(`/company/restaurant/orders/${x.order.id}`)));
    else if (write) { setOrder(null); setOpening({ table: x, guests: String(Math.min(x.seats, 2)) }); }
  };
  const openTable = () => run(async () => {
    const o = await api(`/company/restaurant/tables/${opening.table.id}/orders`, { body: { guests: Number(opening.guests) || 1 } });
    setOpening(null); setOrder(o); await loadFloor();
  });
  const add = (p: any) => run(async () => {
    setOrder(await api(`/company/restaurant/orders/${order.id}/lines`, { body: { lines: [{ productId: p.id, quantity: 1, note: note || null }] } }));
    setNote(''); loadFloor();
  });
  const setQty = (l: any, quantity: number) => run(async () => {
    setOrder(quantity <= 0 ? await api(`/company/restaurant/orders/${order.id}/lines/${l.id}`, { method: 'DELETE' })
      : await api(`/company/restaurant/orders/${order.id}/lines/${l.id}`, { method: 'PATCH', body: { quantity } }));
    loadFloor();
  });
  const setGuests = (guests: number) => run(async () => setOrder(await api(`/company/restaurant/orders/${order.id}`, { method: 'PATCH', body: { guests } })));
  const moveTo = (tableId: string) => run(async () => { setOrder(await api(`/company/restaurant/orders/${order.id}/move`, { body: { tableId } })); setMoving(false); await loadFloor(); });
  const pay = (payments: PosPayment[]) => run(async () => {
    const t = await api(`/company/restaurant/orders/${order.id}/pay`, { body: { sessionId: register.session.id, payments } });
    setPaying(false); setOrder(null); setTicket(t); await Promise.all([loadFloor(), loadRegisters()]);
    api<any[]>(`/company/pos/registers/${registerId}/catalog`).then(setCatalog, () => {});
  });
  const sendOrder = () => run(async () => {
    const r = await api<any>(`/company/restaurant/orders/${order.id}/send`, { body: {} });
    setOrder(r.order); if (r.tickets.length) setSlips(r.tickets); await loadFloor();
  });
  const served = (ticketId: string) => run(async () => {
    await api(`/company/restaurant/kitchen/${ticketId}/served`, { body: {} });
    setOrder(await api(`/company/restaurant/orders/${order.id}`)); await loadFloor();
  });
  /** État d'une ligne : à envoyer, en préparation, prête, servie. */
  const lineState = (l: any): [string, 'warn' | 'ok' | undefined] => !l.sentAt ? ['À envoyer', 'warn']
    : l.station === 'none' || !l.ticketStatus ? ['Envoyé', undefined]
    : l.ticketStatus === 'pending' ? [l.station === 'bar' ? 'Au bar' : 'En cuisine', undefined] : l.ticketStatus === 'ready' ? ['Prêt', 'ok'] : ['Servi', undefined];
  const doCancel = () => run(async () => {
    await api(`/company/restaurant/orders/${order.id}/cancel`, { body: { reason: cancel || null } });
    setCancel(null); setOrder(null); await loadFloor();
  });

  return (
    <>
      <div className="page-head"><h1>Salle</h1>
        <div className="row">
          {registers && registers.length > 1 && <select className="input" style={{ width: 200 }} value={registerId} onChange={(e) => { setOrder(null); setRegisterId(e.target.value); }} aria-label="Caisse">
            {registers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
          {register && (register.session
            ? <span className="small muted">{register.name} ouverte · {register.session.openedBy}</span>
            : <Link className="btn sm" href={`/app/pos/caisse/${register.id}`}>Ouvrir {register.name}</Link>)}
          {can('pos.admin') && <Link className="btn sm" href="/app/pos/plan">Modifier le plan</Link>}
        </div></div>
      <Alert>{!paying && !cancel ? error : ''}</Alert>
      {floor && !floor.areas.length && <p className="muted">Aucune table pour ce site. {can('pos.admin') ? <Link href="/app/pos/plan">Dessinez le plan de salle</Link> : 'Demandez au responsable de dessiner le plan de salle.'}</p>}
      {floor && floor.areas.length > 0 && <div className="salle">
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <div className="floor-tabs">{floor.areas.map((a: any) => <button key={a.id} className={`btn sm${a.id === areaId ? ' primary' : ''}`} onClick={() => setAreaId(a.id)}>
            {a.name} <span className="muted">({a.tables.filter((x: any) => x.order).length}/{a.tables.length})</span></button>)}</div>
          {area && <div className="floor-grid" style={{ ['--cols' as any]: cols, gridTemplateRows: `repeat(${rows}, 100px)` }}>
            {area.tables.map((x: any) => (
              <button key={x.id} type="button" className={`floor-table${x.shape === 'round' ? ' round' : ''}${x.order ? ' busy' : ''}${order?.tableId === x.id ? ' selected' : ''}`}
                style={{ gridColumn: `${x.x + 1} / span ${x.shape === 'long' ? 2 : 1}`, gridRow: x.y + 1 }} onClick={() => pick(x)}
                aria-label={`Table ${x.name}, ${x.order ? `occupée, ${money(x.order.total)}` : 'libre'}`}>
                <b>{x.name}</b>
                {x.order ? <>{x.order.ready > 0 ? <span className="floor-badge ready">Prêt</span> : x.order.pending > 0 ? <span className="floor-badge pending">En cours</span> : null}
                  <span className="small">{money(x.order.total)}</span><span className="small muted">{x.order.guests} couv.</span><span className="small muted">{since(x.order.openedAt)}</span></>
                  : <span className="small muted">{x.seats} places</span>}
              </button>
            ))}
          </div>}
          <p className="small muted" style={{ margin: 0 }}>Touchez une table libre pour l&apos;ouvrir, une table occupée pour voir et compléter sa commande. Le plan se met à jour toutes les 15 secondes.</p>
        </div>

        <aside className="order-panel" ref={panel}>
          {!order ? <p className="muted" style={{ margin: 0 }}>Choisissez une table.</p> : <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>Table {order.tableName}</h2>
              <span className="small muted">{order.areaName} · {since(order.openedAt)} · {order.openedBy}</span>
            </div>
            {order.status === 'open' && write && <div className="row" style={{ alignItems: 'center', gap: 6 }}>
              <span className="small">Couverts</span>
              <button className="btn sm" disabled={busy || order.guests <= 1} onClick={() => setGuests(order.guests - 1)} aria-label="Un couvert de moins">−</button>
              <b>{order.guests}</b>
              <button className="btn sm" disabled={busy} onClick={() => setGuests(order.guests + 1)} aria-label="Un couvert de plus">+</button>
            </div>}
            <div className="order-lines">
              {!order.lines.length && <p className="small muted" style={{ margin: 0 }}>Aucun article : ajoutez-les ci-dessous.</p>}
              {order.lines.map((l: any) => (
                <div key={l.id} className="order-line">
                  <div className="order-qty">
                    {write && (!l.sentAt || can('pos.validate')) && <button className="btn sm" disabled={busy} onClick={() => setQty(l, l.quantity - 1)} aria-label="Retirer une unité"
                      title={l.sentAt ? 'Article déjà envoyé : retrait réservé au responsable' : undefined}>−</button>}
                    <b>{l.quantity.toLocaleString('fr-FR')}</b>
                    {write && !l.sentAt && <button className="btn sm" disabled={busy} onClick={() => setQty(l, l.quantity + 1)} aria-label="Ajouter une unité">+</button>}
                  </div>
                  <div className="small">{l.description} {(() => { const [label, tone] = lineState(l); return <Pill tone={tone}>{label}</Pill>; })()}{l.note && <div className="muted">« {l.note} »</div>}</div>
                  <b className="small">{money(l.totalTtc)}</b>
                </div>
              ))}
            </div>
            {order.tickets.filter((k: any) => k.status === 'ready').map((k: any) => (
              <Alert key={k.id} kind="ok"><div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span><b>{STATIONS[k.station]} : bon {k.number} prêt</b>, à servir.</span>
                {write && <button className="btn sm primary" disabled={busy} onClick={() => served(k.id)}>Servi</button>}</div></Alert>))}
            <div className="pos-total"><span>Total</span><b>{money(order.totals.ttc)}</b></div>
            {write && order.unsent > 0 && <button className="btn primary" disabled={busy} onClick={sendOrder}>Envoyer en cuisine ({order.unsent} article{order.unsent > 1 ? 's' : ''})</button>}
            {write && <>
              <div className="grid2">
                <input className="input" type="search" placeholder="Rechercher un article" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un article" />
                <input className="input" placeholder="Remarque (sans piment…)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Remarque pour la cuisine" />
              </div>
              <div className="order-picker">
                {matches.map((p) => <button key={p.id} type="button" className="pos-tile" disabled={busy} onClick={() => add(p)}>
                  <span className="pos-tile-name small">{p.name}</span><b>{money(ttc(p.salePrice, p.vatRate))}</b>
                  {p.stock != null && <span className="small" style={{ color: p.stock <= 0 ? 'var(--crit)' : 'var(--muted)' }}>{p.stock <= 0 ? 'Rupture' : `Stock ${p.stock.toLocaleString('fr-FR')}`}</span>}</button>)}
                {!matches.length && <p className="small muted">Aucun article.</p>}
              </div>
              <div className="row">
                <button className={`btn${order.unsent ? '' : ' primary'}`} disabled={busy || !order.lines.length || !register?.session} title={!register?.session ? `Ouvrez d'abord ${register?.name}` : undefined} onClick={() => { setError(''); setPaying(true); }}>Encaisser</button>
                <button className="btn" disabled={!order.lines.length} onClick={() => setBill(true)}>Addition</button>
                <button className="btn" disabled={busy} onClick={() => setMoving(!moving)}>Transférer</button>
                <button className="btn danger" disabled={busy} onClick={() => { setError(''); setCancel(''); }}>Annuler</button>
              </div>
              {!register?.session && <p className="small muted" style={{ margin: 0 }}>Pour encaisser, <Link href={`/app/pos/caisse/${register?.id}`}>ouvrez {register?.name}</Link> avec son fond de caisse.</p>}
              {moving && <div style={{ display: 'grid', gap: 6 }}>
                <span className="small">Transférer vers une table libre :</span>
                <div className="row" style={{ gap: 6 }}>{allTables.filter((x: any) => !x.order).map((x: any) => <button key={x.id} className="btn sm" disabled={busy} onClick={() => moveTo(x.id)}>{x.name} <span className="muted">· {x.areaName}</span></button>)}
                  {!allTables.some((x: any) => !x.order) && <span className="small muted">Aucune table libre.</span>}</div>
              </div>}
            </>}
          </>}
        </aside>
      </div>}

      {opening && <div className="modal-back" onClick={() => setOpening(null)}><form className="modal" style={{ width: 'min(380px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); openTable(); }}>
        <h2 style={{ margin: 0 }}>Ouvrir la table {opening.table.name}</h2>
        <Alert>{error}</Alert>
        <Field label="Nombre de couverts" type="number" min={1} max={200} autoFocus value={opening.guests} onChange={(e) => setOpening({ ...opening, guests: e.target.value })} />
        <div className="row"><button className="btn primary" disabled={busy}>Ouvrir la table</button><button type="button" className="btn" onClick={() => setOpening(null)}>Annuler</button></div>
      </form></div>}

      {paying && order && <PayDialog total={order.totals.ttc} withCard={withCard} busy={busy} error={error} title={`Table ${order.tableName} ·`} onPay={pay} onClose={() => setPaying(false)} />}

      {cancel !== null && order && <div className="modal-back" onClick={() => setCancel(null)}><form className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); doCancel(); }}>
        <h2 style={{ margin: 0 }}>Annuler la commande de la table {order.tableName}</h2>
        <Alert>{error}</Alert>
        {order.lines.length > 0
          ? order.lines.some((l: any) => l.sentAt)
            ? <><p className="small" style={{ margin: 0 }}>Des articles sont déjà envoyés en préparation : rien ne sera encaissé ni sorti du stock, les bons en attente seront annulés. L&apos;annulation est réservée au responsable de caisse et reste inscrite au journal.</p>
              <Field label="Motif" required value={cancel} onChange={(e) => setCancel(e.target.value)} placeholder="Client parti, erreur de table…" /></>
            : <p className="small" style={{ margin: 0 }}>Rien n&apos;est encore envoyé en cuisine : la commande sera supprimée et la table libérée.</p>
          : <p className="small" style={{ margin: 0 }}>La commande est vide : la table sera libérée.</p>}
        <div className="row"><button className="btn danger" disabled={busy}>Annuler la commande</button><button type="button" className="btn" onClick={() => setCancel(null)}>Retour</button></div>
      </form></div>}

      {bill && order && <div className="modal-back" onClick={() => setBill(false)}><div className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="tk print-area">
          <div className="tk-head"><b className="tk-title">Addition</b></div>
          <div className="tk-meta"><span>Table {order.tableName}</span><span>{order.guests} couvert{order.guests > 1 ? 's' : ''}</span></div>
          <div className="tk-meta"><span>{new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span><span>{order.openedBy}</span></div>
          <div className="tk-lines">{order.lines.map((l: any) => <div key={l.id} className="tk-row"><span>{l.quantity.toLocaleString('fr-FR')} × {l.description}</span><b>{money(l.totalTtc)}</b></div>)}</div>
          <div className="tk-total"><span>TOTAL TTC</span><b>{money(order.totals.ttc)}</b></div>
          <p className="tk-foot">Ce document n&apos;est pas un ticket de caisse.</p>
        </div>
        <div className="row no-print"><button className="btn primary" onClick={() => window.print()}>Imprimer l&apos;addition</button><button className="btn" onClick={() => setBill(false)}>Fermer</button></div>
      </div></div>}

      {slips && <div className="modal-back" onClick={() => setSlips(null)}><div className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <Alert kind="ok">{slips.length > 1 ? `${slips.length} bons envoyés` : 'Bon envoyé'} : {slips.map((k) => `${STATIONS[k.station]} n° ${k.number}`).join(', ')}. {slips.length > 1 ? 'Ils s’affichent' : 'Il s’affiche'} sur l&apos;écran Cuisine et bar.</Alert>
        <div className="print-area">{slips.map((k) => <KitchenSlip key={k.id} k={k} />)}</div>
        <div className="row no-print"><button className="btn primary" autoFocus onClick={() => setSlips(null)}>Retour à la salle</button><button className="btn" onClick={() => window.print()}>Imprimer {slips.length > 1 ? 'les bons' : 'le bon'}</button></div>
      </div></div>}

      {ticket && <div className="modal-back" onClick={() => setTicket(null)}><div className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="no-print">{ticket.change > 0 ? <div className="pos-change big"><span>Monnaie à rendre</span><b>{money(ticket.change)}</b></div>
          : <Alert kind="ok">Ticket {ticket.number} enregistré : {money(ticket.totalTtc)}.</Alert>}</div>
        <PosTicket t={ticket} />
        <div className="row no-print"><button className="btn primary" autoFocus onClick={() => setTicket(null)}>Retour à la salle</button><button className="btn" onClick={() => window.print()}>Imprimer le ticket</button></div>
      </div></div>}
    </>
  );
}
