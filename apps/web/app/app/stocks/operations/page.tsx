'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money, STOCK_DOC, stockReason } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';

const TABS: [string, string][] = [['receipt,issue,transfer', 'Tous'], ['receipt', 'Entrées'], ['issue', 'Sorties'], ['transfer', 'Transferts']];

/** Bons d'entrée, de sortie et de transfert : tout ce qui bouge en stock hors factures. */
export default function StockOperationsPage() {
  const { can, ctx } = useSession();
  const [type, setType] = useState(TABS[0][0]);
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const { error, run } = useAction();
  useEffect(() => { run(async () => setRows(await api(`/company/stock/documents?type=${type}${status ? `&status=${status}` : ''}`))); }, [type, status]); // eslint-disable-line

  return (
    <>
      <div className="page-head"><h1>Entrées et sorties</h1>
        {can('stock.create') && !ctx?.readOnly && <div className="row">
          <Link className="btn primary" href="/app/stocks/operations/nouveau?type=receipt">+ Entrée</Link>
          <Link className="btn" href="/app/stocks/operations/nouveau?type=issue">− Sortie</Link>
          <Link className="btn" href="/app/stocks/operations/nouveau?type=transfer">⇄ Transfert</Link>
        </div>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Les achats et les ventes facturés bougent le stock tout seuls. Ici : achats payés comptant, production, dons, consommation interne, casse, pertes et transferts entre entrepôts.</p>
      <Alert>{error}</Alert>
      <div className="row">
        <div className="seg" role="group" aria-label="Type de bon">{TABS.map(([k, l]) => <button key={k} aria-pressed={type === k} onClick={() => setType(k)}>{l}</button>)}</div>
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
          <option value="">Tous les statuts</option><option value="draft">Brouillons</option><option value="done">Validés</option>
        </select>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>N°</th><th>Date</th><th>Type</th><th>Motif</th><th>Entrepôt</th><th className="n">Articles</th><th className="n">Valeur</th><th>Statut</th></tr></thead>
        <tbody>
          {rows?.map((d) => (
            <tr key={d.id}>
              <td style={{ whiteSpace: 'nowrap' }}><Link href={`/app/stocks/operations/${d.id}`}>{d.number ?? 'Brouillon'}</Link></td>
              <td style={{ whiteSpace: 'nowrap' }}>{date(d.date)}</td>
              <td>{STOCK_DOC[d.type]}</td>
              <td className="small">{stockReason(d.type, d.reason) ?? ''}{d.contactName && <span className="muted"> · {d.contactName}</span>}</td>
              <td className="small">{d.warehouse}{d.destWarehouse && <> → {d.destWarehouse}</>}</td>
              <td className="n">{d.lines}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{d.status === 'done' ? money(d.totalValue) : '—'}</td>
              <td>{d.status === 'done' ? <Pill tone="ok">Validé</Pill> : <Pill tone="warn">Brouillon</Pill>}</td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun bon pour le moment.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
