'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/components/session';
import { Alert, Field, useAction } from '@/components/ui';

const ACTION_KEYS = ['read', 'create', 'update', 'validate', 'cancel', 'export', 'admin'];

export type RoleDraft = { id?: string; name: string; description?: string | null; permissions: string[] };

/**
 * Création ou modification d'un rôle : nom, description et permissions par module.
 * Utilisé par l'application Rôles et par Utilisateurs (créer un rôle au moment d'inviter ou de modifier un accès).
 */
export function RoleEditor({ role, onClose, onSaved }: { role: RoleDraft; onClose: () => void; onSaved: (role: any) => void | Promise<void> }) {
  const { ctx } = useSession();
  const [edit, setEdit] = useState<RoleDraft>(role);
  const [catalog, setCatalog] = useState<any>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { run(async () => setCatalog(await api('/permissions'))); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (p: string) => setEdit({ ...edit, permissions: edit.permissions.includes(p) ? edit.permissions.filter((x) => x !== p) : [...edit.permissions, p] });
  const save = () => run(async () => {
    const body = { name: edit.name, description: edit.description, permissions: edit.permissions };
    const saved = edit.id ? await api(`/company/roles/${edit.id}`, { method: 'PATCH', body }) : await api('/company/roles', { body });
    await onSaved(saved);
  });

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="role-editor-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="role-editor-title">{edit.id ? `Modifier « ${role.name} »` : 'Nouveau rôle'}</h2>
        <Alert>{error}</Alert>
        <div className="grid2">
          <Field label="Nom" placeholder="Ex. Responsable de boutique" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <Field label="Description" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
        </div>
        {!catalog ? <p className="muted small">Chargement des permissions…</p> : <>
          <div style={{ overflowX: 'auto' }}><div className="perm-grid" style={{ minWidth: 640 }}>
            <div className="h" style={{ justifyContent: 'flex-start' }}>Module</div>{ACTION_KEYS.map((a) => <div key={a} className="h">{catalog.actions[a]}</div>)}
            {catalog.modules.map((m: any) => [
              <div key={m.key}>{m.label}{!ctx?.entitlements.modules.includes(m.entitlement) && <span className="small muted">&nbsp;(hors formule)</span>}</div>,
              ...ACTION_KEYS.map((a) => <div key={`${m.key}.${a}`} className="c">{(m.actions ?? ACTION_KEYS).includes(a) && <input type="checkbox" aria-label={`${m.label} ${catalog.actions[a]}`} checked={edit.permissions.includes(`${m.key}.${a}`)} onChange={() => toggle(`${m.key}.${a}`)} />}</div>),
            ])}
          </div></div>
          {[['Administration', catalog.core, false], ['Permissions sensibles (propriétaire uniquement)', catalog.sensitive, true], ['Espace personnel', catalog.self, false]].map(([title, perms, sensitive]: any) => (
            <fieldset key={title} style={{ border: 0, padding: 0, display: 'grid', gap: 4 }}>
              <legend className="small" style={{ fontWeight: 600, marginBottom: 6, color: sensitive ? 'var(--crit)' : undefined }}>{title}</legend>
              {Object.entries(perms).map(([k, label]: any) => <label key={k} className="row small"><input type="checkbox" checked={edit.permissions.includes(k)} onChange={() => toggle(k)} disabled={sensitive && !ctx?.isOwner} /> {label}</label>)}
            </fieldset>
          ))}
        </>}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy || !catalog || edit.name.trim().length < 2} onClick={save}>{edit.id ? 'Enregistrer' : 'Créer le rôle'}</button>
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
        </div>
      </div>
    </div>
  );
}
