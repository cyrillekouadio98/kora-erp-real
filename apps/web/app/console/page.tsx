'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, money, SUB_STATUS } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

export default function ConsoleHome() {
  const [m, setM] = useState<any>(null);
  const [companies, setCompanies] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [ok, setOk] = useState('');
  const { busy, error, run } = useAction();
  const load = useCallback(async () => { setM(await api('/platform/metrics')); setCompanies(await api(`/platform/companies${q ? `?q=${encodeURIComponent(q)}` : ''}`)); }, [q]);
  useEffect(() => { run(load); }, [load]); // eslint-disable-line

  const suspend = (c: any) => { const reason = window.prompt(`Motif de la suspension de « ${c.name} » (visible par le client) :`); if (reason) run(async () => { await api(`/platform/companies/${c.id}/suspend`, { body: { reason } }); await load(); }); };
  const reactivate = (c: any) => { const reason = window.prompt('Motif de la réactivation :', 'Situation régularisée'); if (reason) run(async () => { await api(`/platform/companies/${c.id}/reactivate`, { body: { reason } }); await load(); }); };
  const requestAccess = (c: any) => { const reason = window.prompt(`Motif de la demande d'accès à « ${c.name} » (10 caractères min., visible par le client) :`); if (reason) run(async () => { await api('/platform/support-access', { body: { companyId: c.id, reason, scope: ['users', 'audit'], durationMinutes: 240 } }); setOk(`Demande envoyée à ${c.name}. L'accès sera possible après accord de son administrateur.`); }); };

  return (
    <>
      <div className="page-head"><h1>Clients et indicateurs</h1></div>
      <Alert>{error}</Alert><Alert kind="ok">{ok}</Alert>
      {m && (
        <div className="kpis">
          <div className="card kpi"><div className="l">Entreprises</div><div className="v">{Object.values(m.companies as Record<string, number>).reduce((a, b) => a + b, 0)}</div><div className="small muted">{m.companies.active ?? 0} actives · {m.companies.suspended ?? 0} suspendues</div></div>
          <div className="card kpi"><div className="l">Revenu récurrent estimé</div><div className="v">{money(m.mrrEstimated)}</div><div className="small muted">par mois · {money(m.arrEstimated)} par an</div></div>
          <div className="card kpi"><div className="l">Facturé ce mois</div><div className="v">{money(m.invoicedThisMonth)}</div><div className="small muted">encaissé : {money(m.collectedThisMonth)}</div></div>
          <div className="card kpi"><div className="l">Impayés</div><div className="v">{money(m.openInvoices.amount)}</div><div className="small muted">{m.openInvoices.count} facture(s) · {m.cancellationsLast30Days} résiliation(s) sur 30 j</div></div>
        </div>
      )}
      {m && <div className="row small">{Object.entries(m.subscriptions as Record<string, number>).map(([s, n]) => <Pill key={s} tone={SUB_STATUS[s]?.[1]}>{SUB_STATUS[s]?.[0] ?? s} : {n}</Pill>)}{Object.entries(m.byPlan as Record<string, number>).map(([p, n]) => <Pill key={p}>{p} : {n}</Pill>)}</div>}
      <div className="row"><input className="input" style={{ maxWidth: 320 }} placeholder="Rechercher une entreprise" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Entreprise</th><th>Formule</th><th>Abonnement</th><th className="n">Utilisateurs</th><th>Créée le</th><th></th></tr></thead>
        <tbody>{companies.map((c) => (
          <tr key={c.id}><td><b>{c.name}</b>{c.status === 'suspended' && <> <Pill tone="crit">Suspendue</Pill><div className="small muted">{c.statusReason}</div></>}</td>
            <td>{c.planCode}</td><td>{c.subscriptionStatus && <Pill tone={SUB_STATUS[c.subscriptionStatus]?.[1]}>{SUB_STATUS[c.subscriptionStatus]?.[0]}</Pill>}<div className="small muted">échéance {date(c.currentPeriodEnd)}</div></td>
            <td className="n">{c.activeUsers}</td><td className="small">{date(c.createdAt)}</td>
            <td className="n"><div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn sm" disabled={busy} onClick={() => requestAccess(c)}>Demander un accès</button>
              {c.status === 'active' ? <button className="btn sm danger" disabled={busy} onClick={() => suspend(c)}>Suspendre</button> : <button className="btn sm" disabled={busy} onClick={() => reactivate(c)}>Réactiver</button>}
            </div></td></tr>))}</tbody>
      </table></div>
      <p className="small muted">La console n'affiche que les informations commerciales. Les données métier d'un client ne sont consultables qu'avec son accord, pour une durée limitée, et chaque consultation est inscrite dans son journal d'audit.</p>
    </>
  );
}
