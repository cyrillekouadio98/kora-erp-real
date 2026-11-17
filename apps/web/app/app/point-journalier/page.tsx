'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, useAction } from '@/components/ui';
import { downloadCsv } from '@/components/reports';
import { date, money } from '@/lib/format';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
const firstOfMonth = (offset = 0) => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth() + offset, 1))); };
const lastOfMonth = (offset = 0) => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth() + offset + 1, 0))); };
const PRESETS: [string, () => [string, string]][] = [
  ["Aujourd'hui", () => [today(), today()]],
  ['Hier', () => [daysAgo(1), daysAgo(1)]],
  ['7 derniers jours', () => [daysAgo(6), today()]],
  ['Ce mois', () => [firstOfMonth(), today()]],
  ['Mois dernier', () => [firstOfMonth(-1), lastOfMonth(-1)]],
];
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
const pct = (part: number, of: number) => (of ? `${Math.round((part / of) * 100)} %` : '—');
const signed = (n: number) => <b style={{ color: n < 0 ? 'var(--crit)' : n > 0 ? 'var(--ok)' : undefined }}>{money(n)}</b>;

type Day = { date: string; salesTtc: number; salesHt: number; cashed: number; uncashed: number; invoices: number; cogs: number; margin: number; expenses: number; expenseCount: number; expenseLabels: string | null; result: number };
type Site = { siteId: string; siteCode: string; siteName: string; days: Day[]; totals: Omit<Day, 'date' | 'expenseLabels'> };

/** Point journalier : chaque site à part, jour par jour — ventes, coût des produits vendus, marge, dépenses de caisse, résultat. */
export default function DailyPointPage() {
  const { ctx, can } = useSession();
  const [[from, to], setRange] = useState<[string, string]>(() => [daysAgo(6), today()]);
  const [data, setData] = useState<{ sites: Site[] } | null>(null);
  const [all, setAll] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (from && to && from <= to) run(async () => setData(await api(`/company/reports/daily?from=${from}&to=${to}`))); }, [from, to]); // eslint-disable-line

  const exportCsv = () => downloadCsv(`point-journalier-${from}-${to}.csv`, [
    ['Site', 'Date', 'Ventes TTC', 'Ventes encaissées', 'Ventes non encaissées', 'Ventes HT', 'Coût des produits vendus', 'Marge', 'Dépenses de caisse', 'Résultat'],
    ...(data?.sites ?? []).flatMap((s) => [...s.days].reverse().map((d) => [s.siteName, d.date, d.salesTtc, d.cashed, d.uncashed, d.salesHt, d.cogs, d.margin, d.expenses, d.result])),
  ]);
  const shownSite = ctx?.siteId ? ` · ${ctx.sites.find((x) => x.id === ctx.siteId)?.name}` : '';

  return (
    <>
      <div className="page-head">
        <div><h1>Point journalier</h1><p className="small muted" style={{ margin: 0 }}>{ctx?.company.name}{shownSite}, du {date(from)} au {date(to)} — chaque site séparément</p></div>
        <div className="row no-print">
          {can('reports.export') && <button className="btn" disabled={!data} onClick={exportCsv}>Exporter (CSV)</button>}
          <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button>
        </div>
      </div>
      <div className="card row report-range no-print">
        <label className="field">Du<input className="input" type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} /></label>
        <label className="field">Au<input className="input" type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} /></label>
        <div className="seg">{PRESETS.map(([l, f]) => { const [a, b] = f(); return <button key={l} type="button" aria-pressed={a === from && b === to} onClick={() => setRange([a, b])}>{l}</button>; })}</div>
        <label className="row small" style={{ gap: 6, alignSelf: 'center' }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Afficher les jours sans activité</label>
      </div>
      <Alert>{error}</Alert>
      <p className="small muted no-print" style={{ margin: 0 }}>Ventes : factures et tickets de caisse, avoirs déduits. Encaissé : part des ventes du jour déjà payée (à ce jour) ; non encaissé : reste à payer par les clients sur ces ventes. Coût des produits vendus : sorties de stock des ventes au coût moyen. Marge = ventes HT − coût. Dépenses : saisies directement sur les caisses du site (hors retraits de l&apos;exploitant). Résultat = marge − dépenses de caisse.</p>
      {data && <div className="stack" style={{ opacity: busy ? 0.6 : 1 }}>
        {data.sites.map((s) => {
          const t = s.totals;
          const days = all ? s.days : s.days.filter((d) => d.salesTtc || d.cogs || d.expenses);
          return (
            <section key={s.siteId} className="card daily-site">
              <header><h2>{s.siteName} <span className="small muted">{s.siteCode}</span></h2></header>
              <div className="kpis report-kpis">
                <div className="card kpi"><div className="l">Ventes TTC</div><div className="v">{money(t.salesTtc)}</div><div className="small muted">{money(t.salesHt)} HT · {t.invoices} vente{t.invoices > 1 ? 's' : ''}</div></div>
                <div className="card kpi"><div className="l">Ventes encaissées</div><div className="v">{money(t.cashed)}</div><div className="small muted">{pct(t.cashed, t.salesTtc)} des ventes TTC</div></div>
                <div className={`card kpi${t.uncashed > 0 ? ' warn' : ''}`}><div className="l">Ventes non encaissées</div><div className="v">{money(t.uncashed)}</div><div className="small muted">reste à payer par les clients</div></div>
                <div className="card kpi"><div className="l">Coût des produits vendus</div><div className="v">{money(t.cogs)}</div><div className="small muted">au coût moyen</div></div>
                <div className="card kpi"><div className="l">Marge</div><div className="v">{money(t.margin)}</div><div className="small muted">{pct(t.margin, t.salesHt)} des ventes HT</div></div>
                <div className="card kpi"><div className="l">Dépenses de caisse</div><div className="v">{money(t.expenses)}</div><div className="small muted">{t.expenseCount} dépense{t.expenseCount > 1 ? 's' : ''}</div></div>
                <div className={`card kpi result ${t.result < 0 ? 'neg' : 'pos'}`}><div className="l">Résultat</div><div className="v">{money(t.result)}</div><div className="small muted">marge − dépenses de caisse</div></div>
              </div>
              <div className="table-wrap"><table>
                <thead><tr><th>Jour</th><th className="n">Ventes TTC</th><th className="n">Encaissées</th><th className="n">Non encaissées</th><th className="n">Ventes HT</th><th className="n">Coût des produits vendus</th><th className="n">Marge</th><th className="n">Dépenses de caisse</th><th className="n">Résultat</th></tr></thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.date}>
                      <td style={{ whiteSpace: 'nowrap' }}>{dayLabel(d.date)}<div className="small muted">{d.invoices} vente{d.invoices > 1 ? 's' : ''}</div></td>
                      <td className="n">{money(d.salesTtc)}</td>
                      <td className="n">{money(d.cashed)}</td>
                      <td className="n">{d.uncashed ? <b style={{ color: "var(--crit)" }}>{money(d.uncashed)}</b> : money(0)}</td>
                      <td className="n">{money(d.salesHt)}</td>
                      <td className="n">{money(d.cogs)}</td>
                      <td className="n">{money(d.margin)}<div className="small muted">{pct(d.margin, d.salesHt)}</div></td>
                      <td className="n" title={d.expenseLabels ?? ''}>{money(d.expenses)}{d.expenseLabels && <div className="small muted daily-labels">{d.expenseLabels}</div>}</td>
                      <td className="n">{signed(d.result)}</td>
                    </tr>
                  ))}
                  {!days.length && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>Aucune vente ni dépense de caisse sur cette période.</td></tr>}
                </tbody>
                {days.length > 1 && <tfoot><tr className="total">
                  <td><b>Total</b></td><td className="n"><b>{money(t.salesTtc)}</b></td><td className="n"><b>{money(t.cashed)}</b></td><td className="n"><b>{money(t.uncashed)}</b></td><td className="n"><b>{money(t.salesHt)}</b></td><td className="n"><b>{money(t.cogs)}</b></td>
                  <td className="n"><b>{money(t.margin)}</b></td><td className="n"><b>{money(t.expenses)}</b></td><td className="n">{signed(t.result)}</td>
                </tr></tfoot>}
              </table></div>
            </section>
          );
        })}
        {!data.sites.length && <p className="muted">Aucun site accessible.</p>}
      </div>}
    </>
  );
}
