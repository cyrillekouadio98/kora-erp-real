'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, useAction } from '@/components/ui';

const qty = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 4 });
const num = (v: string) => Number(String(v).replace(/\s/g, '').replace(',', '.'));

/** Fiches techniques : ingrédients d'un plat pour une portion ; le plat vendu sort ses ingrédients du stock. */
export default function RecipesPage() {
  const { has, can, ctx } = useSession();
  const [list, setList] = useState<any[] | null>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run, setError } = useAction();
  const write = can('products.update') && !ctx?.readOnly;

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([api<any[]>('/company/recipes'), api<any[]>('/company/products')]);
    setList(r); setProducts(p);
  }, []);
  useEffect(() => { if (has('recipes')) run(load); }, []); // eslint-disable-line

  const withRecipe = useMemo(() => new Set((list ?? []).map((r) => r.productId)), [list]);
  const usedAsIngredient = useMemo(() => new Set((list ?? []).flatMap((r) => r.ingredients.map((i: any) => i.ingredientId))), [list]);
  if (!has('recipes')) return <Alert kind="warn">Les fiches techniques ne sont pas activées pour votre entreprise. Contactez Kora ERP pour les activer.</Alert>;

  const dishes = products.filter((p) => !withRecipe.has(p.id) && !usedAsIngredient.has(p.id));
  const ingredients = (dishId: string) => products.filter((p) => p.trackStock && p.id !== dishId && !withRecipe.has(p.id));
  const open = (r: any) => { setError(''); setNotice(''); setEdit({ productId: r.productId, name: r.name, saved: r, rows: r.ingredients.map((i: any) => ({ ingredientId: i.ingredientId, quantity: String(i.quantity) })) }); };
  const start = () => { setError(''); setNotice(''); setEdit({ productId: '', name: '', saved: null, rows: [{ ingredientId: '', quantity: '' }] }); };
  const unit = (id: string) => products.find((p) => p.id === id)?.unit ?? '';
  const save = (remove = false) => run(async () => {
    // Une ligne commencée sans quantité lisible est signalée : elle ne doit pas disparaître de la fiche sans prévenir.
    const bad = remove ? [] : edit.rows.filter((r: any) => r.ingredientId && !(num(r.quantity) > 0));
    if (bad.length) { setError(`Indiquez la quantité de : ${bad.map((r: any) => products.find((p) => p.id === r.ingredientId)?.name ?? '?').join(', ')}.`); return; }
    const rows = remove ? [] : edit.rows.filter((r: any) => r.ingredientId).map((r: any) => ({ ingredientId: r.ingredientId, quantity: num(r.quantity) }));
    if (!remove && !rows.length) { setError('Ajoutez au moins un ingrédient avec sa quantité.'); return; }
    const r = await api<any>(`/company/recipes/${edit.productId}`, { method: 'PUT', body: { ingredients: rows } });
    setNotice(remove ? `Fiche de « ${r.name} » supprimée : le plat ne sort plus d'ingrédients.` : `Fiche de « ${r.name} » enregistrée : coût de revient ${money(r.cost)} par portion.`);
    setEdit(remove ? null : { ...edit, name: r.name, saved: r }); await load();
  });
  const setRow = (i: number, patch: any) => setEdit({ ...edit, rows: edit.rows.map((r: any, k: number) => (k === i ? { ...r, ...patch } : r)) });

  return (
    <>
      <div className="page-head"><h1>Fiches techniques</h1>{write && <button className="btn primary" onClick={start}>+ Nouvelle fiche</button>}</div>
      <p className="muted" style={{ margin: 0 }}>La fiche d&apos;un plat liste ses ingrédients pour <b>une portion</b>. À chaque vente (caisse, table ou facture), ils sortent du stock de l&apos;entrepôt qui vend, au coût moyen ; la caisse affiche les portions encore possibles et refuse la vente quand un ingrédient manque. Les ingrédients sont des <Link href="/app/articles">articles</Link> suivis en stock (riz, huile, poisson…).</p>
      <Alert>{!edit ? error : ''}</Alert>
      {notice && !edit && <Alert kind="ok">{notice}</Alert>}
      {list && !list.length && <p className="muted">Aucune fiche pour l&apos;instant.</p>}
      {list && list.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>Plat</th><th>Ingrédients</th><th className="n">Coût de revient</th><th className="n">Prix de vente HT</th><th className="n">Marge</th><th className="n">Coût matière</th><th className="n">Portions possibles</th></tr></thead>
        <tbody>{list.map((r) => (
          <tr key={r.productId} style={{ cursor: 'pointer' }} onClick={() => open(r)}>
            <td><b>{r.name}</b> <span className="small muted">{r.code}</span></td>
            <td className="small">{r.ingredients.map((i: any) => `${i.name} ${qty(i.quantity)} ${i.unit}`).join(' · ')}</td>
            <td className="n">{money(r.cost)}</td><td className="n">{money(r.salePrice)}</td>
            <td className="n" style={{ color: r.margin < 0 ? 'var(--crit)' : undefined }}>{money(r.margin)}</td>
            <td className="n" style={{ color: (r.costRate ?? 0) > 40 ? 'var(--warn)' : undefined }}>{r.costRate === null ? '—' : `${r.costRate.toLocaleString('fr-FR')} %`}</td>
            <td className="n" style={{ color: r.portions === 0 ? 'var(--crit)' : undefined }}>{r.portions ?? '—'}</td>
          </tr>))}</tbody>
      </table></div>}
      {list && list.length > 0 && <p className="small muted" style={{ margin: 0 }}>Coût matière : part du prix de vente HT consommée en ingrédients (au-delà de 40 %, il s&apos;affiche en orange). Portions possibles : d&apos;après le stock de tous les entrepôts.</p>}

      {edit && <div className="modal-back" onClick={() => setEdit(null)}><form className="modal" style={{ width: 'min(640px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
        <h2 style={{ margin: 0 }}>{edit.saved ? `Fiche — ${edit.name}` : 'Nouvelle fiche technique'}</h2>
        <Alert>{error}</Alert>
        {notice && <Alert kind="ok">{notice}</Alert>}
        {!edit.saved && <label className="field">Plat<select className="input" required value={edit.productId} onChange={(e) => setEdit({ ...edit, productId: e.target.value })}>
          <option value="">Choisir le plat…</option>{dishes.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}</select>
          <span className="small muted">Le plat se crée d&apos;abord dans <Link href="/app/articles">Articles</Link> (une prestation, avec son prix de vente).</span></label>}
        {edit.productId && <>
          <div className="small"><b>Ingrédients pour une portion</b></div>
          <div style={{ display: 'grid', gap: 6 }}>
            {edit.rows.map((r: any, i: number) => (
              <div key={i} className="row" style={{ gap: 6, alignItems: 'center' }}>
                <select className="input" style={{ flex: 1, minWidth: 180 }} value={r.ingredientId} onChange={(e) => setRow(i, { ingredientId: e.target.value })} aria-label={`Ingrédient ${i + 1}`}>
                  <option value="">Ingrédient…</option>
                  {ingredients(edit.productId).filter((p) => p.id === r.ingredientId || !edit.rows.some((x: any) => x.ingredientId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input className="input" style={{ width: 110 }} type="number" min={0} step="any" placeholder="Quantité" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} aria-label={`Quantité de l'ingrédient ${i + 1}`} />
                <span className="small muted" style={{ width: 60 }}>{unit(r.ingredientId)}</span>
                <button type="button" className="btn sm" onClick={() => setEdit({ ...edit, rows: edit.rows.filter((_: any, k: number) => k !== i) })} aria-label="Retirer l'ingrédient">×</button>
              </div>))}
            <div><button type="button" className="btn sm" onClick={() => setEdit({ ...edit, rows: [...edit.rows, { ingredientId: '', quantity: '' }] })}>+ Ingrédient</button></div>
            {!ingredients(edit.productId).length && <p className="small muted" style={{ margin: 0 }}>Aucun article suivi en stock : créez d&apos;abord les ingrédients dans Articles (biens).</p>}
          </div>
          {edit.saved?.ingredients.length > 0 && <div className="table-wrap"><table>
            <thead><tr><th>Ingrédient</th><th className="n">Quantité</th><th className="n">Coût unitaire</th><th className="n">Coût</th></tr></thead>
            <tbody>{edit.saved.ingredients.map((i: any) => <tr key={i.ingredientId}><td>{i.name}</td><td className="n">{qty(i.quantity)} {i.unit}</td><td className="n">{money(i.unitCost)}</td><td className="n">{money(i.cost)}</td></tr>)}
              <tr><td colSpan={3}><b>Coût de revient d&apos;une portion</b> · prix HT {money(edit.saved.salePrice)} · marge {money(edit.saved.margin)}{edit.saved.costRate !== null && ` · coût matière ${edit.saved.costRate.toLocaleString('fr-FR')} %`}</td><td className="n"><b>{money(edit.saved.cost)}</b></td></tr></tbody>
          </table></div>}
        </>}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">{write && <button className="btn primary" disabled={busy || !edit.productId}>Enregistrer</button>}<button type="button" className="btn" onClick={() => setEdit(null)}>Fermer</button></div>
          {write && edit.saved && edit.saved.ingredients.length > 0 && <button type="button" className="btn danger" disabled={busy} onClick={() => save(true)}>Supprimer la fiche</button>}
        </div>
      </form></div>}
    </>
  );
}
