'use client';
import { CONTRACTS, date, money } from '@/lib/format';

/** Bulletin de paie imprimable. */
export function Payslip({ slip, label, company, onClose }: { slip: any; label: string; company: any; onClose: () => void }) {
  const e = slip.employee;
  const gains = slip.lines.filter((l: any) => l.gain !== undefined);
  const deductions = slip.lines.filter((l: any) => l.employee !== undefined || l.employer !== undefined);
  return (
    <div className="print-area" style={{ display: 'grid', gap: 12 }}>
      <div className="doc-head">
        <div><div className="doc-company">{company?.name}</div><div className="small muted">{[company?.address, company?.city].filter(Boolean).join(', ')}</div>
          <div className="small muted">{company?.tax_id && `NCC ${company.tax_id}`}</div></div>
        <div style={{ textAlign: 'right' }}><div className="doc-title" style={{ fontSize: 18 }}>Bulletin de paie</div><div><b>{label[0].toUpperCase() + label.slice(1)}</b></div></div>
      </div>
      <div className="grid2 small">
        <div><b>{e.name}</b> · {e.number}<br />{e.jobTitle ?? '—'}{e.department ? ` · ${e.department}` : ''}<br />Contrat : {CONTRACTS[e.contractType]} · entré le {date(e.hireDate)}</div>
        <div>N° CNPS : {e.cnpsNumber ?? '—'}<br />Parts fiscales : {e.parts}</div>
      </div>
      <table className="vat" style={{ width: '100%' }}>
        <thead><tr><th>Éléments de rémunération</th><th className="n">Montant</th></tr></thead>
        <tbody>{gains.map((l: any) => <tr key={l.code}><td>{l.label}</td><td className="n">{money(l.gain)}</td></tr>)}
          <tr><td><b>Salaire brut</b></td><td className="n"><b>{money(slip.gross)}</b></td></tr></tbody>
      </table>
      <table className="vat" style={{ width: '100%' }}>
        <thead><tr><th>Cotisations et retenues</th><th className="n">Base</th><th className="n">Taux</th><th className="n">Salarié</th><th className="n">Employeur</th></tr></thead>
        <tbody>{deductions.map((l: any) => <tr key={l.code}><td>{l.label}</td><td className="n">{l.base !== undefined ? money(l.base) : ''}</td><td className="n">{l.rate !== undefined ? `${l.rate.toLocaleString('fr-FR')} %` : ''}</td>
          <td className="n">{l.employee ? money(l.employee) : ''}</td><td className="n">{l.employer ? money(l.employer) : ''}</td></tr>)}
          <tr><td colSpan={3}><b>Total</b></td><td className="n"><b>{money(slip.totals.deductions)}</b></td><td className="n"><b>{money(slip.totals.socialEmployer + slip.totals.taxesEmployer)}</b></td></tr></tbody>
      </table>
      <dl className="totals" style={{ justifySelf: 'end' }}><dt className="grand">Net à payer</dt><dd className="grand">{money(slip.net)}</dd><dt>Coût total employeur</dt><dd>{money(slip.employerCost)}</dd></dl>
      <div className="row no-print"><button type="button" className="btn" onClick={() => window.print()}>Imprimer / PDF</button><button type="button" className="btn" onClick={onClose}>Fermer</button></div>
    </div>
  );
}
