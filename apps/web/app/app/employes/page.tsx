'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { CONTRACTS, date, MARITAL, money, PAYMENT_METHODS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, hue, Pill, shrinkImage, useAction } from '@/components/ui';

const EMPTY = {
  firstName: '', lastName: '', jobTitle: '', department: '', hireDate: new Date().toISOString().slice(0, 10), endDate: '', contractType: 'cdi', cnpsNumber: '',
  maritalStatus: 'single', children: 0, partsOverride: '', category: '', targetNet: '', baseSalary: 0, extraSalary: 0, housingAllowance: 0, transportAllowance: 0, otherAllowances: 0,
  paymentMethod: 'bank_transfer', bankDetails: '', phone: '', email: '',
};

/** Fiche de l'API vers le formulaire : valeurs absentes (salaires masqués) remplacées par celles par défaut. */
const MONEY_FIELDS = ['baseSalary', 'extraSalary', 'housingAllowance', 'transportAllowance', 'otherAllowances'];
/** Champs dont dépend le calcul : les modifier rend le bulletin simulé périmé. */
const SIM_FIELDS = ['category', 'targetNet', 'housingAllowance', 'transportAllowance', 'otherAllowances', 'maritalStatus', 'children', 'partsOverride', 'baseSalary', 'extraSalary'];

/** Aperçu du bulletin calculé à partir du net : gains, retenues du salarié, net et coût employeur. */
function SimulatedSlip({ slip }: { slip: any }) {
  const gains = slip.lines.filter((l: any) => l.gain !== undefined);
  const withheld = slip.lines.filter((l: any) => l.employee);
  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 8, background: 'var(--surface-2)' }}>
      <h3>Bulletin simulé</h3>
      <table className="vat" style={{ width: '100%' }}><tbody>
        {gains.map((l: any) => <tr key={l.code}><td>{l.label}</td><td className="n">{money(l.gain)}</td></tr>)}
        <tr><td><b>Salaire brut</b></td><td className="n"><b>{money(slip.gross)}</b></td></tr>
        {withheld.map((l: any) => <tr key={l.code}><td>{l.label}</td><td className="n">−{money(l.employee)}</td></tr>)}
        <tr><td><b>Net à payer</b></td><td className="n"><b>{money(slip.net)}</b></td></tr>
      </tbody></table>
      <div className="small muted">Charges patronales : {money(slip.totals.socialEmployer + slip.totals.taxesEmployer)} · coût total employeur : <b>{money(slip.employerCost)}</b></div>
    </div>
  );
}

/** Photo de l'employé, ou ses initiales sur une teinte qui lui est propre. */
function Avatar({ e, src = e.photo && `/api${e.photo}` }: { e: any; src?: string | null }) {
  if (src) return <img className="vg-photo" src={src} alt="" loading="lazy" />;
  return <div className="vg-photo vg-initials" style={{ '--h': hue(e.fullName ?? `${e.firstName} ${e.lastName}`) } as React.CSSProperties} aria-hidden>{`${(e.firstName ?? '')[0] ?? ''}${(e.lastName ?? '')[0] ?? ''}`.toUpperCase()}</div>;
}

/** Vignette d'un employé : photo, poste, contacts, matricule et service. */
function EmployeeCard({ e, onOpen }: { e: any; onOpen?: () => void }) {
  const body = <>
    <Avatar e={e} />
    <div className="vg-body">
      <b>{e.fullName}</b>
      <span className="muted">{e.jobTitle ?? 'Poste non renseigné'}</span>
      {e.email && <span className="muted" title={e.email}>✉ {e.email}</span>}
      {e.phone && <span className="muted">☎ {e.phone}</span>}
      <div className="vg-tags">
        <span className="vg-badge">{e.number} · {CONTRACTS[e.contractType]}</span>
        {e.department && <span className="vg-tag" style={{ '--h': hue(e.department) } as React.CSSProperties}>{e.department}</span>}
        {!e.active && <Pill>Sorti le {date(e.endDate)}</Pill>}
        {e.linked && <Pill tone="ok">Espace employé</Pill>}
      </div>
    </div>
  </>;
  const cls = `vg-card${e.active ? '' : ' left'}`;
  return onOpen ? <button type="button" className={cls} onClick={onOpen}>{body}</button> : <div className={cls}>{body}</div>;
}

const toForm = (e: any) => ({ ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, e[k] ?? (EMPTY as any)[k]])), partsOverride: e.partsOverride ?? '', endDate: e.endDate ?? '', id: e.id, photo: e.photo ?? null });

export default function EmployeesPage() {
  return <Suspense><Employees /></Suspense>;
}

function Employees() {
  const { can, ctx } = useSession();
  const salaries = can('payroll.salaries');
  const bank = can('employees.bank_details');
  const writable = !ctx?.readOnly;
  const [rows, setRows] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [includeLeft, setIncludeLeft] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const [categories, setCategories] = useState<{ code: string; label: string; minSalary: number }[]>([]);
  const [sim, setSim] = useState<any>(null);
  const [view, setView] = useState<'cards' | 'list'>(() => { try { return localStorage.getItem('kora.employes.vue') === 'list' ? 'list' : 'cards'; } catch { return 'cards'; } });
  const [dept, setDept] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const pickView = (v: 'cards' | 'list') => { setView(v); try { localStorage.setItem('kora.employes.vue', v); } catch { /* sans stockage */ } };
  useEffect(() => { if (salaries) api('/company/payroll/settings').then((s) => setCategories(s.params.categories ?? []), () => {}); }, [salaries]);
  const catLabel = (code: string | null) => categories.find((c) => c.code === code)?.label ?? code;
  const { busy, error, run } = useAction();
  const load = useCallback(() => api(`/company/employees?includeLeft=${includeLeft}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows), [q, includeLeft]);
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { if (SIM_FIELDS.includes(k)) setSim(null); setEdit({ ...edit, [k]: e.target.value }); };
  const open = (e: any) => { setSim(null); setPhoto(undefined); setEdit(e); };
  // Ouverture directe d'une fiche : /app/employes?id=… (liens depuis la paie)
  const direct = useSearchParams().get('id');
  useEffect(() => { if (direct) api(`/company/employees/${direct}`).then((e) => open(toForm(e)), () => {}); }, [direct]); // eslint-disable-line

  // « Calculer la fiche » : salaire de base et sursalaire qui donnent le net demandé (rien n'est enregistré avant « Enregistrer »).
  const calculate = () => run(async () => {
    const r = await api('/company/payroll/net-to-gross', { body: {
      targetNet: Number(edit.targetNet), category: edit.category || null, housingAllowance: Number(edit.housingAllowance || 0),
      transportAllowance: Number(edit.transportAllowance || 0), otherAllowances: Number(edit.otherAllowances || 0),
      maritalStatus: edit.maritalStatus, children: Number(edit.children || 0), partsOverride: edit.partsOverride === '' || edit.partsOverride === null ? null : Number(edit.partsOverride),
    } });
    setEdit((x: any) => ({ ...x, baseSalary: r.baseSalary, extraSalary: r.extraSalary }));
    setSim(r);
  });

  const save = () => run(async () => {
    const body: any = {};
    for (const k of Object.keys(EMPTY)) {
      if (!salaries && [...MONEY_FIELDS, 'targetNet', 'category'].includes(k)) continue;
      if (k === 'bankDetails' && (!bank || edit.bankDetails === '••••')) continue;
      const v = edit[k];
      body[k] = ['children', ...MONEY_FIELDS].includes(k) ? Number(v || 0)
        : k === 'partsOverride' || k === 'targetNet' ? (v === '' || v === null ? null : Number(v)) : k === 'endDate' || k === 'category' ? v || null : v;
    }
    const saved = edit.id ? await api(`/company/employees/${edit.id}`, { method: 'PATCH', body }) : await api('/company/employees', { body });
    if (photo !== undefined) await api(`/company/employees/${saved.id}/photo`, { method: 'PUT', body: { photo } });
    setEdit(null); await load();
  });

  const departments = Object.entries((rows ?? []).reduce<Record<string, number>>((acc, e) => { const k = e.department ?? ''; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}))
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'fr')));
  const shown = (rows ?? []).filter((e) => dept === null || (e.department ?? '') === dept);
  const editable = can('employees.update') && writable;

  return (
    <>
      <div className="page-head"><h1>Employés</h1>
        {can('employees.create') && writable && <button className="btn primary" onClick={() => open({ ...EMPTY })}>Nouvel employé</button>}</div>
      <Alert kind="ok">{notice}</Alert>
      <Alert>{!edit && error}</Alert>
      {!salaries && <Alert kind="info">Les salaires et la paie ne sont visibles qu'avec la permission sensible « voir les salaires et bulletins ».</Alert>}
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}><Field label="Rechercher" type="search" placeholder="Nom, matricule, poste…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="row small" style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={includeLeft} onChange={(e) => setIncludeLeft(e.target.checked)} /> Inclure les employés sortis</label>
        <span className="small muted" style={{ alignSelf: 'flex-end', marginLeft: 'auto' }}>{rows ? `${shown.length} employé${shown.length > 1 ? 's' : ''}` : ''}</span>
        <div className="seg" style={{ alignSelf: 'flex-end' }} role="group" aria-label="Affichage">
          <button type="button" aria-pressed={view === 'cards'} onClick={() => pickView('cards')}>Vignettes</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => pickView('list')}>Liste</button></div>
      </div>
      <div className="emp-layout">
      <nav className="emp-side" aria-label="Services">
        <h3>Service</h3>
        <button type="button" aria-pressed={dept === null} onClick={() => setDept(null)}><span>Tous</span><span>{rows?.length ?? ''}</span></button>
        {departments.map(([d, n]) => <button key={d} type="button" aria-pressed={dept === d} onClick={() => setDept(dept === d ? null : d)}><span>{d || 'Sans service'}</span><span>{n}</span></button>)}
      </nav>
      {view === 'cards' ? (
        <div className="vg-grid">
          {shown.map((e) => <EmployeeCard key={e.id} e={e} onOpen={editable ? () => open(toForm(e)) : undefined} />)}
          {rows && !shown.length && <p className="muted">Aucun employé.</p>}
        </div>
      ) : <div className="table-wrap"><table>
        <thead><tr><th>Matricule</th><th>Employé</th><th>Contrat</th>{salaries && <th>Catégorie</th>}<th>Embauche</th><th className="n">Parts</th>{salaries && <th className="n">Salaire de base</th>}<th>Paiement</th><th></th></tr></thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.id} style={e.active ? undefined : { opacity: 0.6 }}>
              <td style={{ whiteSpace: 'nowrap' }}><code className="k">{e.number}</code></td>
              <td><div className="row" style={{ flexWrap: 'nowrap' }}><span className="vg-mini"><Avatar e={e} /></span><div><b>{e.fullName}</b>{!e.active && <> <Pill>Sorti le {date(e.endDate)}</Pill></>}{e.linked && <> <Pill tone="ok">Espace employé</Pill></>}<div className="small muted">{[e.jobTitle, e.department].filter(Boolean).join(' · ')}</div></div></div></td>
              <td>{CONTRACTS[e.contractType]}</td>
              {salaries && <td className="small">{e.category ? catLabel(e.category) : '—'}</td>}
              <td style={{ whiteSpace: 'nowrap' }}>{date(e.hireDate)}</td>
              <td className="n">{e.parts}</td>
              {salaries && <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(e.baseSalary)}</td>}
              <td className="small">{PAYMENT_METHODS[e.paymentMethod]}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                {can('users.admin') && writable && e.active && !e.linked && <button className="btn sm" disabled={busy} title={e.email ? undefined : 'Renseignez d’abord son e-mail'}
                  onClick={() => run(async () => { await api(`/company/employees/${e.id}/invite`, { body: {} }); setNotice(`Invitation envoyée à ${e.fullName} (${e.email}) : à son acceptation, il ou elle accédera à ses bulletins et à ses congés.`); })}>Inviter dans son espace</button>}
                {can('employees.update') && writable && <button className="btn sm" onClick={() => open(toForm(e))}>Modifier</button>}</div></td>
            </tr>
          ))}
          {rows && !shown.length && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun employé.</td></tr>}
        </tbody>
      </table></div>}
      </div>

      {edit && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2>{edit.id ? `${edit.firstName} ${edit.lastName}` : 'Nouvel employé'}</h2>
            <Alert>{error}</Alert>
            <div className="vg-avatar-edit">
              <Avatar e={{ ...edit, fullName: `${edit.firstName} ${edit.lastName}` }} src={photo === undefined ? edit.photo && `/api${edit.photo}` : photo} />
              <div className="row">
                <label className="btn sm">{edit.photo || photo ? 'Changer la photo' : 'Ajouter une photo'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(ev) => { const f = ev.target.files?.[0]; if (f) run(async () => setPhoto(await shrinkImage(f))); ev.target.value = ''; }} /></label>
                {(photo || (edit.photo && photo === undefined)) && <button type="button" className="btn sm" onClick={() => setPhoto(null)}>Retirer</button>}
              </div>
            </div>
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
              <Field label="E-mail (pour l'espace employé)" type="email" value={edit.email ?? ''} onChange={set('email')} />
            </div>
            {salaries && <>
              <h3 style={{ marginTop: 4 }}>Rémunération mensuelle</h3>
              <div className="grid2">
                <label className="field">Catégorie<select className="input" value={edit.category ?? ''} onChange={set('category')}>
                  <option value="">— Aucune —</option>
                  {categories.map((c) => <option key={c.code} value={c.code}>{c.label}{c.minSalary ? ` — ${money(c.minSalary)}` : ' — salaire catégoriel non renseigné'}</option>)}
                  {edit.category && !categories.some((c) => c.code === edit.category) && <option value={edit.category}>{edit.category}</option>}
                </select></label>
                <Field label="Net à payer (FCFA)" type="number" min={0} placeholder="Ex. 250000" value={edit.targetNet ?? ''} onChange={set('targetNet')} />
                <Field label="Indemnité de transport" type="number" min={0} value={edit.transportAllowance} onChange={set('transportAllowance')} />
                <Field label="Indemnité de logement" type="number" min={0} value={edit.housingAllowance} onChange={set('housingAllowance')} />
                <Field label="Autres indemnités imposables" type="number" min={0} value={edit.otherAllowances} onChange={set('otherAllowances')} />
              </div>
              <div className="row">
                <button type="button" className="btn" disabled={busy || !Number(edit.targetNet)} onClick={calculate}>Calculer la fiche</button>
                <span className="small muted" style={{ flex: 1, minWidth: 200 }}>Salaire de base = salaire catégoriel ; le sursalaire complète jusqu'au net à payer, compte tenu des indemnités, de la CNPS, de la CMU et de l'ITS.</span>
              </div>
              {sim?.warnings.map((w: string) => <Alert key={w} kind="warn">{w}</Alert>)}
              <div className="grid2">
                <Field label="Salaire de base (FCFA)" type="number" min={0} required value={edit.baseSalary} onChange={set('baseSalary')} />
                <Field label="Sursalaire (FCFA)" type="number" min={0} value={edit.extraSalary} onChange={set('extraSalary')} />
              </div>
              {sim && <SimulatedSlip slip={sim.payslip} />}
            </>}
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
