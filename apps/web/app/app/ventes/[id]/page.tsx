'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, dateTime, DOC_LABEL, docStatus, DocType, money, PAYMENT_METHODS, REMINDER_CHANNELS } from '@/lib/format';
import { useSession } from '@/components/session';
import { SalesEditor } from '@/components/sales-editor';
import { Alert, Field, Pill, useAction } from '@/components/ui';
import { AccountSelect } from '@/components/account-select';

const LIST_HREF: Record<DocType, [string, string]> = { quote: ['/app/ventes/devis', 'Devis'], invoice: ['/app/ventes/factures', 'Factures'], credit_note: ['/app/ventes/avoirs', 'Avoirs'] };

/** Phrase reliant le document affiché à un document lié (devis d'origine, facture, avoirs). */
function relation(doc: any, r: any) {
  if (doc.type === 'invoice' && r.type === 'quote') return 'Établie à partir du devis';
  if (doc.type === 'quote') return 'Facturé par';
  if (doc.type === 'invoice' && r.type === 'credit_note') return `Avoir de ${money(r.totalTtc)} :`;
  return 'Avoir sur la facture';
}

/** Message de relance prêt à copier (WhatsApp, SMS, e-mail). */
function reminderText(doc: any, company: any) {
  const late = doc.dueDate && doc.dueDate < new Date().toISOString().slice(0, 10);
  return `Bonjour ${doc.customer.name},\n\nSauf erreur de notre part, la facture ${doc.number} du ${date(doc.issueDate)}${late ? `, arrivée à échéance le ${date(doc.dueDate)},` : ''} présente un reste à payer de ${money(doc.remaining)}.\n\nMerci de bien vouloir procéder à son règlement ou de nous indiquer la date prévue. Si le paiement a déjà été effectué, veuillez ne pas tenir compte de ce message.\n\nCordialement,\n${company?.name ?? ''}`;
}

export default function SalesDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, ctx } = useSession();
  const [doc, setDoc] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [rem, setRem] = useState<any>(null);
  const [refund, setRefund] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { busy, error, run } = useAction();
  const writable = !ctx?.readOnly;

  const load = useCallback(() => run(async () => setDoc(await api(`/company/sales/documents/${id}`))), [id]); // eslint-disable-line
  useEffect(() => { load(); api('/company').then(setCompany, () => {}); }, [load]);

  if (!doc) return <Alert>{error || null}</Alert>;
  const type = doc.type as DocType;
  const isInvoice = type === 'invoice';
  const isCredit = type === 'credit_note';
  const isOpen = isInvoice && ['issued', 'partially_paid'].includes(doc.status);
  const [listHref, listLabel] = LIST_HREF[type];
  const act = (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    run(async () => {
      const r = await api(`/company/sales/documents/${id}/${path}`, { body: {} });
      if (r.id !== doc.id) router.push(`/app/ventes/${r.id}`); else setDoc(r);
    });
  };
  const status = docStatus(type, doc.status);
  const validateText = { invoice: 'Émettre la facture ? Elle recevra son numéro définitif et ne pourra plus être modifiée.', quote: 'Valider le devis ? Il recevra son numéro et ne pourra plus être modifié.', credit_note: "Émettre l'avoir ? Il diminuera le reste à payer de la facture d'origine et ne pourra plus être modifié." }[type];
  const validateLabel = { invoice: 'Émettre la facture', quote: 'Valider le devis', credit_note: "Émettre l'avoir" }[type];

  return (
    <>
      <div className="page-head no-print">
        <div><Link href={listHref} className="small">← {listLabel}</Link>
          <h1>{DOC_LABEL[type]} {doc.number ?? '(brouillon)'} <Pill tone={status[1]}>{status[0]}</Pill></h1></div>
        <div className="row">
          {doc.status === 'draft' && writable && can('sales.cancel') && <button className="btn danger" disabled={busy} onClick={() => {
            if (window.confirm('Supprimer ce brouillon ?')) run(async () => { await api(`/company/sales/documents/${id}`, { method: 'DELETE' }); router.replace(listHref); });
          }}>Supprimer</button>}
          {doc.status === 'draft' && writable && can('sales.validate') && <button className="btn primary" disabled={busy || dirty}
            title={dirty ? 'Enregistrez d\u2019abord le brouillon' : undefined} onClick={() => act('validate', validateText)}>{validateLabel}</button>}
          {type === 'quote' && doc.status === 'sent' && writable && can('sales.validate') && <>
            <button className="btn" disabled={busy} onClick={() => act('refuse')}>Refusé par le client</button>
            <button className="btn" disabled={busy} onClick={() => act('accept')}>Accepté par le client</button></>}
          {type === 'quote' && ['sent', 'accepted'].includes(doc.status) && writable && can('sales.create') &&
            <button className="btn primary" disabled={busy} onClick={() => act('convert')}>Transformer en facture</button>}
          {isInvoice && ['issued', 'partially_paid', 'paid'].includes(doc.status) && writable && can('sales.create') &&
            <button className="btn" disabled={busy} onClick={() => act('credit-note')}>Établir un avoir</button>}
          {isOpen && writable && can('sales.update') && <button className="btn" onClick={() => { setCopied(false); setRem({ channel: 'whatsapp', note: '', promisedOn: '' }); }}>Relancer</button>}
          {isOpen && writable && can('cash.create') &&
            <button className="btn primary" onClick={() => setPay({ amount: doc.remaining, method: 'cash', paidOn: new Date().toISOString().slice(0, 10), reference: '' })}>Enregistrer un encaissement</button>}
          {doc.status !== 'draft' && <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button>}
        </div>
      </div>
      <Alert>{!pay && !rem && !refund && error}</Alert>
      {dirty && <Alert kind="warn">Modifications non enregistrées : enregistrez le brouillon avant de le valider.</Alert>}
      {doc.related?.map((r: any) => <Alert key={r.id} kind="info">{relation(doc, r)} <Link href={`/app/ventes/${r.id}`}>{r.number ?? 'brouillon'}</Link>{r.status === 'draft' ? ' (brouillon à émettre)' : ''}.</Alert>)}
      {doc.refundDue > 0 && <Alert kind="warn">Le client a payé <b>{money(doc.refundDue)}</b> de plus que ce qu'il doit après avoir : ce trop-perçu est à lui rembourser.
        {writable && can('cash.create') && <> <button className="btn sm" onClick={() => setRefund({ amount: doc.refundDue, method: 'bank_transfer', accountId: '', paidOn: new Date().toISOString().slice(0, 10), reference: '' })}>Rembourser le client</button></>}</Alert>}

      {doc.status === 'draft' && writable && can('sales.update')
        ? <SalesEditor key={doc.id} type={type} doc={doc} onSaved={setDoc} onDirtyChange={setDirty} />
        : (
          <article className="card doc">
            <header className="doc-head">
              <div><div className="doc-company">{company?.name}</div>
                <div className="small muted">{[company?.address, company?.city].filter(Boolean).join(', ')}{company?.phone ? ` · ${company.phone}` : ''}</div>
                <div className="small muted">{[company?.rccm && `RCCM ${company.rccm}`, company?.tax_id && `NCC ${company.tax_id}`, company?.tax_regime].filter(Boolean).join(' · ')}</div></div>
              <div style={{ textAlign: 'right' }}><div className="doc-title">{DOC_LABEL[type]}</div>
                <div><b>{doc.number ?? 'Brouillon'}</b></div><div className="small">du {date(doc.issueDate)}</div>
                {isInvoice && <div className="small">Échéance : {date(doc.dueDate)}</div>}
                {type === 'quote' && <div className="small">Valable jusqu'au {date(doc.validUntil)}</div>}
                {isCredit && doc.related?.[0] && <div className="small">Sur la facture {doc.related[0].number}</div>}</div>
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
                {isInvoice && doc.creditedAmount > 0 && <><dt>Avoirs</dt><dd>− {money(doc.creditedAmount)}</dd></>}
                {isInvoice && doc.paidAmount > 0 && <><dt>Déjà réglé</dt><dd>− {money(doc.paidAmount)}</dd></>}
                {isInvoice && (doc.paidAmount > 0 || doc.creditedAmount > 0) && <><dt className="grand">Reste à payer</dt><dd className="grand">{money(doc.remaining)}</dd></>}</dl>
            </div>
            {doc.notes && <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{doc.notes}</p>}
          </article>
        )}

      {isInvoice && doc.payments.length > 0 && (
        <div className="card no-print"><header><h2>Encaissements</h2></header>
          <div className="table-wrap"><table><tbody>{doc.payments.map((p: any) => (
            <tr key={p.id}><td>{date(p.paidOn)}</td><td>{PAYMENT_METHODS[p.method]}{p.accountName && <div className="small muted">{p.accountName}</div>}</td><td className="small muted">{p.reference}</td><td className="n">{money(p.amount)}</td></tr>))}</tbody></table></div>
        </div>
      )}

      {isInvoice && doc.refunds?.length > 0 && (
        <div className="card no-print"><header><h2>Remboursements au client</h2></header>
          <div className="table-wrap"><table><tbody>{doc.refunds.map((r: any) => (
            <tr key={r.id}><td>{date(r.date)}</td><td>{r.accountName}</td><td className="small muted">{r.reference}</td><td className="n">− {money(r.amount)}</td></tr>))}</tbody></table></div>
        </div>
      )}

      {refund && (
        <div className="modal-back" onClick={() => setRefund(null)}>
          <form className="modal" style={{ width: 'min(460px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { setDoc(await api(`/company/sales/documents/${id}/refunds`, { body: { ...refund, amount: Number(refund.amount), reference: refund.reference || null, accountId: refund.accountId || null } })); setRefund(null); });
          }}>
            <h2>Rembourser {doc.customer.name}</h2>
            <p className="small muted" style={{ margin: 0 }}>Trop-perçu sur {doc.number} : <b>{money(doc.refundDue)}</b></p>
            <Alert>{error}</Alert>
            <Field label="Montant remboursé (FCFA)" type="number" min={1} max={doc.refundDue} required value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
            <label className="field">Mode de remboursement
              <select className="input" value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <AccountSelect method={refund.method} value={refund.accountId} onChange={(v) => setRefund({ ...refund, accountId: v })} label="Payé depuis" />
            <Field label="Date" type="date" required max={new Date().toISOString().slice(0, 10)} value={refund.paidOn} onChange={(e) => setRefund({ ...refund, paidOn: e.target.value })} />
            <Field label="Référence (n° de virement, de chèque…)" value={refund.reference} onChange={(e) => setRefund({ ...refund, reference: e.target.value })} />
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setRefund(null)}>Annuler</button></div>
          </form>
        </div>
      )}

      {isInvoice && doc.reminders.length > 0 && (
        <div className="card no-print"><header><h2>Relances</h2><span className="small muted">{doc.reminders.length} relance{doc.reminders.length > 1 ? 's' : ''}</span></header>
          <div className="table-wrap"><table><tbody>{doc.reminders.map((r: any) => (
            <tr key={r.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{dateTime(r.createdAt)}</td><td>{REMINDER_CHANNELS[r.channel]}</td>
              <td className="small">{r.note}{r.promisedOn && <> <Pill tone="warn">Paiement promis le {date(r.promisedOn)}</Pill></>}</td><td className="small muted">{r.by}</td></tr>))}</tbody></table></div>
        </div>
      )}

      {pay && (
        <div className="modal-back" onClick={() => setPay(null)}>
          <form className="modal" style={{ width: 'min(460px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { setDoc(await api(`/company/sales/documents/${id}/payments`, { body: { ...pay, amount: Number(pay.amount), reference: pay.reference || null, accountId: pay.accountId || null } })); setPay(null); });
          }}>
            <h2>Encaissement — {doc.number}</h2>
            <p className="small muted" style={{ margin: 0 }}>Reste à payer : <b>{money(doc.remaining)}</b></p>
            <Alert>{error}</Alert>
            <Field label="Montant (FCFA)" type="number" min={1} max={doc.remaining} required value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            <label className="field">Mode de paiement
              <select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <AccountSelect method={pay.method} value={pay.accountId ?? ''} onChange={(v) => setPay({ ...pay, accountId: v })} />
            <Field label="Date" type="date" required max={new Date().toISOString().slice(0, 10)} value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} />
            <Field label="Référence (n° de transaction, de chèque…)" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setPay(null)}>Annuler</button></div>
          </form>
        </div>
      )}

      {rem && (
        <div className="modal-back" onClick={() => setRem(null)}>
          <form className="modal" style={{ width: 'min(560px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => { setDoc(await api(`/company/sales/documents/${id}/reminders`, { body: { channel: rem.channel, note: rem.note || null, promisedOn: rem.promisedOn || null } })); setRem(null); });
          }}>
            <h2>Relancer {doc.customer.name}</h2>
            <p className="small muted" style={{ margin: 0 }}>Facture {doc.number} · reste à payer <b>{money(doc.remaining)}</b>{doc.contact.phone ? ` · ${doc.contact.phone}` : ''}{doc.contact.email ? ` · ${doc.contact.email}` : ''}</p>
            <Alert>{error}</Alert>
            <label className="field">Message proposé (à copier dans WhatsApp, un SMS ou un e-mail)
              <textarea className="input" rows={8} readOnly value={reminderText(doc, company)} />
            </label>
            <div><button type="button" className="btn sm" onClick={() => navigator.clipboard.writeText(reminderText(doc, company)).then(() => setCopied(true))}>{copied ? 'Copié ✓' : 'Copier le message'}</button></div>
            <div className="grid2">
              <label className="field">Moyen utilisé
                <select className="input" value={rem.channel} onChange={(e) => setRem({ ...rem, channel: e.target.value })}>{Object.entries(REMINDER_CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <Field label="Paiement promis le (facultatif)" type="date" min={new Date().toISOString().slice(0, 10)} value={rem.promisedOn} onChange={(e) => setRem({ ...rem, promisedOn: e.target.value })} />
            </div>
            <Field label="Compte rendu (facultatif)" placeholder="Ex. : la comptable confirme un virement vendredi" value={rem.note} onChange={(e) => setRem({ ...rem, note: e.target.value })} />
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer la relance</button><button type="button" className="btn" onClick={() => setRem(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
