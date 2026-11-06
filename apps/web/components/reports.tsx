'use client';
import { ChartCard, Donut, fcfa, LineChart, monthLong, monthTick, RankedBars } from './charts';
import { Pill } from './ui';
import { date, EXPENSE_CATEGORIES, ISSUE_REASONS, PAYMENT_METHODS, qty, RECEIPT_REASONS } from '@/lib/format';

/** Rapports du module Rapports : gestion, stocks, clients, fournisseurs. Chacun reçoit la réponse de l'API et sait l'exporter. */

type Row = (string | number)[];

/** Libellés des postes de dépense propres au rapport, en plus des catégories de trésorerie. */
const POSTS: Record<string, string> = {
  ...EXPENSE_CATEGORIES, purchases: 'Achats de services et fournitures', stock_issues: 'Pertes et consommations de stock',
  inventory: "Écarts d'inventaire", cash_difference: 'Écarts de caisse', payroll: 'Charges de personnel (paie)',
};
const PAY_COLOR: Record<string, string> = { cash: 'var(--pay-cash)', mobile_money: 'var(--pay-mobile)', bank_transfer: 'var(--pay-transfer)', cheque: 'var(--pay-cheque)', card: 'var(--pay-card)' };

/** Nature d'un flux de stock : origine du mouvement, motif du bon pour les entrées et sorties manuelles. */
const flowLabel = (key: string) => {
  const [kind, reason] = key.split(':');
  if (kind === 'issue') return ISSUE_REASONS[reason] ?? 'Autre sortie';
  if (kind === 'receipt') return (RECEIPT_REASONS[reason] ?? 'Autre entrée').split(' (')[0];
  return ({ opening: 'Stock initial', purchase: 'Achats facturés', sale: 'Ventes', sale_return: 'Retours clients', adjustment: "Écarts d'inventaire", cancellation: 'Annulations de factures' } as Record<string, string>)[kind] ?? kind;
};
/** Couleur fixe par nature de sortie (jamais selon le rang) ; les natures rares partagent le gris. */
const FLOW_COLOR: Record<string, string> = { sale: 'var(--pay-cash)', adjustment: 'var(--pay-mobile)', 'issue:loss': 'var(--pay-cheque)', 'issue:consumption': 'var(--pay-transfer)', 'issue:expired': 'var(--pay-card)' };

/** Âge des créances et échéances des dettes : du plus sain au plus urgent, même teinte qui fonce. */
const AGE: Record<string, [string, string]> = {
  notDue: ['Non échu', 'var(--age-0)'], d30: ['1 à 30 jours de retard', 'var(--age-1)'], d60: ['31 à 60 jours', 'var(--age-2)'], d90: ['61 à 90 jours', 'var(--age-3)'], more: ['Plus de 90 jours', 'var(--age-4)'],
};
const DUE: Record<string, [string, string]> = {
  later: ['Dans plus de 30 jours', 'var(--age-0)'], month: ['Dans 8 à 30 jours', 'var(--age-1)'], week: ['Dans les 7 jours', 'var(--age-2)'], overdue: ['En retard', 'var(--age-4)'],
};

const pct = (a: number, b: number) => (b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
/** Montant retranché : « −x FCFA », et 0 sans signe. */
const minus = (v: number) => (v ? fcfa(-v) : fcfa(0));
export const dayTick = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
export const dayLong = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** Évolution par rapport à la période précédente ; « good » dit si une hausse est une bonne nouvelle (none : neutre). */
function Delta({ cur, prev, good = 'up' }: { cur: number; prev: number; good?: 'up' | 'down' | 'none' }) {
  const p = pct(cur, prev);
  if (p === null) return <span className="delta flat">{cur === 0 ? 'Comme la période précédente' : 'Période précédente : 0 FCFA'}</span>;
  const tone = good === 'none' || Math.abs(p) < 0.5 ? 'flat' : (p > 0) === (good === 'up') ? 'up' : 'down';
  return <span className={`delta ${tone}`}>{p > 0 ? '▲' : p < 0 ? '▼' : '='} {Math.abs(p).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % <span className="muted">vs {fcfa(prev)}</span></span>;
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="muted small" style={{ margin: 0 }}>{children}</p>;

/** Fichier CSV (séparateur point-virgule, UTF-8 avec BOM : s'ouvre tel quel dans Excel). */
export function downloadCsv(name: string, rows: Row[]) {
  const csv = '﻿' + rows.map((row) => row.map((v) => (typeof v === 'string' && /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(';')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: name });
  a.click(); URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ gestion

export function managementCsv(r: any): Row[] {
  const t = r.totals, p = r.previousTotals;
  return [['Poste', `Du ${date(r.from)} au ${date(r.to)}`, `Du ${date(r.previous.from)} au ${date(r.previous.to)}`],
    ['Chiffre d\'affaires TTC', t.salesTtc, p.salesTtc], ['Chiffre d\'affaires HT', t.salesHt, p.salesHt], ['Nombre de factures', t.invoices, p.invoices],
    ['Coût des marchandises vendues', t.cogs, p.cogs], ['Marge brute', t.grossMargin, p.grossMargin],
    ...r.expensesByCategory.map((e: any) => [`Dépense : ${POSTS[e.key] ?? e.key}`, e.amount, r.previousExpensesByCategory.find((x: any) => x.key === e.key)?.amount ?? 0]),
    ['Total des dépenses', t.expenses, p.expenses], ['Autres recettes', t.otherIncome, p.otherIncome], ['Résultat', t.result, p.result],
    [], ['Encaissements', 'Montant'], ...r.collections.map((c: any) => [PAYMENT_METHODS[c.method] ?? c.method, c.amount])];
}

/** Rapport de gestion : chiffre d'affaires, marge, dépenses et résultat, comparés à la période précédente. */
export function ManagementReport({ r }: { r: any }) {
  const t = r.totals, p = r.previousTotals;
  const byDay = r.trend.unit === 'day';
  return <>
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
          : <Empty>Aucun encaissement sur la période.</Empty>}
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
            : <Empty>Aucune dépense sur la période.</Empty>}
        </section>
        <section className="card"><header><h2>Articles les plus vendus</h2><span className="small muted">hors taxes</span></header>
          {r.topProducts.length
            ? <RankedBars items={r.topProducts.map((x: any) => ({ label: x.name, value: x.salesHt, detail: `${x.quantity.toLocaleString('fr-FR')} ${x.unit ?? ''}`.trim() }))} />
            : <Empty>Aucune vente d&apos;article sur la période.</Empty>}
        </section>
      </div>
    </div>

    <p className="small muted" style={{ margin: 0 }}>
      Résultat de gestion calculé sur vos opérations : ventes moins coût des marchandises vendues (au coût moyen), dépenses de trésorerie hors retraits de l&apos;exploitant,
      achats facturés hors marchandises stockées, pertes de stock et écarts. Les achats de marchandises comptent au moment de leur vente.
      {r.payrollIncluded ? ' Les charges de personnel sont celles des paies validées dont le mois se termine dans la période.' : ' Les charges de personnel des paies n’y figurent pas (module Paie absent, site choisi, ou permission « voir les salaires » manquante).'}
      {' '}Les états comptables officiels restent dans Comptabilité.
    </p>
  </>;
}

// ------------------------------------------------------------------ stocks

const STOCK_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = { out: ['Rupture', 'crit'], low: ['Stock bas', 'warn'], dormant: ['Sans vente', 'mute'], ok: ['Normal', 'ok'] };

export function stockCsv(r: any): Row[] {
  const t = r.totals;
  return [['Indicateur', 'Valeur'], ['Valeur du stock au début', t.valueStart], ['Valeur du stock à la fin', t.valueEnd], ['Coût des ventes', t.cogs],
    ['Rotation (fois)', t.turnover ?? ''], ['Couverture (jours)', t.coverDays ?? ''], [],
    ['Nature', 'Entrées (valeur)', 'Sorties (valeur)'], ...r.flows.map((f: any) => [flowLabel(f.key), f.in, f.out]), [],
    ['Code', 'Article', 'Unité', 'Stock début', 'Entrées', 'Sorties', 'Stock fin', 'Vendus', 'Valeur fin', 'Seuil', 'Couverture (jours)', 'État'],
    ...r.products.map((p: any) => [p.code, p.name, p.unit ?? '', p.qtyStart, p.qtyIn, p.qtyOut, p.qtyEnd, p.sold, p.valueEnd, p.minStock ?? '', p.coverDays ?? '', STOCK_STATUS[p.status][0]])];
}

/** Rapport des stocks : valeur, flux par nature, rotation, couverture et situation de chaque article. */
export function StockReport({ r }: { r: any }) {
  const t = r.totals;
  const byDay = r.unit === 'day';
  const outs = r.flows.filter((f: any) => f.out > 0 && f.key !== 'transfer').sort((a: any, b: any) => b.out - a.out);
  // Anneau : les 4 premières natures de sortie, le reste regroupé.
  const donut = [...outs.slice(0, 4).map((f: any) => ({ key: f.key, label: flowLabel(f.key), value: f.out, color: FLOW_COLOR[f.key] ?? 'var(--age-1)' })),
    ...(outs.length > 4 ? [{ key: 'other', label: 'Autres sorties', value: outs.slice(4).reduce((s: number, f: any) => s + f.out, 0), color: 'var(--muted)' }] : [])];
  return <>
    <div className="kpis report-kpis">
      <div className="card kpi"><div className="l">Valeur du stock</div><div className="v">{fcfa(t.valueEnd)}</div>
        <div className="small muted">au {date(r.to)}, au coût moyen</div><Delta cur={t.valueEnd} prev={t.valueStart} good="none" /></div>
      <div className="card kpi"><div className="l">Coût des ventes</div><div className="v">{fcfa(t.cogs)}</div>
        <div className="small muted">{t.turnover === null ? 'Rotation : —' : `Rotation : ${t.turnover.toLocaleString('fr-FR')} fois sur la période`}</div></div>
      <div className="card kpi"><div className="l">Couverture</div><div className="v">{t.coverDays === null ? '—' : `${t.coverDays.toLocaleString('fr-FR')} jours`}</div>
        <div className="small muted">{t.coverDays === null ? 'aucune vente sur la période' : 'de ventes au rythme de la période'}</div></div>
      <div className="card kpi"><div className="l">À surveiller</div><div className="v">{t.out + t.low}</div>
        <div className="small muted">{t.out} en rupture · {t.low} sous le seuil · {t.dormant} sans vente</div></div>
    </div>

    <div className="report-grid">
      <ChartCard title="Valeur du stock" subtitle={byDay ? 'En fin de journée, au coût moyen' : 'En fin de mois, au coût moyen'}
        table={{ head: [byDay ? 'Jour' : 'Mois', 'Valeur'], rows: r.trend.map((x: any) => [byDay ? dayLong(x.key) : monthLong(x.key), fcfa(x.value)]) }}>
        <LineChart categories={r.trend.map((x: any) => x.key)} values={r.trend.map((x: any) => x.value)} color="var(--series-1)" label="Valeur du stock" height={240}
          tick={byDay ? (c: string) => dayTick(c) : monthTick} long={byDay ? dayLong : monthLong} />
      </ChartCard>
      <ChartCard title="Sorties de stock" subtitle="Par nature, en valeur"
        table={{ head: ['Nature', 'Valeur'], rows: outs.map((f: any) => [flowLabel(f.key), fcfa(f.out)]) }}>
        {donut.length ? <Donut label="Sorties de stock" items={donut} /> : <Empty>Aucune sortie sur la période.</Empty>}
      </ChartCard>
    </div>

    <section className="card">
      <header><h2>Entrées et sorties par nature</h2><span className="small muted">en valeur, transferts entre entrepôts exclus</span></header>
      {r.flows.filter((f: any) => f.key !== 'transfer').length ? <div className="table-wrap"><table>
        <thead><tr><th>Nature</th><th className="n">Entrées</th><th className="n">Sorties</th></tr></thead>
        <tbody>{r.flows.filter((f: any) => f.key !== 'transfer').map((f: any) => <tr key={f.key}><td>{flowLabel(f.key)}</td><td className="n">{f.in ? fcfa(f.in) : '—'}</td><td className="n">{f.out ? fcfa(f.out) : '—'}</td></tr>)}
          <tr className="total"><td><b>Total</b></td><td className="n"><b>{fcfa(t.valueIn)}</b></td><td className="n"><b>{fcfa(t.valueOut)}</b></td></tr></tbody>
      </table></div> : <Empty>Aucun mouvement sur la période.</Empty>}
    </section>

    <section className="card">
      <header><h2>Situation par article</h2><span className="small muted">quantités sur la période, valeur au {date(r.to)}</span></header>
      {r.products.length ? <div className="table-wrap"><table>
        <thead><tr><th>Article</th><th className="n">Début</th><th className="n">Entrées</th><th className="n">Sorties</th><th className="n">Fin</th><th className="n">Valeur</th><th className="n">Vendus</th><th className="n">Couverture</th><th>État</th></tr></thead>
        <tbody>{r.products.map((p: any) => (
          <tr key={p.code}><td><b>{p.name}</b><div className="small muted">{p.code}</div></td>
            <td className="n">{qty(p.qtyStart)}</td><td className="n">{qty(p.qtyIn)}</td><td className="n">{qty(p.qtyOut)}</td>
            <td className="n"><b>{qty(p.qtyEnd)}</b> <span className="small muted">{p.unit}</span></td><td className="n">{fcfa(p.valueEnd)}</td><td className="n">{qty(p.sold)}</td>
            <td className="n">{p.coverDays === null ? '—' : `${p.coverDays} j`}</td><td><Pill tone={STOCK_STATUS[p.status][1]}>{STOCK_STATUS[p.status][0]}</Pill></td></tr>))}</tbody>
      </table></div> : <Empty>Aucun article suivi en stock.</Empty>}
    </section>
    <p className="small muted" style={{ margin: 0 }}>Valeur au coût moyen pondéré. Rotation = coût des ventes / stock moyen de la période. Couverture = nombre de jours de ventes que le stock final permet de servir, au rythme de la période.</p>
  </>;
}

// ------------------------------------------------------------------ clients

export function customersCsv(r: any): Row[] {
  const t = r.totals;
  return [['Indicateur', 'Valeur'], ['Ventes HT', t.salesHt], ['Ventes HT période précédente', t.previousHt], ['Clients actifs', t.active], ['Nouveaux clients', t.newCustomers],
    ['Panier moyen HT', t.averageBasket], ['Encaissé sur la période', t.collected], ['Reste à encaisser', t.due], ['Dont en retard', t.overdue], ['Délai moyen de paiement (jours)', t.paymentDays ?? ''], [],
    ['Balance âgée', 'Montant'], ...r.aging.map((a: any) => [AGE[a.key][0], a.amount]), [],
    ['Code', 'Client', 'Ventes HT', 'Période précédente', 'Factures', 'Encaissé', 'Reste dû', 'En retard', 'Dernière facture', 'Nouveau'],
    ...r.customers.map((c: any) => [c.code, c.name, c.salesHt, c.previousHt, c.invoices, c.collected, c.due, c.overdue, c.last ?? '', c.isNew ? 'oui' : ''])];
}

/** Rapport clients : qui achète, combien, qui paie, qui doit encore et depuis quand. */
export function CustomersReport({ r }: { r: any }) {
  const t = r.totals;
  const active = r.customers.filter((c: any) => c.salesHt > 0);
  const aging = r.aging.filter((a: any) => a.amount > 0);
  return <>
    <div className="kpis report-kpis">
      <div className="card kpi"><div className="l">Ventes HT</div><div className="v">{fcfa(t.salesHt)}</div>
        <div className="small muted">{t.active} client{t.active > 1 ? 's' : ''} actif{t.active > 1 ? 's' : ''} · {t.newCustomers} nouveau{t.newCustomers > 1 ? 'x' : ''}</div><Delta cur={t.salesHt} prev={t.previousHt} /></div>
      <div className="card kpi"><div className="l">Panier moyen</div><div className="v">{fcfa(t.averageBasket)}</div>
        <div className="small muted">HT par facture · {t.invoices} facture{t.invoices > 1 ? 's' : ''}</div></div>
      <div className="card kpi"><div className="l">Encaissé</div><div className="v">{fcfa(t.collected)}</div>
        <div className="small muted">{t.paymentDays === null ? 'délai de paiement : —' : `payé en ${t.paymentDays} jour${t.paymentDays > 1 ? 's' : ''} en moyenne`}</div></div>
      <div className={`card kpi result ${t.overdue > 0 ? 'neg' : ''}`}><div className="l">Reste à encaisser</div><div className="v">{fcfa(t.due)}</div>
        <div className="small muted">{t.overdue > 0 ? `dont ${fcfa(t.overdue)} en retard` : 'aucun retard'} · à ce jour</div></div>
    </div>

    <div className="report-grid">
      <section className="card"><header><h2>Meilleurs clients</h2><span className="small muted">{t.topShare !== null ? `le premier pèse ${t.topShare} % des ventes` : 'ventes HT, avoirs déduits'}</span></header>
        {active.length ? <RankedBars items={active.slice(0, 10).map((c: any) => ({ label: c.name, value: c.salesHt, detail: `${c.invoices} fact.` }))} /> : <Empty>Aucune vente sur la période.</Empty>}
      </section>
      <ChartCard title="Balance âgée" subtitle="Reste à encaisser à ce jour, par retard"
        table={{ head: ['Retard', 'Montant'], rows: r.aging.map((a: any) => [AGE[a.key][0], fcfa(a.amount)]) }}>
        {aging.length ? <Donut label="Balance âgée" items={aging.map((a: any) => ({ key: a.key, label: AGE[a.key][0], value: a.amount, color: AGE[a.key][1] }))} /> : <Empty>Rien à encaisser.</Empty>}
      </ChartCard>
    </div>

    <section className="card">
      <header><h2>Détail par client</h2><span className="small muted">ventes et encaissements de la période, reste dû à ce jour</span></header>
      {r.customers.length ? <div className="table-wrap"><table>
        <thead><tr><th>Client</th><th className="n">Ventes HT</th><th className="n">Évolution</th><th className="n">Factures</th><th className="n">Encaissé</th><th className="n">Reste dû</th><th className="n">En retard</th><th>Dernière facture</th></tr></thead>
        <tbody>{r.customers.map((c: any) => {
          const e = pct(c.salesHt, c.previousHt);
          return <tr key={c.id}><td><b>{c.name}</b> {c.isNew && <Pill tone="ok">Nouveau</Pill>}<div className="small muted">{c.code}</div></td>
            <td className="n">{fcfa(c.salesHt)}</td>
            <td className="n">{e === null ? <span className="muted">—</span> : <span className={`delta ${e >= 0 ? 'up' : 'down'}`}>{e > 0 ? '▲' : '▼'} {Math.abs(Math.round(e))} %</span>}</td>
            <td className="n">{c.invoices}</td><td className="n">{fcfa(c.collected)}</td><td className="n">{c.due ? fcfa(c.due) : '—'}</td>
            <td className="n">{c.overdue ? <b style={{ color: 'var(--crit)' }}>{fcfa(c.overdue)}</b> : '—'}</td><td className="small">{c.last ? date(c.last) : '—'}</td></tr>;
        })}</tbody>
      </table></div> : <Empty>Aucun client sur la période.</Empty>}
    </section>
    <p className="small muted" style={{ margin: 0 }}>Ventes : factures émises moins avoirs, hors taxes. Délai de paiement : de l&apos;émission au dernier encaissement des factures soldées dans la période. Reste dû et retards : situation à ce jour, quelle que soit la période.</p>
  </>;
}

// ------------------------------------------------------------------ fournisseurs

export function suppliersCsv(r: any): Row[] {
  const t = r.totals;
  return [['Indicateur', 'Valeur'], ['Achats HT', t.purchasesHt], ['Achats HT période précédente', t.previousHt], ['Fournisseurs actifs', t.active], ['Réglé sur la période', t.paid],
    ['Reste à payer', t.due], ['Dont en retard', t.overdue], ['À payer dans les 7 jours', t.dueSoon], [],
    ['Échéancier', 'Montant'], ...r.schedule.map((s: any) => [DUE[s.key][0], s.amount]), [],
    ['Code', 'Fournisseur', 'Achats HT', 'Période précédente', 'Factures', 'Réglé', 'Reste dû', 'En retard', 'Dans les 7 jours', 'Dernière facture'],
    ...r.suppliers.map((s: any) => [s.code, s.name, s.purchasesHt, s.previousHt, s.invoices, s.paid, s.due, s.overdue, s.dueSoon, s.last ?? ''])];
}

/** Rapport fournisseurs : à qui l'on achète, ce qui a été réglé, ce qui reste dû et quand. */
export function SuppliersReport({ r }: { r: any }) {
  const t = r.totals;
  const active = r.suppliers.filter((s: any) => s.purchasesHt > 0);
  const schedule = ['overdue', 'week', 'month', 'later'].map((k) => r.schedule.find((s: any) => s.key === k)).filter((s: any) => s && s.amount > 0);
  return <>
    <div className="kpis report-kpis">
      <div className="card kpi"><div className="l">Achats HT</div><div className="v">{fcfa(t.purchasesHt)}</div>
        <div className="small muted">{t.active} fournisseur{t.active > 1 ? 's' : ''} · {t.invoices} facture{t.invoices > 1 ? 's' : ''}</div><Delta cur={t.purchasesHt} prev={t.previousHt} good="none" /></div>
      <div className="card kpi"><div className="l">Réglé</div><div className="v">{fcfa(t.paid)}</div><div className="small muted">sur la période</div></div>
      <div className={`card kpi result ${t.overdue > 0 ? 'neg' : ''}`}><div className="l">Reste à payer</div><div className="v">{fcfa(t.due)}</div>
        <div className="small muted">{t.overdue > 0 ? `dont ${fcfa(t.overdue)} en retard` : 'aucun retard'} · à ce jour</div></div>
      <div className="card kpi"><div className="l">À payer sous 7 jours</div><div className="v">{fcfa(t.dueSoon)}</div><div className="small muted">à prévoir en trésorerie</div></div>
    </div>

    <div className="report-grid">
      <section className="card"><header><h2>Principaux fournisseurs</h2><span className="small muted">{t.topShare !== null ? `le premier pèse ${t.topShare} % des achats` : 'achats HT facturés'}</span></header>
        {active.length ? <RankedBars items={active.slice(0, 10).map((s: any) => ({ label: s.name, value: s.purchasesHt, detail: `${s.invoices} fact.` }))} /> : <Empty>Aucun achat facturé sur la période.</Empty>}
      </section>
      <ChartCard title="Échéancier" subtitle="Reste à payer à ce jour, par échéance"
        table={{ head: ['Échéance', 'Montant'], rows: r.schedule.map((s: any) => [DUE[s.key][0], fcfa(s.amount)]) }}>
        {schedule.length ? <Donut label="Échéancier fournisseurs" items={schedule.map((s: any) => ({ key: s.key, label: DUE[s.key][0], value: s.amount, color: DUE[s.key][1] }))} /> : <Empty>Rien à payer.</Empty>}
      </ChartCard>
    </div>

    <section className="card">
      <header><h2>Détail par fournisseur</h2><span className="small muted">achats et règlements de la période, reste dû à ce jour</span></header>
      {r.suppliers.length ? <div className="table-wrap"><table>
        <thead><tr><th>Fournisseur</th><th className="n">Achats HT</th><th className="n">Évolution</th><th className="n">Factures</th><th className="n">Réglé</th><th className="n">Reste dû</th><th className="n">En retard</th><th className="n">Sous 7 jours</th><th>Dernière facture</th></tr></thead>
        <tbody>{r.suppliers.map((s: any) => {
          const e = pct(s.purchasesHt, s.previousHt);
          return <tr key={s.id}><td><b>{s.name}</b><div className="small muted">{s.code}</div></td>
            <td className="n">{fcfa(s.purchasesHt)}</td><td className="n">{e === null ? <span className="muted">—</span> : <span className="delta flat">{e > 0 ? '▲' : '▼'} {Math.abs(Math.round(e))} %</span>}</td>
            <td className="n">{s.invoices}</td><td className="n">{fcfa(s.paid)}</td><td className="n">{s.due ? fcfa(s.due) : '—'}</td>
            <td className="n">{s.overdue ? <b style={{ color: 'var(--crit)' }}>{fcfa(s.overdue)}</b> : '—'}</td><td className="n">{s.dueSoon ? fcfa(s.dueSoon) : '—'}</td>
            <td className="small">{s.last ? date(s.last) : '—'}</td></tr>;
        })}</tbody>
      </table></div> : <Empty>Aucun fournisseur sur la période.</Empty>}
    </section>
    <p className="small muted" style={{ margin: 0 }}>Achats : factures fournisseurs validées, hors taxes. Reste à payer et échéances : situation à ce jour, quelle que soit la période.</p>
  </>;
}
