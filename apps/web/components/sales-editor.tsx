'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { DOC_LABEL, money, PURCHASE_LABEL, VAT_RATES } from '@/lib/format';
import { Alert, Field, useAction } from '@/components/ui';

interface Line { productId: string | null; description: string; quantity: number | string; unit: string | null; unitPrice: number | string; discountPct: number | string; vatRate: number }
const EMPTY_LINE: Line = { productId: null, description: '', quantity: 1, unit: null, unitPrice: 0, discountPct: 0, vatRate: 18 };
/** Ne garde que les champs saisissables d'une ligne (l'API refuse les champs calculés comme totalHt). */
const toLine = (l: any): Line => ({ productId: l.productId ?? null, description: l.description ?? '', quantity: l.quantity ?? 1, unit: l.unit ?? null, unitPrice: l.unitPrice ?? 0, discountPct: l.discountPct ?? 0, vatRate: l.vatRate ?? 18 });

/** Même règle que l'API : chaque ligne arrondie au franc, puis additionnée. */
function lineTotals(l: Line) {
  const ht = Math.round(Number(l.quantity || 0) * Number(l.unitPrice || 0) * (1 - Number(l.discountPct || 0) / 100));
  return { ht, vat: Math.round((ht * l.vatRate) / 100) };
}

/** Ce qui distingue la saisie d'un document de vente de celle d'un document d'achat. */
const SCOPES = {
  sales: {
    base: '/company/sales/documents', party: 'client', excludeKind: 'supplier', labels: DOC_LABEL as Record<string, string>,
    price: (p: any) => p.salePrice, newTitle: (t: string) => (t === 'invoice' ? 'Nouvelle facture' : 'Nouveau devis'),
  },
  purchases: {
    base: '/company/purchases/documents', party: 'fournisseur', excludeKind: 'customer', labels: PURCHASE_LABEL as Record<string, string>,
    price: (p: any) => p.purchasePrice ?? 0, newTitle: (t: string) => (t === 'invoice' ? 'Nouvelle facture fournisseur' : 'Nouveau bon de commande'),
  },
};
const today = () => new Date().toISOString().slice(0, 10);

/** Saisie d'un brouillon (devis, facture, avoir, bon de commande, facture fournisseur), en création ou modification. */
export function SalesEditor({ type, doc, onSaved, onDirtyChange, scope = 'sales' }: { type: string; doc?: any; onSaved: (doc: any) => void; onDirtyChange?: (dirty: boolean) => void; scope?: keyof typeof SCOPES }) {
  const cfg = SCOPES[scope];
  const isCredit = type === 'credit_note';
  const isPurchaseInvoice = scope === 'purchases' && type === 'invoice';
  // Date limite propre au document : échéance (facture), validité (devis), livraison prévue (commande)
  const limitKey = type === 'invoice' ? 'dueDate' : type === 'quote' ? 'validUntil' : type === 'order' ? 'expectedDate' : null;
  const [contacts, setContacts] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [contactId, setContactId] = useState<string>(doc?.contact?.id ?? '');
  const [notes, setNotes] = useState<string>(doc?.notes ?? '');
  const [limitDate, setLimitDate] = useState<string>((limitKey && doc?.[limitKey]) ?? '');
  const [supplierRef, setSupplierRef] = useState<string>(doc?.supplierRef ?? '');
  const [issueDate, setIssueDate] = useState<string>(doc?.issueDate ?? today());
  const [lines, setLines] = useState<Line[]>(doc?.lines?.length ? doc.lines.map(toLine) : [{ ...EMPTY_LINE }]);
  const [restock, setRestock] = useState<boolean>(doc?.restock ?? true);
  const [dirty, setDirty] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]); // eslint-disable-line

  useEffect(() => {
    api('/company/contacts').then((c) => setContacts(c.filter((x: any) => x.kind !== cfg.excludeKind)), () => {});
    api('/company/products').then(setProducts, () => {});
  }, [cfg.excludeKind]);

  const editLines = (next: Line[]) => { setDirty(true); setLines(next); };
  const setLine = (i: number, patch: Partial<Line>) => editLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickProduct = (i: number, id: string) => {
    const p = products.find((x) => x.id === id);
    setLine(i, p ? { productId: p.id, description: p.name, unit: p.unit, unitPrice: cfg.price(p), vatRate: p.vatRate } : { productId: null });
  };
  const totals = lines.map(lineTotals);
  const ht = totals.reduce((s, t) => s + t.ht, 0);
  const vat = totals.reduce((s, t) => s + t.vat, 0);

  const save = () => run(async () => {
    const body: any = {
      contactId, notes: notes || null,
      lines: lines.map(toLine).map((l) => ({ ...l, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct || 0), unit: l.unit || null })),
      ...(limitKey ? { [limitKey]: limitDate || null } : {}),
      ...(isPurchaseInvoice ? { supplierRef: supplierRef || null, issueDate } : {}),
      ...(isCredit ? { restock } : {}),
    };
    const saved = doc ? await api(`${cfg.base}/${doc.id}`, { method: 'PATCH', body }) : await api(cfg.base, { body: { ...body, type } });
    setDirty(false);
    onSaved(saved);
  });

  const limitLabel = {
    dueDate: `Échéance (vide : selon le délai de paiement du ${cfg.party})`, validUntil: 'Valable jusqu’au (vide : 30 jours)', expectedDate: 'Livraison prévue le (facultatif)',
  }[limitKey ?? 'dueDate'];
  const Party = cfg.party[0].toUpperCase() + cfg.party.slice(1);

  return (
    <form className="card form" onChange={() => setDirty(true)} onSubmit={(e) => { e.preventDefault(); save(); }}>
      <header><h2>{doc ? `${cfg.labels[type]} — brouillon` : cfg.newTitle(type)}</h2>
        <span className="small muted">{isCredit ? 'Réduisez les quantités ou les prix pour un avoir partiel.' : isPurchaseInvoice ? 'Recopiez la facture reçue du fournisseur.' : 'Le numéro définitif est attribué à la validation.'}</span></header>
      <Alert>{error}</Alert>
      <div className="grid2">
        <label className="field">{Party}
          <select className="input" required disabled={isCredit} value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">— Choisir un {cfg.party} —</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
          {!contacts.length && <span className="small muted" style={{ fontWeight: 400 }}>Aucun {cfg.party} : <Link href="/app/contacts">créez-en un d'abord</Link>.</span>}
        </label>
        {isPurchaseInvoice && <Field label="N° de la facture du fournisseur (obligatoire pour valider)" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} placeholder="Ex. FV-2026/118" />}
        {isPurchaseInvoice && <Field label="Date de la facture du fournisseur" type="date" required max={today()} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}
        {limitKey && <label className="field">{limitLabel}
          <input className="input" type="date" value={limitDate} onChange={(e) => setLimitDate(e.target.value)} />
        </label>}
      </div>

      <div className="table-wrap"><table className="lines">
        <thead><tr><th style={{ minWidth: 170 }}>Article</th><th style={{ minWidth: 200 }}>Désignation</th><th className="n">Qté</th><th className="n">Prix unit. HT</th><th className="n">Remise %</th><th>TVA</th><th className="n">Total HT</th><th></th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><select className="input" value={l.productId ?? ''} onChange={(e) => pickProduct(i, e.target.value)} aria-label={`Article ligne ${i + 1}`}>
                <option value="">Saisie libre</option>{products.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}{p.trackStock ? ` (stock : ${p.stockQty.toLocaleString('fr-FR')})` : ''}</option>)}
              </select></td>
              <td><input className="input" required value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label={`Désignation ligne ${i + 1}`} /></td>
              <td><input className="input n" type="number" min="0.001" step="any" required value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={`Quantité ligne ${i + 1}`} style={{ width: 80 }} /></td>
              <td><input className="input n" type="number" min="0" step="any" required value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} aria-label={`Prix ligne ${i + 1}`} style={{ width: 120 }} /></td>
              <td><input className="input n" type="number" min="0" max="100" step="any" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} aria-label={`Remise ligne ${i + 1}`} style={{ width: 70 }} /></td>
              <td><select className="input" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) })} aria-label={`TVA ligne ${i + 1}`} style={{ minWidth: 78 }}>{VAT_RATES.map((r) => <option key={r} value={r}>{r} %</option>)}</select></td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(totals[i].ht)}</td>
              <td>{lines.length > 1 && <button type="button" className="btn sm danger" onClick={() => editLines(lines.filter((_, j) => j !== i))} aria-label={`Supprimer la ligne ${i + 1}`}>✕</button>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <button type="button" className="btn" onClick={() => editLines([...lines, { ...EMPTY_LINE }])}>+ Ajouter une ligne</button>
        <dl className="totals"><dt>Total HT</dt><dd>{money(ht)}</dd><dt>TVA</dt><dd>{money(vat)}</dd><dt className="grand">Total TTC</dt><dd className="grand">{money(ht + vat)}</dd></dl>
      </div>
      {isCredit && <label className="row small"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
        Les marchandises de cet avoir reviennent en stock (décochez pour une simple remise de prix)</label>}
      <label className="field">{scope === 'purchases' ? 'Notes internes, conditions (facultatif)' : 'Conditions, mentions (facultatif)'}<textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="row"><button className="btn primary" disabled={busy || !contactId}>{busy ? 'Enregistrement…' : 'Enregistrer le brouillon'}</button></div>
    </form>
  );
}
