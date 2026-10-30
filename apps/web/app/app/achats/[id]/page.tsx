'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, money, PAYMENT_METHODS, PURCHASE_LABEL, PURCHASE_STATUS } from '@/lib/format';
import { useSession } from '@/components/session';
import { SalesEditor } from '@/components/sales-editor';
import { Alert, Field, Pill, useAction } from '@/components/ui';
import { AccountSelect } from '@/components/account-select';

export default function PurchaseDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, ctx } = useSession();
  const [doc, setDoc] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const { busy, error, run } = useAction();
  const writable = !ctx?.readOnly;

  const load = useCallback(() => run(async () => setDoc(await api(`/company/purchases/documents/${id}`))), [id]); // eslint-disable-line
  useEffect(() => { load(); api('/company').then(setCompany, () => {}); }, [load]);

  if (!doc) return <Alert>{error || null}</Alert>;
  const type = doc.type as 'order' | 'invoice';
  const isInvoice = type === 'invoice';
  const isOpen = isInvoice && ['to_pay', 'partially_paid'].includes(doc.status);
  const listHref = isInvoice ? '/app/achats/factures' : '/app/achats/commandes';
  const act = (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    run(async () => {
      const r = await api(`/company/purchases/documents/${id}/${path}`, { body: {} });
      if (r.id !== doc.id) router.push(`/app/achats/${r.id}`); else setDoc(r);
    });
  };
  const status = PURCHASE_STATUS[doc.status];

  return (
    <>
      <div className="page-head no-print">
        <div><Link href={listHref} className="small">← {isInvoice ? 'Factures fournisseurs' : 'Bons de commande'}</Link>
          <h1>{PURCHASE_LABEL[type]} {doc.number ?? '(brouillon)'} <Pill tone={status[1]}>{status[0]}</Pill></h1></div>
        <div className="row">
          {doc.status === 'draft' && writable && can('purchases.cancel') && <button className="btn danger" disabled={busy} onClick={() => {
            if (window.confirm('Supprimer ce brouillon ?')) run(async () => { await api(`/company/purchases/documents/${id}`, { method: 'DELETE' }); router.replace(listHref); });
          }}>Supprimer</button>}
          {doc.status === 'draft' && writable && can('purchases.validate') && <button className="btn primary" disabled={busy || dirty}
            title={dirty ? 'Enregistrez d’abord le brouillon' : undefined}
            onClick={() => act('validate', isInvoice ? 'Valider la facture fournisseur ? Elle sera enregistrée dans vos dettes et ne pourra plus être modifiée.' : 'Valider le bon de commande ? Il recevra son numéro et pourra être envoyé au fournisseur.')}>
            {isInvoice ? 'Valider la facture' : 'Valider le bon de commande'}</button>}
          {type === 'order' && doc.status === 'sent' && writable && can('purchases.cancel') && <button className="btn" disabled={busy} onClick={() => act('cancel', 'Annuler ce bon de commande ?')}>Annuler la commande</button>}
          {type === 'order' && doc.status === 'sent' && writable && can('purchases.create') && <button className="btn primary" disabled={busy} onClick={() => act('convert')}>Saisir la facture reçue</button>}
          {isOpen && writable && can('cash.create') &&
            <button className="btn primary" onClick={() => setPay({ amount: doc.remaining, method: 'bank_transfer', paidOn: new Date().toISOString().slice(0, 10), reference: '' })}>Enregistrer un règlement</button>}
          {doc.status !== 'draft' && <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button>}
        </div>
      </div>
      <Alert>{!pay && error}</Alert>
      {dirty && <Alert kind="warn">Modifications non enregistrées : enregistrez le brouillon avant de le valider.</Alert>}
      {doc.related?.map((r: any) => <Alert key={r.id} kind="info">{r.type === 'order' ? 'Établie à partir du bon de commande' : 'Facturé par'} <Link href={`/app/achats/${r.id}`}>{r.number ?? 'brouillon de facture'}</Link>.</Alert>)}

      {doc.status === 'draft' && writable && can('purchases.update')
        ? <SalesEditor key={doc.id} scope="purchases" type={type} doc={doc} onSaved={setDoc} onDirtyChange={setDirty} />
        : (
          <article className="card doc">
            <header className="doc-head">
              <div><div className="doc-company">{company?.name}</div>
                <div className="small muted">{[company?.address, company?.city].filter(Boolean).join(', ')}{company?.phone ? ` · ${company.phone}` : ''}</div>
                <div className="small muted">{[company?.rccm && `RCCM ${company.rccm}`, company?.tax_id && `NCC ${company.tax_id}`].filter(Boolean).join(' · ')}</div></div>
              <div style={{ textAlign: 'right' }}><div className="doc-title">{PURCHASE_LABEL[type]}</div>
                <div><b>{doc.number ?? 'Brouillon'}</b></div>
                {isInvoice ? <>
                  <div className="small">Réf. fournisseur : <b>{doc.supplierRef ?? '—'}</b> du {date(doc.issueDate)}</div>
                  <div className="small">Échéance : {date(doc.dueDate)}</div>
                </> : <>
                  <div className="small">du {date(doc.issueDate)}</div>
                  {doc.expectedDate && <div className="small">Livraison souhaitée le {date(doc.expectedDate)}</div>}
                </>}</div>
            </header>
            <div className="doc-customer"><div className="small muted">Fournisseur</div><b>{doc.supplier.name}</b>
              <div className="small">{[doc.supplier.address, doc.supplier.city].filter(Boolean).join(', ')}</div>
              <div className="small">{[doc.supplier.taxId && `NCC ${doc.supplier.taxId}`, doc.supplier.phone].filter(Boolean).join(' · ')}</div></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Désignation</th><th className="n">Qté</th><th className="n">Prix unit. HT</th><th className="n">Remise</th><th className="n">TVA</th><th className="n">Total HT</th></tr></thead>
              <tbody>{doc.lines.map((l: any) => (
                <tr key={l.id}><td>{l.description}</td><td className="n">{l.quantity.toLocaleString('fr-FR')}{l.unit ? ` ${l.unit}` : ''}</td><td className="n">{money(l.unitPrice)}</td>
                  <td className="n">{l.discountPct ? `${l.discountPct} %` : '—'}</td><td className="n">{l.vatRate} %</td><td className="n">{money(l.totalHt)}</td></tr>))}</tbody>
            </table></div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <table className="vat"><thead><tr><th>Taux</th><th className="n">Base HT</th><th className="n">TVA</th></tr></thead>
                <tbody>{doc.vatBreakdown.map((v: any) => <tr key={v.rate}><td>{v.rate} %</td><td className="n">{money(v.base)}</td><td className="n">{money(v.vat)}</td></tr>)}</tbody></table>
              <dl className="totals"><dt>Total HT</dt><dd>{money(doc.totalHt)}</dd><dt>TVA</dt><dd>{money(doc.totalVat)}</dd><dt className="grand">Total TTC</dt><dd className="grand">{money(doc.totalTtc)}</dd>
                {isInvoice && doc.paidAmount > 0 && <><dt>Déjà réglé</dt><dd>− {money(doc.paidAmount)}</dd><dt className="grand">Reste à payer</dt><dd className="grand">{money(doc.remaining)}</dd></>}</dl>
            </div>
            {doc.notes && <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{doc.notes}</p>}
          </article>
        )}

      {isInvoice && doc.payments.length > 0 && (
        <div className="card no-print"><header><h2>Règlements</h2></header>
          <div className="table-wrap"><table><tbody>{doc.payments.map((p: any) => (
            <tr key={p.id}><td>{date(p.paidOn)}</td><td>{PAYMENT_METHODS[p.method]}{p.accountName && <div className="small muted">{p.accountName}</div>}</td><td className="small muted">{p.reference}</td><td className="n">{money(p.amount)}</td></tr>))}</tbody></table></div>
        </div>
      )}

      {pay && (
        <div className="modal-back" onClick={() => setPay(null)}>
          <form className="modal" style={{ width: 'min(460px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { setDoc(await api(`/company/purchases/documents/${id}/payments`, { body: { ...pay, amount: Number(pay.amount), reference: pay.reference || null, accountId: pay.accountId || null } })); setPay(null); });
          }}>
            <h2>Règlement — {doc.number}</h2>
            <p className="small muted" style={{ margin: 0 }}>{doc.supplier.name} · reste à payer : <b>{money(doc.remaining)}</b></p>
            <Alert>{error}</Alert>
            <Field label="Montant (FCFA)" type="number" min={1} max={doc.remaining} required value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            <label className="field">Mode de paiement
              <select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <AccountSelect method={pay.method} value={pay.accountId ?? ''} onChange={(v) => setPay({ ...pay, accountId: v })} />
            <Field label="Date" type="date" required max={new Date().toISOString().slice(0, 10)} value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} />
            <Field label="Référence (n° de virement, de chèque…)" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setPay(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
