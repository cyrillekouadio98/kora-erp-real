'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ACCOUNT_KINDS, date, dateTime, ISSUE_REASONS, money, qty, RECEIPT_REASONS, STOCK_DOC, stockReason } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
interface Line { productId: string; quantity: string; unitCost: string; note: string }
const toLine = (l: any): Line => ({ productId: l.productId, quantity: l.quantity === null || l.quantity === undefined ? '' : String(l.quantity), unitCost: l.unitCost === null || l.unitCost === undefined ? '' : String(l.unitCost), note: l.note ?? '' });

/** Page d'un bon de stock : saisie du brouillon, validation, puis bon imprimable. base : liste à laquelle il appartient. */
export function StockDocument({ id, type: newType, base }: { id?: string; type?: string; base: string }) {
  const router = useRouter();
  const { can, ctx } = useSession();
  // Sites : on part d'un entrepôt du site affiché (ou des sites permis) ; on peut livrer n'importe quel site.
  const multiSite = (ctx?.sites.length ?? 0) > 1 || !!ctx?.siteRestricted;
  const fromHere = (w: any) => (ctx?.siteId ? w.siteId === ctx.siteId : !ctx?.siteRestricted || !!ctx.sites.some((s) => s.id === w.siteId));
  const whLabel = (w: any) => `${w.code} · ${w.name}${multiSite ? ` — ${w.siteName}` : ''}`;
  const writable = !ctx?.readOnly;
  const [doc, setDoc] = useState<any>(null);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [stock, setStock] = useState<Record<string, any>>({});
  const [form, setForm] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [filter, setFilter] = useState('');
  const { busy, error, run } = useAction();
  const type: string = doc?.type ?? newType;
  const draft = !doc || doc.status === 'draft';
  const editable = draft && writable && can(doc ? 'stock.update' : 'stock.create');

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api(`/company/stock/documents/${id}`);
    setDoc(d);
    setForm({ warehouseId: d.warehouse.id, destWarehouseId: d.destWarehouse?.id ?? '', reason: d.reason, date: d.date, contactId: d.contact?.id ?? '', treasuryAccountId: d.treasuryAccount?.id ?? '', reference: d.reference ?? '', notes: d.notes ?? '' });
    setLines(d.lines.map(toLine));
  }, [id]);

  useEffect(() => {
    run(async () => {
      const w = (await api('/company/stock/warehouses')).filter((x: any) => !x.archived);
      setWarehouses(w);
      if (!id) {
        // Départ : un entrepôt du site affiché (son principal d'abord).
        const mine = w.filter(fromHere);
        setForm({ warehouseId: (mine.find((x: any) => x.isDefault) ?? mine[0] ?? w.find((x: any) => x.isDefault))?.id ?? '', destWarehouseId: '', reason: newType === 'receipt' ? 'production' : newType === 'issue' ? 'consumption' : newType, date: today(), contactId: '', treasuryAccountId: '', reference: '', notes: '' });
        setLines([]);
      }
      await load();
    });
    api('/company/contacts').then(setContacts, () => {});
    api('/company/treasury/accounts').then((a) => setAccounts(a.filter((x: any) => !x.archivedAt && !x.archived)), () => {});
  }, [id, newType, load]); // eslint-disable-line

  // Stock de l'entrepôt de départ : disponible et coût moyen de chaque article
  useEffect(() => {
    if (!form?.warehouseId) return;
    api(`/company/stock?warehouseId=${form.warehouseId}`).then((o) => setStock(Object.fromEntries(o.items.map((i: any) => [i.id, i]))), () => {});
  }, [form?.warehouseId]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const products = useMemo(() => Object.values(stock).sort((a: any, b: any) => a.name.localeCompare(b.name)), [stock]) as any[];
  const cashPurchase = type === 'receipt' && form?.reason === 'cash_purchase';

  const lineValue = (l: Line) => {
    const p = stock[l.productId]; const q = Number(l.quantity || 0);
    if (type === 'receipt') return q * Number(l.unitCost || (p?.avgCost || p?.purchasePrice || 0));
    if (type === 'inventory') return (q - (doc?.lines.find((x: any) => x.productId === l.productId)?.expected ?? 0)) * (p?.avgCost ?? 0);
    return q * (p?.avgCost ?? 0);
  };
  const total = lines.reduce((s, l) => s + (type === 'inventory' && l.quantity === '' ? 0 : lineValue(l)), 0);

  const body = () => ({
    warehouseId: form.warehouseId || null, ...(type === 'transfer' ? { destWarehouseId: form.destWarehouseId || null } : {}),
    ...(type === 'receipt' || type === 'issue' ? { reason: form.reason, contactId: form.contactId || null } : {}),
    ...(cashPurchase ? { treasuryAccountId: form.treasuryAccountId || null } : {}),
    date: form.date, reference: form.reference || null, notes: form.notes || null,
    lines: lines.filter((l) => l.productId).map((l) => ({
      productId: l.productId, quantity: l.quantity === '' ? null : Number(l.quantity),
      ...(type === 'receipt' ? { unitCost: l.unitCost === '' ? null : Number(l.unitCost) } : {}), note: l.note || null,
    })),
  });

  const save = () => run(async () => {
    if (doc) { setDoc(await api(`/company/stock/documents/${doc.id}`, { method: 'PATCH', body: body() })); return true; }
    const d = await api('/company/stock/documents', { body: { type, ...body() } });
    router.replace(`${base}/${d.id}`);
    return true;
  });
  const validate = () => run(async () => {
    await api(`/company/stock/documents/${doc.id}`, { method: 'PATCH', body: body() });
    await api(`/company/stock/documents/${doc.id}/validate`, { method: 'POST' });
    await load();
  });
  const remove = () => run(async () => {
    if (!confirm('Supprimer ce brouillon ?')) return;
    await api(`/company/stock/documents/${doc.id}`, { method: 'DELETE' });
    router.replace(base);
  });

  if (!form) return <Alert>{error}</Alert>;
  const wName = (wid: string) => warehouses.find((w) => w.id === wid)?.name ?? doc?.warehouse?.name;
  const fromW = warehouses.find((w) => w.id === form?.warehouseId), toW = warehouses.find((w) => w.id === form?.destWarehouseId);
  const interSite = fromW && toW && fromW.siteId !== toW.siteId ? `${fromW.siteName} → ${toW.siteName}` : '';
  const reasons = type === 'receipt' ? RECEIPT_REASONS : type === 'issue' ? ISSUE_REASONS : null;
  const title = doc?.number ? `${STOCK_DOC[type]} ${doc.number}` : `${STOCK_DOC[type]}${doc ? ' — brouillon' : ' — nouveau'}`;

  // ------------------------------------------------------------------ bon validé : document imprimable
  if (!draft) {
    const motive = stockReason(type, doc.reason);
    return (
      <>
        <div className="page-head no-print"><h1>{title}</h1>
          <div className="row">
            {writable && can('stock.cancel') && <button className="btn" disabled={busy} onClick={() => {
              const text = `Remettre ${type === 'inventory' ? "l'inventaire" : 'le bon'} ${doc.number} en brouillon pour le corriger ?\n\nSes mouvements de stock seront annulés${doc.treasuryAccount ? ", le paiement en trésorerie et son écriture seront contre-passés" : ''}. Il gardera son numéro ; vous le validerez de nouveau après correction.`;
              if (confirm(text)) run(async () => { await api(`/company/stock/documents/${doc.id}/reset-to-draft`, { method: 'POST' }); await load(); });
            }}>Remettre en brouillon</button>}
            <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button><Link className="btn" href={base}>Retour à la liste</Link></div></div>
        <Alert>{error}</Alert>
        <div className="card stock-print">
          <header className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div><h2 style={{ margin: 0 }}>{STOCK_DOC[type]}</h2><div className="small muted">{doc.number} · {date(doc.date)}</div></div>
            <Pill tone="ok">Validé</Pill>
          </header>
          <dl className="stock-meta">
            <dt>{type === 'transfer' ? 'Départ' : 'Entrepôt'}</dt><dd>{doc.warehouse.code} · {doc.warehouse.name}</dd>
            {doc.destWarehouse && <><dt>Arrivée</dt><dd>{doc.destWarehouse.code} · {doc.destWarehouse.name}</dd></>}
            {motive && <><dt>Motif</dt><dd>{motive}</dd></>}
            {doc.contact && <><dt>{type === 'receipt' ? 'Fournisseur' : 'Bénéficiaire'}</dt><dd>{doc.contact.name}</dd></>}
            {doc.treasuryAccount && <><dt>Payé depuis</dt><dd>{doc.treasuryAccount.name} ({ACCOUNT_KINDS[doc.treasuryAccount.kind]}) — écriture 601000</dd></>}
            {doc.reference && <><dt>Référence</dt><dd>{doc.reference}</dd></>}
            <dt>Validé</dt><dd>{dateTime(doc.validatedAt)}{doc.validatedBy && ` par ${doc.validatedBy}`}</dd>
          </dl>
          <div className="table-wrap"><table>
            <thead>{type === 'inventory'
              ? <tr><th>Article</th><th className="n">Théorique</th><th className="n">Compté</th><th className="n">Écart</th><th className="n">Valeur de l'écart</th></tr>
              : <tr><th>Article</th><th className="n">Quantité</th><th className="n">Coût unitaire</th><th className="n">Valeur</th><th>Note</th></tr>}</thead>
            <tbody>{doc.lines.map((l: any) => type === 'inventory' ? (
              <tr key={l.id}><td><b>{l.name}</b> <span className="small muted">{l.code}</span></td><td className="n">{qty(l.expected)} {l.unit}</td><td className="n">{qty(l.quantity)}</td>
                <td className="n" style={{ color: l.quantity - l.expected < 0 ? 'var(--crit)' : l.quantity - l.expected > 0 ? 'var(--ok)' : undefined }}>{l.quantity === l.expected ? '—' : `${l.quantity > l.expected ? '+' : ''}${qty(l.quantity - l.expected)}`}</td>
                <td className="n">{l.value ? money(l.value) : '—'}</td></tr>
            ) : (
              <tr key={l.id}><td><b>{l.name}</b> <span className="small muted">{l.code}</span></td><td className="n">{qty(l.quantity)} {l.unit}</td><td className="n">{money(l.unitCost ?? 0)}</td><td className="n">{money(l.value ?? 0)}</td><td className="small">{l.note}</td></tr>
            ))}</tbody>
            <tfoot><tr><th colSpan={type === 'inventory' ? 4 : 3}>{type === 'inventory' ? 'Écart total (au coût moyen)' : type === 'receipt' ? "Valeur totale (coût d'entrée)" : 'Valeur totale (au coût moyen pondéré)'}</th><th className="n">{money(doc.totalValue)}</th>{type !== 'inventory' && <th />}</tr></tfoot>
          </table></div>
          {doc.notes && <p className="small"><b>Notes :</b> {doc.notes}</p>}
          <div className="signatures"><div>{type === 'receipt' ? 'Livré par' : 'Remis par'}</div><div>{type === 'issue' ? 'Reçu par' : type === 'inventory' ? 'Compté par' : 'Réceptionné par'}</div><div>Visa du responsable</div></div>
        </div>
      </>
    );
  }

  // ------------------------------------------------------------------ brouillon
  const isInventory = type === 'inventory';
  const shown = lines.map((l, i) => ({ l, i })).filter(({ l }) => !filter || (stock[l.productId]?.name ?? '').toLowerCase().includes(filter.toLowerCase()));
  const counted = lines.filter((l) => l.quantity !== '').length;
  const unused = products.filter((p) => !lines.some((l) => l.productId === p.id));

  return (
    <>
      <div className="page-head no-print"><h1>{title}</h1>
        <div className="row">
          {isInventory && <button className="btn" onClick={() => window.print()}>Imprimer la feuille de comptage</button>}
          <Link className="btn" href={base}>Retour à la liste</Link>
        </div>
      </div>
      <Alert>{error}</Alert>
      <form className="card form stock-print" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="grid2 no-print">
          <label className="field">{type === 'transfer' ? 'Entrepôt de départ' : 'Entrepôt'}
            <select className="input" disabled={!editable || (isInventory && !!doc)} value={form.warehouseId} onChange={set('warehouseId')}>
              {warehouses.filter((w) => fromHere(w) || w.id === form.warehouseId).map((w) => <option key={w.id} value={w.id}>{whLabel(w)}</option>)}
            </select></label>
          {type === 'transfer' && <label className="field">Entrepôt d'arrivée
            <select className="input" required disabled={!editable} value={form.destWarehouseId} onChange={set('destWarehouseId')}>
              <option value="">— Choisir —</option>
              {multiSite
                ? [...new Set(warehouses.map((w) => w.siteName))].map((site) => (
                  <optgroup key={site} label={site}>{warehouses.filter((w) => w.siteName === site && w.id !== form.warehouseId).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</optgroup>))
                : warehouses.filter((w) => w.id !== form.warehouseId).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
            </select>
            {interSite && <span className="small" style={{ fontWeight: 600, color: 'var(--accent)' }}>Transfert inter-sites : {interSite}</span>}
            {warehouses.length < 2 && <span className="small muted" style={{ fontWeight: 400 }}>Un seul entrepôt : <Link href="/app/stocks/entrepots">créez-en un autre</Link>.</span>}</label>}
          {reasons && <label className="field">Motif
            <select className="input" disabled={!editable} value={form.reason} onChange={set('reason')}>
              {Object.entries(reasons).filter(([k]) => k !== 'cash_purchase' || can('cash.create')).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>}
          <Field label="Date" type="date" required max={today()} disabled={!editable} value={form.date} onChange={set('date')} />
          {cashPurchase && <label className="field">Payé depuis
            <select className="input" required disabled={!editable} value={form.treasuryAccountId} onChange={set('treasuryAccountId')}>
              <option value="">— Caisse, banque ou mobile money —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({ACCOUNT_KINDS[a.kind]}) — solde {money(a.balance)}</option>)}
            </select></label>}
          {reasons && <label className="field">{type === 'receipt' ? 'Fournisseur (facultatif)' : 'Bénéficiaire (facultatif)'}
            <select className="input" disabled={!editable} value={form.contactId} onChange={set('contactId')}>
              <option value="">—</option>
              {contacts.filter((c) => type === 'issue' || c.kind !== 'customer').map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select></label>}
          {!isInventory && <Field label="Référence (facultatif)" disabled={!editable} placeholder={cashPurchase ? 'Ex. n° du reçu' : 'Ex. bon de livraison'} value={form.reference} onChange={set('reference')} />}
        </div>
        {cashPurchase && <Alert kind="info">À la validation : entrée en stock au prix payé, sortie d'argent du compte choisi et écriture comptable D 601000 / C trésorerie. Pour un achat avec facture, passez plutôt par Achats.</Alert>}

        {isInventory && <div className="row no-print" style={{ justifyContent: 'space-between' }}>
          <span className="small muted">{counted} article(s) compté(s) sur {lines.length}. Les articles non comptés ne sont pas modifiés.</span>
          <div className="row">
            <input className="input" placeholder="Filtrer les articles…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
            {editable && <button type="button" className="btn sm" onClick={() => setLines(lines.map((l) => (l.quantity === '' ? { ...l, quantity: String(doc.lines.find((x: any) => x.productId === l.productId)?.expected ?? 0) } : l)))}>
              Reporter le théorique sur les non comptés</button>}
          </div>
        </div>}
        {isInventory && <h2 className="print-only">Feuille de comptage — {wName(form.warehouseId)} — {date(form.date)}</h2>}

        <div className="table-wrap"><table className="lines">
          <thead>{isInventory
            ? <tr><th>Article</th><th className="n">Théorique</th><th className="n">Compté</th><th className="n">Écart</th><th className="n no-print">Valeur de l'écart</th></tr>
            : <tr><th style={{ minWidth: 220 }}>Article</th><th className="n">{type === 'receipt' ? 'En stock' : 'Disponible'}</th><th className="n">Quantité</th>
              <th className="n">{type === 'receipt' ? 'Coût unitaire HT' : 'Coût moyen'}</th><th className="n">Valeur</th><th>Note</th><th /></tr>}</thead>
          <tbody>
            {shown.map(({ l, i }) => {
              const p = stock[l.productId] ?? doc?.lines.find((x: any) => x.productId === l.productId) ?? {};
              if (isInventory) {
                const expected = doc.lines.find((x: any) => x.productId === l.productId)?.expected ?? 0;
                const diff = l.quantity === '' ? null : Number(l.quantity) - expected;
                return (
                  <tr key={l.productId}>
                    <td><b>{p.name}</b> <span className="small muted">{p.code}</span></td>
                    <td className="n">{qty(expected)} {p.unit}</td>
                    <td className="n"><input className="input n" type="number" min="0" step="any" disabled={!editable} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={`Quantité comptée ${p.name}`} style={{ width: 100 }} /></td>
                    <td className="n" style={{ color: diff && diff < 0 ? 'var(--crit)' : diff && diff > 0 ? 'var(--ok)' : undefined }}>{diff === null ? '' : diff === 0 ? '—' : `${diff > 0 ? '+' : ''}${qty(diff)}`}</td>
                    <td className="n no-print">{diff ? money(lineValue(l)) : ''}</td>
                  </tr>
                );
              }
              const short = type !== 'receipt' && Number(l.quantity || 0) > (p.quantity ?? 0);
              return (
                <tr key={i}>
                  <td><select className="input" required disabled={!editable} value={l.productId} onChange={(e) => {
                    const np = stock[e.target.value];
                    setLine(i, { productId: e.target.value, ...(type === 'receipt' && !l.unitCost && np ? { unitCost: String(np.purchasePrice ?? np.avgCost ?? '') } : {}) });
                  }} aria-label={`Article ligne ${i + 1}`}>
                    <option value="">— Choisir un article —</option>
                    {products.filter((x) => x.id === l.productId || !lines.some((o) => o.productId === x.id)).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
                  </select></td>
                  <td className="n" style={{ whiteSpace: 'nowrap', color: short ? 'var(--crit)' : undefined }}>{l.productId ? `${qty(p.quantity ?? 0)} ${p.unit ?? ''}` : ''}</td>
                  <td className="n"><input className="input n" type="number" min="0.001" step="any" required disabled={!editable} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={`Quantité ligne ${i + 1}`} style={{ width: 90 }} /></td>
                  <td className="n">{type === 'receipt'
                    ? <input className="input n" type="number" min="0" step="any" required={cashPurchase} disabled={!editable} placeholder={p.avgCost ? `CMUP ${p.avgCost}` : ''} value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} aria-label={`Coût unitaire ligne ${i + 1}`} style={{ width: 120 }} />
                    : money(p.avgCost ?? 0)}</td>
                  <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(lineValue(l))}</td>
                  <td><input className="input" disabled={!editable} value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} aria-label={`Note ligne ${i + 1}`} /></td>
                  <td>{editable && <button type="button" className="btn sm danger" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Supprimer la ligne ${i + 1}`}>✕</button>}</td>
                </tr>
              );
            })}
            {!lines.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>{isInventory ? 'Aucun article suivi en stock.' : 'Ajoutez les articles concernés.'}</td></tr>}
          </tbody>
        </table></div>

        <div className="row no-print" style={{ justifyContent: 'space-between' }}>
          {!isInventory && editable ? <button type="button" className="btn" disabled={!unused.length} onClick={() => setLines([...lines, { productId: '', quantity: '', unitCost: '', note: '' }])}>+ Ajouter un article</button> : <span />}
          <div><span className="muted small">{isInventory ? 'Écart estimé ' : 'Valeur estimée '}</span><b>{money(total)}</b></div>
        </div>
        <label className="field no-print">Notes (facultatif)<textarea className="input" rows={2} disabled={!editable} value={form.notes} onChange={set('notes')} /></label>
        {writable && <div className="row no-print">
          {editable && <button className="btn" disabled={busy}>{doc ? 'Enregistrer le brouillon' : 'Créer le brouillon'}</button>}
          {doc && can('stock.validate') && <button type="button" className="btn primary" disabled={busy || (isInventory ? !counted : !lines.length)} onClick={() => {
            if (confirm(isInventory ? `Valider l'inventaire ? Les ${counted} article(s) compté(s) seront ajustés au stock compté.` : (doc.number ? `Valider de nouveau le bon ${doc.number} ? Le stock sera mis à jour.` : 'Valider ce bon ? Le stock sera mis à jour. Pour le corriger ensuite, il faudra le remettre en brouillon.'))) validate();
          }}>{isInventory ? "Valider l'inventaire" : 'Valider le bon'}</button>}
          {doc && !doc.number && can('stock.cancel') && <button type="button" className="btn danger" disabled={busy} onClick={remove}>Supprimer le brouillon</button>}
        </div>}
      </form>
    </>
  );
}
