'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';

const KINDS: Record<string, string> = { call: 'Appel', meeting: 'Rendez-vous', email: 'E-mail', note: 'Note', task: 'À faire' };
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** CRM — Actions : les relances et rendez-vous à faire de toutes les affaires en cours, du plus urgent au plus lointain. */
export default function CrmActionsPage() {
  const { has, can, ctx } = useSession();
  const [list, setList] = useState<any[] | null>(null);
  const [mine, setMine] = useState(true);
  const { busy, error, run } = useAction();
  const write = can('sales.update') && !ctx?.readOnly;
  const load = useCallback(async () => setList(await api<any[]>(`/company/opportunities/activities${mine ? '?mine=true' : ''}`)), [mine]);
  useEffect(() => { if (has('crm')) run(load); }, [load]); // eslint-disable-line
  if (!has('crm')) return <Alert kind="warn">Le CRM n&apos;est pas activé pour votre entreprise. Contactez Kora ERP pour l&apos;activer.</Alert>;

  const t = today(), week = inDays(7);
  const groups: [string, string, any[]][] = list ? [
    ['late', 'En retard', list.filter((a) => a.dueDate < t)],
    ['today', "Aujourd'hui", list.filter((a) => a.dueDate === t)],
    ['week', 'Cette semaine', list.filter((a) => a.dueDate > t && a.dueDate <= week)],
    ['later', 'Plus tard', list.filter((a) => a.dueDate > week)],
  ] : [];
  const done = (id: string) => run(async () => { await api(`/company/opportunities/activities/${id}/done`, { body: {} }); await load(); });
  return (
    <>
      <div className="page-head"><h1>Actions à faire</h1>
        <div className="seg" role="group" aria-label="Afficher">
          <button aria-pressed={mine} onClick={() => setMine(true)}>Les miennes</button>
          <button aria-pressed={!mine} onClick={() => setMine(false)}>Toute l&apos;équipe</button>
        </div></div>
      <p className="muted" style={{ margin: 0 }}>Appels, rendez-vous et relances prévus sur les affaires en cours. Une action se programme depuis la fiche d&apos;une <Link href="/app/crm">opportunité</Link>, avec une date « À faire le ».</p>
      <Alert>{error}</Alert>
      {list && !list.length && <p className="muted">Aucune action à faire{mine ? ' pour vous' : ''}. </p>}
      {groups.filter(([, , l]) => l.length).map(([k, label, l]) => (
        <section key={k} className="card" style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ margin: 0, color: k === 'late' ? 'var(--crit)' : undefined }}>{label} <span className="muted small">({l.length})</span></h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Action</th><th>Affaire</th><th>Client ou prospect</th><th className="n">Montant</th>{!mine && <th>Commercial</th>}<th /></tr></thead>
            <tbody>{l.map((a) => (
              <tr key={a.id}>
                <td>{date(a.dueDate)}</td>
                <td><Pill tone={k === 'late' ? 'crit' : k === 'today' ? 'warn' : undefined}>{KINDS[a.kind]}</Pill> {a.note}</td>
                <td><Link href={`/app/crm?id=${a.opportunityId}`}>{a.code} · {a.title}</Link></td>
                <td>{a.customer}{a.phone && <div className="small muted"><a href={`tel:${String(a.phone).replace(/\s/g, '')}`}>{a.phone}</a></div>}</td>
                <td className="n">{money(a.amount)}</td>
                {!mine && <td>{a.owner ?? <span className="muted">—</span>}</td>}
                <td>{write && <button className="btn sm" disabled={busy} onClick={() => done(a.id)}>Fait</button>}</td>
              </tr>))}</tbody>
          </table></div>
        </section>
      ))}
    </>
  );
}
