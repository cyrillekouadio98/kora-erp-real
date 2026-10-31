'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const qty = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
const REASONS: Record<string, string> = { opening: 'Stock initial', purchase: 'Achat', sale: 'Vente', sale_return: 'Retour client', adjustment: 'Inventaire' };

export default function StockPage() {
  const { can, ctx } = useSession();
  const admin = can('products.admin') && !ctx?.readOnly;
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => api('/company/stock').then(setData), []);
  useEffect(() => { load(); }, [load]);
  const open = (m: any) => { setError(''); setModal(m); };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setModal({ ...modal, [k]: e.target.value });

  const submit = () => run(async () => {
    const m = modal;
    if (m.type === 'opening') await api(`/company/stock/${m.item.id}/opening`, { body: { quantity: Number(m.quantity), unitCost: Number(m.unitCost), date: m.date } });
    if (m.type === 'count') {
      const r = await api(`/company/stock/${m.item.id}/count`, { body: { counted: Number(m.counted), reason: m.reason } });
      setNotice(r.difference ? `Inventaire de « ${m.item.name} » : écart de ${qty(r.difference)} ${m.item.unit} enregistré.` : `Inventaire de « ${m.item.name} » : aucun écart.`);
    }
    if (m.type === 'threshold') await api(`/company/stock/${m.item.id}`, { method: 'PATCH', body: { minStock: m.minStock === '' ? null : Number(m.minStock) } });
    if (m.type === 'variation') {
      const r = await api('/company/stock/variation', { body: { date: m.date } });
      setNotice(r.variation ? `Variation de stock comptabilisée (${r.entry}) : ${money(r.variation)} — stock valorisé à ${money(r.stockValue)}.` : `Le compte 311000 est déjà égal à la valeur du stock (${money(r.stockValue)}) : aucune écriture nécessaire.`);
    }
    setModal(null); await load();
  });

  const items = (data?.items ?? []).filter((i: any) => !filter || (filter === 'alert' ? i.alert : i.alert === filter));

  return (
    <>
      <div className="page-head"><h1>Stocks</h1>
        {can('accounting.validate') && ctx?.entitlements.modules.includes('accounting') && !ctx?.readOnly &&
          <button className="btn" onClick={() => open({ type: 'variation', date: today() })}>Comptabiliser la variation de stock</button>}
      </div>
      <Alert kind="ok">{notice}</Alert>
      <Alert>{!modal && error}</Alert>
      {data && (
        <div className="kpis">
          <div className="card kpi"><div className="l">Valeur du stock</div><div className="v">{money(data.totalValue)}</div><div className="small muted">au coût moyen pondéré (CMUP)</div></div>
          <div className="card kpi"><div className="l">Articles suivis</div><div className="v">{data.items.length}</div></div>
          <button className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setFilter(filter === 'out' ? '' : 'out')}>
            <div className="l">En rupture</div><div className="v" style={{ color: data.outOfStock ? 'var(--crit)' : undefined }}>{data.outOfStock}</div></button>
          <button className="card kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setFilter(filter === 'low' ? '' : 'low')}>
            <div className="l">Sous le seuil d'alerte</div><div className="v" style={{ color: data.lowStock ? 'var(--warn)' : undefined }}>{data.lowStock}</div></button>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>Les entrées viennent des factures fournisseurs validées, les sorties des factures de vente émises, les retours des avoirs. Un article ne peut pas être vendu au-delà de son stock.{filter && <> · <button className="btn sm" onClick={() => setFilter('')}>Voir tous les articles</button></>}</p>

      <div className="table-wrap"><table>
        <thead><tr><th>Article</th><th className="n">En stock</th><th className="n">Coût moyen</th><th className="n">Valeur</th><th className="n">Seuil</th><th>Dernier mouvement</th><th></th></tr></thead>
        <tbody>
          {items.map((i: any) => (
            <tr key={i.id}>
              <td><b>{i.name}</b> {i.alert === 'out' && <Pill tone="crit">Rupture</Pill>}{i.alert === 'low' && <Pill tone="warn">Stock bas</Pill>}<div className="small muted">{i.code}</div></td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}><b>{qty(i.quantity)}</b> {i.unit}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(i.avgCost)}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(i.value)}</td>
              <td className="n">{i.minStock ?? '—'}</td>
              <td className="small">{i.lastMovement ? date(i.lastMovement) : <span className="muted">aucun</span>}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                <button className="btn sm" onClick={() => api(`/company/stock/${i.id}/movements`).then((r) => open({ type: 'card', item: i, ...r }))}>Fiche</button>
                {admin && !i.lastMovement && <button className="btn sm primary" onClick={() => open({ type: 'opening', item: i, quantity: '', unitCost: '', date: today() })}>Stock initial</button>}
                {admin && i.lastMovement && <button className="btn sm" onClick={() => open({ type: 'count', item: i, counted: i.quantity, reason: '' })}>Inventaire</button>}
                {admin && <button className="btn sm" onClick={() => open({ type: 'threshold', item: i, minStock: i.minStock ?? '' })}>Seuil</button>}
              </div></td>
            </tr>
          ))}
          {data && !items.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
            {filter ? 'Aucun article dans cette situation.' : <>Aucun article suivi en stock. Les biens créés dans <Link href="/app/articles">Articles</Link> apparaissent ici.</>}</td></tr>}
        </tbody>
      </table></div>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: modal.type === 'card' ? 'min(900px, 100%)' : 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {modal.type === 'card' && <>
              <h2>Fiche de stock — {modal.item.name}</h2>
              <p className="small muted" style={{ margin: 0 }}>En stock : <b>{qty(modal.product.stock_qty)} {modal.item.unit}</b> · valeur {money(modal.product.stock_value)} · coût moyen {money(modal.product.avg_cost)}</p>
              <div className="table-wrap"><table>
                <thead><tr><th>Date</th><th>Mouvement</th><th className="n">Entrée</th><th className="n">Sortie</th><th className="n">Valeur</th><th className="n">Stock après</th></tr></thead>
                <tbody>{modal.movements.map((m: any) => (
                  <tr key={m.id}><td style={{ whiteSpace: 'nowrap' }}>{date(m.date)}</td><td className="small"><b>{REASONS[m.reason]}</b> · {m.label}{m.by && <span className="muted"> · {m.by}</span>}</td>
                    <td className="n">{m.direction === 'in' ? qty(m.quantity) : ''}</td><td className="n">{m.direction === 'out' ? qty(m.quantity) : ''}</td>
                    <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(m.value)}</td><td className="n" style={{ whiteSpace: 'nowrap' }}>{qty(m.qtyAfter)}</td></tr>))}
                  {!modal.movements.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center' }}>Aucun mouvement.</td></tr>}</tbody>
              </table></div>
              <div className="row"><button type="button" className="btn" onClick={() => setModal(null)}>Fermer</button></div>
            </>}
            {modal.type === 'opening' && <>
              <h2>Stock initial — {modal.item.name}</h2>
              <p className="small muted" style={{ margin: 0 }}>Quantité présente avant l'utilisation de Kora, et son coût d'achat unitaire. Elle sera passée en comptabilité en à-nouveaux (311000 / 471000).</p>
              <Alert>{error}</Alert>
              <div className="grid2">
                <Field label={`Quantité (${modal.item.unit})`} type="number" min="0.001" step="any" required value={modal.quantity} onChange={set('quantity')} />
                <Field label="Coût d'achat unitaire HT (FCFA)" type="number" min={0} step="any" required value={modal.unitCost} onChange={set('unitCost')} />
                <Field label="Date" type="date" required max={today()} value={modal.date} onChange={set('date')} />
                <div className="field small" style={{ alignSelf: 'end' }}>Valeur : <b>{money(Number(modal.quantity || 0) * Number(modal.unitCost || 0))}</b></div>
              </div>
            </>}
            {modal.type === 'count' && <>
              <h2>Inventaire — {modal.item.name}</h2>
              <p className="small muted" style={{ margin: 0 }}>Stock théorique : <b>{qty(modal.item.quantity)} {modal.item.unit}</b>. L'écart entre ou sort au coût moyen.</p>
              <Alert>{error}</Alert>
              <Field label={`Quantité comptée (${modal.item.unit})`} type="number" min={0} step="any" required value={modal.counted} onChange={set('counted')} />
              {modal.counted !== '' && Number(modal.counted) !== modal.item.quantity && <Alert kind="warn">Écart de {qty(Number(modal.counted) - modal.item.quantity)} {modal.item.unit}, soit environ {money((Number(modal.counted) - modal.item.quantity) * modal.item.avgCost)}.</Alert>}
              <Field label="Raison de l'écart" required minLength={3} placeholder="Ex. casse, sacs percés, erreur de livraison" value={modal.reason} onChange={set('reason')} />
            </>}
            {modal.type === 'threshold' && <>
              <h2>Seuil d'alerte — {modal.item.name}</h2>
              <Alert>{error}</Alert>
              <Field label={`Alerter quand le stock descend à (${modal.item.unit})`} type="number" min={0} step="any" placeholder="Vide : pas d'alerte" value={modal.minStock} onChange={set('minStock')} />
            </>}
            {modal.type === 'variation' && <>
              <h2>Variation de stock</h2>
              <p className="small" style={{ margin: 0 }}>Les achats sont comptés en charges (601000). À chaque clôture (mois, exercice), cette écriture ajuste le compte de stock 311000 à la valeur réelle du stock, en contrepartie de 603100 : votre résultat devient exact.</p>
              <Alert>{error}</Alert>
              <Field label="Valeur du stock arrêtée au" type="date" required max={today()} value={modal.date} onChange={set('date')} />
            </>}
            {modal.type !== 'card' && <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>}
          </form>
        </div>
      )}
    </>
  );
}
