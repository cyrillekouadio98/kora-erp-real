'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { money, VAT_RATES } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const EMPTY = { kind: 'good', name: '', code: '', description: '', unit: 'unité', salePrice: 0, purchasePrice: '', vatRate: 18 };
const FIELDS = Object.keys(EMPTY) as (keyof typeof EMPTY)[];

export default function ProductsPage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState('false');
  const [edit, setEdit] = useState<any>(null);
  const { busy, error, run } = useAction();
  const params = new URLSearchParams({ archived, ...(q.trim() ? { q: q.trim() } : {}) }).toString();

  const load = useCallback(() => run(async () => setRows(await api(`/company/products?${params}`))), [params]); // eslint-disable-line
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);

  const save = () => run(async () => {
    const body: any = Object.fromEntries(FIELDS.map((k) => [k, edit[k]]));
    body.purchasePrice = body.purchasePrice === '' || body.purchasePrice === null ? null : Number(body.purchasePrice);
    if (edit.id) await api(`/company/products/${edit.id}`, { method: 'PATCH', body }); else await api('/company/products', { body });
    setEdit(null); await load();
  });
  const toggleArchive = (p: any) => run(async () => { await api(`/company/products/${p.id}/${p.archivedAt ? 'restore' : 'archive'}`, { body: {} }); await load(); });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <>
      <div className="page-head">
        <h1>Articles</h1>
        {can('products.create') && writable && <button className="btn primary" onClick={() => setEdit({ ...EMPTY })}>Nouvel article</button>}
      </div>
      <Alert>{!edit && error}</Alert>
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder="Nom, code, description…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="field" style={{ flex: 1, minWidth: 130 }}>Affichage
          <select className="input" value={archived} onChange={(e) => setArchived(e.target.value)}><option value="false">Actifs</option><option value="true">Archivés</option><option value="all">Tous</option></select>
        </label>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Désignation</th><th>Type</th><th className="n">Prix de vente HT</th><th className="n">TVA</th><th className="n">Prix TTC</th><th className="n">Stock</th><th></th></tr></thead>
        <tbody>
          {rows?.map((p) => (
            <tr key={p.id} style={p.archivedAt ? { opacity: .6 } : undefined}>
              <td style={{ whiteSpace: 'nowrap' }}><code className="k">{p.code}</code></td>
              <td><b>{p.name}</b>{p.archivedAt && <> <Pill>Archivé</Pill></>}<div className="small muted">par {p.unit}{p.description ? ` · ${p.description}` : ''}</div></td>
              <td><Pill tone={p.kind === 'good' ? 'ok' : 'mute'}>{p.kind === 'good' ? 'Bien' : 'Service'}</Pill></td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(p.salePrice)}</td>
              <td className="n">{p.vatRate} %</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(p.salePrice * (1 + p.vatRate / 100))}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{p.trackStock ? <Link href="/app/stocks">{p.stockQty.toLocaleString('fr-FR')} {p.unit}</Link> : <span className="muted">—</span>}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {writable && can('products.update') && !p.archivedAt && <button className="btn sm" onClick={() => setEdit({ ...Object.fromEntries(FIELDS.map((k) => [k, p[k] ?? EMPTY[k]])), id: p.id })}>Modifier</button>}
                {writable && can('products.cancel') && <button className={`btn sm${p.archivedAt ? '' : ' danger'}`} disabled={busy} onClick={() => toggleArchive(p)}>{p.archivedAt ? 'Restaurer' : 'Archiver'}</button>}
              </div></td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>
            {q || archived !== 'false' ? 'Aucun article ne correspond à ces critères.' : 'Aucun article pour l’instant. Créez vos produits et services pour les retrouver dans vos devis et factures.'}
          </td></tr>}
        </tbody>
      </table></div>

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `Modifier ${edit.code}` : 'Nouvel article'}</h2>
            <Alert>{error}</Alert>
            <div className="grid2">
              <Field label="Désignation" required minLength={2} value={edit.name} onChange={set('name')} />
              <label className="field">Type
                <select className="input" value={edit.kind} onChange={set('kind')}><option value="good">Bien (marchandise)</option><option value="service">Service</option></select>
              </label>
              <Field label="Code (laisser vide : automatique)" value={edit.code} onChange={set('code')} placeholder="ART-00001" />
              <Field label="Unité" value={edit.unit} onChange={set('unit')} placeholder="unité, sac, kg, heure…" />
              <Field label="Prix de vente HT (FCFA)" type="number" min={0} step="any" required value={edit.salePrice} onChange={set('salePrice')} />
              <label className="field">TVA
                <select className="input" value={edit.vatRate} onChange={set('vatRate')}>{VAT_RATES.map((r) => <option key={r} value={r}>{r === 18 ? '18 % (taux normal)' : r === 9 ? '9 % (taux réduit)' : '0 % (exonéré)'}</option>)}</select>
              </label>
              <Field label="Prix d'achat HT (facultatif)" type="number" min={0} step="any" value={edit.purchasePrice ?? ''} onChange={set('purchasePrice')} />
            </div>
            <label className="field">Description<textarea className="input" rows={2} value={edit.description ?? ''} onChange={set('description')} /></label>
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
