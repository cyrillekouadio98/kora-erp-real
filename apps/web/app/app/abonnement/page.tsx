'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date, money, SUB_STATUS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';

export default function SubscriptionPage() {
  const { can, refresh } = useSession();
  const admin = can('billing.admin');
  const [sub, setSub] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const s = await api('/company/subscription'); setSub(s); setCycle(s.billingCycle);
    setPlans(await api('/plans')); setInvoices(await api('/company/invoices'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!sub) return <p className="muted">Chargement…</p>;
  const st = SUB_STATUS[sub.status];

  const pay = (id: string) => run(async () => { const r = await api(`/company/invoices/${id}/checkout`, { body: { provider: 'sandbox' } }); window.location.href = r.checkoutUrl; });
  const change = (code: string) => run(async () => {
    const r = await api('/company/subscription/change', { body: { planCode: code, billingCycle: cycle } });
    setNotice([r.applied === 'immediately' ? 'Formule changée.' : r.applied === 'at_period_end' ? `Changement programmé pour le ${date(r.effectiveAt)}.` : 'Une facture a été émise : la nouvelle formule sera active dès son paiement.', ...(r.warnings ?? [])].join(' '));
    await load(); await refresh();
  });

  return (
    <>
      <div className="page-head"><h1>Abonnement</h1></div>
      <Alert>{error}</Alert><Alert kind="ok">{notice}</Alert>
      <div className="card">
        <header><h2>{sub.plan.name} <Pill tone={st[1]}>{st[0]}</Pill></h2>
          {admin && sub.status === 'active' && (sub.cancelAtPeriodEnd
            ? <button className="btn sm" onClick={() => run(async () => { await api('/company/subscription/resume', { method: 'POST', body: {} }); await load(); })}>Annuler la résiliation</button>
            : <button className="btn sm danger" onClick={() => run(async () => { await api('/company/subscription/cancel', { method: 'POST', body: {} }); await load(); })}>Résilier à l'échéance</button>)}
        </header>
        <div className="kpis">
          <div className="kpi"><div className="l">{sub.status === 'trialing' ? "Fin de l'essai" : 'Prochaine échéance'}</div><div className="v" style={{ fontSize: 18 }}>{date(sub.currentPeriodEnd)}</div></div>
          <div className="kpi"><div className="l">Utilisateurs</div><div className="v" style={{ fontSize: 18 }}>{sub.usage.users} / {sub.entitlements.quotas.users ?? 'illimité'}</div></div>
          {sub.graceUntil && <div className="kpi"><div className="l">Suspension le</div><div className="v" style={{ fontSize: 18, color: 'var(--warn)' }}>{date(sub.graceUntil)}</div></div>}
        </div>
        {sub.cancelAtPeriodEnd && <Alert kind="warn">Résiliation programmée au {date(sub.currentPeriodEnd)}. Vos données resteront consultables et exportables 90 jours.</Alert>}
        {sub.pendingChange && <Alert kind="info">Passage à la formule {sub.pendingChange.plan_code} programmé au {date(sub.currentPeriodEnd)}.</Alert>}
      </div>

      {sub.openInvoices.length > 0 && (
        <div className="card"><header><h2>Factures à régler</h2></header>
          <div className="table-wrap"><table><tbody>{sub.openInvoices.map((i: any) => (
            <tr key={i.id}><td>{i.number}</td><td className="n">{money(i.amount, i.currency)}</td><td className="small muted">échéance {date(i.due_at)}</td>
              <td className="n">{admin && <button className="btn sm primary" disabled={busy} onClick={() => pay(i.id)}>Payer</button>}</td></tr>))}</tbody></table></div>
        </div>
      )}

      {admin && (
        <div className="card">
          <header><h2>Changer de formule</h2>
            <div className="row small"><label className="row"><input type="radio" checked={cycle === 'monthly'} onChange={() => setCycle('monthly')} /> Mensuel</label><label className="row"><input type="radio" checked={cycle === 'yearly'} onChange={() => setCycle('yearly')} /> Annuel (2 mois offerts)</label></div>
          </header>
          <div className="kpis">
            {plans.filter((p) => p.priceMonthly > 0).map((p) => {
              const current = p.code === sub.plan.code && cycle === sub.billingCycle;
              return (
                <div key={p.code} className="card" style={{ display: 'grid', gap: 8 }}>
                  <h3>{p.name}</h3>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{money(cycle === 'yearly' ? p.priceYearly : p.priceMonthly)}<span className="small muted"> / {cycle === 'yearly' ? 'an' : 'mois'}</span></div>
                  <div className="small muted">{p.entitlements.quotas.users ?? 'Illimité'} utilisateurs · {p.entitlements.modules.length} modules{p.entitlements.modules.includes('payroll') ? ' · paie incluse' : ''}</div>
                  <button className="btn sm" disabled={busy || current} onClick={() => change(p.code)}>{current ? 'Formule actuelle' : 'Choisir'}</button>
                </div>
              );
            })}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>Montée en gamme : facturée au prorata, active dès le paiement. Descente : appliquée à l'échéance. Aucune donnée n'est supprimée en cas de dépassement d'une limite.</p>
        </div>
      )}

      <div className="card"><header><h2>Historique des factures</h2></header>
        {invoices.length === 0 ? <p className="muted small">Aucune facture pour l'instant.</p> : (
          <div className="table-wrap"><table><thead><tr><th>Numéro</th><th>Émise le</th><th className="n">Montant</th><th>Statut</th></tr></thead>
            <tbody>{invoices.map((i) => <tr key={i.id}><td>{i.number}</td><td>{date(i.issued_at)}</td><td className="n">{money(i.amount, i.currency)}</td>
              <td><Pill tone={i.status === 'paid' ? 'ok' : i.status === 'open' ? 'warn' : 'mute'}>{i.status === 'paid' ? 'Payée' : i.status === 'open' ? 'À régler' : 'Annulée'}</Pill></td></tr>)}</tbody></table></div>)}
      </div>
    </>
  );
}
