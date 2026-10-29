'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const ACTION_KEYS = ['read', 'create', 'update', 'validate', 'cancel', 'export', 'admin'];

export default function RolesPage() {
  const { can, ctx } = useSession();
  const admin = can('users.admin') && !ctx?.readOnly;
  const [roles, setRoles] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => { setRoles(await api('/company/roles')); setCatalog(await api('/permissions')); }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (p: string) => setEdit({ ...edit, permissions: edit.permissions.includes(p) ? edit.permissions.filter((x: string) => x !== p) : [...edit.permissions, p] });
  const save = () => run(async () => {
    const body = { name: edit.name, description: edit.description, permissions: edit.permissions };
    if (edit.id) await api(`/company/roles/${edit.id}`, { method: 'PATCH', body }); else await api('/company/roles', { body });
    setEdit(null); await load();
  });

  return (
    <>
      <div className="page-head"><h1>Rôles et permissions</h1>{admin && <button className="btn primary" onClick={() => setEdit({ name: '', description: '', permissions: [] })}>Nouveau rôle</button>}</div>
      <Alert>{error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Rôle</th><th>Description</th><th className="n">Permissions</th><th className="n">Utilisateurs</th>{admin && <th></th>}</tr></thead>
        <tbody>{roles.map((r) => (
          <tr key={r.id}><td><b>{r.name}</b> {r.isSystem && <Pill>Standard</Pill>}</td><td className="small muted">{r.description}</td><td className="n">{r.permissions.length}</td><td className="n">{r.memberCount}</td>
            {admin && <td className="n"><div className="row" style={{ justifyContent: 'flex-end' }}>
              {r.key !== 'owner' && <button className="btn sm" onClick={() => setEdit({ ...r })}>Modifier</button>}
              {!r.isSystem && <button className="btn sm danger" onClick={() => run(async () => { await api(`/company/roles/${r.id}`, { method: 'DELETE' }); await load(); })}>Supprimer</button>}
            </div></td>}
          </tr>))}</tbody>
      </table></div>
      {edit && catalog && (
        <div className="modal-back" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{edit.id ? `Modifier « ${edit.name} »` : 'Nouveau rôle'}</h2>
            <Alert>{error}</Alert>
            <div className="grid2"><Field label="Nom" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /><Field label="Description" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
            <div style={{ overflowX: 'auto' }}><div className="perm-grid" style={{ minWidth: 640 }}>
              <div className="h" style={{ justifyContent: 'flex-start' }}>Module</div>{ACTION_KEYS.map((a) => <div key={a} className="h">{catalog.actions[a]}</div>)}
              {catalog.modules.map((m: any) => [
                <div key={m.key}>{m.label}{!ctx?.entitlements.modules.includes(m.entitlement) && <span className="small muted">&nbsp;(hors formule)</span>}</div>,
                ...ACTION_KEYS.map((a) => <div key={`${m.key}.${a}`} className="c"><input type="checkbox" aria-label={`${m.label} ${catalog.actions[a]}`} checked={edit.permissions.includes(`${m.key}.${a}`)} onChange={() => toggle(`${m.key}.${a}`)} /></div>),
              ])}
            </div></div>
            {[['Administration', catalog.core, false], ['Permissions sensibles (propriétaire uniquement)', catalog.sensitive, true], ['Espace personnel', catalog.self, false]].map(([title, perms, sensitive]: any) => (
              <fieldset key={title} style={{ border: 0, padding: 0, display: 'grid', gap: 4 }}>
                <legend className="small" style={{ fontWeight: 600, marginBottom: 6, color: sensitive ? 'var(--crit)' : undefined }}>{title}</legend>
                {Object.entries(perms).map(([k, label]: any) => <label key={k} className="row small"><input type="checkbox" checked={edit.permissions.includes(k)} onChange={() => toggle(k)} disabled={sensitive && !ctx?.isOwner} /> {label}</label>)}
              </fieldset>
            ))}
            <div className="row"><button className="btn primary" disabled={busy || edit.name.length < 2} onClick={save}>Enregistrer</button><button className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
          </div>
        </div>
      )}
    </>
  );
}
