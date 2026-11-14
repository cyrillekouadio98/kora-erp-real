'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Pill, useAction } from '@/components/ui';
import { RoleDraft, RoleEditor } from '@/components/role-editor';

export default function RolesPage() {
  const { can, ctx } = useSession();
  const admin = can('users.admin') && !ctx?.readOnly;
  const [roles, setRoles] = useState<any[]>([]);
  const [edit, setEdit] = useState<RoleDraft | null>(null);
  const { error, run } = useAction();
  const load = useCallback(async () => { setRoles(await api('/company/roles')); }, []);
  // Chargement initial via run : une erreur (accès refusé, réseau) s'affiche au lieu de laisser la page vide.
  useEffect(() => { run(load); }, [load]);

  return (
    <>
      <div className="page-head"><h1>Rôles et permissions</h1>{admin && <button className="btn primary" onClick={() => setEdit({ name: '', description: '', permissions: [] })}>Nouveau rôle</button>}</div>
      <Alert>{error}</Alert>
      <div className="table-wrap"><table>
        <thead><tr><th>Rôle</th><th>Description</th><th className="n">Permissions</th><th className="n">Utilisateurs</th>{admin && <th></th>}</tr></thead>
        <tbody>{roles.map((r) => (
          <tr key={r.id}><td><b>{r.name}</b> {r.isSystem && <Pill>Standard</Pill>} {r.ownerOnly && r.key !== 'owner' && <Pill tone="warn">Attribué par un propriétaire</Pill>}</td><td className="small muted">{r.description}</td><td className="n">{r.permissions.length}</td><td className="n">{r.memberCount}</td>
            {admin && <td className="n"><div className="row" style={{ justifyContent: 'flex-end' }}>
              {r.key !== 'owner' && <button className="btn sm" onClick={() => setEdit({ ...r })}>Modifier</button>}
              {!r.isSystem && <button className="btn sm danger" onClick={() => run(async () => { await api(`/company/roles/${r.id}`, { method: 'DELETE' }); await load(); })}>Supprimer</button>}
            </div></td>}
          </tr>))}</tbody>
      </table></div>
      {edit && <RoleEditor role={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await load(); }} />}
    </>
  );
}
