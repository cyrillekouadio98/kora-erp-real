'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money, qty, STOCK_MOVES } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

/** Lien vers la pièce à l'origine d'un mouvement : bon de stock, facture de vente ou d'achat. */
function source(m: any) {
  if (m.documentId) return <Link href={`/app/stocks/${m.reason === 'adjustment' ? 'inventaires' : 'operations'}/${m.documentId}`}>{m.documentNumber}</Link>;
  if (m.sourceId && (m.reason === 'sale' || m.reason === 'sale_return')) return <Link href={`/app/ventes/${m.sourceId}`}>Voir la pièce</Link>;
  if (m.sourceId && (m.reason === 'purchase' || (m.reason === 'cancellation' && m.label.includes("l'achat")))) return <Link href={`/app/achats/${m.sourceId}`}>Voir la pièce</Link>;
  if (m.sourceId && m.reason === 'cancellation') return <Link href={`/app/ventes/${m.sourceId}`}>Voir la pièce</Link>;
  return null;
}

/** Journal de tous les mouvements de stock, avec export CSV. */
export default function StockMovementsPage() {
  const [f, setF] = useState({ from: monthStart(), to: today(), warehouseId: '', reason: '', q: '' });
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const { error, run } = useAction();
  useEffect(() => { api('/company/stock/warehouses').then(setWarehouses, () => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => run(async () => {
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
      setData(await api(`/company/stock/movements?${qs}`));
    }), 250);
    return () => clearTimeout(t);
  }, [f]); // eslint-disable-line
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const exportCsv = () => {
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Article', 'Code', 'Entrepôt', 'Nature', 'Libellé', 'Entrée', 'Sortie', 'Valeur', 'Stock entrepôt après', 'Stock total après'],
      ...data.movements.map((m: any) => [m.date, m.productName, m.productCode, m.warehouseCode, STOCK_MOVES[m.reason], m.label,
        m.direction === 'in' ? m.quantity : '', m.direction === 'out' ? m.quantity : '', m.value, m.whQtyAfter, m.qtyAfter])];
    const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `mouvements-stock-${f.from}-${f.to}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="page-head"><h1>Mouvements de stock</h1>
        <button className="btn" disabled={!data?.movements.length} onClick={exportCsv}>Exporter (CSV)</button></div>
      <Alert>{error}</Alert>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field small">Du<input className="input" type="date" value={f.from} onChange={set('from')} /></label>
        <label className="field small">Au<input className="input" type="date" value={f.to} onChange={set('to')} /></label>
        {warehouses.length > 1 && <label className="field small">Entrepôt<select className="input" value={f.warehouseId} onChange={set('warehouseId')}>
          <option value="">Tous</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>}
        <label className="field small">Nature<select className="input" value={f.reason} onChange={set('reason')}>
          <option value="">Toutes</option>{Object.entries(STOCK_MOVES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field small" style={{ flex: 1, minWidth: 180 }}>Recherche<input className="input" placeholder="Article, n° de pièce…" value={f.q} onChange={set('q')} /></label>
      </div>
      {data && <div className="kpis">
        <div className="card kpi"><div className="l">Entrées (valeur)</div><div className="v">{money(data.totalIn)}</div></div>
        <div className="card kpi"><div className="l">Sorties (valeur)</div><div className="v">{money(data.totalOut)}</div></div>
        <div className="card kpi"><div className="l">Mouvements</div><div className="v">{data.movements.length}</div></div>
      </div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Article</th><th>Entrepôt</th><th>Mouvement</th><th className="n">Entrée</th><th className="n">Sortie</th><th className="n">Valeur</th><th className="n">Stock après</th><th>Pièce</th></tr></thead>
        <tbody>
          {data?.movements.map((m: any) => (
            <tr key={m.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{date(m.date)}</td>
              <td><b>{m.productName}</b><div className="small muted">{m.productCode}</div></td>
              <td className="small">{m.warehouseCode}</td>
              <td className="small"><Pill tone={m.reason === 'transfer' ? 'mute' : m.direction === 'in' ? 'ok' : 'warn'}>{STOCK_MOVES[m.reason]}</Pill> {m.label}{m.by && <span className="muted"> · {m.by}</span>}</td>
              <td className="n">{m.direction === 'in' ? qty(m.quantity) : ''}</td>
              <td className="n">{m.direction === 'out' ? qty(m.quantity) : ''}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(m.value)}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{qty(m.whQtyAfter)} {m.unit}</td>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>{source(m)}</td>
            </tr>
          ))}
          {data && !data.movements.length && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun mouvement sur cette période.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
