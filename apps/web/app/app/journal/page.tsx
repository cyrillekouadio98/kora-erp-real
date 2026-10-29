'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ACTION_LABELS, dateTime } from '@/lib/format';
import { Pill } from '@/components/ui';

const ACTORS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = { user: ['Utilisateur', 'mute'], support: ['Support éditeur', 'warn'], platform: ['Éditeur', 'warn'], system: ['Automatique', 'mute'] };

export default function AuditPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [more, setMore] = useState(true);
  const load = async (before?: string) => {
    const r = await api(`/company/audit?limit=50${before ? `&before=${before}` : ''}`);
    setRows((x) => (before ? [...x, ...r] : r)); setMore(r.length === 50);
  };
  useEffect(() => { load(); }, []);
  return (
    <>
      <div className="page-head"><h1>Journal d'audit</h1></div>
      <p className="muted small" style={{ margin: 0 }}>Toutes les actions sensibles sur votre entreprise, y compris celles de l'éditeur et de son support. Ce journal ne peut pas être modifié.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Auteur</th><th>Action</th><th>Détails</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{dateTime(r.createdAt)}</td>
            <td>{r.actorName ?? '—'} <Pill tone={ACTORS[r.actorType]?.[1]}>{ACTORS[r.actorType]?.[0]}</Pill></td>
            <td>{ACTION_LABELS[r.action] ?? r.action}</td>
            <td className="small muted" style={{ maxWidth: 380, wordBreak: 'break-word' }}>{Object.keys(r.data ?? {}).length ? JSON.stringify(r.data) : ''}</td></tr>))}</tbody>
      </table></div>
      {more && rows.length > 0 && <button className="btn" onClick={() => load(rows[rows.length - 1].id)}>Voir plus</button>}
    </>
  );
}
