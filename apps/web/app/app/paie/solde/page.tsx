'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { CONTRACTS, date, money, SETTLEMENT_REASONS } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, useAction } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);

export default function FinalSettlementPage() {
  return <Suspense><FinalSettlement /></Suspense>;
}

/**
 * Solde de tout compte : indemnités dues au départ d'un salarié (licenciement, préavis, congés non pris,
 * fin de CDD), présentées sous forme de reçu imprimable. Le calcul n'enregistre rien.
 */
function FinalSettlement() {
  const { can, ctx } = useSession();
  const params = useSearchParams();
  const [employees, setEmployees] = useState<any[]>([]);
  const [company, setCompany] = useState<any>(null);
  const [f, setF] = useState({ employeeId: params.get('employe') ?? '', endDate: today(), reason: 'dismissal', noticeMonths: '', leaveDays: '' });
  const [r, setR] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => { api('/company/payroll/contracts').then((rows) => setEmployees(rows.filter((c: any) => c.status !== 'upcoming'))); api('/company').then(setCompany, () => {}); }, []);
  // L'employé choisi propose sa date de fin de contrat et le motif qui lui correspond.
  useEffect(() => {
    const e = employees.find((x) => x.id === f.employeeId);
    if (e) setF((p) => ({ ...p, endDate: e.endDate ?? today(), reason: e.contractType === 'cdd' && e.endDate ? 'end_of_contract' : p.reason, noticeMonths: '', leaveDays: '' }));
    setR(null);
  }, [f.employeeId, employees.length]); // eslint-disable-line

  if (!can('payroll.salaries')) return <Alert kind="info">Le solde de tout compte est réservé aux personnes disposant de la permission sensible « voir les salaires et bulletins ».</Alert>;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setR(null); setF({ ...f, [k]: e.target.value, ...(k === 'reason' ? { noticeMonths: '' } : {}), ...(k === 'endDate' ? { leaveDays: '' } : {}) }); };
  const compute = () => run(async () => {
    const q = new URLSearchParams({ employeeId: f.employeeId, endDate: f.endDate, reason: f.reason, ...(f.noticeMonths !== '' ? { noticeMonths: f.noticeMonths } : {}), ...(f.leaveDays !== '' ? { leaveDays: f.leaveDays } : {}) });
    const res = await api(`/company/payroll/final-settlement?${q}`);
    setR(res); setF((p) => ({ ...p, noticeMonths: String(res.noticeMonths), leaveDays: String(res.leaveDays) }));
  });
  const e = r?.employee;
  const sameEnd = e && e.endDate === r.endDate;

  return (
    <>
      <div className="page-head no-print"><div><h1>Départ d'un salarié</h1><div className="small muted">Indemnités de fin de contrat et reçu pour solde de tout compte</div></div></div>
      <form className="card no-print" style={{ display: 'grid', gap: 12 }} onSubmit={(ev) => { ev.preventDefault(); compute(); }}>
        <div className="grid2">
          <label className="field">Employé<select className="input" required value={f.employeeId} onChange={set('employeeId')}>
            <option value="">— Choisir un employé —</option>
            {employees.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.number}{x.status === 'ended' ? ' (parti)' : ''}</option>)}</select></label>
          <label className="field">Motif du départ<select className="input" value={f.reason} onChange={set('reason')}>
            {Object.entries(SETTLEMENT_REASONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <Field label="Date de fin du contrat" type="date" required value={f.endDate} onChange={set('endDate')} />
          <Field label="Préavis non effectué, payé par l'employeur (mois)" type="number" min={0} max={12} step={0.5} placeholder="Proposé selon l'ancienneté" value={f.noticeMonths} onChange={(ev) => setF({ ...f, noticeMonths: ev.target.value })} />
          <Field label="Jours de congés à indemniser" type="number" min={0} max={400} step={0.1} placeholder="Solde du module Congés" value={f.leaveDays} onChange={(ev) => setF({ ...f, leaveDays: ev.target.value })} />
        </div>
        {r && r.leave.available > 30 && Number(f.leaveDays) === r.leave.available && <Alert kind="warn">Le module Congés affiche {r.leave.available} jours non pris depuis l'embauche. Si des congés ont été pris avant N'Ora ou si un report d'ouverture manque, corrigez le nombre de jours à indemniser (ou le report dans <Link href="/app/conges">Congés</Link>) puis recalculez.</Alert>}
        <Alert>{error}</Alert>
        <div className="row"><button className="btn primary" disabled={busy || !f.employeeId}>Calculer le solde</button>
          {r && <button type="button" className="btn" onClick={() => window.print()}>Imprimer / PDF</button>}
          {r && !sameEnd && can('employees.update') && !ctx?.readOnly && <button type="button" className="btn" disabled={busy} onClick={() => run(async () => {
            await api(`/company/employees/${e.id}`, { method: 'PATCH', body: { endDate: r.endDate } });
            setEmployees(employees.map((x) => (x.id === e.id ? { ...x, endDate: r.endDate } : x))); setR({ ...r, employee: { ...e, endDate: r.endDate } });
            setNotice(`Départ de ${e.name} enregistré au ${date(r.endDate)} : il ne figurera plus dans les paies suivantes.`);
          })}>Enregistrer le départ au {date(r.endDate)}</button>}
        </div>
        {notice && <Alert kind="ok">{notice}</Alert>}
        <p className="small muted" style={{ margin: 0 }}>Calcul indicatif selon le Code du travail ivoirien, à faire valider par votre expert-comptable ou votre conseil avant remise au salarié (convention collective, dispositions plus favorables du contrat). Le salaire du dernier mois est payé par la paie du mois.</p>
      </form>

      {r && (
        <article className="card settlement">
          <header className="settlement-head">
            <div><b>{company?.name}</b>{(company?.address || company?.city) && <div>{[company.address, company.city].filter(Boolean).join(' - ')}</div>}
              {(company?.rccm || company?.tax_id) && <div>{[company.rccm && `RCCM ${company.rccm}`, company.tax_id && `NCC ${company.tax_id}`].filter(Boolean).join(' · ')}</div>}</div>
            <div style={{ textAlign: 'right' }}><h2>Reçu pour solde de tout compte</h2><div className="small muted">Établi le {date(today())}</div></div>
          </header>
          <dl className="stock-meta">
            <dt>Salarié</dt><dd><b>{e.name}</b> · matricule {e.number}{e.cnpsNumber ? ` · CNPS ${e.cnpsNumber}` : ''}</dd>
            <dt>Emploi</dt><dd>{[e.jobTitle, e.department, e.category && `catégorie ${e.category}`].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>Contrat</dt><dd>{CONTRACTS[e.contractType]} du {date(e.hireDate)} au {date(r.endDate)} · ancienneté {r.seniority.years} an(s) {r.seniority.months} mois</dd>
            <dt>Motif</dt><dd>{r.reasonLabel}</dd>
            <dt>Salaire de référence</dt><dd>{money(r.average)} par mois <span className="muted">({r.averageBasis})</span></dd>
            <dt>Congés</dt><dd>{r.leave.acquired} jour(s) acquis, {r.leave.taken} pris, {r.leave.available} restant(s) · <b>{r.leaveDays} indemnisé(s)</b></dd>
          </dl>
          <div className="table-wrap"><table>
            <thead><tr><th>Élément</th><th>Base de calcul</th><th>Régime</th><th className="n">Montant</th></tr></thead>
            <tbody>
              {r.lines.map((l: any) => <tr key={l.code}><td><b>{l.label}</b></td><td className="small">{l.basis}</td>
                <td className="small">{l.taxable ? 'Soumis à ITS et CNPS' : 'Exonéré dans la limite légale'}</td><td className="n" style={{ whiteSpace: 'nowrap' }}>{money(l.amount)}</td></tr>)}
              {!r.lines.length && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center' }}>Aucune indemnité due pour ce motif de départ.</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan={3}><b>Total brut dû au salarié</b></td><td className="n" style={{ whiteSpace: 'nowrap' }}><b>{money(r.total)}</b></td></tr></tfoot>
          </table></div>
          {r.suggestedNotice > 0 && Number(f.noticeMonths) !== r.suggestedNotice && <p className="small muted no-print" style={{ margin: 0 }}>Préavis légal proposé pour cette ancienneté : {r.suggestedNotice} mois.</p>}
          <p className="small" style={{ margin: 0 }}>Je soussigné(e) <b>{e.name}</b> reconnais avoir reçu de <b>{company?.name}</b> la somme de <b>{money(r.total)}</b> (montant brut, avant retenues fiscales et sociales sur les éléments soumis) pour solde de tout compte, en paiement des salaires, accessoires et indemnités de toute nature dus au titre de l'exécution et de la cessation de mon contrat de travail. Ce reçu peut être dénoncé dans les délais prévus par la loi.</p>
          <div className="signatures" style={{ gridTemplateColumns: '1fr 1fr' }}><div>L'employeur<br />(cachet et signature)</div><div>Le salarié<br />« Pour solde de tout compte », date et signature</div></div>
          <p className="small muted no-print" style={{ margin: 0 }}>Pensez au certificat de travail et à l'attestation de la CNPS. Les bulletins passés restent consultables dans <Link href="/app/paie/fiches">Bulletins</Link>.</p>
        </article>
      )}
    </>
  );
}
