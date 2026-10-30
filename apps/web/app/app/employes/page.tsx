'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { CONTRACTS, date, MARITAL, money, PAYMENT_METHODS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const EMPTY = {
  firstName: '', lastName: '', jobTitle: '', department: '', hireDate: new Date().toISOString().slice(0, 10), endDate: '', contractType: 'cdi', cnpsNumber: '',
  maritalStatus: 'single', children: 0, partsOverride: '', baseSalary: 0, housingAllowance: 0, transportAllowance: 0, otherAllowances: 0,
  paymentMethod: 'bank_transfer', bankDetails: '', phone: '', email: '',
};

/** Fiche de l'API vers le formulaire : valeurs absentes (salaires masqués) remplacées par celles par défaut. */
const toForm = (e: any) => ({ ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, e[k] ?? (EMPTY as any)[k]])), partsOverride: e.partsOverride ?? '', endDate: e.endDate ?? '', id: e.id });

export default function EmployeesPage() {
  const { can, ctx } = useSession();
  const salaries = can('payroll.salaries');
  const bank = can('employees.bank_details');
  const writable = !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [includeLeft, setIncludeLeft] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api(`/company/employees?includeLeft=${includeLeft}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows), [q, includeLeft]);
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setEdit({ ...edit, [k]: e.target.value });

  const save = () => run(async () => {
    const body: any = {};
    for (const k of Object.keys(EMPTY)) {
      if (!salaries && ['baseSalary', 'housingAllowance', 'transportAllowance', 'otherAllowances'].includes(k)) continue;
      if (k === 'bankDetails' && (!bank || edit.bankDetails === '••••')) continue;
      const v = edit[k];
      body[k] = ['children', 'baseSalary', 'housingAllowance', 'transportAllowance', 'otherAllowances'].includes(k) ? Number(v || 0)
        : k === 'partsOverride' ? (v === '' || v === null ? null : Number(v)) : k === 'endDate' ? v || null : v;
    }
    if (edit.id) await api(`/company/employees/${edit.id}`, { method: 'PATCH', body }); else await api('/company/employees', { body });
    setEdit(null); await load();
  });

  return (
    <>
      <div className="page-head"><h1>Employés</h1>
        {can('employees.create') && writable && <button className="btn primary" onClick={() => setEdit({ ...EMPTY })}>Nouvel employé</button>}</div>
      {!salaries && <Alert kind="info">Les salaires et la paie ne sont visibles qu'avec la permission sensible « voir les salaires et bulletins ».</Alert>}
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder="Nom, matricule, poste…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="row small" style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={includeLeft} onChange={(e) => setIncludeLeft(e.target.checked)} /> Inclure les employés sortis</label>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Matricule</th><th>Employé</th><th>Contrat</th><th>Embauche</th><th className="n">Parts</th>{salaries && <th className="n">Salaire de base</th>}<th>Paiement</th><th></th></tr></thead>
        <tbody>
          {rows?.map((e) => (
            <tr key={e.id} style={e.active ? undefined : { opacity: 0.6 }}>
              <td><code className="k">{e.number}</code></td>
              <td><b>{e.fullName}</b>{!e.active && <> <Pill>Sorti le {date(e.endDate)}</Pill></>}<div className="small muted">{[e.jobTitle, e.department].filter(Boolean).join(' · ')}</div></td>
              <td>{CONTRACTS[e.contractType]}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{date(e.hireDate)}</td>
              <td className="n">{e.parts}</td>
              {salaries && <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(e.baseSalary)}</td>}
              <td className="small">{PAYMENT_METHODS[e.paymentMethod]}</td>
              <td className="n">{can('employees.update') && writable && <button className="btn sm" onClick={() => setEdit(toForm(e))}>Modifier</button>}</td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun employé.</td></tr>}
        </tbody>
      </table></div>

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `${edit.firstName} ${edit.lastName}` : 'Nouvel employé'}</h2>
            <Alert>{error}</Alert>
            <div className="grid2">
              <Field label="Prénom" required value={edit.firstName} onChange={set('firstName')} />
              <Field label="Nom" required value={edit.lastName} onChange={set('lastName')} />
              <Field label="Poste" value={edit.jobTitle ?? ''} onChange={set('jobTitle')} />
              <Field label="Service" value={edit.department ?? ''} onChange={set('department')} />
              <label className="field">Contrat<select className="input" value={edit.contractType} onChange={set('contractType')}>{Object.entries(CONTRACTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <Field label="N° CNPS" value={edit.cnpsNumber ?? ''} onChange={set('cnpsNumber')} />
              <Field label="Date d'embauche" type="date" required value={edit.hireDate} onChange={set('hireDate')} />
              <Field label="Date de sortie (le cas échéant)" type="date" value={edit.endDate ?? ''} onChange={set('endDate')} />
              <label className="field">Situation de famille<select className="input" value={edit.maritalStatus} onChange={set('maritalStatus')}>{Object.entries(MARITAL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <Field label="Enfants à charge" type="number" min={0} max={20} value={edit.children} onChange={set('children')} />
              <Field label="Parts fiscales (vide : calcul automatique)" type="number" min={1} max={5} step={0.5} value={edit.partsOverride} onChange={set('partsOverride')} />
              <label className="field">Paiement du salaire<select className="input" value={edit.paymentMethod} onChange={set('paymentMethod')}>
                {['bank_transfer', 'mobile_money', 'cash'].map((k) => <option key={k} value={k}>{PAYMENT_METHODS[k]}</option>)}</select></label>
              {bank && <Field label={edit.paymentMethod === 'mobile_money' ? 'Numéro mobile money' : 'RIB'} value={edit.bankDetails ?? ''} onChange={set('bankDetails')} />}
              <Field label="Téléphone" value={edit.phone ?? ''} onChange={set('phone')} />
            </div>
            {salaries && <>
              <h3 style={{ marginTop: 4 }}>Rémunération mensuelle</h3>
              <div className="grid2">
                <Field label="Salaire de base (FCFA)" type="number" min={0} required value={edit.baseSalary} onChange={set('baseSalary')} />
                <Field label="Indemnité de transport" type="number" min={0} value={edit.transportAllowance} onChange={set('transportAllowance')} />
                <Field label="Indemnité de logement" type="number" min={0} value={edit.housingAllowance} onChange={set('housingAllowance')} />
                <Field label="Autres indemnités imposables" type="number" min={0} value={edit.otherAllowances} onChange={set('otherAllowances')} />
              </div>
            </>}
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
