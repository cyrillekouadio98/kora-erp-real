const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
export const money = (n: number, currency = 'XOF') => `${nf.format(Math.round(n))} ${currency === 'XOF' ? 'FCFA' : currency}`;
export const date = (v?: string | null) => (v ? new Date(v).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (v?: string | null) => (v ? new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export const SUB_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = {
  trialing: ["Période d'essai", 'ok'], active: ['Actif', 'ok'], grace: ['Paiement en attente', 'warn'],
  suspended: ['Suspendu', 'crit'], cancelled: ['Résilié', 'mute'], archived: ['Archivé', 'mute'],
};

export const ACTION_LABELS: Record<string, string> = {
  'company.created': 'Entreprise créée', 'company.updated': 'Fiche entreprise modifiée', 'company.suspended': 'Entreprise suspendue par l’éditeur',
  'company.reactivated': 'Entreprise réactivée par l’éditeur', 'session.company_selected': 'Entreprise sélectionnée',
  'role.created': 'Rôle créé', 'role.updated': 'Rôle modifié', 'role.deleted': 'Rôle supprimé',
  'member.updated': 'Accès d’un utilisateur modifié', 'invitation.created': 'Invitation envoyée', 'invitation.revoked': 'Invitation annulée',
  'invitation.accepted': 'Invitation acceptée', 'subscription.status_changed': 'Statut de l’abonnement modifié',
  'subscription.payment_received': 'Paiement reçu', 'subscription.plan_changed': 'Formule changée', 'subscription.change_requested': 'Changement de formule demandé',
  'subscription.downgrade_scheduled': 'Changement de formule programmé', 'subscription.cancel_requested': 'Résiliation demandée',
  'subscription.cancel_withdrawn': 'Résiliation annulée', 'support_access.requested': 'Le support demande un accès',
  'support_access.approved': 'Accès support accordé', 'support_access.denied': 'Accès support refusé', 'support_access.revoked': 'Accès support révoqué',
  'support.viewed': 'Consultation par le support', 'data.exported': 'Export complet des données',
  'subscription.downgrade_withdrawn': 'Changement de formule programmé annulé', 'subscription.payment_unapplied': 'Paiement reçu non affecté',
};

// ---------------------------------------------------------------- détails du journal d'audit, en clair

const DETAIL_LABELS: Record<string, string> = {
  to: 'Nouvelle valeur', from: 'Ancienne valeur', cycle: 'Facturation', effective_at: "Date d'effet", amount: 'Montant', number: 'Facture',
  invoice: 'Facture', renewal_invoice: 'Facture de renouvellement', provider: 'Moyen de paiement', reason: 'Motif', email: 'E-mail', name: 'Nom',
  scope: 'Périmètre', expires_at: "Jusqu'au", during_trial: "Pendant l'essai", tables: 'Données', kept: 'Formule conservée', at: 'Le',
  status: 'Statut', roles: 'Rôles', role_ids: 'Rôles', valid_until: "Accès jusqu'au", added: 'Permissions ajoutées', removed: 'Permissions retirées',
  permissions: 'Permissions', user_id: 'Utilisateur', received: 'Reçu', expected: 'Attendu', invoice_status: 'Statut de la facture',
  // Champs de la fiche entreprise
  legal_form: 'Forme juridique', rccm: 'RCCM', tax_id: 'Compte contribuable (NCC)', tax_regime: 'Régime fiscal', address: 'Adresse',
  city: 'Ville', phone: 'Téléphone',
};
const VALUE_LABELS: Record<string, string> = {
  monthly: 'mensuelle', yearly: 'annuelle', sandbox: 'paiement de test', manual: 'virement saisi par l’éditeur', active: 'actif', disabled: 'désactivé',
  unpaid_at_period_end: 'impayé à l’échéance', grace_expired: 'période de grâce écoulée', trial_cancelled: 'essai résilié',
  cancelled_at_period_end: 'résiliation à l’échéance', retention_period_over: 'durée de conservation écoulée',
  amount_mismatch: 'montant différent de la facture', invoice_not_open: 'facture déjà réglée ou annulée',
  users: 'utilisateurs', settings: 'paramètres', billing: 'abonnement', audit: "journal d'audit", open: 'à régler', paid: 'réglée', void: 'annulée',
  starter: 'Starter', business: 'Business', premium: 'Premium', cabinet: 'Cabinet', enterprise: 'Enterprise',
  // Contenu de l'export
  company: 'fiche entreprise', members: 'utilisateurs', roles: 'rôles', member_roles: 'attribution des rôles', invitations: 'invitations',
  subscription: 'abonnement', invoices: 'factures', audit_log: "journal d'audit",
};
/** Identifiants techniques (sans intérêt pour le lecteur), masqués du journal. */
const HIDDEN_KEYS = new Set(['membership_id', 'payment_id', 'provider_ref', 'user_id']);
const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isIsoDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v);

function detailValue(key: string, v: unknown, names: Record<string, string>): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (key === 'amount' && typeof v === 'number') return money(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => detailValue(key, x, names)).join(', ') : 'aucune';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('from' in o || 'to' in o) return `${detailValue(key, o.from, names)} → ${detailValue(key, o.to, names)}`;
    if ('amount' in o) return money(Number(o.amount), String(o.currency ?? 'XOF'));
    return Object.entries(o).map(([k, x]) => `${DETAIL_LABELS[k] ?? k} : ${detailValue(k, x, names)}`).join(' · ');
  }
  if (isUuid(v)) return names[v as string] ?? '—';
  if (isIsoDate(v)) return (v as string).length > 10 ? dateTime(v as string) : date(v as string);
  const s = String(v);
  if ((key === 'to' || key === 'from') && SUB_STATUS[s]) return SUB_STATUS[s][0];
  return VALUE_LABELS[s] ?? s;
}

/**
 * Détails d'une entrée du journal, lisibles par un non-technicien : une ligne par information.
 * `names` traduit les identifiants connus (rôles) en libellés ; les autres identifiants sont masqués.
 */
export function auditDetails(data: Record<string, unknown> | null | undefined, names: Record<string, string> = {}): string[] {
  if (!data) return [];
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (HIDDEN_KEYS.has(k) || v === undefined) continue;
    if (k === 'changes' && v && typeof v === 'object') {
      // Modification de la fiche entreprise : une ligne par champ modifié.
      // Les entrées antérieures au correctif de l'API contiennent aussi les champs inchangés : on les écarte.
      for (const [field, change] of Object.entries(v as Record<string, unknown>)) {
        const c = change as { from?: unknown; to?: unknown } | null;
        if (c && typeof c === 'object' && JSON.stringify(c.from ?? null) === JSON.stringify(c.to ?? null)) continue;
        lines.push(`${DETAIL_LABELS[field] ?? field} : ${detailValue(field, change, names)}`);
      }
      continue;
    }
    // Information absente (ex. aucune facture de renouvellement réémise) : rien à afficher.
    if (v === null || (isUuid(v) && !names[v as string])) continue;
    lines.push(`${DETAIL_LABELS[k] ?? k} : ${detailValue(k, v, names)}`);
  }
  return lines;
}
