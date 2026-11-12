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
  /** Formule choisie, en attente de confirmation. */
  const [confirm, setConfirm] = useState<any>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const s = await api('/company/subscription'); setSub(s); setCycle(s.billingCycle);
    setPlans(await api('/plans')); setInvoices(await api('/company/invoices'));
  }, []);
  // Chargement initial via run : une erreur (accès refusé, réseau) s'affiche au lieu de laisser la page vide.
  useEffect(() => { run(load); }, [load]);
  if (!sub) return error ? <><div className="page-head"><h1>Abonnement</h1></div><Alert>{error}</Alert></> : <p className="muted">Chargement…</p>;
  /** Nom commercial d'une formule (« Starter »), à partir de son code (« starter »). */
  const planName = (code: string) => plans.find((p) => p.code === code)?.name ?? code;
  const st = SUB_STATUS[sub.status];

  const pay = (id: string) => run(async () => { const r = await api(`/company/invoices/${id}/checkout`, { body: { provider: 'sandbox' } }); window.location.href = r.checkoutUrl; });
  const change = (code: string) => run(async () => {
    setConfirm(null);
    const r = await api('/company/subscription/change', { body: { planCode: code, billingCycle: cycle } });
    setNotice([r.applied === 'immediately' ? 'Formule changée.' : r.applied === 'at_period_end' ? `Changement programmé pour le ${date(r.effectiveAt)}.` : 'Une facture a été émise : la nouvelle formule sera active dès son paiement.', ...(r.warnings ?? [])].join(' '));
    await load(); await refresh();
  });
  /** Revenir à la formule actuelle annule la descente de gamme programmée (rien n'est facturé). */
  const keepCurrent = () => run(async () => {
    await api('/company/subscription/change', { body: { planCode: sub.plan.code, billingCycle: sub.billingCycle } });
    setNotice(`Changement annulé : vous restez sur la formule ${sub.plan.name}.`);
    await load(); await refresh();
  });

  /** Conséquence du changement vers une formule, expliquée avant confirmation. */
  const monthly = (p: { priceMonthly: number; priceYearly: number }, c: string) => (c === 'yearly' ? p.priceYearly / 12 : p.priceMonthly);
  const consequence = (p: any) => {
    const lines: string[] = [];
    if (sub.status === 'trialing') lines.push("Pendant l'essai, le changement est immédiat et rien n'est facturé.");
    else if (sub.status === 'active' && monthly(p, cycle) <= monthly(sub.plan, sub.billingCycle)) {
      lines.push(`Le changement s'appliquera le ${date(sub.currentPeriodEnd)} : vous gardez la formule ${sub.plan.name} jusque-là, déjà réglée.`);
    } else {
      lines.push(sub.status === 'active'
        ? 'Une facture au prorata de la période restante sera émise ; la nouvelle formule sera active dès son paiement.'
        : 'Une facture sera émise ; la nouvelle formule sera active dès son paiement.');
    }
    const quota = p.entitlements.quotas.users;
    if (quota !== null && sub.usage.users > quota) lines.push(`Vous avez ${sub.usage.users} utilisateurs pour ${quota} inclus : aucun ne sera supprimé, mais vous ne pourrez plus en ajouter.`);
    return lines;
  };

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
        {sub.pendingChange && <Alert kind="info">
          Passage à la formule {planName(sub.pendingChange.plan_code)}{sub.pendingChange.billing_cycle === 'yearly' ? ' (annuelle)' : ''} programmé au {date(sub.currentPeriodEnd)}.
          {admin && sub.status === 'active' && <> <button className="btn sm" disabled={busy} onClick={keepCurrent}>Annuler ce changement</button></>}
        </Alert>}
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
                  <button className="btn sm" disabled={busy || current} onClick={() => setConfirm(p)}>{current ? 'Formule actuelle' : 'Choisir'}</button>
                </div>
              );
            })}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>Montée en gamme : facturée au prorata, active dès le paiement. Descente : appliquée à l'échéance. Aucune donnée n'est supprimée en cas de dépassement d'une limite.</p>
        </div>
      )}

      {confirm && (
        <div className="modal-back" onClick={() => setConfirm(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" style={{ width: 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <h2 id="confirm-title">Passer à la formule {confirm.name} ?</h2>
            <p style={{ margin: 0 }}><b>{money(cycle === 'yearly' ? confirm.priceYearly : confirm.priceMonthly)}</b> / {cycle === 'yearly' ? 'an' : 'mois'} · {confirm.entitlements.quotas.users ?? 'Illimité'} utilisateurs · {confirm.entitlements.modules.length} modules</p>
            {consequence(confirm).map((line, i) => <Alert key={i} kind={i === 0 ? 'info' : 'warn'}>{line}</Alert>)}
            <div className="row"><button className="btn primary" disabled={busy} onClick={() => change(confirm.code)}>Confirmer</button><button className="btn" onClick={() => setConfirm(null)}>Annuler</button></div>
          </div>
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
