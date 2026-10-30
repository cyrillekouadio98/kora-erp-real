'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, DOC_LABEL, DOC_STATUS, money, PAYMENT_METHODS } from '@/lib/format';
import { useSession } from '@/components/session';
import { SalesEditor } from '@/components/sales-editor';
import { Alert, Field, Pill, useAction } from '@/components/ui';

export default function SalesDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, ctx } = useSession();
  const [doc, setDoc] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const { busy, error, run } = useAction();
  const writable = !ctx?.readOnly;

  const load = useCallback(() => run(async () => setDoc(await api(`/company/sales/documents/${id}`))), [id]); // eslint-disable-line
  useEffect(() => { load(); api('/company').then(setCompany, () => {}); }, [load]);

  if (!doc) return <Alert>{error || null}</Alert>;
  const isInvoice = doc.type === 'invoice';
  const listHref = isInvoice ? '/app/ventes/factures' : '/app/ventes/devis';
  const act = (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    run(async () => {
      const r = await api(`/company/sales/documents/${id}/${path}`, { body: {} });
      if (r.id !== doc.id) router.push(`/app/ventes/${r.id}`); else setDoc(r);
    });
  };
  const status = DOC_STATUS[doc.status];

  return (
    <>
      <div className="page-head no-print">
        <div><Link href={listHref} className="small">← {isInvoice ? 'Factures' : 'Devis'}</Link>
          <h1>{DOC_LABEL[doc.type as 'quote' | 'invoice']} {doc.number ?? '(brouillon)'} <Pill tone={status[1]}>{status[0]}</Pill></h1></div>
        <div className="row">
          {doc.status === 'draft' && writable && can('sales.cancel') && <button className="btn danger" disabled={busy} onClick={() => {
            if (window.confirm('Supprimer ce brouillon ?')) run(async () => { await api(`/company/sales/documents/${id}`, { method: 'DELETE' }); router.replace(listHref); });
          }}>Supprimer</button>}
          {doc.status === 'draft' && writable && can('sales.validate') && <button className="btn primary" disabled={busy}
            onClick={() => act('validate', isInvoice ? 'Émettre la facture ? Elle recevra son numéro définitif et ne pourra plus être modifiée.' : 'Valider le devis ? Il recevra son numéro et ne pourra plus être modifié.')}>
            {isInvoice ? 'Émettre la facture' : 'Valider le devis'}</button>}
          {doc.type === 'quote' && doc.status === 'sent' && writable && can('sales.validate') && <>
            <button className="btn" disabled={busy} onClick={() => act('refuse')}>Refusé par le client</button>
            <button className="btn" disabled={busy} onClick={() => act('accept')}>Accepté par le client</button></>}
          {doc.type === 'quote' && ['sent', 'accepted'].includes(doc.status) && writable && can('sales.create') &&
            <button className="btn primary" disabled={busy} onClick={() => act('convert')}>Transformer en facture</button>}
          {isInvoice && ['issued', 'partially_paid'].includes(doc.status) && writable && can('cash.create') &&
            <button className="btn primary" onClick={() => setPay({ amount: doc.remaining, method: 'cash', paidOn: new Date().toISOString().slice(0, 10), reference: '' })}>Enregistrer un encaissement</button>}
          {doc.status !== 'draft' && <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button>}
        </div>
      </div>
      <Alert>{!pay && error}</Alert>
      {doc.related?.map((r: any) => <Alert key={r.id} kind="info">{r.type === 'quote' ? 'Établie à partir du devis' : 'Facturé par'} <Link href={`/app/ventes/${r.id}`}>{r.number ?? 'brouillon de facture'}</Link>.</Alert>)}

      {doc.status === 'draft' && writable && can('sales.update')
        ? <SalesEditor type={doc.type} doc={doc} onSaved={setDoc} />
        : (
          <article className="card doc">
            <header className="doc-head">
              <div><div className="doc-company">{company?.name}</div>
                <div className="small muted">{[company?.address, company?.city].filter(Boolean).join(', ')}{company?.phone ? ` · ${company.phone}` : ''}</div>
                <div className="small muted">{[company?.rccm && `RCCM ${company.rccm}`, company?.tax_id && `NCC ${company.tax_id}`, company?.tax_regime].filter(Boolean).join(' · ')}</div></div>
              <div style={{ textAlign: 'right' }}><div className="doc-title">{DOC_LABEL[doc.type as 'quote' | 'invoice']}</div>
                <div><b>{doc.number ?? 'Brouillon'}</b></div><div className="small">du {date(doc.issueDate)}</div>
                <div className="small">{isInvoice ? `Échéance : ${date(doc.dueDate)}` : `Valable jusqu'au ${date(doc.validUntil)}`}</div></div>
            </header>
            <div className="doc-customer"><div className="small muted">Client</div><b>{doc.customer.name}</b>
              <div className="small">{[doc.customer.address, doc.customer.city].filter(Boolean).join(', ')}</div>
              <div className="small">{[doc.customer.taxId && `NCC ${doc.customer.taxId}`, doc.customer.rccm && `RCCM ${doc.customer.rccm}`].filter(Boolean).join(' · ')}</div></div>
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
                {isInvoice && doc.paidAmount > 0 && <><dt>Déjà réglé</dt><dd>{money(doc.paidAmount)}</dd><dt className="grand">Reste à payer</dt><dd className="grand">{money(doc.remaining)}</dd></>}</dl>
            </div>
            {doc.notes && <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{doc.notes}</p>}
          </article>
        )}

      {isInvoice && doc.payments.length > 0 && (
        <div className="card no-print"><header><h2>Encaissements</h2></header>
          <div className="table-wrap"><table><tbody>{doc.payments.map((p: any) => (
            <tr key={p.id}><td>{date(p.paidOn)}</td><td>{PAYMENT_METHODS[p.method]}</td><td className="small muted">{p.reference}</td><td className="n">{money(p.amount)}</td></tr>))}</tbody></table></div>
        </div>
      )}

      {pay && (
        <div className="modal-back" onClick={() => setPay(null)}>
          <form className="modal" style={{ width: 'min(460px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { setDoc(await api(`/company/sales/documents/${id}/payments`, { body: { ...pay, amount: Number(pay.amount), reference: pay.reference || null } })); setPay(null); });
          }}>
            <h2>Encaissement — {doc.number}</h2>
            <p className="small muted" style={{ margin: 0 }}>Reste à payer : <b>{money(doc.remaining)}</b></p>
            <Alert>{error}</Alert>
            <Field label="Montant (FCFA)" type="number" min={1} max={doc.remaining} required value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            <label className="field">Mode de paiement
              <select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <Field label="Date" type="date" required max={new Date().toISOString().slice(0, 10)} value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} />
            <Field label="Référence (n° de transaction, de chèque…)" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setPay(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
