'use client';
import { CONTRACTS, PAYMENT_METHODS } from '@/lib/format';

const cfa = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} CFA`;
const rate = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hours = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const fr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const periodEnd = (p: string) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);
const MONTHLY_HOURS = 173.33;

/** Ancienneté à la fin de la période : « 2 an(s) 3 mois ». */
function seniority(hire: string, end: string) {
  let months = (Number(end.slice(0, 4)) - Number(hire.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(hire.slice(5, 7));
  if (Number(end.slice(8, 10)) < Number(hire.slice(8, 10))) months--;
  months = Math.max(0, months);
  return `${Math.floor(months / 12)} an(s) ${months % 12} mois`;
}

interface Row { n: number; label: string; count?: string; amount?: number; rate?: string; gain?: number; ret?: number; erRate?: string; erRet?: number; total?: boolean }

/** Bulletin de paie imprimable : identification, rubriques (part salariale et patronale), cumuls, congés. */
export function Payslip({ slip, period, company, onClose }: { slip: any; period: string; company: any; onClose: () => void }) {
  const e = slip.employee;
  const t = slip.totals;
  const line = (code: string) => slip.lines.find((l: any) => l.code === code);
  const gain = (code: string) => line(code)?.gain ?? 0;
  const end = periodEnd(period);
  const taxable = slip.taxable ?? slip.gross - gain('TRA');

  // Salaire de base et sursalaire : montant contractuel, taux payé (jours payés / jours de référence), gain
  const base = gain('BASE'), extra = gain('SUR'), contract = base + extra;
  const paid = contract + gain('ABS');
  const ratio = contract > 0 ? paid / contract : 1;
  const baseGain = Math.round(base * ratio);
  const count = (slip.refDays ?? 30).toFixed(1);
  const rows: Row[] = [{ n: 1, label: 'Salaire de base', count, amount: base, rate: rate(ratio * 100), gain: baseGain }];
  if (extra) rows.push({ n: 2, label: 'Sursalaire', count, amount: extra, rate: rate(ratio * 100), gain: paid - baseGain });
  for (const code of ['HS', 'LOG', 'IND', 'PRI', 'TRI']) if (line(code)) rows.push({ n: rows.length + 1, label: line(code).label, gain: gain(code) });
  rows.push({ n: 501, label: 'Salaire imposable', gain: taxable, total: true });

  const cmu = line('CMU'), cnps = line('CNPS'), its = line('ITS');
  if (cmu?.employee) rows.push({ n: 505, label: 'CMU employé', amount: cmu.employee, ret: cmu.employee });
  if (cnps) rows.push({ n: 506, label: 'CNPS employé', amount: cnps.base, rate: rate(cnps.rate), ret: cnps.employee });
  if (its?.employee) rows.push({ n: 507, label: 'Impôt sur traitements et salaires (ITS)', amount: its.base, ret: its.employee });
  if (line('AVA')) rows.push({ n: 508, label: "Remboursement d'avance", ret: line('AVA').employee });
  if (line('RET')) rows.push({ n: 509, label: 'Autres retenues', ret: line('RET').employee });
  rows.push({ n: 701, label: 'Total retenue employé', ret: t.deductions, total: true });

  const employer = (num: number, label: string, l: any, amount?: number) => {
    if (l?.employer) rows.push({ n: num, label, amount: amount ?? l.base, erRate: l.rate !== undefined ? rate(l.rate) : undefined, erRet: l.employer });
  };
  employer(703, 'Accident de travail', line('AT'));
  employer(704, 'Prestation familiale', line('PF'));
  if (cnps?.employer) rows.push({ n: 705, label: 'Retraite générale', amount: cnps.base, erRate: rate((cnps.employer / cnps.base) * 100), erRet: cnps.employer });
  employer(706, 'CMU employeur', cmu, cmu?.employer);
  employer(707, "Taxe d'apprentissage", line('TA'));
  employer(708, 'Impôt sur traitement de salaire', line('CE'));
  employer(709, 'Taxe de formation professionnelle continue', line('FPC'));
  rows.push({ n: 901, label: 'Total retenue patronale', erRet: t.socialEmployer + t.taxesEmployer, total: true });
  if (gain('TRA')) rows.push({ n: 902, label: 'Prime de transport', gain: gain('TRA') });

  // Cumuls : ceux calculés par l'API, sinon ceux du seul bulletin
  const own = { taxable, transport: gain('TRA'), employeeCharges: t.socialEmployee + t.its, employerCharges: t.socialEmployer + t.taxesEmployer, net: slip.net, minutes: MONTHLY_HOURS * ratio * 60 };
  const cum = slip.cumuls?.period ?? own;
  const year = slip.cumuls?.year ?? own;
  const overtime = line('HS') ? '—' : '00:00';
  const cell = (v?: number) => (v === undefined ? '' : cfa(v));
  const where = [company?.address, company?.city].filter(Boolean).join(' - ');

  return (
    <div className="print-area fiche">
      <header className="fiche-head">
        <div className="fiche-company">{company?.name}</div>
        <div className="fiche-contact">
          {where && <div>{where}</div>}
          {company?.email && <div><b>Email :</b> {company.email}</div>}
          {company?.phone && <div><b>Tel :</b> {company.phone}</div>}
          {(company?.tax_id || company?.rccm) && <div>{[company?.rccm && `RCCM ${company.rccm}`, company?.tax_id && `NCC ${company.tax_id}`].filter(Boolean).join(' · ')}</div>}
        </div>
      </header>

      <h2 className="fiche-title">FICHE DE PAIE - {e.name}</h2>

      <table className="fiche-id">
        <tbody>
          <tr><th>Emploi occupé</th><th>Matricule</th><th>Numéro CNPS</th><th>Période</th></tr>
          <tr><td>{e.jobTitle ?? ''}</td><td>{e.number}</td><td>{e.cnpsNumber ?? ''}</td><td>{`01/${period.slice(5, 7)}/${period.slice(0, 4)} au ${fr(end)}`}</td></tr>
          <tr><th>Part</th><th>Date d'embauche</th><th>Ancienneté</th><th>Date de paiement</th></tr>
          <tr><td>{Number(e.parts).toFixed(1)}</td><td>{fr(e.hireDate)}</td><td>{seniority(e.hireDate, end)}</td><td>{fr(slip.paidAt ?? end)}</td></tr>
          <tr><th>Mode paiement</th><th>Niveau</th><th>Indice</th><th>Contrat</th></tr>
          <tr><td>{PAYMENT_METHODS[e.paymentMethod] ?? ''}</td><td></td><td></td><td>{CONTRACTS[e.contractType] ?? ''}</td></tr>
          <tr><th>Catégorie</th><th>Département</th><th>Qualification</th><th>CCN CCI</th></tr>
          <tr><td>{e.category ?? ''}</td><td>{e.department ?? ''}</td><td></td><td></td></tr>
        </tbody>
      </table>

      <div className="fiche-scroll">
        <table className="fiche-lines">
          <thead>
            <tr><th rowSpan={2}>N°</th><th rowSpan={2}>Désignation</th><th rowSpan={2}>Nombre</th><th rowSpan={2}>Montant</th><th colSpan={3}>Part salariale</th><th colSpan={3}>Part patronale</th></tr>
            <tr><th>Taux</th><th>Gain</th><th>Retenue</th><th>Taux</th><th>Gain</th><th>Retenue</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.n} className={r.total ? 'total' : undefined}>
                <td>{r.n}</td><td className="label">{r.label}</td><td>{r.count ?? ''}</td><td className="n">{cell(r.amount)}</td>
                <td className="n">{r.rate ?? ''}</td><td className="n">{cell(r.gain)}</td><td className="n">{cell(r.ret)}</td>
                <td className="n">{r.erRate ?? ''}</td><td className="n"></td><td className="n">{cell(r.erRet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="fiche-scroll">
        <table className="fiche-cumuls">
          <thead><tr><th>Cumuls</th><th>Salaire brut</th><th>Prime Transport</th><th>Charges salariales</th><th>Charges patronales</th><th>Heures travaillées</th><th>Heures sup.</th><th>Net à payer</th><th>NET A PAYER</th></tr></thead>
          <tbody>
            <tr><th>Période</th><td>{cfa(cum.taxable)}</td><td>{cfa(cum.transport)}</td><td>{cfa(cum.employeeCharges)}</td><td>{cfa(cum.employerCharges)}</td><td>{hours(cum.minutes)}</td><td>{overtime}</td><td>{cfa(cum.net)}</td>
              <td rowSpan={2} className="fiche-net">{cfa(slip.net)}</td></tr>
            <tr><th>Année</th><td>{cfa(year.taxable)}</td><td>{cfa(year.transport)}</td><td>{cfa(year.employeeCharges)}</td><td>{cfa(year.employerCharges)}</td><td>{hours(year.minutes)}</td><td>{overtime}</td><td>{cfa(year.net)}</td></tr>
          </tbody>
        </table>
      </div>

      {slip.leave && <>
        <div className="fiche-section">Informations congé</div>
        <table className="fiche-id">
          <tbody>
            <tr><th>Jours de congé acquis</th><th>Jours de congé pris</th><th>Jours de congé restant</th></tr>
            <tr><td>{slip.leave.acquired.toLocaleString('fr-FR')}</td><td>{slip.leave.taken.toLocaleString('fr-FR')}</td><td>{slip.leave.remaining.toLocaleString('fr-FR')}</td></tr>
          </tbody>
        </table>
      </>}

      <p className="fiche-foot">Pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée.</p>
      <div className="row no-print"><button type="button" className="btn" onClick={() => window.print()}>Imprimer / PDF</button><button type="button" className="btn" onClick={onClose}>Fermer</button></div>
    </div>
  );
}
