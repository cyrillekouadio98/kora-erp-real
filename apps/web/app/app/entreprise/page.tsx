'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Field, useAction } from '@/components/ui';

const FIELDS: [string, string, boolean?][] = [['name', 'Raison sociale'], ['legalForm', 'Forme juridique (SARL, SA, SAS…)'], ['rccm', 'RCCM'], ['taxId', 'Numéro de compte contribuable (NCC)', true], ['taxRegime', 'Régime fiscal', true], ['address', 'Adresse'], ['city', 'Ville'], ['phone', 'Téléphone'], ['email', 'E-mail de contact']];
const COLS: Record<string, string> = { name: 'name', legalForm: 'legal_form', rccm: 'rccm', taxId: 'tax_id', taxRegime: 'tax_regime', address: 'address', city: 'city', phone: 'phone', email: 'email' };

export default function CompanyPage() {
  const { can, ctx, refresh } = useSession();
  const [f, setF] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const editable = can('settings.admin') && !ctx?.readOnly;
  useEffect(() => { api('/company').then((c) => setF(Object.fromEntries(Object.entries(COLS).map(([k, col]) => [k, c[col] ?? ''])))); }, []);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const body: Record<string, string | null> = {};
      for (const [k, , tax] of FIELDS) if (!tax || can('settings.tax')) body[k] = f[k] === '' && k !== 'name' ? null : f[k];
      await api('/company', { method: 'PATCH', body }); setSaved(true); await refresh();
    });
  };
  return (
    <>
      <div className="page-head"><h1>Fiche entreprise</h1>
        {can('data.export_all') && <a className="btn" href="/api/company/export">Exporter toutes les données (.zip)</a>}</div>
      <Alert>{error}</Alert>{saved && <Alert kind="ok">Fiche enregistrée.</Alert>}
      <form className="card form" onSubmit={save}>
        <div className="grid2">
          {FIELDS.map(([k, label, tax]) => <Field key={k} label={label} value={f[k] ?? ''} disabled={!editable || (tax && !can('settings.tax'))} onChange={(e) => setF({ ...f, [k]: e.target.value })} />)}
        </div>
        {editable && <div><button className="btn primary" disabled={busy}>Enregistrer</button></div>}
        <p className="small muted" style={{ margin: 0 }}>Les informations fiscales ne sont modifiables qu'avec la permission « paramètres fiscaux ». Chaque modification est inscrite au journal d'audit.</p>
      </form>
    </>
  );
}
