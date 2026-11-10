'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, money, qty, STOCK_MOVES } from '@/lib/format';
import { useSession } from '@/components/session';
import { ImportButton } from '@/components/import';
import { STOCK_IMPORT } from '@/components/import-configs';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const FILTERS: Record<string, [string, (i: any) => boolean]> = {
  out: ['En rupture', (i) => i.alert === 'out'], low: ["Sous le seuil d'alerte", (i) => i.alert === 'low'], toOrder: ['À commander', (i) => i.toOrder],
  reserved: ['Réservés par des commandes', (i) => i.reserved > 0], incoming: ['En commande fournisseur', (i) => i.incoming > 0],
};

/**
 * Vue d'ensemble du stock : physique, réservé par les commandes clients, disponible, à recevoir des fournisseurs.
 * Les articles à réapprovisionner se commandent d'ici : le bon de commande fournisseur est préparé dans Achats.
 */
export default function StockPage() {
  const router = useRouter();
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const admin = can('stock.admin') && writable;
  const canOrder = can('purchases.create') && !!ctx?.entitlements.modules.includes('purchases') && writable;
  const [warehouseId, setWarehouseId] = useState('');
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [modal, setModal] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => api(`/company/stock${warehouseId ? `?warehouseId=${warehouseId}` : ''}`).then(setData), [warehouseId]);
  useEffect(() => { load(); }, [load]);
  const open = (m: any) => { setError(''); setModal(m); };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setModal({ ...modal, [k]: e.target.value });
  const wName = (id: string) => data?.warehouses.find((w: any) => w.id === id)?.code ?? '';
  const multi = (data?.warehouses.length ?? 0) > 1;
  // Ajustement rapide : dans l'entrepôt affiché, sinon dans l'entrepôt par défaut
  const expectedFor = (i: any) => (warehouseId || !multi ? i.quantity : i.byWarehouse.find((b: any) => b.warehouseId === data.warehouses.find((w: any) => w.isDefault)?.id)?.quantity ?? 0);

  const items = (data?.items ?? []).filter((i: any) => (!filter || FILTERS[filter][1](i))
    && (!search || `${i.name} ${i.code}`.toLowerCase().includes(search.toLowerCase())));
  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const startOrder = async () => {
    if (!suppliers.length) setSuppliers((await api('/company/contacts')).filter((c: any) => c.kind !== 'customer' && !c.archivedAt));
    const chosen = data.items.filter((i: any) => selected.includes(i.id));
    open({ type: 'order', contactId: '', lines: chosen.map((i: any) => ({ item: i, quantity: String(i.suggested || 1), unitPrice: String(i.purchasePrice ?? i.avgCost ?? 0) })) });
  };

  const submit = () => run(async () => {
    const m = modal;
    if (m.type === 'order') {
      const po = await api('/company/purchases/documents', { body: {
        type: 'order', contactId: m.contactId, warehouseId: warehouseId || null, notes: 'Réapprovisionnement préparé depuis Stocks',
        lines: m.lines.map((l: any) => ({ productId: l.item.id, description: l.item.name, unit: l.item.unit, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), vatRate: l.item.vatRate })),
      } });
      router.push(`/app/achats/${po.id}`);
      return;
    }
    if (m.type === 'opening') await api(`/company/stock/${m.item.id}/opening`, { body: { quantity: Number(m.quantity), unitCost: Number(m.unitCost), date: m.date, warehouseId: m.warehouseId || null } });
    if (m.type === 'count') {
      const r = await api(`/company/stock/${m.item.id}/count`, { body: { counted: Number(m.counted), reason: m.reason, warehouseId: warehouseId || null } });
      setNotice(r.difference ? `« ${m.item.name} » : écart de ${qty(r.difference)} ${m.item.unit} enregistré.` : `« ${m.item.name} » : aucun écart.`);
    }
    if (m.type === 'threshold') await api(`/company/stock/${m.item.id}`, { method: 'PATCH', body: { minStock: m.minStock === '' ? null : Number(m.minStock) } });
    setModal(null); await load();
  });

  return (
    <>
      <div className="page-head"><h1>Stocks</h1>
        <div className="row">
          {multi && <select className="input" style={{ width: 'auto' }} value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setSelected([]); }} aria-label="Entrepôt">
            <option value="">Tous les entrepôts</option>{data.warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select>}
          {can('stock.create') && writable && <>
            <Link className="btn" href="/app/stocks/operations/nouveau?type=receipt">+ Entrée</Link>
            <Link className="btn" href="/app/stocks/operations/nouveau?type=issue">− Sortie</Link>
            {multi && <Link className="btn" href="/app/stocks/operations/nouveau?type=transfer">⇄ Transfert</Link>}
            <Link className="btn" href="/app/stocks/inventaires">Inventaire</Link>
            <ImportButton config={STOCK_IMPORT} onDone={load} />
          </>}
        </div>
      </div>
      <Alert kind="ok">{notice}</Alert>
      <Alert>{!modal && error}</Alert>
      {data?.draftDocuments > 0 && <Alert kind="info">{data.draftDocuments} bon(s) de stock en brouillon : <Link href="/app/stocks/operations">à valider</Link> pour que le stock soit à jour.</Alert>}
      {data && (
        <div className="kpis">
          <Link className="card kpi" href="/app/stocks/valorisation" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="l">Valeur du stock</div><div className="v">{money(data.totalValue)}</div><div className="small muted">au coût moyen pondéré (CMUP)</div></Link>
          <Link className="card kpi" href="/app/stocks/mouvements" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="l">30 derniers jours</div><div className="small">Entrées <b>{money(data.in30)}</b></div><div className="small">Sorties <b>{money(data.out30)}</b></div></Link>
          {(['out', 'low', 'toOrder'] as const).map((k) => {
            const n = k === 'out' ? data.outOfStock : k === 'low' ? data.lowStock : data.toOrder;
            return <button key={k} className="card kpi" style={{ textAlign: 'left', cursor: 'pointer', outline: filter === k ? '2px solid var(--accent)' : undefined }} onClick={() => setFilter(filter === k ? '' : k)}>
              <div className="l">{FILTERS[k][0]}</div><div className="v" style={{ color: n ? (k === 'out' ? 'var(--crit)' : 'var(--warn)') : undefined }}>{n}</div>
              {k === 'toOrder' && <div className="small muted">prévisionnel sous le seuil</div>}</button>;
          })}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <input className="input" placeholder="Rechercher un article…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
          <select className="input" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtre">
            <option value="">Tous les articles</option>{Object.entries(FILTERS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        {canOrder && <div className="row">
          {filter === 'toOrder' && items.length > 0 && <button className="btn sm" onClick={() => setSelected(items.map((i: any) => i.id))}>Tout sélectionner</button>}
          <button className="btn primary" disabled={!selected.length} onClick={startOrder}>Commander au fournisseur{selected.length ? ` (${selected.length})` : ''}</button>
        </div>}
      </div>

      <div className="table-wrap"><table>
        <thead><tr>{canOrder && <th />}<th>Article</th><th className="n" title="Quantité présente">Physique</th><th className="n" title="Commandes clients confirmées, pas encore facturées">Réservé</th>
          <th className="n">Disponible</th><th className="n" title="Commandes fournisseurs envoyées, pas encore facturées">À recevoir</th><th className="n">Coût moyen</th><th className="n">Valeur</th><th className="n">Seuil</th><th /></tr></thead>
        <tbody>
          {items.map((i: any) => (
            <tr key={i.id}>
              {canOrder && <td><input type="checkbox" checked={selected.includes(i.id)} onChange={() => toggle(i.id)} aria-label={`Sélectionner ${i.name}`} /></td>}
              <td><b>{i.name}</b> {i.alert === 'out' && <Pill tone="crit">Rupture</Pill>}{i.alert === 'low' && <Pill tone="warn">Stock bas</Pill>}{i.toOrder && <Pill tone="warn">À commander : {qty(i.suggested)}</Pill>}
                <div className="small muted">{i.code}{!warehouseId && multi && i.byWarehouse.length > 0 && <> · {[...i.byWarehouse].sort((x: any, y: any) => data.warehouses.findIndex((w: any) => w.id === x.warehouseId) - data.warehouses.findIndex((w: any) => w.id === y.warehouseId)).map((b: any) => `${wName(b.warehouseId)} ${qty(b.quantity)}`).join(' · ')}</>}</div></td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}><b>{qty(i.quantity)}</b> {i.unit}</td>
              <td className="n">{i.reserved ? qty(i.reserved) : '—'}</td>
              <td className="n" style={{ color: i.available < 0 ? 'var(--crit)' : undefined }}>{qty(i.available)}</td>
              <td className="n">{i.incoming ? qty(i.incoming) : '—'}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(i.avgCost)}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(i.value)}</td>
              <td className="n">{i.minStock ?? '—'}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                <button className="btn sm" onClick={() => api(`/company/stock/${i.id}/movements`).then((r) => open({ type: 'card', item: i, ...r }))}>Fiche</button>
                {admin && !i.lastMovement && !warehouseId && <button className="btn sm primary" onClick={() => open({ type: 'opening', item: i, quantity: '', unitCost: i.purchasePrice ?? '', date: today(), warehouseId: '' })}>Stock initial</button>}
                {can('stock.validate') && writable && i.lastMovement && <button className="btn sm" onClick={() => open({ type: 'count', item: i, counted: expectedFor(i), reason: '' })}>Ajuster</button>}
                {admin && <button className="btn sm" onClick={() => open({ type: 'threshold', item: i, minStock: i.minStock ?? '' })}>Seuil</button>}
              </div></td>
            </tr>
          ))}
          {data && !items.length && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
            {filter || search ? 'Aucun article dans cette situation.' : <>Aucun article suivi en stock. Les biens créés dans <Link href="/app/articles">Articles</Link> apparaissent ici.</>}</td></tr>}
        </tbody>
      </table></div>
      <p className="small muted" style={{ margin: 0 }}>Disponible = physique − réservé. Prévisionnel = disponible + à recevoir ; sous le seuil, l'article est à commander (quantité proposée : de quoi remonter à deux fois le seuil).</p>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: modal.type === 'card' || modal.type === 'order' ? 'min(900px, 100%)' : 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {modal.type === 'card' && <>
              <h2>Fiche de stock — {modal.item.name}</h2>
              <p className="small muted" style={{ margin: 0 }}>En stock : <b>{qty(modal.product.stock_qty)} {modal.item.unit}</b> · valeur {money(modal.product.stock_value)} · coût moyen {money(modal.product.avg_cost)}
                {modal.byWarehouse.length > 1 && <> · {modal.byWarehouse.map((b: any) => `${b.code} : ${qty(b.quantity)}`).join(' · ')}</>}</p>
              <div className="table-wrap"><table>
                <thead><tr><th>Date</th><th>Mouvement</th>{multi && <th>Entrepôt</th>}<th className="n">Entrée</th><th className="n">Sortie</th><th className="n">Valeur</th><th className="n">Stock après</th></tr></thead>
                <tbody>{modal.movements.map((m: any) => (
                  <tr key={m.id}><td style={{ whiteSpace: 'nowrap' }}>{date(m.date)}</td><td className="small"><b>{STOCK_MOVES[m.reason]}</b> · {m.label}{m.by && <span className="muted"> · {m.by}</span>}</td>
                    {multi && <td className="small">{m.warehouseCode}</td>}
                    <td className="n">{m.direction === 'in' ? qty(m.quantity) : ''}</td><td className="n">{m.direction === 'out' ? qty(m.quantity) : ''}</td>
                    <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(m.value)}</td><td className="n" style={{ whiteSpace: 'nowrap' }}>{qty(multi ? m.whQtyAfter : m.qtyAfter)}</td></tr>))}
                  {!modal.movements.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center' }}>Aucun mouvement.</td></tr>}</tbody>
              </table></div>
              <div className="row"><button type="button" className="btn" onClick={() => setModal(null)}>Fermer</button></div>
            </>}
            {modal.type === 'order' && <>
              <h2>Commander au fournisseur</h2>
              <p className="small muted" style={{ margin: 0 }}>Un bon de commande fournisseur en brouillon est préparé dans Achats{warehouseId ? `, livraison à ${wName(warehouseId)}` : ''}. Vous pourrez l'ajuster avant de l'envoyer.</p>
              <Alert>{error}</Alert>
              <label className="field">Fournisseur
                <select className="input" required value={modal.contactId} onChange={set('contactId')}>
                  <option value="">— Choisir un fournisseur —</option>{suppliers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label>
              <div className="table-wrap"><table>
                <thead><tr><th>Article</th><th className="n">Prévisionnel</th><th className="n">Seuil</th><th className="n">Quantité à commander</th><th className="n">Prix d'achat HT</th></tr></thead>
                <tbody>{modal.lines.map((l: any, k: number) => {
                  const up = (patch: any) => setModal({ ...modal, lines: modal.lines.map((x: any, j: number) => (j === k ? { ...x, ...patch } : x)) });
                  return <tr key={l.item.id}><td><b>{l.item.name}</b></td><td className="n">{qty(l.item.forecast)}</td><td className="n">{l.item.minStock ?? '—'}</td>
                    <td className="n"><input className="input n" type="number" min="0.001" step="any" required value={l.quantity} onChange={(e) => up({ quantity: e.target.value })} style={{ width: 100 }} aria-label={`Quantité ${l.item.name}`} /></td>
                    <td className="n"><input className="input n" type="number" min="0" step="any" required value={l.unitPrice} onChange={(e) => up({ unitPrice: e.target.value })} style={{ width: 120 }} aria-label={`Prix ${l.item.name}`} /></td></tr>;
                })}</tbody>
              </table></div>
              <div className="small">Total HT estimé : <b>{money(modal.lines.reduce((s: number, l: any) => s + Number(l.quantity || 0) * Number(l.unitPrice || 0), 0))}</b></div>
            </>}
            {modal.type === 'opening' && <>
              <h2>Stock initial — {modal.item.name}</h2>
              <p className="small muted" style={{ margin: 0 }}>Quantité présente avant l'utilisation de Kora, et son coût d'achat unitaire. Elle sera passée en comptabilité en à-nouveaux (311000 / 471000).</p>
              <Alert>{error}</Alert>
              <div className="grid2">
                <Field label={`Quantité (${modal.item.unit})`} type="number" min="0.001" step="any" required value={modal.quantity} onChange={set('quantity')} />
                <Field label="Coût d'achat unitaire HT (FCFA)" type="number" min={0} step="any" required value={modal.unitCost} onChange={set('unitCost')} />
                <Field label="Date" type="date" required max={today()} value={modal.date} onChange={set('date')} />
                {multi && <label className="field">Entrepôt<select className="input" value={modal.warehouseId} onChange={set('warehouseId')}>
                  {data.warehouses.map((w: any) => <option key={w.id} value={w.isDefault ? '' : w.id}>{w.code} · {w.name}</option>)}</select></label>}
                <div className="field small" style={{ alignSelf: 'end' }}>Valeur : <b>{money(Number(modal.quantity || 0) * Number(modal.unitCost || 0))}</b></div>
              </div>
            </>}
            {modal.type === 'count' && <>
              <h2>Ajuster le stock — {modal.item.name}</h2>
              <p className="small muted" style={{ margin: 0 }}>Stock théorique{warehouseId ? ` dans ${wName(warehouseId)}` : multi ? " dans l'entrepôt par défaut" : ''} : <b>{qty(expectedFor(modal.item))} {modal.item.unit}</b>. L'écart entre ou sort au coût moyen. Pour compter tout un entrepôt, faites plutôt un <Link href="/app/stocks/inventaires">inventaire</Link>.</p>
              <Alert>{error}</Alert>
              <Field label={`Quantité comptée (${modal.item.unit})`} type="number" min={0} step="any" required value={modal.counted} onChange={set('counted')} />
              <Field label="Raison de l'écart" required minLength={3} placeholder="Ex. casse, sacs percés, erreur de livraison" value={modal.reason} onChange={set('reason')} />
            </>}
            {modal.type === 'threshold' && <>
              <h2>Seuil d'alerte — {modal.item.name}</h2>
              <Alert>{error}</Alert>
              <Field label={`Alerter quand le stock descend à (${modal.item.unit})`} type="number" min={0} step="any" placeholder="Vide : pas d'alerte" value={modal.minStock} onChange={set('minStock')} />
            </>}
            {modal.type !== 'card' && <div className="row"><button className="btn primary" disabled={busy}>{modal.type === 'order' ? 'Préparer le bon de commande' : 'Enregistrer'}</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>}
          </form>
        </div>
      )}
    </>
  );
}
