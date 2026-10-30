'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money, SUB_STATUS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';
import { ChartCard, ColumnChart, fcfa, LineChart, monthLong, RankedBars } from '@/components/charts';

const MODULE_LABELS: Record<string, string> = { contacts: 'Contacts', sales: 'Devis et ventes', cash: 'Caisse', purchases: 'Achats', bank: 'Banque', accounting: 'Comptabilité', hr: 'Employés et congés', payroll: 'Paie' };

export default function Dashboard() {
  const { me, ctx, can, refresh } = useSession();
  const [sub, setSub] = useState<any>(null);
  const [sales, setSales] = useState<any>(null);
  const [purchases, setPurchases] = useState<any>(null);
  const [dash, setDash] = useState<any>(null);
  const [months, setMonths] = useState(12);
  const [loading, setLoading] = useState(false);
  const [stock, setStock] = useState<any>(null);
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (ctx && can('billing.read')) api('/company/subscription').then(setSub, () => {});
    if (ctx && can('sales.read') && ctx.entitlements.modules.includes('sales')) api('/company/sales/summary').then(setSales, () => {});
    if (ctx && can('purchases.read') && ctx.entitlements.modules.includes('purchases')) api('/company/purchases/summary').then(setPurchases, () => {});
    if (ctx && can('products.read')) api('/company/stock').then((s) => s.items.length && setStock(s), () => {});
  }, [ctx]); // eslint-disable-line
  // Le changement de période garde l'affichage précédent (atténué) pendant le rechargement : pas de saut.
  useEffect(() => {
    if (!ctx) return;
    setLoading(true);
    api(`/company/dashboard?months=${months}`).then(setDash, () => {}).finally(() => setLoading(false));
  }, [ctx, months]);

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
  const cur = dash?.monthly[dash.monthly.length - 1];
  const prev = dash?.monthly[dash.monthly.length - 2];
  const chartSeries = dash ? [
    { key: 'revenue', label: "Chiffre d'affaires", color: 'var(--series-1)', values: dash.monthly.map((x: any) => x.revenueHt) },
    ...(dash.sections.purchases ? [{ key: 'purchases', label: 'Achats', color: 'var(--series-2)', values: dash.monthly.map((x: any) => x.purchasesHt) }] : []),
  ] : [];
  return (
    <>
      <div className="page-head"><h1>{ctx.company.name}</h1>
        {can('sales.create') && !ctx.readOnly && <div className="row"><Link className="btn" href="/app/ventes/nouveau?type=quote">Nouveau devis</Link><Link className="btn primary" href="/app/ventes/nouveau?type=invoice">Nouvelle facture</Link></div>}</div>
      {dash && (dash.sections.sales || dash.sections.cash) && <>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="seg" role="group" aria-label="Période des graphiques">
            {[3, 6, 12].map((n) => <button key={n} aria-pressed={months === n} onClick={() => setMonths(n)}>{n} mois</button>)}
          </div>
        </div>
        <div className="kpis" style={{ opacity: loading ? 0.6 : 1 }}>
          {dash.sections.sales && <Kpi label="Chiffre d'affaires du mois" value={cur?.revenueHt ?? 0} previous={prev?.revenueHt} hint="hors taxes, avoirs déduits" />}
          {dash.sections.sales && <Kpi label="Encaissé ce mois" value={cur?.collected ?? 0} previous={prev?.collected} hint="tous modes de paiement" />}
          {dash.sections.cash && <Kpi label="Trésorerie disponible" value={cur?.cashEnd ?? 0} previous={prev?.cashEnd ?? undefined} hint={<Link href="/app/tresorerie">caisse, banque et mobile money</Link>} />}
          {sales && <div className="card kpi"><div className="l">À encaisser</div><div className="v">{money(sales.outstanding)}</div>
            <div className="small">{sales.overdueCount ? <Link href="/app/ventes/relances" style={{ color: 'var(--crit)' }}>{sales.overdueCount} en retard · {money(sales.overdueAmount)}</Link> : <span className="muted">aucune facture en retard</span>}</div></div>}
          {purchases && <div className="card kpi"><div className="l">À payer aux fournisseurs</div><div className="v">{money(purchases.payable)}</div>
            <div className="small"><Link href="/app/achats/echeancier">voir l'échéancier</Link></div></div>}
        </div>
      </>}
      {dash?.alerts.length > 0 && (
        <div className="card"><header><h2>À traiter</h2><span className="small muted">{dash.alerts.length} point(s)</span></header>
          <div style={{ display: 'grid', gap: 8 }}>{dash.alerts.map((a: any) => (
            <Link key={a.kind} href={a.href} className="row" style={{ justifyContent: 'space-between', textDecoration: 'none', color: 'var(--ink)', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span><Pill tone={a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : 'mute'}>{a.severity === 'critical' ? '⚠ Urgent' : a.severity === 'warning' ? 'À surveiller' : 'Info'}</Pill> {a.label}</span>
              <span className="small"><b>{a.count}</b>{a.amount ? ` · ${money(a.amount)}` : ''} →</span>
            </Link>))}</div>
        </div>
      )}
      {dash?.sections.sales && (
        <ChartCard title={dash.sections.purchases ? "Chiffre d'affaires et achats" : "Chiffre d'affaires"} subtitle={`par mois, hors taxes — ${months} derniers mois`}
          legend={chartSeries.map((s) => ({ label: s.label, color: s.color, kind: 'box' as const }))}
          table={{ head: ['Mois', ...chartSeries.map((s) => s.label)], rows: dash.months.map((mo: string, i: number) => [monthLong(mo), ...chartSeries.map((s) => fcfa(s.values[i] ?? 0))]) }}>
          <ColumnChart categories={dash.months} series={chartSeries} />
        </ChartCard>
      )}
      {dash && (dash.sections.cash || dash.topCustomers.length > 0) && (
        <div className="dash-grid">
          {dash.sections.cash && (
            <ChartCard title="Trésorerie" subtitle="solde de tous les comptes en fin de mois"
              table={{ head: ['Mois', 'Solde'], rows: dash.months.map((mo: string, i: number) => [monthLong(mo), dash.monthly[i].cashEnd === null ? '—' : fcfa(dash.monthly[i].cashEnd)]) }}>
              <LineChart categories={dash.months} values={dash.monthly.map((x: any) => x.cashEnd)} color="var(--series-1)" label="Trésorerie" />
            </ChartCard>
          )}
          {dash.topCustomers.length > 0 && (
            <ChartCard title="Meilleurs clients" subtitle={`chiffre d'affaires hors taxes — ${months} derniers mois`}
              table={{ head: ['Client', 'Chiffre d’affaires HT'], rows: dash.topCustomers.map((c: any) => [c.name, fcfa(c.amount)]) }}>
              <RankedBars items={dash.topCustomers.map((c: any) => ({ label: c.name, value: c.amount }))} />
            </ChartCard>
          )}
          {dash.topProducts.length > 0 && (
            <ChartCard title="Articles les plus vendus" subtitle={`chiffre d'affaires hors taxes — ${months} derniers mois`}
              table={{ head: ['Article', 'Quantité', 'Chiffre d’affaires HT'], rows: dash.topProducts.map((p: any) => [p.name, `${p.quantity.toLocaleString('fr-FR')} ${p.unit ?? ''}`, fcfa(p.amount)]) }}>
              <RankedBars items={dash.topProducts.map((p: any) => ({ label: p.name, value: p.amount, detail: `${p.quantity.toLocaleString('fr-FR')} ${p.unit ?? ''}` }))} />
            </ChartCard>
          )}
        </div>
      )}
      {(sales || purchases || stock) && (
        <div className="kpis">
          {sales && <div className="card kpi"><div className="l">Devis en cours</div><div className="v">{sales.openQuotes}</div><div className="small muted"><Link href="/app/ventes/devis">voir les devis</Link></div></div>}
          {purchases && <div className="card kpi"><div className="l">Commandes fournisseurs en cours</div><div className="v">{purchases.openOrders}</div><div className="small muted"><Link href="/app/achats/commandes">voir les commandes</Link></div></div>}
          {stock && <div className="card kpi"><div className="l">Valeur du stock</div><div className="v">{money(stock.totalValue)}</div><div className="small muted"><Link href="/app/stocks">voir les stocks</Link></div></div>}
        </div>
      )}
      {sub && (
        <div className="kpis">
          <div className="card kpi"><div className="l">Formule</div><div className="v">{sub.plan.name}</div><div className="small muted">{money(sub.billingCycle === 'yearly' ? sub.plan.priceYearly : sub.plan.priceMonthly)} / {sub.billingCycle === 'yearly' ? 'an' : 'mois'}</div></div>
          <div className="card kpi"><div className="l">Statut</div><div className="v" style={{ fontSize: 18, paddingTop: 6 }}>{st && <Pill tone={st[1]}>{st[0]}</Pill>}</div><div className="small muted">{sub.status === 'trialing' ? `Essai jusqu'au ${date(sub.currentPeriodEnd)}` : `Échéance le ${date(sub.currentPeriodEnd)}`}</div></div>
          <div className="card kpi"><div className="l">Utilisateurs</div><div className="v">{sub.usage.users}{sub.entitlements.quotas.users !== null && <span className="muted" style={{ fontSize: 15 }}> / {sub.entitlements.quotas.users}</span>}</div><div className="small muted">{sub.usage.pendingInvitations} invitation(s) en attente</div></div>
        </div>
      )}
      {can('employees.self') && (
        <div className="card"><header><h2>Mon espace</h2><Link href="/app/moi">Ouvrir</Link></header>
          <p className="small" style={{ margin: 0 }}>Consultez vos bulletins de paie, votre solde de congés, et demandez un congé.</p></div>
      )}
      {can('billing.read') && <div className="card">
        <header><h2>Modules de votre formule</h2>{can('billing.admin') && <Link href="/app/abonnement">Changer de formule</Link>}</header>
        <div className="row">
          {Object.entries(MODULE_LABELS).map(([k, l]) => <Pill key={k} tone={ctx.entitlements.modules.includes(k) ? 'ok' : 'mute'}>{l}{ctx.entitlements.modules.includes(k) ? '' : ' · non inclus'}</Pill>)}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>Disponibles : clients et fournisseurs, articles, ventes (devis, factures, avoirs, encaissements, relances) achats (bons de commande, factures et règlements fournisseurs, échéancier) trésorerie (caisse, banque, mobile money) comptabilité SYSCOHADA (écritures automatiques, grand livre, balance, TVA, résultat), stocks valorisés au CMUP, employés et paie ivoirienne (selon votre formule).</p>
      </div>}
      <div className="card">
        <header><h2>Pour bien démarrer</h2></header>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          {can('settings.admin') && <li><Link href="/app/entreprise">Compléter la fiche de l'entreprise</Link> (RCCM, compte contribuable, adresse).</li>}
          {can('contacts.create') && <li><Link href="/app/contacts">Enregistrer vos clients et fournisseurs</Link>, puis <Link href="/app/articles">vos articles</Link>.</li>}
          {can('sales.create') && <li><Link href="/app/ventes/nouveau?type=quote">Établir votre premier devis</Link> et le transformer en facture.</li>}
          {can('users.admin') && <li><Link href="/app/utilisateurs">Inviter vos collaborateurs</Link> et leur attribuer un rôle.</li>}
          <li><Link href="/app/securite">Activer la double authentification</Link>{me.user.mfaEnabled ? ' — déjà activée.' : ' pour protéger votre compte.'}</li>
        </ul>
      </div>
    </>
  );
}

/** Indicateur du mois avec son évolution par rapport au mois précédent. */
function Kpi({ label, value, previous, hint }: { label: string; value: number; previous?: number | null; hint?: React.ReactNode }) {
  const delta = previous === undefined || previous === null ? null : value - previous;
  const pct = delta !== null && previous ? Math.round((delta / Math.abs(previous)) * 100) : null;
  return (
    <div className="card kpi"><div className="l">{label}</div><div className="v">{money(value)}</div>
      {delta !== null && (
        <div className={`delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
          {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {delta === 0 ? 'stable' : `${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct} %)` : ''}`}
          <span className="muted" style={{ fontWeight: 400 }}> vs mois précédent</span>
        </div>
      )}
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}
