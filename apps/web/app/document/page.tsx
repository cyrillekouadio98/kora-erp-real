'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import { date, DOC_LABEL, money } from '@/lib/format';

/** Document consulté par son destinataire (lien reçu par e-mail), sans compte Kora. */
function PublicDocument() {
  const token = useSearchParams().get('token') ?? '';
  const [doc, setDoc] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/public/document?token=${encodeURIComponent(token)}`).then(setDoc, (e) => setError(e.status === 404 ? 'Ce lien est invalide ou a expiré. Demandez un nouvel envoi à votre fournisseur.' : errorMessage(e))); }, [token]);
  if (error) return <main className="auth"><div className="card"><p>{error}</p></div></main>;
  if (!doc) return <main className="auth"><p className="muted">Chargement…</p></main>;
  const c = doc.company;
  const isInvoice = doc.type === 'invoice';
  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px', display: 'grid', gap: 16 }}>
      <div className="row no-print" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => window.print()}>Imprimer / enregistrer en PDF</button></div>
      <article className="card doc">
        <header className="doc-head">
          <div><div className="doc-company">{c.name}</div>
            <div className="small muted">{[c.address, c.city].filter(Boolean).join(', ')}{c.phone ? ` · ${c.phone}` : ''}{c.email ? ` · ${c.email}` : ''}</div>
            <div className="small muted">{[c.rccm && `RCCM ${c.rccm}`, c.taxId && `NCC ${c.taxId}`, c.taxRegime].filter(Boolean).join(' · ')}</div></div>
          <div style={{ textAlign: 'right' }}><div className="doc-title">{DOC_LABEL[doc.type as 'invoice']}</div><div><b>{doc.number}</b></div><div className="small">du {date(doc.issueDate)}</div>
            {isInvoice && <div className="small">Échéance : {date(doc.dueDate)}</div>}{doc.type === 'quote' && <div className="small">Valable jusqu'au {date(doc.validUntil)}</div>}</div>
        </header>
        <div className="doc-customer"><div className="small muted">Client</div><b>{doc.customer.name}</b>
          <div className="small">{[doc.customer.address, doc.customer.city].filter(Boolean).join(', ')}</div>
          <div className="small">{doc.customer.taxId && `NCC ${doc.customer.taxId}`}</div></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Désignation</th><th className="n">Qté</th><th className="n">Prix unit. HT</th><th className="n">Remise</th><th className="n">TVA</th><th className="n">Total HT</th></tr></thead>
          <tbody>{doc.lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="n">{l.quantity.toLocaleString('fr-FR')}{l.unit ? ` ${l.unit}` : ''}</td>
            <td className="n">{money(l.unitPrice)}</td><td className="n">{l.discountPct ? `${l.discountPct} %` : '—'}</td><td className="n">{l.vatRate} %</td><td className="n">{money(l.totalHt)}</td></tr>)}</tbody>
        </table></div>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <table className="vat"><thead><tr><th>Taux</th><th className="n">Base HT</th><th className="n">TVA</th></tr></thead>
            <tbody>{doc.vatBreakdown.map((v: any) => <tr key={v.rate}><td>{v.rate} %</td><td className="n">{money(v.base)}</td><td className="n">{money(v.vat)}</td></tr>)}</tbody></table>
          <dl className="totals"><dt>Total HT</dt><dd>{money(doc.totalHt)}</dd><dt>TVA</dt><dd>{money(doc.totalVat)}</dd><dt className="grand">Total TTC</dt><dd className="grand">{money(doc.totalTtc)}</dd>
            {isInvoice && (doc.paidAmount > 0 || doc.creditedAmount > 0) && <><dt>Déjà réglé ou crédité</dt><dd>− {money(doc.paidAmount + doc.creditedAmount)}</dd><dt className="grand">Reste à payer</dt><dd className="grand">{money(doc.remaining)}</dd></>}</dl>
        </div>
        {doc.notes && <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{doc.notes}</p>}
      </article>
      <p className="small muted no-print" style={{ textAlign: 'center' }}>Document transmis par {c.name} avec Kora ERP.</p>
    </main>
  );
}

export default function PublicDocumentPage() { return <Suspense><PublicDocument /></Suspense>; }
