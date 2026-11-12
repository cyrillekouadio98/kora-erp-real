'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

const BUCKETS: [string, string][] = [['not_due', 'Non échu'], ['d30', '1 à 30 jours de retard'], ['d60', '31 à 60 jours'], ['d90', '61 à 90 jours'], ['over90', 'Plus de 90 jours']];

/** Dettes fournisseurs : ce qu'il faut payer, à qui et quand. */
export default function PayablesPage() {
  const [data, setData] = useState<any>(null);
  const { error, run } = useAction();
  useEffect(() => { run(async () => setData(await api('/company/purchases/payables'))); }, []); // eslint-disable-line

  const bySupplier = Object.values((data?.invoices ?? []).reduce((acc: Record<string, any>, i: any) => {
    acc[i.contact.id] ??= { contact: i.contact, invoices: [], total: 0, nextDue: i.dueDate };
    acc[i.contact.id].invoices.push(i);
    acc[i.contact.id].total += i.remaining;
    return acc;
  }, {})).sort((a: any, b: any) => (a.nextDue ?? '').localeCompare(b.nextDue ?? '')) as any[];

  return (
    <>
      <div className="page-head"><h1>Échéancier fournisseurs</h1></div>
      <Alert>{error}</Alert>
      {data && (
        <div className="kpis">
          <div className="card kpi"><div className="l">Total à payer</div><div className="v">{money(data.total)}</div></div>
          <div className="card kpi"><div className="l">Échéances sous 7 jours</div><div className="v">{money(data.dueIn7Days)}</div></div>
          <div className="card kpi"><div className="l">Échéances sous 30 jours</div><div className="v">{money(data.dueIn30Days)}</div></div>
          <div className="card kpi"><div className="l">En retard</div><div className="v" style={{ color: data.total - data.totals.not_due ? 'var(--crit)' : undefined }}>{money(data.total - data.totals.not_due)}</div>
            <div className="small muted">{BUCKETS.slice(1).filter(([k]) => data.totals[k]).map(([k, l]) => `${l} : ${money(data.totals[k])}`).join(' · ') || 'aucune facture en retard'}</div></div>
        </div>
      )}
      {data && !bySupplier.length && <div className="card muted" style={{ textAlign: 'center' }}>Aucune facture fournisseur à payer.</div>}
      {bySupplier.map((g) => (
        <div key={g.contact.id} className="card">
          <header>
            <div><h2>{g.contact.name}</h2><div className="small muted">{[g.contact.code, g.contact.phone].filter(Boolean).join(' · ')}</div></div>
            <div style={{ textAlign: 'right' }}><div className="small muted">Reste à payer</div><b style={{ fontSize: 18 }}>{money(g.total)}</b></div>
          </header>
          <div className="table-wrap"><table>
            <thead><tr><th>Facture</th><th>Réf. fournisseur</th><th>Échéance</th><th></th><th className="n">Reste à payer</th></tr></thead>
            <tbody>{g.invoices.map((i: any) => (
              <tr key={i.id}>
                <td style={{ whiteSpace: 'nowrap' }}><Link href={`/app/achats/${i.id}`}>{i.number}</Link><div className="small muted">du {date(i.issueDate)}</div></td>
                <td className="small">{i.supplierRef}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{date(i.dueDate)}</td>
                <td>{i.daysLate > 0 ? <Pill tone={i.daysLate > 60 ? 'crit' : 'warn'}>{i.daysLate} jour{i.daysLate > 1 ? 's' : ''} de retard</Pill>
                  : i.daysLate > -8 ? <Pill tone="warn">{i.daysLate === 0 ? 'Aujourd’hui' : `Dans ${-i.daysLate} jour${i.daysLate < -1 ? 's' : ''}`}</Pill> : <Pill tone="ok">À échoir</Pill>}</td>
                <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(i.remaining)}</td>
              </tr>))}</tbody>
          </table></div>
        </div>
      ))}
    </>
  );
}
