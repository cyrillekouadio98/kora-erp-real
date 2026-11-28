'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { KitchenSlip, STATIONS } from '@/components/pos';
import { Alert, useAction } from '@/components/ui';

const minutes = (v: string) => Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000));
const KEY = 'kora.cuisine.station';

/** Écran de la cuisine ou du bar : bons à préparer, du plus ancien au plus récent ; « Prêt » prévient le serveur. */
export default function KitchenPage() {
  const { has, ctx } = useSession();
  const [station, setStation] = useState<'kitchen' | 'bar'>('kitchen');
  const [siteId, setSiteId] = useState('');
  const [board, setBoard] = useState<any>(null);
  const [print, setPrint] = useState<any>(null);
  const [, tick] = useState(0);
  const { busy, error, run } = useAction();
  const sites = ctx?.sites ?? [];

  useEffect(() => { try { const s = localStorage.getItem(KEY); if (s === 'bar' || s === 'kitchen') setStation(s); } catch { /* navigation privée */ } }, []);
  const load = useCallback(async () => setBoard(await api(`/company/restaurant/kitchen?station=${station}${siteId ? `&siteId=${siteId}` : ''}`)), [station, siteId]);
  useEffect(() => {
    if (!has('restaurant_tables')) return;
    try { localStorage.setItem(KEY, station); } catch { /* navigation privée */ }
    run(load);
    // Les serveurs envoient en continu : l'écran se met à jour seul, et l'attente de chaque bon avance.
    const h = setInterval(() => { load().catch(() => {}); tick((x) => x + 1); }, 10000);
    return () => clearInterval(h);
  }, [load]); // eslint-disable-line

  if (!has('restaurant_tables')) return <Alert kind="warn">Le plan de salle n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;
  const mark = (id: string, status: 'ready' | 'pending') => run(async () => { await api(`/company/restaurant/kitchen/${id}/${status}`, { body: {} }); await load(); });
  const writable = !ctx?.readOnly;

  return (
    <>
      <div className="page-head"><h1>{STATIONS[station]}</h1>
        <div className="row">
          {sites.length > 1 && <select className="input" style={{ width: 180 }} value={siteId || board?.siteId || ''} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
            {sites.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          <div className="seg" role="group" aria-label="Poste">
            {(['kitchen', 'bar'] as const).map((k) => <button key={k} aria-pressed={station === k} onClick={() => setStation(k)}>{STATIONS[k]}{board?.counts?.[k] ? ` (${board.counts[k]})` : ''}</button>)}
          </div>
        </div></div>
      <p className="muted" style={{ margin: 0 }}>Les bons arrivent ici dès que le serveur envoie la commande depuis la <Link href="/app/pos/salle">salle</Link>. Touchez <b>Prêt</b> quand le plat est prêt à servir : la table le signale au serveur. L&apos;écran se met à jour toutes les 10 secondes.</p>
      <Alert>{error}</Alert>
      {board && <>
        {!board.pending.length && <p className="muted">Aucun bon en attente.</p>}
        <div className="kitchen-board">
          {board.pending.map((k: any) => {
            const m = minutes(k.createdAt);
            return (
              <div key={k.id} className={`kitchen-card${m >= 25 ? ' very-late' : m >= 15 ? ' late' : ''}`}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <b style={{ fontSize: 20 }}>Table {k.tableName}</b>
                  <span className="small" style={{ color: m >= 25 ? 'var(--crit)' : m >= 15 ? 'var(--warn)' : 'var(--muted)', fontWeight: 600 }}>{m} min</span>
                </div>
                <div className="small muted">Bon {k.number} · {k.guests} couv. · {k.waiter ?? ''}</div>
                <div style={{ display: 'grid', gap: 4 }}>{k.lines.map((l: any, i: number) => (
                  <div key={i}><div className="kline">{l.quantity.toLocaleString('fr-FR')} × {l.description}</div>{l.note && <div className="knote small">→ {l.note}</div>}</div>))}</div>
                <div className="row">
                  {writable && <button className="btn primary" disabled={busy} onClick={() => mark(k.id, 'ready')}>Prêt</button>}
                  <button className="btn sm" onClick={() => setPrint(k)}>Imprimer</button>
                </div>
              </div>
            );
          })}
        </div>
        {board.ready.length > 0 && <>
          <h2 style={{ margin: '8px 0 0' }}>Prêts, en attente du serveur</h2>
          <div className="kitchen-board">{board.ready.map((k: any) => (
            <div key={k.id} className="kitchen-card ready">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}><b>Table {k.tableName}</b><span className="small muted">Bon {k.number} · prêt depuis {minutes(k.readyAt)} min</span></div>
              <div className="small">{k.lines.map((l: any) => `${l.quantity.toLocaleString('fr-FR')} × ${l.description}`).join(' · ')}</div>
              {writable && <div><button className="btn sm" disabled={busy} onClick={() => mark(k.id, 'pending')}>Remettre en préparation</button></div>}
            </div>))}</div>
        </>}
      </>}

      {print && <div className="modal-back" onClick={() => setPrint(null)}><div className="modal" style={{ width: 'min(380px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="print-area"><KitchenSlip k={print} /></div>
        <div className="row no-print"><button className="btn primary" autoFocus onClick={() => window.print()}>Imprimer</button><button className="btn" onClick={() => setPrint(null)}>Fermer</button></div>
      </div></div>}
    </>
  );
}
