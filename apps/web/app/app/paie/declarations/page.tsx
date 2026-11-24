'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { downloadCsv } from '@/lib/import-files';
import { useSession } from '@/components/session';
import { Alert, useAction } from '@/components/ui';

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const label = (p: string) => `${MONTHS[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const KINDS = { cnps: 'CNPS', its: 'ITS et taxes', disa: 'DISA (annuelle)' } as const;
type Kind = keyof typeof KINDS;

/** États préparatoires des déclarations CNPS, ITS et DISA, à partir des bulletins validés. */
export default function DeclarationsPage() {
  const { has, can, ctx } = useSession();
  const [kind, setKind] = useState<Kind>('cnps');
  const [monthly, setMonthly] = useState(true);
  const [period, setPeriod] = useState(lastMonth());
  const [year, setYear] = useState(Number(lastMonth().slice(0, 4)));
  const [data, setData] = useState<any>(null);
  const [employer, setEmployer] = useState('');
  const { busy, error, run } = useAction();
  // Période : un mois, le trimestre civil du mois choisi (CNPS des petites entreprises) ou l'année (DISA).
  const range = (): [string, string] => {
    if (kind === 'disa') return [`${year}-01`, `${year}-12`];
    if (kind === 'cnps' && !monthly) { const y = period.slice(0, 4), q = Math.floor((Number(period.slice(5)) - 1) / 3); return [`${y}-${String(q * 3 + 1).padStart(2, '0')}`, `${y}-${String(q * 3 + 3).padStart(2, '0')}`]; }
    return [period, period];
  };
  const [from, to] = range();
  useEffect(() => { if (has('social_declarations')) run(async () => { const d = await api<any>(`/company/payroll/declarations?from=${from}&to=${to}`); setData(d); setEmployer(d.company.cnpsEmployerNumber ?? ''); }); }, [from, to]); // eslint-disable-line
  if (!has('social_declarations')) return <Alert kind="warn">Les déclarations CNPS, ITS et DISA ne sont pas activées pour votre entreprise. Contactez Kora ERP pour les activer.</Alert>;

  const title = kind === 'disa' ? `DISA ${year}` : `${KINDS[kind]} — ${from === to ? label(from) : `${label(from)} à ${label(to)}`}`;
  const saveEmployer = () => run(async () => { await api('/company/payroll/declarations/employer', { method: 'PUT', body: { cnpsEmployerNumber: employer } }); setData({ ...data, company: { ...data.company, cnpsEmployerNumber: employer || null }, warnings: data.warnings.filter((w: string) => !w.startsWith("Le numéro d'employeur") || !employer) }); });
  const csv = () => {
    const e = data.employees;
    if (kind === 'its') downloadCsv(`its-${from}.csv`, [['Matricule', 'Nom', 'Brut imposable', 'ITS avant réduction', 'Réduction familiale', 'ITS retenu'], ...e.map((r: any) => [r.number, r.name, r.taxable, r.itsGross, r.itsReduction, r.its])]);
    else if (kind === 'cnps') downloadCsv(`cnps-${from}-${to}.csv`, [['Matricule', 'N° CNPS', 'Nom', 'Mois', 'Brut soumis', 'Base retraite', 'Retraite salarié', 'Retraite employeur', 'Base PF/AT', 'Prestations familiales', 'Accident du travail', 'CMU salarié', 'CMU employeur'],
      ...e.map((r: any) => [r.number, r.cnpsNumber ?? '', r.name, r.months, r.taxable, r.retirementBase, r.retirementEmployee, r.retirementEmployer, r.smallBase, r.familyBenefits, r.workAccident, r.cmuEmployee, r.cmuEmployer])]);
    else downloadCsv(`disa-${year}.csv`, [['Matricule', 'N° CNPS', 'Nom', 'Contrat', 'Premier mois', 'Dernier mois', 'Mois payés', 'Salaire brut', 'Brut imposable', 'Base retraite', 'Retraite salarié', 'Retraite employeur', 'ITS'],
      ...e.map((r: any) => [r.number, r.cnpsNumber ?? '', r.name, r.contractType, r.firstPeriod, r.lastPeriod, r.months, r.gross, r.taxable, r.retirementBase, r.retirementEmployee, r.retirementEmployer, r.its])]);
  };
  const c = data?.cnps, tx = data?.tax;
  return (
    <>
      <div className="page-head no-print"><h1>Déclarations</h1>
        <div className="row">{data?.employees.length > 0 && <><button className="btn" onClick={csv}>Exporter (CSV)</button><button className="btn" onClick={() => window.print()}>Imprimer</button></>}</div></div>
      <p className="muted no-print" style={{ margin: 0 }}>États préparés à partir des <b>bulletins validés</b> : vérifiez-les avant de les reporter sur les portails de la CNPS (e-CNPS) et de la DGI (e-impôts). Les taux appliqués sont ceux des paramètres de paie de chaque bulletin. Les stagiaires et occasionnels, sans cotisations ni impôt, n&apos;y figurent pas.</p>
      <div className="row no-print">
        {(Object.keys(KINDS) as Kind[]).map((k) => <button key={k} className={`btn sm${kind === k ? ' primary' : ''}`} onClick={() => setKind(k)}>{KINDS[k]}</button>)}
        {kind !== 'disa' ? <input className="input" type="month" style={{ width: 170 }} value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Mois" />
          : <select className="input" style={{ width: 110 }} value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Année">{Array.from({ length: 5 }, (_, i) => Number(lastMonth().slice(0, 4)) - i).map((y) => <option key={y} value={y}>{y}</option>)}</select>}
        {kind === 'cnps' && <select className="input" style={{ width: 160 }} value={monthly ? 'm' : 'q'} onChange={(e) => setMonthly(e.target.value === 'm')} aria-label="Périodicité"><option value="m">Mensuelle</option><option value="q">Trimestrielle</option></select>}
      </div>
      <Alert>{error}</Alert>
      {data && <>
        {data.warnings.length > 0 && <Alert kind="warn"><div style={{ display: 'grid', gap: 2 }}>{data.warnings.map((w: string) => <div key={w}>⚠ {w}</div>)}</div></Alert>}
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <header><h2>{title}</h2><span className="small muted">{data.company.name}</span></header>
          <div className="small" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 24px' }}>
            <span>NCC : <b>{data.company.taxId ?? '—'}</b></span><span>RCCM : <b>{data.company.rccm ?? '—'}</b></span>
            <span className="row" style={{ gap: 6, alignItems: 'center' }}>N° employeur CNPS : {can('payroll.admin') && !ctx?.readOnly
              ? <><input className="input no-print" style={{ width: 150 }} value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="À renseigner" aria-label="Numéro d'employeur CNPS" />
                {employer !== (data.company.cnpsEmployerNumber ?? '') && <button className="btn sm no-print" disabled={busy} onClick={saveEmployer}>Enregistrer</button>}<b className="print-only">{data.company.cnpsEmployerNumber}</b></>
              : <b>{data.company.cnpsEmployerNumber ?? '—'}</b>}</span>
            <span>Salariés déclarés : <b>{data.employees.length}</b></span>
          </div>
          {kind === 'cnps' && <>
            <div className="kpis">
              <div className="card kpi"><div className="l">Retraite (salarié + employeur)</div><div className="v">{money(c.retirement)}</div><div className="small muted">{money(c.retirementEmployee)} + {money(c.retirementEmployer)}</div></div>
              <div className="card kpi"><div className="l">Prestations familiales + AT</div><div className="v">{money(c.familyBenefits + c.workAccident)}</div><div className="small muted">{money(c.familyBenefits)} + {money(c.workAccident)}</div></div>
              <div className="card kpi"><div className="l">CMU</div><div className="v">{money(c.cmu)}</div></div>
              <div className="card kpi"><div className="l">Total à verser à la CNPS</div><div className="v">{money(c.total)}</div></div>
            </div>
            <div className="table-wrap"><table>
              <thead><tr><th>Salarié</th><th>N° CNPS</th>{!monthly && <th className="n">Mois</th>}<th className="n">Brut soumis</th><th className="n">Base retraite</th><th className="n">Retraite sal.</th><th className="n">Retraite empl.</th><th className="n">Base PF/AT</th><th className="n">PF</th><th className="n">AT</th><th className="n">CMU</th></tr></thead>
              <tbody>{data.employees.map((r: any) => <tr key={r.employeeId}><td>{r.name}</td><td style={{ color: r.cnpsNumber ? undefined : 'var(--crit)' }}>{r.cnpsNumber ?? 'à renseigner'}</td>{!monthly && <td className="n">{r.months}</td>}
                <td className="n">{money(r.taxable)}</td><td className="n">{money(r.retirementBase)}</td><td className="n">{money(r.retirementEmployee)}</td><td className="n">{money(r.retirementEmployer)}</td><td className="n">{money(r.smallBase)}</td><td className="n">{money(r.familyBenefits)}</td><td className="n">{money(r.workAccident)}</td><td className="n">{money(r.cmuEmployee + r.cmuEmployer)}</td></tr>)}</tbody>
              <tfoot><tr><th colSpan={monthly ? 2 : 3}>Total</th><th className="n">{money(c.taxable)}</th><th className="n">{money(c.retirementBase)}</th><th className="n">{money(c.retirementEmployee)}</th><th className="n">{money(c.retirementEmployer)}</th><th className="n">{money(c.smallBase)}</th><th className="n">{money(c.familyBenefits)}</th><th className="n">{money(c.workAccident)}</th><th className="n">{money(c.cmu)}</th></tr></tfoot>
            </table></div>
          </>}
          {kind === 'its' && <>
            <div className="kpis">
              <div className="card kpi"><div className="l">ITS retenu sur salaires</div><div className="v">{money(tx.its)}</div></div>
              <div className="card kpi"><div className="l">Contribution employeur</div><div className="v">{money(tx.employerTax)}</div></div>
              <div className="card kpi"><div className="l">Apprentissage + formation continue</div><div className="v">{money(tx.apprenticeship + tx.training)}</div><div className="small muted">{money(tx.apprenticeship)} + {money(tx.training)}</div></div>
              <div className="card kpi"><div className="l">Total à déclarer</div><div className="v">{money(tx.total)}</div></div>
            </div>
            <div className="table-wrap"><table>
              <thead><tr><th>Salarié</th><th className="n">Brut imposable</th><th className="n">ITS avant réduction</th><th className="n">Réduction familiale</th><th className="n">ITS retenu</th></tr></thead>
              <tbody>{data.employees.map((r: any) => <tr key={r.employeeId}><td>{r.name}</td><td className="n">{money(r.taxable)}</td><td className="n">{money(r.itsGross)}</td><td className="n">{money(r.itsReduction)}</td><td className="n">{money(r.its)}</td></tr>)}</tbody>
              <tfoot><tr><th>Total</th><th className="n">{money(c.taxable)}</th><th className="n">{money(c.itsGross)}</th><th className="n">{money(c.itsReduction)}</th><th className="n">{money(tx.its)}</th></tr></tfoot>
            </table></div>
          </>}
          {kind === 'disa' && <div className="table-wrap"><table>
            <thead><tr><th>Salarié</th><th>N° CNPS</th><th>Période</th><th className="n">Mois</th><th className="n">Salaire brut</th><th className="n">Base retraite</th><th className="n">Retraite (sal. + empl.)</th><th className="n">ITS</th></tr></thead>
            <tbody>{data.employees.map((r: any) => <tr key={r.employeeId}><td>{r.name}</td><td style={{ color: r.cnpsNumber ? undefined : 'var(--crit)' }}>{r.cnpsNumber ?? 'à renseigner'}</td><td className="small">{label(r.firstPeriod)} – {label(r.lastPeriod)}</td><td className="n">{r.months}</td>
              <td className="n">{money(r.gross)}</td><td className="n">{money(r.retirementBase)}</td><td className="n">{money(r.retirementEmployee + r.retirementEmployer)}</td><td className="n">{money(r.its)}</td></tr>)}</tbody>
            <tfoot><tr><th colSpan={4}>Total</th><th className="n">{money(c.gross)}</th><th className="n">{money(c.retirementBase)}</th><th className="n">{money(c.retirement)}</th><th className="n">{money(tx.its)}</th></tr></tfoot>
          </table></div>}
          {!data.employees.length && <p className="muted" style={{ margin: 0 }}>Aucun bulletin validé sur la période.</p>}
        </div>
      </>}
    </>
  );
}
