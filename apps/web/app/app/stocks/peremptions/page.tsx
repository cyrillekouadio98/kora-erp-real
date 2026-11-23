'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money, qty } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';

const STATUS: Record<string, string> = { expired: 'Périmés', expiring: 'Bientôt périmés', all: 'Tous les lots' };

/** Lots en stock et leur date limite (fonctionnalité « Lots et dates de péremption »). */
export default function ExpiryPage() {
  const { has } = useSession();
  const [status, setStatus] = useState('expiring');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<any>(null);
  const { error, run } = useAction();
  useEffect(() => { if (has('stock_lots')) run(async () => setData(await api(`/company/stock/lots?status=${status}&days=${days}`))); }, [status, days]); // eslint-disable-line
  if (!has('stock_lots')) return <Alert kind="warn">Le suivi par lots n'est pas activé pour votre entreprise. Contactez Kora ERP pour l'activer.</Alert>;
  const when = (l: any) => l.daysLeft === null ? 'sans date' : l.daysLeft < 0 ? `périmé depuis ${-l.daysLeft} j` : l.daysLeft === 0 ? "périme aujourd'hui" : `dans ${l.daysLeft} j`;
  return (
    <>
      <div className="page-head"><h1>Péremptions</h1></div>
      <p className="muted" style={{ margin: 0 }}>Lots en stock des articles suivis par lots. Les ventes prennent d'abord le lot qui périme le plus tôt ; un lot périmé n'est vendu qu'en dernier. Sortez les lots périmés par un <Link href="/app/stocks/operations">bon de sortie</Link>, motif « Produit périmé ».</p>
      <Alert>{error}</Alert>
      {data && <div className="kpis">
        <button type="button" className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setStatus('expired')}><div className="l">Lots périmés</div><div className="v" style={{ color: data.expired.lots ? 'var(--crit)' : undefined }}>{data.expired.lots}</div><div className="small muted">{money(data.expired.value)} au coût moyen</div></button>
        <button type="button" className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setStatus('expiring')}><div className="l">Périment sous {days} jours</div><div className="v" style={{ color: data.expiring.lots ? 'var(--warn)' : undefined }}>{data.expiring.lots}</div><div className="small muted">{money(data.expiring.value)} au coût moyen</div></button>
        <button type="button" className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setStatus('all')}><div className="l">Lots en stock</div><div className="v">{data.total.lots}</div><div className="small muted">{money(data.total.value)} au coût moyen</div></button>
      </div>}
      <div className="row">
        <select className="input" style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Lots affichés">{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <label className="row small" style={{ gap: 6 }}>Alerte à
          <select className="input" style={{ width: 110 }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Délai d'alerte">{[7, 15, 30, 60, 90].map((d) => <option key={d} value={d}>{d} jours</option>)}</select></label>
      </div>
      {data && <div className="table-wrap"><table>
        <thead><tr><th>Article</th><th>Lot</th><th>Entrepôt</th><th className="n">Quantité</th><th>Péremption</th><th className="n">Valeur</th></tr></thead>
        <tbody>{data.lots.length ? data.lots.map((l: any) => (
          <tr key={l.id}><td><b>{l.name}</b> <span className="small muted">{l.code}</span></td><td>{l.lotNumber}</td><td>{l.warehouse}</td>
            <td className="n" style={{ whiteSpace: 'nowrap' }}>{qty(l.quantity)} {l.unit}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{l.expiryDate ? date(l.expiryDate) : '—'} {l.status === 'expired' ? <Pill tone="crit">{when(l)}</Pill> : l.status === 'expiring' ? <Pill tone="warn">{when(l)}</Pill> : <span className="small muted">{when(l)}</span>}</td>
            <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(l.value)}</td></tr>
        )) : <tr><td colSpan={6} className="muted">{status === 'expired' ? 'Aucun lot périmé en stock.' : status === 'expiring' ? `Aucun lot ne périme dans les ${days} prochains jours.` : 'Aucun lot en stock.'}</td></tr>}</tbody>
      </table></div>}
    </>
  );
}
