'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money, qty } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, useAction } from '@/components/ui';

interface Line { id: string; code: string; name: string; unit: string; vatRate: number; quantity: number; forecast: number; minStock: number; supplierId: string; lastPurchase: string | null; order: string; unitPrice: string; chosen: boolean }

/** Réapprovisionnement : articles sous leur seuil regroupés par fournisseur habituel, un bon de commande en brouillon par fournisseur. */
export default function RestockPage() {
  const { has, can, ctx } = useSession();
  const [data, setData] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [created, setCreated] = useState<any[]>([]);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (!has('restock')) return;
    run(async () => {
      const d = await api<any>(`/company/stock/restock${warehouseId ? `?warehouseId=${warehouseId}` : ''}`);
      setData(d);
      setLines(d.items.map((i: any) => ({ ...i, supplierId: i.supplierId ?? '', order: String(i.suggested || 1), unitPrice: String(i.unitPrice ?? 0), chosen: true })));
    });
  }, [warehouseId]); // eslint-disable-line
  const groups = useMemo(() => {
    const by = new Map<string, Line[]>();
    for (const l of lines) by.set(l.supplierId, [...(by.get(l.supplierId) ?? []), l]);
    return [...by.entries()].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1));
  }, [lines]);
  if (!has('restock')) return <Alert kind="warn">Le réapprovisionnement n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;
  const set = (id: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const supplierName = (id: string) => data?.suppliers.find((s: any) => s.id === id)?.name;
  const ready = lines.filter((l) => l.chosen && l.supplierId && Number(l.order) > 0);
  const createOrders = () => run(async () => {
    const out: any[] = [];
    for (const [supplierId, ls] of groups) {
      const chosen = ls.filter((l) => l.chosen && Number(l.order) > 0);
      if (!supplierId || !chosen.length) continue;
      const po = await api<any>('/company/purchases/documents', { body: {
        type: 'order', contactId: supplierId, warehouseId: warehouseId || null, notes: 'Réapprovisionnement préparé par Kora',
        lines: chosen.map((l) => ({ productId: l.id, description: l.name, unit: l.unit, quantity: Number(l.order), unitPrice: Number(l.unitPrice), vatRate: l.vatRate })),
      } });
      out.push({ id: po.id, supplier: supplierName(supplierId), lines: chosen.length, total: po.totalTtc });
    }
    setCreated(out);
    setLines(lines.filter((l) => !(l.chosen && l.supplierId && Number(l.order) > 0)));
  });
  const write = can('purchases.create') && !ctx?.readOnly;
  return (
    <>
      <div className="page-head"><h1>Réapprovisionnement</h1>
        {data?.warehouses?.length > 1 && <select className="input" style={{ width: 220 }} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Entrepôt">
          <option value="">Tous les entrepôts</option>{data.warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}</div>
      <p className="muted" style={{ margin: 0 }}>Articles dont le stock prévisionnel (stock − commandes clients + commandes fournisseurs en cours) est au niveau de leur seuil d&apos;alerte. Ils sont rangés sous leur fournisseur habituel, avec la quantité conseillée et le dernier prix payé. Vérifiez, puis créez un bon de commande en brouillon par fournisseur.</p>
      <Alert>{error}</Alert>
      {created.length > 0 && <Alert kind="ok"><div style={{ display: 'grid', gap: 2 }}>{created.map((c) => <div key={c.id}>Bon de commande pour <b>{c.supplier}</b> ({c.lines} article(s), {money(c.total)} TTC) : <Link href={`/app/achats/${c.id}`}>ouvrir le brouillon</Link></div>)}</div></Alert>}
      {data && !lines.length && <p className="muted">Aucun article à commander. Les seuils d&apos;alerte se règlent dans <Link href="/app/stocks">Stocks</Link> (bouton Seuil ou Réglages).</p>}
      {groups.map(([supplierId, ls]) => (
        <div key={supplierId || 'none'} className="card" style={{ display: 'grid', gap: 8 }}>
          <header><h2>{supplierId ? supplierName(supplierId) : 'Sans fournisseur habituel'}</h2><span className="small muted">{ls.length} article(s)</span></header>
          {!supplierId && <p className="small muted" style={{ margin: 0 }}>Ces articles n&apos;ont jamais été achetés dans Kora : choisissez leur fournisseur.</p>}
          <div className="table-wrap"><table>
            <thead><tr><th /><th>Article</th><th className="n">Stock</th><th className="n">Prévisionnel</th><th className="n">Seuil</th><th>Fournisseur</th><th className="n">À commander</th><th className="n">Prix HT</th></tr></thead>
            <tbody>{ls.map((l) => (
              <tr key={l.id}>
                <td><input type="checkbox" checked={l.chosen} onChange={(e) => set(l.id, { chosen: e.target.checked })} aria-label={`Commander ${l.name}`} /></td>
                <td><b>{l.name}</b> <span className="small muted">{l.code}</span>{l.lastPurchase && <div className="small muted">dernier achat le {date(l.lastPurchase)}</div>}</td>
                <td className="n">{qty(l.quantity)} {l.unit}</td><td className="n">{qty(l.forecast)}</td><td className="n">{qty(l.minStock)}</td>
                <td><select className="input" value={l.supplierId} onChange={(e) => set(l.id, { supplierId: e.target.value })} aria-label={`Fournisseur de ${l.name}`} style={{ minWidth: 170 }}>
                  <option value="">— Choisir —</option>{data.suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                <td className="n"><input className="input n" type="number" min="0.001" step="any" value={l.order} onChange={(e) => set(l.id, { order: e.target.value })} aria-label={`Quantité de ${l.name}`} style={{ width: 90 }} /></td>
                <td className="n"><input className="input n" type="number" min="0" step="any" value={l.unitPrice} onChange={(e) => set(l.id, { unitPrice: e.target.value })} aria-label={`Prix de ${l.name}`} style={{ width: 110 }} /></td>
              </tr>))}</tbody>
          </table></div>
        </div>
      ))}
      {write && ready.length > 0 && <div><button className="btn primary" disabled={busy} onClick={createOrders}>
        Créer {new Set(ready.map((l) => l.supplierId)).size} bon(s) de commande en brouillon ({ready.length} article(s))</button></div>}
    </>
  );
}
