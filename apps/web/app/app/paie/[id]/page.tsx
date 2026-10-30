'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';
import { Payslip } from '@/components/payslip';

const INPUTS: [string, string][] = [['overtime', 'Heures supplémentaires (FCFA)'], ['bonus', 'Primes du mois (FCFA)'], ['absenceDays', 'Jours d’absence non rémunérés'],
  ['advanceDeduction', "Remboursement d'avance (FCFA)"], ['otherDeduction', 'Autres retenues (FCFA)']];

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, ctx } = useSession();
  const writable = !ctx?.readOnly;
  const [r, setR] = useState<any>(null);
  const [company, setCompany] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [modal, setModal] = useState<any>(null);
  const { busy, error, run, setError } = useAction();
  const load = useCallback(() => run(async () => setR(await api(`/company/payroll/runs/${id}`))), [id]); // eslint-disable-line
  useEffect(() => { load(); api('/company').then(setCompany, () => {}); api('/company/treasury/accounts').then(setAccounts, () => {}); }, [load]);
  if (!r) return <Alert>{error || null}</Alert>;
  const draft = r.status === 'draft';
  const d = r.declarations;

  return (
    <>
      <div className="page-head no-print">
        <div><Link href="/app/paie" className="small">← Paie</Link>
          <h1>Paie de {r.label} {draft ? <Pill tone="warn">Brouillon</Pill> : <Pill tone="ok">Validée</Pill>}</h1></div>
        <div className="row">
          {draft && writable && can('payroll.cancel') && <button className="btn danger" disabled={busy} onClick={() => { if (window.confirm('Supprimer cette paie en brouillon ?')) run(async () => { await api(`/company/payroll/runs/${id}`, { method: 'DELETE' }); router.replace('/app/paie'); }); }}>Supprimer</button>}
          {draft && writable && can('payroll.update') && <button className="btn" disabled={busy} onClick={() => run(async () => setR(await api(`/company/payroll/runs/${id}/recompute`, { body: {} })))}>Recalculer d'après les fiches</button>}
          {draft && writable && can('payroll.validate') && <button className="btn primary" disabled={busy} onClick={() => { if (window.confirm('Valider la paie ? Les bulletins ne pourront plus être modifiés et la paie sera passée en comptabilité.')) run(async () => setR(await api(`/company/payroll/runs/${id}/validate`, { body: {} }))); }}>Valider la paie</button>}
          {!draft && r.totals.paid < r.payslips.length && writable && can('payroll.validate') && <button className="btn primary" onClick={() => { setError(''); setModal({ type: 'pay', accountId: accounts.find((a) => a.kind === 'bank')?.id ?? accounts[0]?.id ?? '', date: new Date().toISOString().slice(0, 10) }); }}>Payer les salaires</button>}
        </div>
      </div>
      <Alert>{!modal && error}</Alert>

      <div className="kpis no-print">
        <div className="card kpi"><div className="l">Salaires bruts</div><div className="v">{money(r.totals.gross)}</div></div>
        <div className="card kpi"><div className="l">Net à payer</div><div className="v">{money(r.totals.net)}</div><div className="small muted">{r.totals.paid}/{r.payslips.length} payé(s)</div></div>
        <div className="card kpi"><div className="l">Coût employeur</div><div className="v">{money(r.totals.employerCost)}</div></div>
      </div>

      <div className="table-wrap no-print"><table>
        <thead><tr><th>Employé</th><th className="n">Brut</th><th className="n">CNPS + CMU</th><th className="n">ITS</th><th className="n">Autres retenues</th><th className="n">Net à payer</th><th className="n">Coût employeur</th><th></th></tr></thead>
        <tbody>{r.payslips.map((p: any) => (
          <tr key={p.id}>
            <td><b>{p.employee.name}</b><div className="small muted">{p.employee.number} · {p.employee.jobTitle ?? ''} · {p.employee.parts} part(s)</div></td>
            <td className="n">{money(p.gross)}</td><td className="n">{money(p.totals.socialEmployee)}</td><td className="n">{money(p.totals.its)}</td>
            <td className="n">{money(p.totals.advances + p.totals.otherDeductions)}</td><td className="n"><b>{money(p.net)}</b>{p.paidAt && <div><Pill tone="ok">Payé le {date(p.paidAt)}</Pill></div>}</td>
            <td className="n">{money(p.employerCost)}</td>
            <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
              {draft && writable && can('payroll.update') && <button className="btn sm" onClick={() => { setError(''); setModal({ type: 'inputs', slip: p, ...p.inputs }); }}>Éléments variables</button>}
              <button className="btn sm" onClick={() => setModal({ type: 'slip', slip: p })}>Bulletin</button>
            </div></td>
          </tr>))}</tbody>
        <tfoot><tr><td><b>Totaux</b></td><td className="n"><b>{money(r.totals.gross)}</b></td><td></td><td className="n"><b>{money(d.its.withheld)}</b></td><td></td><td className="n"><b>{money(r.totals.net)}</b></td><td className="n"><b>{money(r.totals.employerCost)}</b></td><td></td></tr></tfoot>
      </table></div>

      <div className="row no-print" style={{ alignItems: 'stretch' }}>
        <div className="card" style={{ flex: 1, minWidth: 260 }}><header><h2>À déclarer à la CNPS</h2><b>{money(d.cnps.total + d.cmu.total)}</b></header>
          <table className="vat"><tbody>
            <tr><td>Retraite — part salariale</td><td className="n">{money(d.cnps.retirementEmployee)}</td></tr><tr><td>Retraite — part patronale</td><td className="n">{money(d.cnps.retirementEmployer)}</td></tr>
            <tr><td>Prestations familiales</td><td className="n">{money(d.cnps.familyBenefits)}</td></tr><tr><td>Accident du travail</td><td className="n">{money(d.cnps.workAccident)}</td></tr>
            <tr><td>CMU (salariés et employeur)</td><td className="n">{money(d.cmu.total)}</td></tr></tbody></table></div>
        <div className="card" style={{ flex: 1, minWidth: 260 }}><header><h2>À déclarer aux impôts</h2><b>{money(d.its.total)}</b></header>
          <table className="vat"><tbody>
            <tr><td>ITS retenu sur salaires</td><td className="n">{money(d.its.withheld)}</td></tr><tr><td>Contribution employeur</td><td className="n">{money(d.its.employerTax)}</td></tr>
            <tr><td>Taxe d'apprentissage</td><td className="n">{money(d.its.apprenticeship)}</td></tr><tr><td>Formation continue</td><td className="n">{money(d.its.training)}</td></tr></tbody></table></div>
      </div>

      {modal && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <form className="modal" style={{ width: modal.type === 'slip' ? 'min(820px, 100%)' : 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (modal.type === 'inputs') setR(await api(`/company/payroll/runs/${id}/payslips/${modal.slip.id}`, { method: 'PATCH', body: Object.fromEntries(INPUTS.map(([k]) => [k, Number(modal[k] || 0)])) }));
              if (modal.type === 'pay') setR(await api(`/company/payroll/runs/${id}/pay`, { body: { accountId: modal.accountId, date: modal.date } }));
              setModal(null);
            });
          }}>
            {modal.type === 'inputs' && <>
              <h2>Éléments variables — {modal.slip.employee.name}</h2>
              <Alert>{error}</Alert>
              {INPUTS.map(([k, label]) => <Field key={k} label={label} type="number" min={0} step="any" value={modal[k]} onChange={(e) => setModal({ ...modal, [k]: e.target.value })} />)}
              <div className="row"><button className="btn primary" disabled={busy}>Recalculer le bulletin</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>
            </>}
            {modal.type === 'pay' && <>
              <h2>Payer les salaires de {r.label}</h2>
              <p className="small muted" style={{ margin: 0 }}>Un décaissement par salarié non encore payé, pour un total de <b>{money(r.payslips.filter((p: any) => !p.paidAt).reduce((s: number, p: any) => s + p.net, 0))}</b>.</p>
              <Alert>{error}</Alert>
              <label className="field">Payé depuis<select className="input" value={modal.accountId} onChange={(e) => setModal({ ...modal, accountId: e.target.value })}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance)})</option>)}</select></label>
              <Field label="Date du paiement" type="date" required max={new Date().toISOString().slice(0, 10)} value={modal.date} onChange={(e) => setModal({ ...modal, date: e.target.value })} />
              <div className="row"><button className="btn primary" disabled={busy}>Enregistrer le paiement</button><button type="button" className="btn" onClick={() => setModal(null)}>Annuler</button></div>
            </>}
            {modal.type === 'slip' && <Payslip slip={modal.slip} label={r.label} company={company} onClose={() => setModal(null)} />}
          </form>
        </div>
      )}
    </>
  );
}
