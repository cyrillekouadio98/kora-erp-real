'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money, SUB_STATUS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const MODULE_LABELS: Record<string, string> = { contacts: 'Contacts', sales: 'Devis et ventes', cash: 'Caisse', purchases: 'Achats', bank: 'Banque', accounting: 'Comptabilité', hr: 'Employés et congés', payroll: 'Paie' };

export default function Dashboard() {
  const { me, ctx, can, refresh } = useSession();
  const [sub, setSub] = useState<any>(null);
  const [sales, setSales] = useState<any>(null);
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (ctx && can('billing.read')) api('/company/subscription').then(setSub, () => {});
    if (ctx && can('sales.read') && ctx.entitlements.modules.includes('sales')) api('/company/sales/summary').then(setSales, () => {});
  }, [ctx]); // eslint-disable-line

  if (!ctx) {
    return (
      <div className="card form">
        <h1>Bienvenue {me.user.fullName}</h1>
        <p className="muted">Créez votre première entreprise pour commencer.</p>
        <Alert>{error}</Alert>
        <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api('/companies', { body: { name } }); await api('/auth/switch-company', { body: { companyId: r.companyId } }); await refresh(); }); }}>
          <div style={{ flex: 1, minWidth: 220 }}><Field label="Nom de l'entreprise" required value={name} onChange={(e) => setName(e.target.value)} /></div>
          <button className="btn primary" disabled={busy}>Créer</button>
        </form>
      </div>
    );
  }
  const st = sub ? SUB_STATUS[sub.status] : null;
  return (
    <>
      <div className="page-head"><h1>{ctx.company.name}</h1>
        {can('sales.create') && !ctx.readOnly && <div className="row"><Link className="btn" href="/app/ventes/nouveau?type=quote">Nouveau devis</Link><Link className="btn primary" href="/app/ventes/nouveau?type=invoice">Nouvelle facture</Link></div>}</div>
      {sales && (
        <div className="kpis">
          <div className="card kpi"><div className="l">Chiffre d'affaires du mois</div><div className="v">{money(sales.revenueMonthHt)}</div><div className="small muted">hors taxes, factures émises</div></div>
          <div className="card kpi"><div className="l">Encaissé ce mois</div><div className="v">{money(sales.collectedMonth)}</div><div className="small muted">tous modes de paiement</div></div>
          <div className="card kpi"><div className="l">À encaisser</div><div className="v">{money(sales.outstanding)}</div>
            <div className="small">{sales.overdueCount ? <Link href="/app/ventes/relances" style={{ color: 'var(--crit)' }}>{sales.overdueCount} facture(s) en retard · {money(sales.overdueAmount)}</Link> : <span className="muted">aucune facture en retard</span>}</div></div>
          <div className="card kpi"><div className="l">Devis en cours</div><div className="v">{sales.openQuotes}</div><div className="small muted"><Link href="/app/ventes/devis">voir les devis</Link></div></div>
        </div>
      )}
      {sub && (
        <div className="kpis">
          <div className="card kpi"><div className="l">Formule</div><div className="v">{sub.plan.name}</div><div className="small muted">{money(sub.billingCycle === 'yearly' ? sub.plan.priceYearly : sub.plan.priceMonthly)} / {sub.billingCycle === 'yearly' ? 'an' : 'mois'}</div></div>
          <div className="card kpi"><div className="l">Statut</div><div className="v" style={{ fontSize: 18, paddingTop: 6 }}>{st && <Pill tone={st[1]}>{st[0]}</Pill>}</div><div className="small muted">{sub.status === 'trialing' ? `Essai jusqu'au ${date(sub.currentPeriodEnd)}` : `Échéance le ${date(sub.currentPeriodEnd)}`}</div></div>
          <div className="card kpi"><div className="l">Utilisateurs</div><div className="v">{sub.usage.users}{sub.entitlements.quotas.users !== null && <span className="muted" style={{ fontSize: 15 }}> / {sub.entitlements.quotas.users}</span>}</div><div className="small muted">{sub.usage.pendingInvitations} invitation(s) en attente</div></div>
        </div>
      )}
      <div className="card">
        <header><h2>Modules de votre formule</h2>{can('billing.admin') && <Link href="/app/abonnement">Changer de formule</Link>}</header>
        <div className="row">
          {Object.entries(MODULE_LABELS).map(([k, l]) => <Pill key={k} tone={ctx.entitlements.modules.includes(k) ? 'ok' : 'mute'}>{l}{ctx.entitlements.modules.includes(k) ? '' : ' · non inclus'}</Pill>)}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>Disponibles : clients et fournisseurs, articles, devis, factures, avoirs, encaissements et relances. Les achats, la caisse, la banque, la comptabilité et la paie arrivent avec les prochains lots.</p>
      </div>
      <div className="card">
        <header><h2>Pour bien démarrer</h2></header>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          <li><Link href="/app/entreprise">Compléter la fiche de l'entreprise</Link> (RCCM, compte contribuable, adresse).</li>
          {can('contacts.create') && <li><Link href="/app/contacts">Enregistrer vos clients et fournisseurs</Link>, puis <Link href="/app/articles">vos articles</Link>.</li>}
          {can('sales.create') && <li><Link href="/app/ventes/nouveau?type=quote">Établir votre premier devis</Link> et le transformer en facture.</li>}
          {can('users.admin') && <li><Link href="/app/utilisateurs">Inviter vos collaborateurs</Link> et leur attribuer un rôle.</li>}
          <li><Link href="/app/securite">Activer la double authentification</Link>{me.user.mfaEnabled ? ' — déjà activée.' : ' pour protéger votre compte.'}</li>
        </ul>
      </div>
    </>
  );
}
