'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, docStatus, DocType, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const STATUSES = {
  quote: ['draft', 'sent', 'accepted', 'refused', 'invoiced'],
  invoice: ['draft', 'issued', 'partially_paid', 'paid', 'credited'],
  credit_note: ['draft', 'issued'],
};
const TITLES = { quote: 'Devis', invoice: 'Factures', credit_note: 'Avoirs' };

/** Liste des devis ou des factures, avec recherche et filtre par statut. */
export function SalesList({ type }: { type: DocType }) {
  const { can, ctx } = useSession();
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { error, run } = useAction();
  const params = new URLSearchParams({ type, ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}) }).toString();
  const load = useCallback(() => run(async () => setRows(await api(`/company/sales/documents?${params}`))), [params]); // eslint-disable-line
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  const isInvoice = type === 'invoice';
  const isCredit = type === 'credit_note';

  return (
    <>
      <div className="page-head">
        <h1>{TITLES[type]}</h1>
        <div className="row">
          {can('sales.export') && <a className="btn" href={`/api/company/sales/documents/export?type=${type}`}>Exporter (CSV)</a>}
          {can('sales.create') && !ctx?.readOnly && !isCredit && <Link className="btn primary" href={`/app/ventes/nouveau?type=${type}`}>{isInvoice ? 'Nouvelle facture' : 'Nouveau devis'}</Link>}
        </div>
      </div>
      <Alert>{error}</Alert>
      {isCredit && <p className="small muted" style={{ margin: 0 }}>Un avoir s'établit depuis la facture à corriger ou annuler (bouton « Établir un avoir »).</p>}
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder="Numéro, client…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="field" style={{ flex: 1, minWidth: 150 }}>Statut
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>{STATUSES[type].map((s) => <option key={s} value={s}>{docStatus(type, s)[0]}</option>)}
          </select>
        </label>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Numéro</th><th>Client</th><th>Date</th>{!isCredit && <th>{isInvoice ? 'Échéance' : 'Valable jusqu’au'}</th>}<th>Statut</th><th className="n">Total TTC</th>{isInvoice && <th className="n">Reste à payer</th>}</tr></thead>
        <tbody>
          {rows?.map((d) => (
            <tr key={d.id}>
              <td style={{ whiteSpace: 'nowrap' }}><Link href={`/app/ventes/${d.id}`}>{d.number ?? 'Brouillon'}</Link></td>
              <td><b>{d.contactName}</b><div className="small muted">{d.contactCode}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>{date(d.issueDate)}</td>
              {!isCredit && <td style={{ whiteSpace: 'nowrap' }}>{date(isInvoice ? d.dueDate : d.validUntil)}{d.overdue && <> <Pill tone="crit">En retard</Pill></>}</td>}
              <td><Pill tone={docStatus(type, d.status)[1]}>{docStatus(type, d.status)[0]}</Pill></td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(d.totalTtc)}</td>
              {isInvoice && <td className="n" style={{ whiteSpace: 'nowrap' }}>{d.status === 'draft' ? '—' : money(d.remaining)}</td>}
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
            {q || status ? 'Aucun document ne correspond à ces critères.' : isInvoice ? 'Aucune facture pour l’instant.' : isCredit ? 'Aucun avoir pour l’instant.' : 'Aucun devis pour l’instant.'}
          </td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
