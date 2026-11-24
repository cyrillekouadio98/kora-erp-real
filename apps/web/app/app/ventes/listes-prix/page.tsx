'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

interface Item { productId: string; unitId: string; minQuantity: string; price: string }

/** Listes de prix (grossiste, demi-gros, détail) : prix par article et palier de quantité, affectées aux clients. */
export default function PriceListsPage() {
  const { can, has, ctx } = useSession();
  const [lists, setLists] = useState<any[]>([]);
  const [current, setCurrent] = useState<any>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [newName, setNewName] = useState('');
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const edit = can('products.update') && !ctx?.readOnly;
  const loadLists = useCallback(async () => setLists(await api('/company/price-lists')), []);
  const open = async (id: string) => {
    const l = await api<any>(`/company/price-lists/${id}`);
    setCurrent(l); setNotice('');
    setItems(l.items.map((i: any) => ({ productId: i.productId, unitId: i.unitId ?? '', minQuantity: String(i.minQuantity), price: String(i.price) })));
  };
  useEffect(() => { if (has('price_lists')) run(async () => { await loadLists(); setProducts(await api('/company/products')); }); }, []); // eslint-disable-line
  if (!has('price_lists')) return <Alert kind="warn">Les listes de prix ne sont pas activées pour votre entreprise. Contactez Kora ERP pour les activer.</Alert>;

  const product = (id: string) => products.find((p) => p.id === id);
  const catalogue = (i: Item) => {
    const p = product(i.productId); if (!p) return null;
    const u = i.unitId ? p.units?.find((x: any) => x.id === i.unitId) : null;
    return u ? u.salePrice ?? Math.round(p.salePrice * u.factor) : p.salePrice;
  };
  const setItem = (k: number, patch: Partial<Item>) => setItems(items.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const create = (e: React.FormEvent) => { e.preventDefault(); run(async () => { const r = await api<any>('/company/price-lists', { body: { name: newName } }); setNewName(''); await loadLists(); await open(r.id); }); };
  const save = () => run(async () => {
    await api(`/company/price-lists/${current.id}`, { method: 'PATCH', body: { name: current.name, discountPct: Number(current.discountPct || 0), notes: current.notes || null } });
    const r = await api<any>(`/company/price-lists/${current.id}/items`, { method: 'PUT', body: { items: items.filter((i) => i.productId && i.price !== '').map((i) => ({ productId: i.productId, unitId: i.unitId || null, minQuantity: Number(i.minQuantity || 1), price: Number(i.price) })) } });
    await loadLists(); await open(current.id); setNotice(`Liste « ${current.name} » enregistrée : ${r.items} prix.`);
  });
  const archive = () => run(async () => { await api(`/company/price-lists/${current.id}`, { method: 'PATCH', body: { archived: !current.archivedAt } }); await loadLists(); await open(current.id); });

  return (
    <>
      <div className="page-head"><h1>Listes de prix</h1></div>
      <p className="muted" style={{ margin: 0 }}>Un client rattaché à une liste (fiche <Link href="/app/contacts">Contacts</Link>) reçoit ses prix automatiquement sur ses devis, commandes et factures : le prix du palier atteint pour l&apos;article, sinon le prix de l&apos;article moins la remise générale de la liste. Le prix reste modifiable sur chaque ligne.</p>
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card" style={{ minWidth: 240, display: 'grid', gap: 8 }}>
          <header><h2>Listes</h2></header>
          {lists.map((l) => (
            <button key={l.id} type="button" className={`btn sm${current?.id === l.id ? ' primary' : ''}`} style={{ justifyContent: 'space-between' }} onClick={() => run(() => open(l.id))}>
              <span>{l.name}</span><span className="small">{l.archivedAt ? 'archivée' : `${l.customers} client${l.customers > 1 ? 's' : ''}`}</span></button>))}
          {!lists.length && <p className="small muted" style={{ margin: 0 }}>Aucune liste pour l&apos;instant.</p>}
          {edit && <form onSubmit={create} style={{ display: 'grid', gap: 6 }}>
            <Field label="Nouvelle liste" required minLength={2} placeholder="Ex. Grossiste" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn sm" disabled={busy}>Créer la liste</button></form>}
        </div>
        {current && <div className="card" style={{ flex: 1, minWidth: 320, display: 'grid', gap: 12 }}>
          <header><h2>{current.name}</h2>{current.archivedAt && <Pill>Archivée</Pill>}</header>
          <div className="grid2">
            <Field label="Nom" required disabled={!edit} value={current.name} onChange={(e) => setCurrent({ ...current, name: e.target.value })} />
            <Field label="Remise générale (%) sur les articles non listés" type="number" min={0} max={99.99} step="any" disabled={!edit} value={current.discountPct} onChange={(e) => setCurrent({ ...current, discountPct: e.target.value })} />
          </div>
          <div className="table-wrap"><table>
            <thead><tr><th style={{ minWidth: 200 }}>Article</th>{has('units') && <th>Unité</th>}<th className="n">À partir de</th><th className="n">Prix catalogue</th><th className="n">Prix de la liste HT</th><th /></tr></thead>
            <tbody>{items.map((i, k) => {
              const p = product(i.productId); const cat = catalogue(i);
              return <tr key={k}>
                <td><select className="input" disabled={!edit} value={i.productId} onChange={(e) => setItem(k, { productId: e.target.value, unitId: '' })} aria-label={`Article ligne ${k + 1}`} style={{ minWidth: 200 }}>
                  <option value="">— Choisir —</option>{products.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></td>
                {has('units') && <td>{p?.units?.length ? <select className="input" disabled={!edit} value={i.unitId} onChange={(e) => setItem(k, { unitId: e.target.value })} aria-label={`Unité ligne ${k + 1}`} style={{ minWidth: 90 }}>
                  <option value="">{p.unit || 'unité'}</option>{p.units.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : <span className="small muted">{p?.unit ?? ''}</span>}</td>}
                <td className="n"><input className="input n" type="number" min="0.001" step="any" disabled={!edit} value={i.minQuantity} onChange={(e) => setItem(k, { minQuantity: e.target.value })} aria-label={`Palier ligne ${k + 1}`} style={{ width: 90 }} /></td>
                <td className="n" style={{ whiteSpace: 'nowrap' }}>{cat === null ? '—' : money(cat)}</td>
                <td className="n"><input className="input n" type="number" min="0" step="any" required disabled={!edit} value={i.price} onChange={(e) => setItem(k, { price: e.target.value })} aria-label={`Prix ligne ${k + 1}`} style={{ width: 120 }} />
                  {cat !== null && i.price !== '' && Number(i.price) < cat && <div className="small muted">−{Math.round((1 - Number(i.price) / cat) * 1000) / 10} %</div>}</td>
                <td>{edit && <button type="button" className="btn sm danger" onClick={() => setItems(items.filter((_, j) => j !== k))} aria-label={`Retirer la ligne ${k + 1}`}>✕</button>}</td>
              </tr>;
            })}{!items.length && <tr><td colSpan={6} className="muted">Aucun prix particulier : la remise générale s&apos;applique à tous les articles.</td></tr>}</tbody>
          </table></div>
          {edit && <div className="row">
            <button type="button" className="btn sm" onClick={() => setItems([...items, { productId: '', unitId: '', minQuantity: '1', price: '' }])}>+ Ajouter un prix</button>
            <span className="small muted">Plusieurs prix pour un même article : un palier par quantité minimale (ex. 1 et 10 sacs).</span></div>}
          {current.customers.length > 0 && <p className="small" style={{ margin: 0 }}><b>Clients :</b> {current.customers.map((c: any) => c.name).join(', ')}</p>}
          {edit && <div className="row">
            <button type="button" className="btn primary" disabled={busy || !!current.archivedAt} onClick={save}>Enregistrer la liste</button>
            <button type="button" className="btn" disabled={busy} onClick={archive}>{current.archivedAt ? 'Restaurer' : 'Archiver'}</button>
            {!current.archivedAt && current.customers.length > 0 && <span className="small muted">Archiver la liste rend à ses clients les prix des articles.</span>}</div>}
        </div>}
      </div>
    </>
  );
}
