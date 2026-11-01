'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { CONTRACT_STATUS, CONTRACTS, date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Pill } from '@/components/ui';

/** Libellés courts des avertissements portés par une fiche (voir le tableau de bord). */
const WARNINGS: Record<string, string> = {
  ending_soon: 'Se termine dans les 30 jours', cdd_no_end: 'CDD sans date de fin', below_smig: 'Sous le SMIG',
  no_category: 'Sans catégorie', no_cnps: 'Sans n° CNPS', no_payment_details: 'Sans coordonnées de paiement',
};

export default function ContractsPage() {
  return <Suspense><Contracts /></Suspense>;
}

/** Contrats de travail : type, dates, catégorie, salaire mensuel et points à compléter. */
function Contracts() {
  const { can } = useSession();
  const params = useSearchParams();
  const [rows, setRows] = useState<any[] | null>(null);
  const [f, setF] = useState({ q: '', status: params.get('statut') ?? (params.get('alerte') ? '' : 'current'), type: '', warning: params.get('alerte') ?? '' });
  useEffect(() => { api('/company/payroll/contracts').then(setRows); }, []);
  const salaries = can('payroll.salaries');
  const shown = (rows ?? []).filter((c) => (!f.q || `${c.name} ${c.number} ${c.jobTitle ?? ''} ${c.department ?? ''}`.toLowerCase().includes(f.q.toLowerCase()))
    && (!f.status || (f.status === 'current' ? c.status !== 'ended' : c.status === f.status || (f.status === 'running' && c.status === 'ending')))
    && (!f.type || c.contractType === f.type) && (!f.warning || c.warnings.includes(f.warning)));
  const count = (s: string) => (rows ?? []).filter((c) => c.status === s).length;

  return (
    <>
      <div className="page-head"><h1>Contrats</h1>
        {can('employees.create') && <Link className="btn primary" href="/app/employes">Gérer les employés</Link>}</div>
      {rows && <div className="kpis">
        {(['running', 'ending', 'upcoming', 'ended'] as const).map((s) => (
          <button key={s} className="card kpi" style={{ textAlign: 'left', cursor: 'pointer', outline: f.status === s ? '2px solid var(--accent)' : undefined }} onClick={() => setF({ ...f, status: f.status === s ? 'current' : s, warning: '' })}>
            <div className="l">{CONTRACT_STATUS[s][0]}</div><div className="v">{count(s)}</div></button>))}
      </div>}
      <div className="row">
        <input className="input" type="search" placeholder="Employé, poste, service…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ width: 240 }} aria-label="Rechercher" />
        <select className="input" style={{ width: 'auto' }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Situation">
          <option value="current">En cours et à venir</option><option value="">Tous, y compris terminés</option>
          {Object.entries(CONTRACT_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="input" style={{ width: 'auto' }} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Type de contrat">
          <option value="">Tous les types</option>{Object.entries(CONTRACTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="input" style={{ width: 'auto' }} value={f.warning} onChange={(e) => setF({ ...f, warning: e.target.value })} aria-label="Point à compléter">
          <option value="">Tous les contrats</option>{Object.entries(WARNINGS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Employé</th><th>Contrat</th><th>Catégorie</th><th>Début</th><th>Fin</th>{salaries && <th className="n">Salaire mensuel</th>}<th>Situation</th><th /></tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.id}>
              <td><b>{c.name}</b><div className="small muted">{c.number}{c.jobTitle ? ` · ${c.jobTitle}` : ''}{c.department ? ` · ${c.department}` : ''}</div></td>
              <td>{CONTRACTS[c.contractType]}</td><td>{c.category ?? <span className="muted">—</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{date(c.hireDate)}</td><td style={{ whiteSpace: 'nowrap' }}>{c.endDate ? date(c.endDate) : <span className="muted">—</span>}</td>
              {salaries && <td className="n">{money(c.monthlySalary)}</td>}
              <td><Pill tone={CONTRACT_STATUS[c.status][1]}>{CONTRACT_STATUS[c.status][0]}</Pill>
                {c.warnings.filter((w: string) => w !== 'ending_soon').length > 0 && <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>{c.warnings.filter((w: string) => w !== 'ending_soon').map((w: string) => WARNINGS[w]).join(' · ')}</div>}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                <Link className="btn sm" href={`/app/employes?id=${c.id}`}>Fiche</Link>
                {salaries && c.status !== 'upcoming' && <Link className="btn sm" href={`/app/paie/solde?employe=${c.id}`}>Solde de tout compte</Link>}</div></td>
            </tr>))}
          {rows && !shown.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun contrat dans cette sélection.</td></tr>}
        </tbody>
      </table></div>
      <p className="small muted" style={{ margin: 0 }}>Le contrat est porté par la fiche de l'employé (type, dates, catégorie, éléments de salaire) : il se modifie depuis <Link href="/app/employes">Employés</Link>.</p>
    </>
  );
}
