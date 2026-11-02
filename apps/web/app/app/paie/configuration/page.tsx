'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, useAction } from '@/components/ui';

const PARAM_LABELS: [string, string, string][] = [
  ['cnpsEmployeeRate', 'CNPS retraite — part salariale', '%'], ['cnpsEmployerRate', 'CNPS retraite — part patronale', '%'], ['cnpsCeiling', 'Plafond mensuel retraite CNPS', 'FCFA'],
  ['familyBenefitsRate', 'Prestations familiales (employeur)', '%'], ['workAccidentRate', 'Accident du travail (employeur)', '%'], ['smallBenefitsCeiling', 'Plafond PF / AT', 'FCFA'],
  ['cmuPerPerson', 'CMU par bénéficiaire', 'FCFA'], ['cmuEmployerShare', 'CMU prise en charge par l’employeur', 'FCFA'],
  ['employerTaxRate', 'Contribution employeur sur salaires', '%'], ['apprenticeshipTaxRate', "Taxe d'apprentissage", '%'], ['trainingTaxRate', 'Taxe formation continue', '%'],
  ['transportExemptCap', 'Transport exonéré par mois', 'FCFA'], ['workingDays', 'Jours de référence (absences)', 'j'], ['leaveDaysPerMonth', 'Congés acquis par mois de service', 'j ouvrables'], ['smig', 'SMIG mensuel', 'FCFA'],
];

/** Configuration de la paie : taux et plafonds, grille des catégories, barème de l'ITS. */
export default function PayrollSettingsPage() {
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [settings, setSettings] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { api('/company/payroll/settings').then((s) => setSettings({ ...s.params, _defaults: s.defaults })); }, []);
  if (!settings) return null;
  return (
    <>
      <div className="page-head"><h1>Paramètres de la paie</h1></div>
      {!can('payroll.admin') && <Alert kind="info">Consultation seule : la modification des paramètres demande la permission d'administration de la paie.</Alert>}
      <form className="card" style={{ display: 'grid', gap: 14 }} onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const body = Object.fromEntries(PARAM_LABELS.map(([k]) => [k, Number(settings[k])]));
          await api('/company/payroll/settings', { method: 'PATCH', body: { ...body, itsBrackets: settings.itsBrackets, itsFamilyReduction: settings.itsFamilyReduction,
            categories: settings.categories.filter((c: any) => c.code.trim()).map((c: any) => ({ code: c.code.trim(), label: c.label.trim() || c.code.trim(), minSalary: Number(c.minSalary || 0) })) } });
          setSaved(true);
        });
      }}>
        <Alert kind="warn">Valeurs à faire valider par votre expert-comptable. Une modification s'applique aux paies préparées ou recalculées ensuite, jamais aux paies validées.</Alert>
        <Alert>{error}</Alert>
        <div className="grid2">{PARAM_LABELS.map(([k, label, unit]) => (
          <Field key={k} label={`${label} (${unit})`} type="number" step="any" min={0} disabled={!can('payroll.admin')} value={settings[k]} onChange={(e) => { setSaved(false); setSettings({ ...settings, [k]: e.target.value }); }} />))}</div>
        <h3>Grille des catégories</h3>
        <p className="small muted" style={{ margin: 0 }}>Salaire catégoriel mensuel de chaque catégorie, selon la convention collective de votre branche (barèmes revalorisés par l'arrêté n° 50/MEPS/CAB de 2023). Il sert de salaire de base au bouton « Calculer la fiche » des employés ; le sursalaire complète jusqu'au net demandé.</p>
        <div className="table-wrap"><table>
          <thead><tr><th style={{ width: 90 }}>Code</th><th>Intitulé</th><th className="n" style={{ width: 170 }}>Salaire catégoriel</th><th></th></tr></thead>
          <tbody>{settings.categories.map((c: any, i: number) => {
            const setCat = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setSettings({ ...settings, categories: settings.categories.map((x: any, j: number) => (j === i ? { ...x, [k]: e.target.value } : x)) });
            return (
              <tr key={i}>
                <td><input className="input" aria-label="Code" required maxLength={20} disabled={!can('payroll.admin')} value={c.code} onChange={setCat('code')} /></td>
                <td><input className="input" aria-label="Intitulé" maxLength={80} disabled={!can('payroll.admin')} value={c.label} onChange={setCat('label')} /></td>
                <td><input className="input n" aria-label="Salaire catégoriel" type="number" min={0} disabled={!can('payroll.admin')} placeholder="non renseigné" value={c.minSalary || ''} onChange={setCat('minSalary')} /></td>
                <td className="n">{can('payroll.admin') && <button type="button" className="btn sm" aria-label={`Retirer ${c.label}`} onClick={() => setSettings({ ...settings, categories: settings.categories.filter((_: any, j: number) => j !== i) })}>Retirer</button>}</td>
              </tr>
            );
          })}</tbody></table></div>
        {can('payroll.admin') && <div><button type="button" className="btn sm" onClick={() => setSettings({ ...settings, categories: [...settings.categories, { code: '', label: '', minSalary: 0 }] })}>+ Ajouter une catégorie</button></div>}
        <h3>Barème mensuel de l'ITS</h3>
        <table className="vat"><thead><tr><th>Jusqu'à</th><th className="n">Taux</th></tr></thead>
          <tbody>{settings.itsBrackets.map(([ceiling, rate]: [number | null, number], i: number) => (
            <tr key={i}><td>{ceiling === null ? 'Au-delà' : money(ceiling)}</td><td className="n">{rate} %</td></tr>))}</tbody></table>
        <h3>Réduction d'ITS pour charges de famille (par mois)</h3>
        <p className="small" style={{ margin: 0 }}>{Object.entries(settings.itsFamilyReduction).map(([parts, amount]) => `${parts} part${Number(parts) > 1 ? 's' : ''} : ${money(amount as number)}`).join(' · ')}</p>
        <div className="row">{can('payroll.admin') && writable && <button className="btn primary" disabled={busy}>Enregistrer</button>}{saved && <span className="small muted">Paramètres enregistrés.</span>}</div>
      </form>
    </>
  );
}
