'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const PARAM_LABELS: [string, string, string][] = [
  ['cnpsEmployeeRate', 'CNPS retraite — part salariale', '%'], ['cnpsEmployerRate', 'CNPS retraite — part patronale', '%'], ['cnpsCeiling', 'Plafond mensuel retraite CNPS', 'FCFA'],
  ['familyBenefitsRate', 'Prestations familiales (employeur)', '%'], ['workAccidentRate', 'Accident du travail (employeur)', '%'], ['smallBenefitsCeiling', 'Plafond PF / AT', 'FCFA'],
  ['cmuPerPerson', 'CMU par bénéficiaire', 'FCFA'], ['cmuEmployerShare', 'CMU prise en charge par l’employeur', 'FCFA'],
  ['employerTaxRate', 'Contribution employeur sur salaires', '%'], ['apprenticeshipTaxRate', "Taxe d'apprentissage", '%'], ['trainingTaxRate', 'Taxe formation continue', '%'],
  ['transportExemptCap', 'Transport exonéré par mois', 'FCFA'], ['workingDays', 'Jours de référence (absences)', 'j'],
];

export default function PayrollPage() {
  const { can, ctx } = useSession();
  const router = useRouter();
  const writable = !ctx?.readOnly;
  const [runs, setRuns] = useState<any[] | null>(null);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [settings, setSettings] = useState<any>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api('/company/payroll/runs').then(setRuns, () => setRuns([])), []);
  useEffect(() => { load(); }, [load]);

  if (!can('payroll.salaries')) return <><div className="page-head"><h1>Paie</h1></div><Alert kind="info">La paie est réservée aux personnes disposant de la permission sensible « voir les salaires et bulletins ».</Alert></>;
  return (
    <>
      <div className="page-head"><h1>Paie</h1>
        <div className="row">
          <button className="btn" onClick={() => api('/company/payroll/settings').then((s) => setSettings({ ...s.params, _defaults: s.defaults }))}>Paramètres de calcul</button>
          {can('payroll.create') && writable && <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api('/company/payroll/runs', { body: { period } }); router.push(`/app/paie/${r.id}`); }); }}>
            <input className="input" type="month" value={period} max={new Date().toISOString().slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} aria-label="Mois de paie" style={{ width: 170 }} />
            <button className="btn primary" disabled={busy}>Préparer la paie</button></form>}
        </div>
      </div>
      <Alert>{!settings && error}</Alert>
      <Alert kind="warn">Les taux et barèmes (ITS 2024, CNPS, CMU, taxes) sont des valeurs par défaut <b>à faire valider par votre expert-comptable</b> avant usage réel ; ils se modifient dans « Paramètres de calcul ». Chaque paie validée garde les paramètres avec lesquels elle a été calculée.</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Mois</th><th>Statut</th><th className="n">Employés</th><th className="n">Brut</th><th className="n">Net à payer</th><th className="n">Coût employeur</th><th>Paiement</th></tr></thead>
        <tbody>
          {runs?.map((r) => (
            <tr key={r.id}><td><Link href={`/app/paie/${r.id}`}><b style={{ textTransform: 'capitalize' }}>{r.label}</b></Link></td>
              <td>{r.status === 'validated' ? <Pill tone="ok">Validée</Pill> : <Pill tone="warn">Brouillon</Pill>}</td>
              <td className="n">{r.employees}</td><td className="n">{money(r.gross)}</td><td className="n">{money(r.net)}</td><td className="n">{money(r.employerCost)}</td>
              <td>{r.status !== 'validated' ? '—' : r.paid === r.employees ? <Pill tone="ok">Payée</Pill> : <Pill tone="warn">{r.paid}/{r.employees} payé(s)</Pill>}</td></tr>
          ))}
          {runs && !runs.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucune paie. Enregistrez vos <Link href="/app/employes">employés</Link>, puis préparez la paie du mois.</td></tr>}
        </tbody>
      </table></div>

      {settings && (
        <div className="modal-back" onClick={() => setSettings(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const body = Object.fromEntries(PARAM_LABELS.map(([k]) => [k, Number(settings[k])]));
              await api('/company/payroll/settings', { method: 'PATCH', body: { ...body, itsBrackets: settings.itsBrackets, itsFamilyReduction: settings.itsFamilyReduction } });
              setSettings(null);
            });
          }}>
            <h2>Paramètres de calcul de la paie</h2>
            <Alert kind="warn">Valeurs à faire valider par votre expert-comptable. Une modification s'applique aux paies préparées ou recalculées ensuite, jamais aux paies validées.</Alert>
            <Alert>{error}</Alert>
            <div className="grid2">{PARAM_LABELS.map(([k, label, unit]) => (
              <Field key={k} label={`${label} (${unit})`} type="number" step="any" min={0} disabled={!can('payroll.admin')} value={settings[k]} onChange={(e) => setSettings({ ...settings, [k]: e.target.value })} />))}</div>
            <h3>Barème mensuel de l'ITS</h3>
            <table className="vat"><thead><tr><th>Jusqu'à</th><th className="n">Taux</th></tr></thead>
              <tbody>{settings.itsBrackets.map(([ceiling, rate]: [number | null, number], i: number) => (
                <tr key={i}><td>{ceiling === null ? 'Au-delà' : money(ceiling)}</td><td className="n">{rate} %</td></tr>))}</tbody></table>
            <h3>Réduction d'ITS pour charges de famille (par mois)</h3>
            <p className="small" style={{ margin: 0 }}>{Object.entries(settings.itsFamilyReduction).map(([parts, amount]) => `${parts} part${Number(parts) > 1 ? 's' : ''} : ${money(amount as number)}`).join(' · ')}</p>
            <div className="row">{can('payroll.admin') && writable && <button className="btn primary" disabled={busy}>Enregistrer</button>}<button type="button" className="btn" onClick={() => setSettings(null)}>Fermer</button></div>
          </form>
        </div>
      )}
    </>
  );
}
