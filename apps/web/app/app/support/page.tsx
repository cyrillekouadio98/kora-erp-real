'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Alert, Pill, useAction } from '@/components/ui';

const STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = { requested: ['En attente de votre décision', 'warn'], approved: ['Accordé', 'ok'], denied: ['Refusé', 'mute'], revoked: ['Révoqué', 'mute'] };
const SCOPES: Record<string, string> = { users: 'Utilisateurs', settings: 'Paramètres', billing: 'Abonnement', audit: "Journal d'audit" };

export default function SupportPage() {
  const [rows, setRows] = useState<any[]>([]);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setRows(await api('/company/support-access')), []);
  useEffect(() => { load(); }, [load]);
  const act = (id: string, a: string) => run(async () => { await api(`/company/support-access/${id}/${a}`, { method: 'POST', body: {} }); await load(); });
  return (
    <>
      <div className="page-head"><h1>Accès du support</h1></div>
      <Alert kind="info">L'équipe de l'éditeur n'a pas accès à vos données. Pour vous aider, elle doit vous en demander l'autorisation ici, pour une durée et un périmètre limités. Chacune de ses consultations apparaît dans votre journal d'audit.</Alert>
      <Alert>{error}</Alert>
      {rows.length === 0 ? <p className="muted">Aucune demande d'accès.</p> : (
        <div className="table-wrap"><table><thead><tr><th>Demandée le</th><th>Motif</th><th>Périmètre</th><th>Durée</th><th>Statut</th><th></th></tr></thead>
          <tbody>{rows.map((r) => {
            const active = r.status === 'approved' && r.expiresAt && new Date(r.expiresAt) > new Date();
            return (
              <tr key={r.id}><td className="small">{dateTime(r.createdAt)}</td><td>{r.reason}</td><td className="small">{r.scope.map((s: string) => SCOPES[s] ?? s).join(', ')}</td><td className="small">{r.durationMinutes / 60} h</td>
                <td><Pill tone={STATUS[r.status][1]}>{r.status === 'approved' && !active ? 'Expiré' : STATUS[r.status][0]}</Pill>{active && <div className="small muted">jusqu'au {dateTime(r.expiresAt)}</div>}</td>
                <td className="n"><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {r.status === 'requested' && <><button className="btn sm primary" disabled={busy} onClick={() => act(r.id, 'approve')}>Accorder</button><button className="btn sm" disabled={busy} onClick={() => act(r.id, 'deny')}>Refuser</button></>}
                  {active && <button className="btn sm danger" disabled={busy} onClick={() => act(r.id, 'revoke')}>Révoquer</button>}
                </div></td></tr>
            );
          })}</tbody></table></div>)}
    </>
  );
}
