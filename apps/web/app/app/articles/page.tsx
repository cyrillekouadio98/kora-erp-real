'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ACTIVITIES, date, money, VAT_RATES } from '@/lib/format';
import { useSession } from '@/components/session';
import { ImportButton } from '@/components/import';
import { productsImport } from '@/components/import-configs';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const EMPTY = { kind: 'good', name: '', description: '', unit: 'unité', salePrice: 0, purchasePrice: '', vatRate: 18, barcode: '', siteId: 'auto' };
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
  // Stock initial saisi avec l'article : réservé à qui administre les stocks ; entrepôt au choix s'il y en a plusieurs.
  const canOpening = can('stock.admin');
  // Plusieurs sites : un article peut être réservé à l'un d'eux (il n'est alors proposé que là).
  const sites = ctx?.sites ?? [];
  const multiSite = sites.length > 1;
  const siteName = (id: string | null) => sites.find((x) => x.id === id)?.name;
  const [warehouses, setWarehouses] = useState<any[]>([]);
  useEffect(() => { if (edit && canOpening && !warehouses.length) api('/company/stock/warehouses').then((r: any[]) => setWarehouses(r.filter((w) => !w.archived)), () => {}); }, [!!edit, canOpening]); // eslint-disable-line react-hooks/exhaustive-deps
  // Modification d'une marchandise : stock initial déjà saisi (affiché) ou, sans aucun mouvement, encore saisissable.
  const [history, setHistory] = useState<{ opening: any | null; moves: number; stockQty: number } | null>(null);
  useEffect(() => {
    setHistory(null);
    if (edit?.id && edit.kind === 'good' && can('stock.read')) {
      api(`/company/stock/${edit.id}/movements`).then((r: any) => setHistory({
        opening: r.movements.find((m: any) => m.reason === 'opening') ?? null, moves: r.movements.length, stockQty: r.product.stock_qty,
      }), () => {});
    }
  }, [edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const openingEditable = edit?.kind === 'good' && canOpening && (!edit?.id || history?.moves === 0);

  const save = () => run(async () => {
    const body: any = Object.fromEntries(FIELDS.map((k) => [k, edit[k]]));
    body.purchasePrice = body.purchasePrice === '' || body.purchasePrice === null ? null : Number(body.purchasePrice);
    body.barcode = body.barcode?.trim() || null;
    if (!multiSite) delete body.siteId; else if (body.siteId === 'auto') delete body.siteId; else body.siteId = body.siteId || null;
    if (openingEditable && Number(edit.openingQty) > 0) {
      body.openingStock = { quantity: Number(edit.openingQty), warehouseId: edit.openingWarehouse || null,
        ...(edit.openingCost !== '' && edit.openingCost != null ? { unitCost: Number(edit.openingCost) } : {}) };
    }
    if (edit.id) await api(`/company/products/${edit.id}`, { method: 'PATCH', body }); else await api('/company/products', { body });
    setEdit(null); await load();
  });
  // Suppression : seulement un article jamais utilisé ; sinon l'API répond qu'il faut l'archiver.
  const remove = (p: any) => {
    if (!window.confirm(`Supprimer définitivement « ${p.name} » (${p.code}) ?\n\nPossible seulement s'il n'a jamais servi (aucun devis, facture, achat ni mouvement de stock). Cette action ne peut pas être annulée.`)) return;
    run(async () => { await api(`/company/products/${p.id}`, { method: 'DELETE' }); await load(); });
  };
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
              <td><b>{p.name}</b>{p.archivedAt && <> <Pill>Archivé</Pill></>}<div className="small muted">par {p.unit}{p.barcode ? ` · ${p.barcode}` : ''}{p.description ? ` · ${p.description}` : ''}</div>{multiSite && <div className="small muted">{p.siteId ? <>Site : <b>{siteName(p.siteId) ?? 'autre site'}</b></> : 'Tous les sites'}</div>}</td>
              {showType && <td><Pill tone={p.kind === 'good' ? 'ok' : 'mute'}>{p.kind === 'good' ? (trade ? 'Marchandise' : 'Bien') : (services ? 'Prestation' : 'Service')}</Pill></td>}
              {trade && <td className="n" style={{ whiteSpace: 'nowrap' }}>{p.purchasePrice == null ? <span className="muted">—</span> : money(p.purchasePrice)}</td>}
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(p.salePrice)}</td>
              {trade && <td className="n" style={{ whiteSpace: 'nowrap' }}>{mg ? <span style={mg.value < 0 ? { color: 'var(--crit)' } : undefined}>{money(mg.value)}{mg.rate != null && <div className="small muted">{mg.rate.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</div>}</span> : <span className="muted">—</span>}</td>}
              <td className="n">{p.vatRate} %</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(p.salePrice * (1 + p.vatRate / 100))}</td>
              {showStock && <td className="n" style={{ whiteSpace: 'nowrap' }}>{p.trackStock ? <Link href="/app/stocks">{p.stockQty.toLocaleString('fr-FR')} {p.unit}</Link> : <span className="muted">—</span>}</td>}
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {writable && can('products.update') && !p.archivedAt && <button className="btn sm" onClick={() => setEdit({ ...Object.fromEntries(FIELDS.map((k) => [k, p[k] ?? EMPTY[k]])), siteId: p.siteId ?? '', id: p.id, code: p.code })}>Modifier</button>}
                {writable && can('products.cancel') && <button className={`btn sm${p.archivedAt ? '' : ' danger'}`} disabled={busy} onClick={() => toggleArchive(p)}>{p.archivedAt ? 'Restaurer' : 'Archiver'}</button>}
                {writable && can('products.cancel') && <button className="btn sm danger" disabled={busy} onClick={() => remove(p)}>Supprimer</button>}
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
              {edit.kind === 'good' && <Field label="Code-barres (scanné à la caisse)" value={edit.barcode ?? ''} onChange={set('barcode')} placeholder="Ex. 6151100000017" pattern="[A-Za-z0-9._\-]*" maxLength={40} />}
              {trade && edit.kind === 'good' && <Field label={m.cost} type="number" min={0} step="any" value={edit.purchasePrice ?? ''} onChange={set('purchasePrice')} />}
              <Field label={edit.kind === 'service' && !services ? 'Prix de vente HT (FCFA)' : m.price} type="number" min={0} step="any" required value={edit.salePrice} onChange={set('salePrice')} />
              <label className="field">TVA
                <select className="input" value={edit.vatRate} onChange={set('vatRate')}>{VAT_RATES.map((r) => <option key={r} value={r}>{r === 18 ? '18 % (taux normal)' : r === 9 ? '9 % (taux réduit)' : '0 % (exonéré)'}</option>)}</select>
              </label>
              {multiSite && <label className="field">Site
                <select className="input" value={edit.siteId ?? ''} onChange={set('siteId')}>
                  {!edit.id && <option value="auto">Automatique (site du stock initial)</option>}
                  <option value="">Tous les sites</option>{sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                <span className="small muted">{edit.siteId === 'auto' ? "Avec un stock initial, l'article n'est visible que sur le site de son entrepôt ; sans stock, sur tous les sites." : edit.siteId ? 'Visible seulement sur ce site.' : 'Visible sur tous les sites.'}</span></label>}
              {!(trade && edit.kind === 'good') && <Field label={trade ? "Coût d'achat HT (facultatif)" : m.cost} type="number" min={0} step="any" value={edit.purchasePrice ?? ''} onChange={set('purchasePrice')} />}
            </div>
            {editMargin && <p className="small" style={{ margin: 0 }}>Marge unitaire : <b style={editMargin.value < 0 ? { color: 'var(--crit)' } : undefined}>{money(editMargin.value)}</b>{editMargin.rate != null && <> ({editMargin.rate.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % du prix de vente)</>}</p>}
            {edit.kind === 'good' && edit.id && history && !openingEditable && <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Stock initial</legend>
              {history.opening
                ? <p className="small" style={{ margin: 0 }}><b>{history.opening.quantity.toLocaleString('fr-FR')} {edit.unit}</b> à {money(history.opening.quantity ? history.opening.value / history.opening.quantity : 0)} l&apos;unité, soit {money(history.opening.value)} — {history.opening.warehouseName}, le {date(history.opening.date)}</p>
                : <p className="small" style={{ margin: 0 }}>{history.moves ? 'Aucun stock initial : le stock de cet article vient de ses achats, ventes et bons.' : 'Aucun stock initial saisi.'}</p>}
              <p className="small muted" style={{ margin: '4px 0 0' }}>Stock actuel : <b>{history.stockQty.toLocaleString('fr-FR')} {edit.unit}</b>. Le stock initial ne se modifie plus une fois l&apos;article mouvementé : corrigez le stock par un inventaire dans <Link href="/app/stocks">Stocks</Link>.</p>
            </fieldset>}
            {edit.kind === 'good' && (!edit.id || (history && openingEditable)) && (canOpening ? <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Stock initial (facultatif)</legend>
              <div className="grid2">
                <Field label={`Quantité en stock${edit.unit ? ` (${edit.unit})` : ''}`} type="number" min={0} step="any" value={edit.openingQty ?? ''} onChange={set('openingQty')} placeholder="0" />
                <Field label="Coût unitaire HT (FCFA)" type="number" min={0} step="any" value={edit.openingCost ?? ''} onChange={set('openingCost')}
                  placeholder={edit.purchasePrice !== '' && edit.purchasePrice != null ? `${edit.purchasePrice} (prix d'achat)` : "Prix d'achat"} />
                {warehouses.length > 1 && <label className="field">Entrepôt<select className="input" value={edit.openingWarehouse ?? ''} onChange={(e) => { const w = warehouses.find((x) => x.id === e.target.value); setEdit({ ...edit, openingWarehouse: e.target.value, ...(w && edit.siteId && edit.siteId !== 'auto' ? { siteId: w.siteId } : {}) }); }}>
                  <option value="">Entrepôt du site</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.siteName ? ` — ${w.siteName}` : ''}</option>)}</select></label>}
              </div>
              <p className="small muted" style={{ margin: '4px 0 0' }}>Les quantités déjà en rayon ou en magasin. Le coût unitaire reprend le prix d&apos;achat s&apos;il n&apos;est pas saisi. Ensuite, le stock évolue avec les achats, les ventes et les inventaires.</p>
            </fieldset> : <p className="small muted" style={{ margin: 0 }}>Le stock de cette marchandise se suit dans Stocks : le stock initial s&apos;y saisit après l&apos;enregistrement.</p>)}
            <label className="field">Description<textarea className="input" rows={2} value={edit.description ?? ''} onChange={set('description')} /></label>
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
