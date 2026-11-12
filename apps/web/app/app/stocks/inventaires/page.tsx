'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';

/** Inventaires physiques : feuille de comptage par entrepôt, puis ajustement des écarts au coût moyen. */
export default function InventoriesPage() {
  const router = useRouter();
  const { can, ctx } = useSession();
  const [rows, setRows] = useState<any[] | null>(null);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => {
    run(async () => {
      setRows(await api('/company/stock/documents?type=inventory'));
      const w = (await api('/company/stock/warehouses')).filter((x: any) => !x.archived);
      setWarehouses(w); setWarehouseId(w.find((x: any) => x.isDefault)?.id ?? '');
    });
  }, []); // eslint-disable-line
  const start = () => run(async () => {
    const d = await api('/company/stock/documents', { body: { type: 'inventory', warehouseId } });
    router.push(`/app/stocks/inventaires/${d.id}`);
  });

  return (
    <>
      <div className="page-head"><h1>Inventaires</h1>
        {can('stock.create') && !ctx?.readOnly && <div className="row">
          {warehouses.length > 1 && <select className="input" style={{ width: 'auto' }} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Entrepôt à inventorier">
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select>}
          <button className="btn primary" disabled={busy || !warehouseId} onClick={start}>Nouvel inventaire</button>
        </div>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Un inventaire reprend tous les articles suivis de l'entrepôt. Imprimez la feuille de comptage, saisissez les quantités comptées (en plusieurs fois si besoin), puis validez : chaque écart entre ou sort au coût moyen, et la variation de stock suit en comptabilité.</p>
      <Alert>{error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>N°</th><th>Date</th><th>Entrepôt</th><th className="n">Articles comptés</th><th className="n">Écart en valeur</th><th>Statut</th></tr></thead>
        <tbody>
          {rows?.map((d) => (
            <tr key={d.id}>
              <td><Link href={`/app/stocks/inventaires/${d.id}`}>{d.number ?? 'En cours'}</Link></td>
              <td>{date(d.date)}</td><td>{d.warehouse}</td>
              <td className="n">{d.status === 'done' ? d.lines : `${d.counted} / ${d.lines}`}</td>
              <td className="n" style={{ color: d.totalValue < 0 ? 'var(--crit)' : undefined }}>{d.status === 'done' ? money(d.totalValue) : '—'}</td>
              <td>{d.status === 'done' ? <Pill tone="ok">Validé</Pill> : <Pill tone="warn">Comptage en cours</Pill>}</td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun inventaire pour le moment.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
