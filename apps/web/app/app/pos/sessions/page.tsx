'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { ZReport } from '@/components/pos';
import { Alert, Pill, useAction } from '@/components/ui';

const when = (v?: string | null) => (v ? new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** Sessions de caisse : ouverture, clôture, écarts ; rapport X (en cours) ou Z (clôturée). */
export default function PosSessionsPage() {
  return <Suspense><PosSessions /></Suspense>;
}

function PosSessions() {
  const params = useSearchParams();
  const router = useRouter();
  const [rows, setRows] = useState<any[] | null>(null);
  const [registers, setRegisters] = useState<any[]>([]);
  const [registerId, setRegisterId] = useState('');
  const [report, setReport] = useState<any>(null);
  const { error, run } = useAction();
  const open = params.get('id');

  const load = useCallback(() => run(async () => setRows(await api(`/company/pos/sessions${registerId ? `?registerId=${registerId}` : ''}`))), [registerId]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api<any[]>('/company/pos/registers?archived=true').then(setRegisters, () => {}); }, []);
  useEffect(() => { if (open) run(async () => setReport(await api(`/company/pos/sessions/${open}/report`))); else setReport(null); }, [open]); // eslint-disable-line
  const show = (id: string | null) => router.replace(id ? `/app/pos/sessions?id=${id}` : '/app/pos/sessions', { scroll: false });

  return (
    <>
      <div className="page-head"><h1>Sessions de caisse</h1>
        <label className="field" style={{ minWidth: 200 }}>Caisse
          <select className="input" value={registerId} onChange={(e) => setRegisterId(e.target.value)}><option value="">Toutes</option>{registers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      </div>
      <Alert>{!report && error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Session</th><th>Caisse</th><th>Ouverture</th><th>Clôture</th><th className="n">Tickets</th><th className="n">Ventes TTC</th><th className="n">Fond</th><th className="n">Attendu</th><th className="n">Compté</th><th className="n">Écart</th><th></th></tr></thead>
        <tbody>
          {rows?.map((s) => (
            <tr key={s.id} className="clickable" style={{ cursor: 'pointer' }} onClick={() => show(s.id)}>
              <td style={{ whiteSpace: 'nowrap' }}><code className="k">{s.number}</code></td>
              <td>{s.registerName}</td>
              <td><span style={{ whiteSpace: 'nowrap' }}>{when(s.openedAt)}</span><div className="small muted">{s.openedBy}</div></td>
              <td>{s.status === 'open' ? <Pill tone="ok">Ouverte</Pill> : <><span style={{ whiteSpace: 'nowrap' }}>{when(s.closedAt)}</span><div className="small muted">{s.closedBy}</div></>}</td>
              <td className="n">{s.tickets}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(s.total)}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{money(s.openingFloat)}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{s.expectedCash == null ? '—' : money(s.expectedCash)}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{s.countedCash == null ? '—' : money(s.countedCash)}</td>
              <td className="n" style={{ whiteSpace: 'nowrap' }}>{s.difference == null ? '—' : s.difference === 0 ? <Pill tone="ok">0</Pill> : <Pill tone={Math.abs(s.difference) > 1000 ? 'crit' : 'warn'}>{s.difference > 0 ? '+' : ''}{money(s.difference)}</Pill>}</td>
              <td className="n"><button className="btn sm">{s.status === 'open' ? 'Rapport X' : 'Rapport Z'}</button></td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 28 }}>Aucune session pour l’instant : ouvrez une caisse depuis Point de vente.</td></tr>}
        </tbody>
      </table></div>

      {report && (
        <div className="modal-back" onClick={() => show(null)}>
          <div className="modal" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <ZReport r={report} />
            <div className="row no-print"><button className="btn primary" onClick={() => window.print()}>Imprimer</button><button className="btn" onClick={() => show(null)}>Fermer</button></div>
          </div>
        </div>
      )}
    </>
  );
}
