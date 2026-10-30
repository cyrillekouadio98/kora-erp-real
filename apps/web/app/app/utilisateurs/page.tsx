'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

export default function UsersPage() {
  const { can, me, ctx } = useSession();
  const admin = can('users.admin') && !ctx?.readOnly;
  const [members, setMembers] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [link, setLink] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    setMembers(await api('/company/members'));
    const r = await api('/company/roles'); setRoles(r); setRoleId((v) => v || r.find((x: any) => x.key === 'sales_rep')?.id || r[0]?.id);
    if (can('users.admin')) setInvites((await api('/company/invitations')).filter((i: any) => !i.acceptedAt && !i.revokedAt));
  }, [can]);
  useEffect(() => { load(); }, [load]);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? '—';

  return (
    <>
      <div className="page-head"><h1>Utilisateurs</h1></div>
      <Alert>{error}</Alert>
      {admin && (
        <div className="card">
          <header><h2>Inviter un collaborateur</h2><span className="small muted">L'invitation est valable 7 jours.</span></header>
          <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api('/company/invitations', { body: { email, roleIds: [roleId] } }); setLink(r.inviteUrl); setEmail(''); await load(); }); }}>
            <div style={{ flex: 2, minWidth: 220 }}><Field label="Adresse e-mail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <label className="field" style={{ flex: 1, minWidth: 180 }}>Rôle
              <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            </label>
            <button className="btn primary" disabled={busy} style={{ alignSelf: 'flex-end' }}>Inviter</button>
          </form>
          {link && <Alert kind="ok">Invitation envoyée par e-mail. Vous pouvez aussi transmettre ce lien directement (WhatsApp…) :<br /><code className="k" style={{ wordBreak: 'break-all' }}>{link}</code></Alert>}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Nom</th><th>Rôles</th><th>Statut</th><th>Double auth.</th><th>Accès jusqu'au</th>{admin && <th></th>}</tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td><b>{m.fullName}</b>{m.isOwner && <> <Pill tone="ok">Propriétaire</Pill></>}<div className="small muted">{m.email}</div></td>
                <td>{m.roles.map((r: any) => r.name).join(', ')}</td>
                <td><Pill tone={m.status === 'active' ? 'ok' : 'mute'}>{m.status === 'active' ? 'Actif' : 'Désactivé'}</Pill></td>
                <td>{m.mfaEnabled ? <Pill tone="ok">Activée</Pill> : <Pill tone="warn">Non</Pill>}</td>
                <td>{m.validUntil ? date(m.validUntil) : '—'}</td>
                {admin && <td>{m.email !== me.user.email && <button className="btn sm" onClick={() => setEditing({ ...m, roleIds: m.roles.map((r: any) => r.id) })}>Modifier</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {admin && invites.length > 0 && (
        <div className="card">
          <header><h2>Invitations en attente</h2></header>
          <div className="table-wrap"><table><tbody>
            {invites.map((i) => <tr key={i.id}><td>{i.email}</td><td>{i.roleIds.map(roleName).join(', ')}</td><td className="small muted">expire le {date(i.expiresAt)}</td>
              <td className="n"><button className="btn sm danger" onClick={() => run(async () => { await api(`/company/invitations/${i.id}`, { method: 'DELETE' }); await load(); })}>Annuler</button></td></tr>)}
          </tbody></table></div>
        </div>
      )}
      {editing && (
        <div className="modal-back" onClick={() => setEditing(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); run(async () => {
            await api(`/company/members/${editing.id}`, { method: 'PATCH', body: { roleIds: editing.roleIds, status: editing.status, validUntil: editing.validUntil || null } });
            setEditing(null); await load(); }); }}>
            <h2>{editing.fullName}</h2>
            <Alert>{error}</Alert>
            <fieldset style={{ border: 0, padding: 0, display: 'grid', gap: 6 }}><legend className="small muted" style={{ marginBottom: 6 }}>Rôles</legend>
              {roles.map((r) => <label key={r.id} className="row small"><input type="checkbox" checked={editing.roleIds.includes(r.id)} onChange={(e) => setEditing({ ...editing, roleIds: e.target.checked ? [...editing.roleIds, r.id] : editing.roleIds.filter((x: string) => x !== r.id) })} /> {r.name} <span className="muted">— {r.description}</span></label>)}
            </fieldset>
            <div className="grid2">
              <label className="field">Statut<select className="input" value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}><option value="active">Actif</option><option value="disabled">Désactivé</option></select></label>
              <Field label="Accès jusqu'au (auditeur, consultant)" type="date" value={editing.validUntil ?? ''} onChange={(e) => setEditing({ ...editing, validUntil: e.target.value })} />
            </div>
            <div className="row"><button className="btn primary" disabled={busy || !editing.roleIds.length}>Enregistrer</button><button type="button" className="btn" onClick={() => setEditing(null)}>Annuler</button></div>
          </form>
        </div>
      )}
    </>
  );
}
