'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, money, qty } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);

/** Valeur du stock à une date, au coût moyen pondéré, et rapprochement avec le compte 311 de la comptabilité. */
export default function StockValuationPage() {
  const { can, ctx } = useSession();
  const [day, setDay] = useState(today());
  const [warehouseId, setWarehouseId] = useState('');
  const [data, setData] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const load = () => run(async () => setData(await api(`/company/stock/valuation?date=${day}${warehouseId ? `&warehouseId=${warehouseId}` : ''}`)));
  useEffect(() => { if (day) load(); }, [day, warehouseId]); // eslint-disable-line
  const accounting = ctx?.entitlements.modules.includes('accounting');
  const canPost = accounting && can('accounting.validate') && !ctx?.readOnly;

  const post = () => run(async () => {
    const r = await api('/company/stock/variation', { body: { date: day } });
    setNotice(r.variation ? `Variation de stock comptabilisée (${r.entry}) : ${money(r.variation)}. Le compte 311000 vaut maintenant ${money(r.stockValue)}.` : 'Le compte 311000 est déjà égal à la valeur du stock : aucune écriture nécessaire.');
    await load();
  });

  return (
    <>
      <div className="page-head"><h1>Valorisation du stock</h1>
        <div className="row no-print">
          <label className="field small">Au<input className="input" type="date" max={today()} value={day} onChange={(e) => setDay(e.target.value)} /></label>
          {data && data.byWarehouse.length > 1 && <label className="field small">Entrepôt<select className="input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Tous</option>{data.byWarehouse.map((w: any) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>}
          <button className="btn" onClick={() => window.print()}>Imprimer</button>
        </div>
      </div>
      <Alert kind="ok">{notice}</Alert>
      <Alert>{error}</Alert>
      {data && <>
        <div className="kpis">
          <div className="card kpi"><div className="l">Valeur du stock {warehouseId ? '(entrepôt)' : ''}</div><div className="v">{money(data.total)}</div><div className="small muted">au CMUP, le {date(data.date)}</div></div>
          {accounting && <div className="card kpi"><div className="l">Compte 311000 (comptabilité)</div><div className="v">{money(data.ledger)}</div><div className="small muted">écritures validées à cette date</div></div>}
          {accounting && <div className="card kpi"><div className="l">Écart à régulariser</div><div className="v" style={{ color: data.gap ? 'var(--warn)' : 'var(--ok)' }}>{data.gap ? money(data.gap) : 'Aucun'}</div>
            <div className="small muted">{data.gap ? (data.gap > 0 ? 'stock supérieur au compte : D 311 / C 6031' : 'stock inférieur au compte : D 6031 / C 311') : 'stock et comptabilité concordent'}</div></div>}
        </div>
        {accounting && data.gap !== 0 && <div className="card row no-print" style={{ justifyContent: 'space-between' }}>
          <span className="small">Les achats de marchandises sont passés en charges (601). À chaque clôture (mois, exercice), la variation de stock ajuste le compte 311000 à la valeur réelle du stock : votre résultat devient exact.</span>
          {canPost && <button className="btn primary" disabled={busy} onClick={() => confirm(`Passer l'écriture de variation de stock de ${money(data.gap)} au ${date(day)} ?`) && post()}>Comptabiliser la variation</button>}
        </div>}
        {!warehouseId && data.byWarehouse.length > 1 && <div className="kpis">
          {data.byWarehouse.map((w: any) => <button key={w.id} className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setWarehouseId(w.id)}>
            <div className="l">{w.code} · {w.name}</div><div className="v">{money(w.value)}</div><div className="small muted">{data.total ? Math.round((w.value / data.total) * 100) : 0} % du stock</div></button>)}
        </div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Article</th><th className="n">Quantité</th><th className="n">Coût moyen (CMUP)</th><th className="n">Valeur</th><th className="n">Part</th></tr></thead>
          <tbody>
            {data.items.map((i: any) => (
              <tr key={i.id}><td><b>{i.name}</b> <span className="small muted">{i.code}</span></td><td className="n">{qty(i.quantity)} {i.unit}</td>
                <td className="n">{money(i.avgCost)}</td><td className="n">{money(i.value)}</td><td className="n">{data.total ? `${((i.value / data.total) * 100).toFixed(1)} %` : ''}</td></tr>
            ))}
            {!data.items.length && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun stock à cette date.</td></tr>}
          </tbody>
          <tfoot><tr><th colSpan={3}>Total</th><th className="n">{money(data.total)}</th><th /></tr></tfoot>
        </table></div>
      </>}
    </>
  );
}
