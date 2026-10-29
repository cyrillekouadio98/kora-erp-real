'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

export default function ConsoleInvoices() {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState('open');
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setRows(await api(`/platform/invoices?status=${status}`)), [status]);
  useEffect(() => { run(load); }, [load]); // eslint-disable-line
  const markPaid = (i: any) => { const reference = window.prompt(`Référence du virement reçu pour ${i.number} :`); if (reference) run(async () => { await api(`/platform/invoices/${i.id}/mark-paid`, { body: { reference } }); await load(); }); };
  return (
    <>
      <div className="page-head"><h1>Factures d'abonnement</h1>
        <select className="input" style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">À encaisser</option><option value="paid">Payées</option><option value="void">Annulées</option></select></div>
      <Alert>{error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Numéro</th><th>Client</th><th className="n">Montant</th><th>Émise le</th><th>Échéance</th><th></th></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}><td>{i.number}</td><td>{i.companyName}</td><td className="n">{money(Number(i.amount), i.currency)}</td><td>{date(i.issuedAt)}</td><td>{date(i.dueAt)}</td>
            <td className="n">{i.status === 'open' ? <button className="btn sm" disabled={busy} onClick={() => markPaid(i)}>Enregistrer un virement</button> : <Pill tone={i.status === 'paid' ? 'ok' : 'mute'}>{i.status === 'paid' ? `Payée le ${date(i.paidAt)}` : 'Annulée'}</Pill>}</td></tr>))}</tbody>
      </table></div>
      <p className="small muted">Ces factures concernent l'abonnement au logiciel. Elles sont distinctes des factures commerciales que vos clients émettent dans leur propre activité.</p>
    </>
  );
}
