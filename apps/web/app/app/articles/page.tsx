'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ACTIVITIES, money, VAT_RATES } from '@/lib/format';
import { useSession } from '@/components/session';
import { ImportButton } from '@/components/import';
import { productsImport } from '@/components/import-configs';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const EMPTY = { kind: 'good', name: '', description: '', unit: 'unité', salePrice: 0, purchasePrice: '', vatRate: 18 };
const FIELDS = Object.keys(EMPTY) as (keyof typeof EMPTY)[];

/** Le module s'adapte à l'activité de l'entreprise (fiche entreprise) : libellés, type par défaut, colonnes et champs. */
const MODES = {
  trade: { title: 'Articles', create: 'Nouvel article', one: 'article', empty: { kind: 'good', unit: 'unité' }, units: 'unité, sac, carton, kg, litre…',
    price: 'Prix de vente HT (FCFA)', cost: "Prix d'achat HT", none: 'Aucun article pour l’instant. Créez vos marchandises pour suivre leur stock et votre marge, et les retrouver dans vos devis et factures.',
    kinds: { good: 'Marchandise (stockée)', service: 'Service (livraison, installation…)' } },
  services: { title: 'Prestations', create: 'Nouvelle prestation', one: 'prestation', empty: { kind: 'service', unit: 'forfait' }, units: 'heure, jour, forfait, mois…',
    price: 'Tarif HT (FCFA)', cost: 'Coût de revient HT (facultatif)', none: 'Aucune prestation pour l’instant. Créez vos prestations et leurs tarifs pour les retrouver dans vos devis et factures.',
    kinds: { good: 'Bien (marchandise)', service: 'Prestation de service' } },
  mixed: { title: 'Articles', create: 'Nouvel article', one: 'article', empty: { kind: 'good', unit: 'unité' }, units: 'unité, sac, kg, heure…',
    price: 'Prix de vente HT (FCFA)', cost: "Prix d'achat HT (facultatif)", none: 'Aucun article pour l’instant. Créez vos produits et services pour les retrouver dans vos devis et factures.',
    kinds: { good: 'Bien (marchandise)', service: 'Service' } },
} as const;
/** Marge unitaire et taux de marque, quand le prix d'achat est connu. */
const margin = (p: { salePrice: number; purchasePrice: number | null }) => (p.purchasePrice == null ? null : { value: p.salePrice - p.purchasePrice, rate: p.salePrice > 0 ? ((p.salePrice - p.purchasePrice) / p.salePrice) * 100 : null });

export default function ProductsPage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const activity = ctx?.company.activity ?? 'mixed';
  const m = MODES[activity] ?? MODES.mixed;
  const blank = { ...EMPTY, ...m.empty };
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState('false');
  const [edit, setEdit] = useState<any>(null);
  const [nextCode, setNextCode] = useState('');
  const { busy, error, run } = useAction();
  const params = new URLSearchParams({ archived, ...(q.trim() ? { q: q.trim() } : {}) }).toString();

  const load = useCallback(() => run(async () => setRows(await api(`/company/products?${params}`))), [params]); // eslint-disable-line
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  // Nouvel article : aperçu du code qu'il recevra (attribué à l'enregistrement).
  const creating = !!edit && !edit.id;
  useEffect(() => { if (creating) { setNextCode(''); api('/company/products/next-code').then((r) => setNextCode(r.code), () => {}); } }, [creating]);

  const save = () => run(async () => {
    const body: any = Object.fromEntries(FIELDS.map((k) => [k, edit[k]]));
    body.purchasePrice = body.purchasePrice === '' || body.purchasePrice === null ? null : Number(body.purchasePrice);
    if (edit.id) await api(`/company/products/${edit.id}`, { method: 'PATCH', body }); else await api('/company/products', { body });
    setEdit(null); await load();
  });
  const toggleArchive = (p: any) => run(async () => { await api(`/company/products/${p.id}/${p.archivedAt ? 'restore' : 'archive'}`, { body: {} }); await load(); });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setEdit({ ...edit, [k]: e.target.value });

  const trade = activity === 'trade', services = activity === 'services';
  // Une entreprise de services ne voit le type et le stock que si elle a malgré tout des biens.
  const showType = !services || !!rows?.some((p) => p.kind === 'good');
  const showStock = !services || !!rows?.some((p) => p.trackStock);
  const cols = 6 + (showType ? 1 : 0) + (showStock ? 1 : 0) + (trade ? 2 : 0);
  const editMargin = edit && trade && edit.kind === 'good' && edit.purchasePrice !== '' && edit.purchasePrice != null ? margin({ salePrice: Number(edit.salePrice), purchasePrice: Number(edit.purchasePrice) }) : null;

  return (
    <>
      <div className="page-head">
        <div><h1>{m.title}</h1>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Activité : {ACTIVITIES[activity][0]}{can('settings.read') && <> · <Link href="/app/entreprise">modifier dans la fiche entreprise</Link></>}</p></div>
        {can('products.create') && writable && <div className="row">
          <ImportButton config={productsImport(activity)} onDone={load} />
          <button className="btn primary" onClick={() => setEdit({ ...blank })}>{m.create}</button>
        </div>}
      </div>
      <Alert>{!edit && error}</Alert>
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder="Nom, code, description…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="field" style={{ flex: 1, minWidth: 130 }}>Affichage
          <select className="input" value={archived} onChange={(e) => setArchived(e.target.value)}><option value="false">Actifs</option><option value="true">Archivés</option><option value="all">Tous</option></select>
        </label>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Désignation</th>{showType && <th>Type</th>}{trade && <th className="n">Prix d&apos;achat HT</th>}<th className="n">{services ? 'Tarif HT' : 'Prix de vente HT'}</th>{trade && <th className="n">Marge</th>}<th className="n">TVA</th><th className="n">Prix TTC</th>{showStock && <th className="n">Stock</th>}<th></th></tr></thead>
        <tbody>
          {rows?.map((p) => { const mg = margin(p); return (
            <tr key={p.id} style={p.archivedAt ? { opacity: .6 } : undefined}>
              <td style={{ whiteSpace: 'nowrap' }}><code className="k">{p.code}</code></td>
              <td><b>{p.name}</b>{p.archivedAt && <> <Pill>Archivé</Pill></>}<div className="small muted">par {p.unit}{p.description ? ` · ${p.description}` : ''}</div></td>
              {showType && <td><Pill tone={p.kind === 'good' ? 'ok' : 'mute'}>{p.kind === 'good' ? (trade ? 'Marchandise' : 'Bien') : (services ? 'Prestation' : 'Service')}</Pill></td>}
              {trade && <td className="n" style={{ whiteSpace: 'nowrap' }}>{p.purchasePrice == null ? <span className="muted">—</span> : money(p.purchasePrice)}</td>}
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(p.salePrice)}</td>
              {trade && <td className="n" style={{ whiteSpace: 'nowrap' }}>{mg ? <span style={mg.value < 0 ? { color: 'var(--crit)' } : undefined}>{money(mg.value)}{mg.rate != null && <div className="small muted">{mg.rate.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</div>}</span> : <span className="muted">—</span>}</td>}
              <td className="n">{p.vatRate} %</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(p.salePrice * (1 + p.vatRate / 100))}</td>
              {showStock && <td className="n" style={{ whiteSpace: 'nowrap' }}>{p.trackStock ? <Link href="/app/stocks">{p.stockQty.toLocaleString('fr-FR')} {p.unit}</Link> : <span className="muted">—</span>}</td>}
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {writable && can('products.update') && !p.archivedAt && <button className="btn sm" onClick={() => setEdit({ ...Object.fromEntries(FIELDS.map((k) => [k, p[k] ?? EMPTY[k]])), id: p.id, code: p.code })}>Modifier</button>}
                {writable && can('products.cancel') && <button className={`btn sm${p.archivedAt ? '' : ' danger'}`} disabled={busy} onClick={() => toggleArchive(p)}>{p.archivedAt ? 'Restaurer' : 'Archiver'}</button>}
              </div></td>
            </tr>
          ); })}
          {rows && !rows.length && <tr><td colSpan={cols} className="muted" style={{ textAlign: 'center', padding: 28 }}>
            {q || archived !== 'false' ? `Aucun${services ? 'e prestation' : ' article'} ne correspond à ces critères.` : m.none}
          </td></tr>}
        </tbody>
      </table></div>

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `Modifier ${edit.code}` : m.create}</h2>
            <Alert>{error}</Alert>
            <div className="grid2">
              <Field label="Désignation" required minLength={2} value={edit.name} onChange={set('name')} placeholder={services ? 'Ex. Maintenance informatique' : trade ? 'Ex. Huile végétale 5 L' : undefined} />
              {/* Services : le type n'est proposé que pour un bien déjà existant. */}
              {(!services || edit.kind === 'good') && <label className="field">Type
                <select className="input" value={edit.kind} onChange={set('kind')}><option value="good">{m.kinds.good}</option><option value="service">{m.kinds.service}</option></select>
              </label>}
              <label className="field">Code (automatique)
                <span className="input contact-code">{edit.id ? edit.code : (nextCode || '…')}{!edit.id && <span className="small muted"> attribué à l&apos;enregistrement</span>}</span></label>
              <Field label="Unité" value={edit.unit} onChange={set('unit')} placeholder={m.units} />
              {trade && edit.kind === 'good' && <Field label={m.cost} type="number" min={0} step="any" value={edit.purchasePrice ?? ''} onChange={set('purchasePrice')} />}
              <Field label={edit.kind === 'service' && !services ? 'Prix de vente HT (FCFA)' : m.price} type="number" min={0} step="any" required value={edit.salePrice} onChange={set('salePrice')} />
              <label className="field">TVA
                <select className="input" value={edit.vatRate} onChange={set('vatRate')}>{VAT_RATES.map((r) => <option key={r} value={r}>{r === 18 ? '18 % (taux normal)' : r === 9 ? '9 % (taux réduit)' : '0 % (exonéré)'}</option>)}</select>
              </label>
              {!(trade && edit.kind === 'good') && <Field label={trade ? "Coût d'achat HT (facultatif)" : m.cost} type="number" min={0} step="any" value={edit.purchasePrice ?? ''} onChange={set('purchasePrice')} />}
            </div>
            {editMargin && <p className="small" style={{ margin: 0 }}>Marge unitaire : <b style={editMargin.value < 0 ? { color: 'var(--crit)' } : undefined}>{money(editMargin.value)}</b>{editMargin.rate != null && <> ({editMargin.rate.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % du prix de vente)</>}</p>}
            {!services && edit.kind === 'good' && !edit.id && <p className="small muted" style={{ margin: 0 }}>Le stock de cette marchandise se suit dans Stocks : saisissez le stock initial ou un bon d&apos;entrée après l&apos;enregistrement.</p>}
            <label className="field">Description<textarea className="input" rows={2} value={edit.description ?? ''} onChange={set('description')} /></label>
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
