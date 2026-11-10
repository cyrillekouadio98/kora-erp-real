'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { PosTicket, POS_METHODS } from '@/components/pos';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);

/** Tickets de caisse : recherche, réimpression ; un retour se fait par avoir sur la facture du ticket. */
export default function PosTickets() {
  const { can } = useSession();
  const [rows, setRows] = useState<any[] | null>(null);
  const [date, setDate] = useState(today());
  const [q, setQ] = useState('');
  const [ticket, setTicket] = useState<any>(null);
  const { error, run } = useAction();
  const qs = new URLSearchParams({ ...(date ? { date } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString();

  const load = useCallback(() => run(async () => setRows(await api(`/company/pos/tickets?${qs}`))), [qs]); // eslint-disable-line
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  const total = rows?.reduce((a, r) => a + r.totalTtc, 0) ?? 0;

  return (
    <>
      <div className="page-head"><h1>Tickets de caisse</h1></div>
      <Alert>{!ticket && error}</Alert>
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder="N° de ticket, client…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div style={{ flex: 1, minWidth: 160 }}><Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      </div>
      {rows && rows.length > 0 && <p className="small muted" style={{ margin: 0 }}>{rows.length} ticket{rows.length > 1 ? 's' : ''} · {money(total)}{rows.length === 500 ? ' (500 derniers)' : ''}</p>}
      <div className="table-wrap"><table>
        <thead><tr><th>Ticket</th><th>Heure</th><th>Caisse</th><th>Caissier</th><th>Client</th><th className="n">Articles</th><th>Paiement</th><th className="n">Total TTC</th></tr></thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id} className="clickable" style={{ cursor: 'pointer' }} onClick={() => run(async () => setTicket(await api(`/company/pos/tickets/${r.id}`)))}>
              <td style={{ whiteSpace: 'nowrap' }}><code className="k">{r.number}</code>{r.creditedAmount > 0 && <> <Pill tone="warn">Avoir</Pill></>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
              <td>{r.registerName}<div className="small muted">{r.sessionNumber}</div></td>
              <td>{r.cashier}</td>
              <td>{r.customer}</td>
              <td className="n">{r.items}</td>
              <td className="small">{r.methods.map((m: string) => POS_METHODS[m] ?? m).join(' + ')}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}><b>{money(r.totalTtc)}</b></td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>Aucun ticket {date ? 'ce jour-là' : ''}{q ? ' pour cette recherche' : ''}.</td></tr>}
        </tbody>
      </table></div>

      {ticket && (
        <div className="modal-back" onClick={() => setTicket(null)}>
          <div className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <PosTicket t={ticket} />
            <div className="row no-print">
              <button className="btn primary" onClick={() => window.print()}>Réimprimer</button>
              {can('sales.read') && <Link className="btn" href={`/app/ventes/${ticket.id}`} title="Retour d’articles ou remboursement : créez un avoir depuis la facture du ticket">Retour / avoir</Link>}
              <button className="btn" onClick={() => setTicket(null)}>Fermer</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
