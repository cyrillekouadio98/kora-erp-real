'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, useAction } from '@/components/ui';
import { ChartCard, Donut, fcfa, LineChart, monthLong, monthTick, RankedBars } from '@/components/charts';
import { date, EXPENSE_CATEGORIES, PAYMENT_METHODS } from '@/lib/format';

/** Libellés des postes de dépense propres au rapport, en plus des catégories de trésorerie. */
const POSTS: Record<string, string> = {
  ...EXPENSE_CATEGORIES, purchases: 'Achats de services et fournitures', stock_issues: 'Pertes et consommations de stock',
  inventory: "Écarts d'inventaire", cash_difference: 'Écarts de caisse', payroll: 'Charges de personnel (paie)',
};
const PAY_COLOR: Record<string, string> = { cash: 'var(--pay-cash)', mobile_money: 'var(--pay-mobile)', bank_transfer: 'var(--pay-transfer)', cheque: 'var(--pay-cheque)', card: 'var(--pay-card)' };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const firstOfMonth = (offset = 0) => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth() + offset, 1))); };
const lastOfMonth = (offset = 0) => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth() + offset + 1, 0))); };
const PRESETS: [string, () => [string, string]][] = [
  ['Ce mois', () => [firstOfMonth(), today()]],
  ['Mois dernier', () => [firstOfMonth(-1), lastOfMonth(-1)]],
  ['3 derniers mois', () => [firstOfMonth(-2), today()]],
  ['Cette année', () => [`${new Date().getFullYear()}-01-01`, today()]],
];

/** Montant retranché : « −x FCFA », et 0 sans signe. */
const minus = (v: number) => (v ? fcfa(-v) : fcfa(0));
const pct = (a: number, b: number) => (b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
const dayTick = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLong = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** Évolution par rapport à la période précédente ; « good » dit si une hausse est une bonne nouvelle. */
function Delta({ cur, prev, good = 'up' }: { cur: number; prev: number; good?: 'up' | 'down' }) {
  const p = pct(cur, prev);
  if (p === null) return <span className="delta flat">{cur === 0 ? 'Comme la période précédente' : 'Période précédente : 0 FCFA'}</span>;
  const tone = Math.abs(p) < 0.5 ? 'flat' : (p > 0) === (good === 'up') ? 'up' : 'down';
  return <span className={`delta ${tone}`}>{p > 0 ? '▲' : p < 0 ? '▼' : '='} {Math.abs(p).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % <span className="muted">vs {fcfa(prev)}</span></span>;
}

/** Rapport de gestion : chiffre d'affaires, marge, dépenses et résultat d'une période, comparés à la période précédente. */
export default function ReportPage() {
  const { can, ctx } = useSession();
  const [[from, to], setRange] = useState<[string, string]>(() => [firstOfMonth(), today()]);
  const [r, setR] = useState<any>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { if (from && to && from <= to) run(async () => setR(await api(`/company/reports/management?from=${from}&to=${to}`))); }, [from, to]); // eslint-disable-line

  const exportCsv = () => {
    const t = r.totals, p = r.previousTotals;
    const rows: (string | number)[][] = [['Poste', `Du ${date(r.from)} au ${date(r.to)}`, `Du ${date(r.previous.from)} au ${date(r.previous.to)}`],
      ['Chiffre d\'affaires TTC', t.salesTtc, p.salesTtc], ['Chiffre d\'affaires HT', t.salesHt, p.salesHt], ['Nombre de factures', t.invoices, p.invoices],
      ['Coût des marchandises vendues', t.cogs, p.cogs], ['Marge brute', t.grossMargin, p.grossMargin],
      ...r.expensesByCategory.map((e: any) => [`Dépense : ${POSTS[e.key] ?? e.key}`, e.amount, r.previousExpensesByCategory.find((x: any) => x.key === e.key)?.amount ?? 0]),
      ['Total des dépenses', t.expenses, p.expenses], ['Autres recettes', t.otherIncome, p.otherIncome], ['Résultat', t.result, p.result],
      [], ['Encaissements', 'Montant'], ...r.collections.map((c: any) => [PAYMENT_METHODS[c.method] ?? c.method, c.amount])];
    const csv = '﻿' + rows.map((row) => row.map((v) => (typeof v === 'string' && /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(';')).join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: `rapport-${r.from}-${r.to}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  };

  const t = r?.totals, p = r?.previousTotals;
  const byDay = r?.trend.unit === 'day';
  return (
    <>
      <div className="page-head">
        <div><h1>Rapport de gestion</h1><p className="small muted" style={{ margin: 0 }}>Rentabilité de {ctx?.company.name ?? "l'entreprise"}{ctx?.siteId ? ` · ${ctx.sites.find((s) => s.id === ctx.siteId)?.name}` : ''}, du {date(from)} au {date(to)}</p></div>
        <div className="row no-print">
          {can('reports.export') && <button className="btn" disabled={!r} onClick={exportCsv}>Exporter (CSV)</button>}
          <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button>
        </div>
      </div>
      <div className="card row report-range no-print">
        <label className="field">Du<input className="input" type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} /></label>
        <label className="field">Au<input className="input" type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} /></label>
        <div className="seg">{PRESETS.map(([l, f]) => { const [a, b] = f(); return <button key={l} type="button" aria-pressed={a === from && b === to} onClick={() => setRange([a, b])}>{l}</button>; })}</div>
      </div>
      <Alert>{error}</Alert>

      {r && <div className="stack" style={{ opacity: busy ? 0.6 : 1 }}>
        <div className="kpis report-kpis">
          <div className="card kpi"><div className="l">Chiffre d&apos;affaires TTC</div><div className="v">{fcfa(t.salesTtc)}</div>
            <div className="small muted">{t.invoices} facture{t.invoices > 1 ? 's' : ''} · {fcfa(t.salesHt)} HT</div><Delta cur={t.salesTtc} prev={p.salesTtc} /></div>
          <div className="card kpi"><div className="l">Marge brute</div><div className="v">{fcfa(t.grossMargin)}</div>
            <div className="small muted">{t.salesHt ? `${Math.round((t.grossMargin / t.salesHt) * 100)} % du CA HT` : '—'} · coût des ventes {fcfa(t.cogs)}</div><Delta cur={t.grossMargin} prev={p.grossMargin} /></div>
          <div className="card kpi"><div className="l">Dépenses</div><div className="v">{fcfa(t.expenses)}</div>
            <div className="small muted">hors achats de marchandises stockées</div><Delta cur={t.expenses} prev={p.expenses} good="down" /></div>
          <div className={`card kpi result ${t.result < 0 ? 'neg' : 'pos'}`}><div className="l">Résultat</div><div className="v">{fcfa(t.result)}</div>
            <div className="small muted">{t.result < 0 ? 'Perte' : 'Bénéfice'} avant impôt</div><Delta cur={t.result} prev={p.result} /></div>
        </div>

        <div className="report-grid">
          <ChartCard title="Ventes TTC" subtitle={byDay ? 'Par jour, avoirs déduits' : 'Par mois, avoirs déduits'}
            table={{ head: [byDay ? 'Jour' : 'Mois', 'Ventes TTC'], rows: r.trend.points.map((x: any) => [byDay ? dayLong(x.key) : monthLong(x.key), fcfa(x.salesTtc)]) }}>
            <LineChart categories={r.trend.points.map((x: any) => x.key)} values={r.trend.points.map((x: any) => x.salesTtc)} color="var(--series-1)" label="Ventes TTC" height={240}
              tick={byDay ? (c: string) => dayTick(c) : monthTick} long={byDay ? dayLong : monthLong} />
          </ChartCard>
          <ChartCard title="Encaissements" subtitle="Par mode de paiement"
            table={{ head: ['Mode', 'Montant'], rows: r.collections.map((c: any) => [PAYMENT_METHODS[c.method] ?? c.method, fcfa(c.amount)]) }}>
            {r.collections.length
              ? <Donut label="Encaissements" items={r.collections.map((c: any) => ({ key: c.method, label: PAYMENT_METHODS[c.method] ?? c.method, value: c.amount, color: PAY_COLOR[c.method] ?? 'var(--muted)' }))} />
              : <p className="muted small">Aucun encaissement sur la période.</p>}
          </ChartCard>
        </div>

        <div className="dash-grid">
          <section className="card">
            <header><h2>Compte de résultat</h2><span className="small muted">période précédente : du {date(r.previous.from)} au {date(r.previous.to)}</span></header>
            <div className="table-wrap"><table className="report-pl">
              <thead><tr><th>Poste</th><th className="n">Période</th><th className="n">Précédente</th></tr></thead>
              <tbody>
                <tr><td>Ventes HT (avoirs déduits)</td><td className="n">{fcfa(t.salesHt)}</td><td className="n muted">{fcfa(p.salesHt)}</td></tr>
                <tr><td>− Coût des marchandises vendues</td><td className="n">{minus(t.cogs)}</td><td className="n muted">{minus(p.cogs)}</td></tr>
                <tr className="sub"><td>Marge brute</td><td className="n">{fcfa(t.grossMargin)}</td><td className="n muted">{fcfa(p.grossMargin)}</td></tr>
                {r.expensesByCategory.map((e: any) => <tr key={e.key}><td>− {POSTS[e.key] ?? e.key}</td><td className="n">{minus(e.amount)}</td>
                  <td className="n muted">{minus(r.previousExpensesByCategory.find((x: any) => x.key === e.key)?.amount ?? 0)}</td></tr>)}
                {t.otherIncome !== 0 || p.otherIncome !== 0 ? <tr><td>+ Autres recettes</td><td className="n">{fcfa(t.otherIncome)}</td><td className="n muted">{fcfa(p.otherIncome)}</td></tr> : null}
                <tr className="total"><td>Résultat</td><td className="n">{fcfa(t.result)}</td><td className="n muted">{fcfa(p.result)}</td></tr>
              </tbody>
            </table></div>
          </section>
          <div className="stack">
            <section className="card"><header><h2>Dépenses par poste</h2></header>
              {r.expensesByCategory.filter((e: any) => e.amount > 0).length
                ? <RankedBars items={r.expensesByCategory.filter((e: any) => e.amount > 0).map((e: any) => ({ label: POSTS[e.key] ?? e.key, value: e.amount }))} />
                : <p className="muted small" style={{ margin: 0 }}>Aucune dépense sur la période.</p>}
            </section>
            <section className="card"><header><h2>Articles les plus vendus</h2><span className="small muted">hors taxes</span></header>
              {r.topProducts.length
                ? <RankedBars items={r.topProducts.map((x: any) => ({ label: x.name, value: x.salesHt, detail: `${x.quantity.toLocaleString('fr-FR')} ${x.unit ?? ''}`.trim() }))} />
                : <p className="muted small" style={{ margin: 0 }}>Aucune vente d&apos;article sur la période.</p>}
            </section>
          </div>
        </div>

        <p className="small muted" style={{ margin: 0 }}>
          Résultat de gestion calculé sur vos opérations : ventes moins coût des marchandises vendues (au coût moyen), dépenses de trésorerie hors retraits de l&apos;exploitant,
          achats facturés hors marchandises stockées, pertes de stock et écarts. Les achats de marchandises comptent au moment de leur vente.
          {r.payrollIncluded ? ' Les charges de personnel sont celles des paies validées dont le mois se termine dans la période.' : ' Les charges de personnel des paies n’y figurent pas (module Paie absent, site choisi, ou permission « voir les salaires » manquante).'}
          {' '}Les états comptables officiels restent dans Comptabilité.
        </p>
      </div>}
    </>
  );
}
