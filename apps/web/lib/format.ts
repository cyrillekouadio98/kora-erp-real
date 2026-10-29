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
};
