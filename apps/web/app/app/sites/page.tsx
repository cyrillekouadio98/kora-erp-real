'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const PERIODS: Record<string, [string, () => [string, string]]> = {
  month: ['Ce mois-ci', () => [`${today().slice(0, 7)}-01`, today()]],
  quarter: ['Ce trimestre', () => { const d = new Date(); const m = Math.floor(d.getMonth() / 3) * 3 + 1; return [`${d.getFullYear()}-${String(m).padStart(2, '0')}-01`, today()]; }],
  year: ['Cette année', () => [`${today().slice(0, 4)}-01-01`, today()]],
};

/** Indicateurs comparés, dans l'ordre du tableau ; « sum » : la ligne de total les additionne. */
const COLUMNS: { key: string; label: string; money?: boolean; hint?: string }[] = [
  { key: 'salesHt', label: "Chiffre d'affaires HT", money: true, hint: 'Factures émises moins avoirs, sur la période' },
  { key: 'collected', label: 'Encaissé', money: true, hint: 'Encaissements des factures du site sur la période' },
  { key: 'receivable', label: 'À recevoir', money: true, hint: 'Reste dû par les clients, à ce jour' },
  { key: 'purchasesHt', label: 'Achats HT', money: true, hint: 'Factures fournisseurs de la période' },
  { key: 'payable', label: 'À payer', money: true, hint: 'Reste dû aux fournisseurs, à ce jour' },
  { key: 'cash', label: 'Trésorerie', money: true, hint: 'Solde des caisses et comptes du site en fin de période' },
  { key: 'stockValue', label: 'Valeur du stock', money: true, hint: 'Stock des entrepôts du site au coût moyen, à ce jour' },
  { key: 'employees', label: 'Effectif', hint: 'Employés affectés au site' },
  { key: 'result', label: 'Résultat', money: true, hint: 'Produits moins charges des écritures du site (classes 6 et 7)' },
];

/** Comparatif des sites : ventes, encaissements, restes dus, trésorerie, stock, effectif et résultat de chaque magasin ou succursale. */
export default function SitesOverview() {
  const { ctx, can } = useSession();
  const [period, setPeriod] = useState<string>('month');
  const [range, setRange] = useState<[string, string]>(PERIODS.month[1]());
  const [data, setData] = useState<any>(null);
  const { error, run } = useAction();
  useEffect(() => { run(async () => setData(await api(`/company/sites/overview?from=${range[0]}&to=${range[1]}`))); }, [range]); // eslint-disable-line
  const pick = (k: string) => { setPeriod(k); if (PERIODS[k]) setRange(PERIODS[k][1]()); };
  const rows: any[] = data?.sites ?? [];
  const total = (k: string) => rows.reduce((s, r) => s + r[k], 0);
  const best = Math.max(1, ...rows.map((r) => r.salesHt));
  const show = async (siteId: string) => { await api('/company/sites/active', { body: { siteId } }); window.location.href = '/app/tableau-de-bord'; };

  return (
    <>
      <div className="page-head"><h1>Comparatif des sites</h1>
        <div className="row">
          {can('settings.admin') && <Link className="btn" href="/app/sites/parametres">Gérer les sites</Link>}
          <button className="btn" onClick={() => window.print()}>Imprimer / PDF</button></div></div>
      <Alert>{error}</Alert>
      {ctx?.siteId && <Alert kind="info">L'en-tête affiche un seul site : le comparatif ne montre que lui. Choisissez « Tous les sites » pour comparer.</Alert>}
      <div className="row no-print">
        <div className="seg" role="group" aria-label="Période">
          {Object.entries(PERIODS).map(([k, [l]]) => <button key={k} type="button" aria-pressed={period === k} onClick={() => pick(k)}>{l}</button>)}
          <button type="button" aria-pressed={period === 'custom'} onClick={() => setPeriod('custom')}>Autre période</button></div>
        {period === 'custom' && <>
          <div style={{ width: 170 }}><Field label="Du" type="date" value={range[0]} max={range[1]} onChange={(e) => setRange([e.target.value, range[1]])} /></div>
          <div style={{ width: 170 }}><Field label="Au" type="date" value={range[1]} min={range[0]} onChange={(e) => setRange([range[0], e.target.value])} /></div></>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Du {date(range[0])} au {date(range[1])}{ctx?.company ? ` · ${ctx.company.name}` : ''}</p>

      {data && <>
        <div className="vg-grid">
          {rows.map((r) => (
            <div key={r.id} className="card site-card">
              <header><div><b>{r.name}</b> {r.isDefault && <Pill tone="ok">Principal</Pill>}<div className="small muted">{[r.code, r.city].filter(Boolean).join(' · ')}</div></div>
                <button className="btn sm no-print" onClick={() => show(r.id)} title="Afficher toute l'application pour ce site">Ouvrir</button></header>
              <div className="site-bar" title={`${Math.round((r.salesHt / best) * 100)} % du meilleur site`}><span style={{ width: `${Math.max(0, (r.salesHt / best) * 100)}%` }} /></div>
              <dl className="site-kpis">
                <dt>Chiffre d'affaires HT</dt><dd><b>{money(r.salesHt)}</b> <span className="small muted">({r.invoices} fact.)</span></dd>
                <dt>Encaissé</dt><dd>{money(r.collected)}</dd>
                <dt>Trésorerie</dt><dd>{money(r.cash)}</dd>
                <dt>Valeur du stock</dt><dd>{money(r.stockValue)}</dd>
                <dt>Résultat</dt><dd style={{ color: r.result < 0 ? 'var(--crit)' : undefined }}>{money(r.result)}</dd>
              </dl>
            </div>))}
        </div>

        <div className="table-wrap"><table>
          <thead><tr><th>Site</th>{COLUMNS.map((c) => <th key={c.key} className="n" title={c.hint}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.id}><td><b>{r.name}</b><div className="small muted">{r.code}</div></td>
              {COLUMNS.map((c) => <td key={c.key} className="n" style={{ whiteSpace: 'nowrap', color: c.key === 'result' && r[c.key] < 0 ? 'var(--crit)' : undefined }}>{c.money ? money(r[c.key]) : r[c.key]}</td>)}</tr>)}
            {data.common !== null && data.common !== 0 && <tr><td><b>Commun à l'entreprise</b><div className="small muted">Paie, opérations diverses</div></td>
              {COLUMNS.map((c) => <td key={c.key} className="n">{c.key === 'result' ? money(data.common) : <span className="muted">—</span>}</td>)}</tr>}
            {rows.length > 1 && <tr style={{ fontWeight: 700 }}><td>Total</td>
              {COLUMNS.map((c) => { const v = total(c.key) + (c.key === 'result' ? data.common ?? 0 : 0); return <td key={c.key} className="n" style={{ whiteSpace: 'nowrap' }}>{c.money ? money(v) : v}</td>; })}</tr>}
          </tbody>
        </table></div>
        <p className="small muted" style={{ margin: 0 }}>
          Chaque vente, achat, mouvement de caisse et document de stock appartient à un site. Le résultat d'un site reprend les produits et charges de ses écritures ;
          la paie et les opérations diverses restent communes à l'entreprise. Les clients, fournisseurs, articles et la comptabilité légale sont partagés par tous les sites.
        </p>
      </>}
    </>
  );
}
