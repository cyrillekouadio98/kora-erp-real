'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

const BUCKETS: [string, string][] = [['not_due', 'Non échu'], ['d30', '1 à 30 jours'], ['d60', '31 à 60 jours'], ['d90', '61 à 90 jours'], ['over90', 'Plus de 90 jours']];

/** Créances clients classées par ancienneté du retard, regroupées par client. */
export default function RemindersPage() {
  const [data, setData] = useState<any>(null);
  const [lateOnly, setLateOnly] = useState(true);
  const { error, run } = useAction();
  useEffect(() => { run(async () => setData(await api('/company/sales/receivables'))); }, []); // eslint-disable-line

  const invoices = (data?.invoices ?? []).filter((i: any) => !lateOnly || i.daysLate > 0);
  const byCustomer = Object.values(invoices.reduce((acc: Record<string, any>, i: any) => {
    acc[i.contact.id] ??= { contact: i.contact, invoices: [], total: 0, maxLate: 0 };
    acc[i.contact.id].invoices.push(i);
    acc[i.contact.id].total += i.remaining;
    acc[i.contact.id].maxLate = Math.max(acc[i.contact.id].maxLate, i.daysLate);
    return acc;
  }, {})).sort((a: any, b: any) => b.maxLate - a.maxLate || b.total - a.total) as any[];

  return (
    <>
      <div className="page-head"><h1>Relances clients</h1>
        <label className="row small"><input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} /> Factures en retard uniquement</label></div>
      <Alert>{error}</Alert>
      {data && (
        <div className="kpis">
          {BUCKETS.map(([k, l]) => (
            <div key={k} className="card kpi"><div className="l">{l}</div>
              <div className="v" style={{ fontSize: 20, color: k !== 'not_due' && data.totals[k] ? 'var(--crit)' : undefined }}>{money(data.totals[k])}</div></div>
          ))}
        </div>
      )}
      {data && !byCustomer.length && <div className="card muted" style={{ textAlign: 'center' }}>{lateOnly ? 'Aucune facture en retard. 👍' : 'Aucune facture à encaisser.'}</div>}
      {byCustomer.map((g) => (
        <div key={g.contact.id} className="card">
          <header>
            <div><h2>{g.contact.name}</h2><div className="small muted">{[g.contact.code, g.contact.phone, g.contact.email].filter(Boolean).join(' · ')}</div></div>
            <div style={{ textAlign: 'right' }}><div className="small muted">Reste à payer</div><b style={{ fontSize: 18 }}>{money(g.total)}</b></div>
          </header>
          <div className="table-wrap"><table>
            <thead><tr><th>Facture</th><th>Échéance</th><th>Retard</th><th>Relances</th><th className="n">Reste à payer</th><th></th></tr></thead>
            <tbody>{g.invoices.map((i: any) => (
              <tr key={i.id}>
                <td style={{ whiteSpace: 'nowrap' }}><Link href={`/app/ventes/${i.id}`}>{i.number}</Link><div className="small muted">du {date(i.issueDate)}</div></td>
                <td style={{ whiteSpace: 'nowrap' }}>{date(i.dueDate)}</td>
                <td>{i.daysLate > 0 ? <Pill tone={i.daysLate > 60 ? 'crit' : 'warn'}>{i.daysLate} jour{i.daysLate > 1 ? 's' : ''}</Pill> : <Pill tone="ok">À échoir</Pill>}</td>
                <td className="small">{i.reminderCount ? `${i.reminderCount} · dernière le ${date(i.lastReminderAt)}` : <span className="muted">aucune</span>}
                  {i.promisedOn && <div><Pill tone={i.promisedOn < new Date().toISOString().slice(0, 10) ? 'crit' : 'warn'}>Promis le {date(i.promisedOn)}</Pill></div>}</td>
                <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(i.remaining)}</td>
                <td className="n"><Link className="btn sm" href={`/app/ventes/${i.id}`}>Relancer</Link></td>
              </tr>))}</tbody>
          </table></div>
        </div>
      ))}
    </>
  );
}
