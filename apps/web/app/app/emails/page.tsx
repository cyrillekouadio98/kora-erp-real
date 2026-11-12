'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';

const KINDS: Record<string, string> = { invitation: 'Invitation', sales_document: 'Document de vente', reminder: 'Relance client', password_reset: 'Mot de passe' };
const STATUS: Record<string, [string, 'ok' | 'warn' | 'crit']> = { sent: ['Envoyé', 'ok'], queued: ['En attente', 'warn'], failed: ['Échec', 'crit'] };

export default function EmailsPage() {
  const { can, ctx } = useSession();
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api('/company/emails').then(setData), []);
  useEffect(() => { load(); const h = setInterval(load, 15000); return () => clearInterval(h); }, [load]);
  return (
    <>
      <div className="page-head"><h1>E-mails envoyés</h1><button className="btn" onClick={load}>Actualiser</button></div>
      {data?.mode === 'development' && <Alert kind="warn"><b>Mode développement :</b> aucun serveur d'envoi (SMTP) n'est configuré, les e-mails ne partent pas réellement. Leur contenu reste consultable ici. En production, renseignez <code className="k">SMTP_URL</code>.</Alert>}
      <Alert>{error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Destinataire</th><th>Objet</th><th>Type</th><th>Statut</th><th></th></tr></thead>
        <tbody>
          {data?.messages.map((m: any) => (
            <tr key={m.id}>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>{dateTime(m.createdAt)}</td><td>{m.to}</td><td className="small">{m.subject}</td><td className="small">{KINDS[m.kind] ?? m.kind}</td>
              <td><Pill tone={STATUS[m.status][1]}>{STATUS[m.status][0]}</Pill>{m.status !== 'sent' && m.attempts > 0 && <div className="small muted">{m.attempts} tentative(s){m.lastError ? ` · ${m.lastError}` : ''}</div>}</td>
              <td className="n"><div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                <button className="btn sm" onClick={() => setOpen(m)}>Voir</button>
                {m.status === 'failed' && can('settings.admin') && !ctx?.readOnly && <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api(`/company/emails/${m.id}/retry`, { body: {} }); await load(); })}>Renvoyer</button>}
              </div></td>
            </tr>
          ))}
          {data && !data.messages.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>Aucun e-mail pour l'instant : invitations, envois de documents et relances apparaîtront ici.</td></tr>}
        </tbody>
      </table></div>
      {open && (
        <div className="modal-back" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{open.subject}</h2>
            <p className="small muted" style={{ margin: 0 }}>À : {open.to} · {dateTime(open.createdAt)}</p>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--surface-2)', padding: 14, borderRadius: 8, margin: 0 }}>{open.text}</pre>
            <div className="row"><button className="btn" onClick={() => setOpen(null)}>Fermer</button></div>
          </div>
        </div>
      )}
    </>
  );
}
