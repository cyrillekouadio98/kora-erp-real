'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money, PURCHASE_STATUS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const STATUSES = { order: ['draft', 'sent', 'cancelled', 'invoiced'], invoice: ['draft', 'to_pay', 'partially_paid', 'paid'] };

/** Liste des bons de commande ou des factures fournisseurs. */
export function PurchaseList({ type }: { type: 'order' | 'invoice' }) {
  const { can, ctx } = useSession();
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { error, run } = useAction();
  const params = new URLSearchParams({ type, ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}) }).toString();
  const load = useCallback(() => run(async () => setRows(await api(`/company/purchases/documents?${params}`))), [params]); // eslint-disable-line
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  const isInvoice = type === 'invoice';

  return (
    <>
      <div className="page-head">
        <h1>{isInvoice ? 'Factures fournisseurs' : 'Bons de commande'}</h1>
        <div className="row">
          {can('purchases.export') && <a className="btn" href={`/api/company/purchases/documents/export?type=${type}`}>Exporter (CSV)</a>}
          {can('purchases.create') && !ctx?.readOnly && <Link className="btn primary" href={`/app/achats/nouveau?type=${type}`}>{isInvoice ? 'Saisir une facture fournisseur' : 'Nouveau bon de commande'}</Link>}
        </div>
      </div>
      <Alert>{error}</Alert>
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder={isInvoice ? 'Numéro, référence fournisseur, fournisseur…' : 'Numéro, fournisseur…'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="field" style={{ flex: 1, minWidth: 150 }}>Statut
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>{STATUSES[type].map((s) => <option key={s} value={s}>{PURCHASE_STATUS[s][0]}</option>)}
          </select>
        </label>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Numéro</th>{isInvoice && <th>Réf. fournisseur</th>}<th>Fournisseur</th><th>Date</th><th>{isInvoice ? 'Échéance' : 'Livraison prévue'}</th><th>Statut</th><th className="n">Total TTC</th>{isInvoice && <th className="n">Reste à payer</th>}</tr></thead>
        <tbody>
          {rows?.map((d) => (
            <tr key={d.id}>
              <td style={{ whiteSpace: 'nowrap' }}><Link href={`/app/achats/${d.id}`}>{d.number ?? 'Brouillon'}</Link></td>
              {isInvoice && <td className="small">{d.supplierRef ?? '—'}</td>}
              <td><b>{d.contactName}</b><div className="small muted">{d.contactCode}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>{date(d.issueDate)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{date(isInvoice ? d.dueDate : d.expectedDate)}{d.overdue && <> <Pill tone="crit">En retard</Pill></>}</td>
              <td><Pill tone={PURCHASE_STATUS[d.status][1]}>{PURCHASE_STATUS[d.status][0]}</Pill></td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(d.totalTtc)}</td>
              {isInvoice && <td className="n" style={{ whiteSpace: 'nowrap' }}>{d.status === 'draft' ? '—' : money(d.remaining)}</td>}
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>
            {q || status ? 'Aucun document ne correspond à ces critères.' : isInvoice ? 'Aucune facture fournisseur pour l’instant.' : 'Aucun bon de commande pour l’instant.'}
          </td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
