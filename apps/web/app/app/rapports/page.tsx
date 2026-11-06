'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, useAction } from '@/components/ui';
import { CustomersReport, customersCsv, downloadCsv, ManagementReport, managementCsv, StockReport, stockCsv, SuppliersReport, suppliersCsv } from '@/components/reports';
import { date } from '@/lib/format';

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

/** Les rapports : adresse de l'API, titre, sous-titre, export et rendu. */
const VIEWS = {
  gestion: { label: 'Gestion', path: 'management', title: 'Rapport de gestion', about: 'Rentabilité', csv: managementCsv, Body: ManagementReport },
  stocks: { label: 'Stocks', path: 'stock', title: 'Rapport des stocks', about: 'Stocks', csv: stockCsv, Body: StockReport },
  clients: { label: 'Clients', path: 'customers', title: 'Rapport clients', about: 'Clients', csv: customersCsv, Body: CustomersReport },
  fournisseurs: { label: 'Fournisseurs', path: 'suppliers', title: 'Rapport fournisseurs', about: 'Fournisseurs', csv: suppliersCsv, Body: SuppliersReport },
} as const;
type View = keyof typeof VIEWS;

/** Module Rapports : une période commune, quatre rapports (gestion, stocks, clients, fournisseurs). */
export default function ReportsPage() {
  const { can, ctx } = useSession();
  const views = (Object.keys(VIEWS) as View[]).filter((v) => v !== 'fournisseurs' || ctx?.entitlements.modules.includes('purchases'));
  const [wanted, setView] = useState<View>('gestion');
  // Onglet hors formule (fournisseurs sans le module Achats) : retour au rapport de gestion.
  const view: View = views.includes(wanted) ? wanted : 'gestion';
  const [[from, to], setRange] = useState<[string, string]>(() => [firstOfMonth(), today()]);
  const [r, setR] = useState<{ view: View; data: any } | null>(null);
  const { busy, error, run } = useAction();

  // Onglet retenu dans l'adresse (?vue=stocks), pour le partager ou y revenir.
  useEffect(() => { const v = new URLSearchParams(window.location.search).get('vue') as View | null; if (v && v in VIEWS) setView(v); }, []);
  const pick = (v: View) => { setView(v); window.history.replaceState(null, '', v === 'gestion' ? '/app/rapports' : `/app/rapports?vue=${v}`); };
  useEffect(() => {
    if (from && to && from <= to) run(async () => setR({ view, data: await api(`/company/reports/${VIEWS[view].path}?from=${from}&to=${to}`) }));
  }, [view, from, to]); // eslint-disable-line

  const v = VIEWS[view];
  const data = r?.view === view ? r.data : null;
  const site = ctx?.siteId ? ` · ${ctx.sites.find((s) => s.id === ctx.siteId)?.name}` : '';
  return (
    <>
      <div className="page-head">
        <div><h1>{v.title}</h1><p className="small muted" style={{ margin: 0 }}>{v.about} de {ctx?.company.name ?? "l'entreprise"}{site}, du {date(from)} au {date(to)}</p></div>
        <div className="row no-print">
          {can('reports.export') && <button className="btn" disabled={!data} onClick={() => downloadCsv(`rapport-${view}-${from}-${to}.csv`, v.csv(data))}>Exporter (CSV)</button>}
          <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button>
        </div>
      </div>
      <div className="seg report-tabs no-print" role="tablist">
        {views.map((k) => <button key={k} type="button" role="tab" aria-selected={k === view} aria-pressed={k === view} onClick={() => pick(k)}>{VIEWS[k].label}</button>)}
      </div>
      <div className="card row report-range no-print">
        <label className="field">Du<input className="input" type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} /></label>
        <label className="field">Au<input className="input" type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} /></label>
        <div className="seg">{PRESETS.map(([l, f]) => { const [a, b] = f(); return <button key={l} type="button" aria-pressed={a === from && b === to} onClick={() => setRange([a, b])}>{l}</button>; })}</div>
      </div>
      <Alert>{error}</Alert>
      {data && <div className="stack report" style={{ opacity: busy ? 0.6 : 1 }}><v.Body r={data} /></div>}
    </>
  );
}
