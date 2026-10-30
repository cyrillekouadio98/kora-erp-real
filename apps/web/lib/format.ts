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
  'contact.created': 'Contact créé', 'contact.updated': 'Contact modifié', 'contact.archived': 'Contact archivé',
  'contact.restored': 'Contact restauré', 'contact.exported': 'Contacts exportés',
  'product.created': 'Article créé', 'product.updated': 'Article modifié', 'product.archived': 'Article archivé', 'product.restored': 'Article restauré',
  'quote.created': 'Devis créé', 'quote.updated': 'Devis modifié', 'quote.deleted': 'Brouillon de devis supprimé', 'quote.validated': 'Devis envoyé',
  'quote.accepted': 'Devis accepté', 'quote.refused': 'Devis refusé', 'quote.invoiced': 'Devis transformé en facture', 'quote.exported': 'Devis exportés',
  'invoice.created': 'Facture créée', 'invoice.updated': 'Facture modifiée', 'invoice.deleted': 'Brouillon de facture supprimé', 'invoice.validated': 'Facture émise',
  'invoice.payment_recorded': 'Encaissement enregistré', 'invoice.exported': 'Factures exportées', 'invoice.reminder_recorded': 'Relance client enregistrée',
  'credit_note.created': 'Avoir créé', 'credit_note.updated': 'Avoir modifié', 'credit_note.deleted': 'Brouillon d’avoir supprimé', 'credit_note.validated': 'Avoir émis',
  'credit_note.exported': 'Avoirs exportés',
  'purchase_order.created': 'Bon de commande créé', 'purchase_order.updated': 'Bon de commande modifié', 'purchase_order.deleted': 'Brouillon de bon de commande supprimé',
  'purchase_order.validated': 'Bon de commande envoyé', 'purchase_order.cancelled': 'Bon de commande annulé', 'purchase_order.invoiced': 'Bon de commande facturé',
  'purchase_order.exported': 'Bons de commande exportés', 'purchase_invoice.created': 'Facture fournisseur saisie', 'purchase_invoice.updated': 'Facture fournisseur modifiée',
  'purchase_invoice.deleted': 'Brouillon de facture fournisseur supprimé', 'purchase_invoice.validated': 'Facture fournisseur validée',
  'purchase_invoice.payment_recorded': 'Règlement fournisseur enregistré', 'purchase_invoice.exported': 'Factures fournisseurs exportées',
};

export const DOC_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = {
  draft: ['Brouillon', 'mute'], sent: ['Envoyé', 'warn'], accepted: ['Accepté', 'ok'], refused: ['Refusé', 'crit'], invoiced: ['Facturé', 'ok'],
  issued: ['À encaisser', 'warn'], partially_paid: ['Payée en partie', 'warn'], paid: ['Payée', 'ok'], credited: ['Annulée par avoir', 'mute'],
};
/** Libellé et ton d'un statut selon le type de document (« émis » n'a pas le même sens pour une facture et un avoir). */
export const docStatus = (type: string, status: string): [string, 'ok' | 'warn' | 'crit' | 'mute'] =>
  type === 'credit_note' && status === 'issued' ? ['Émis', 'ok'] : DOC_STATUS[status];
export const REMINDER_CHANNELS: Record<string, string> = { phone: 'Appel téléphonique', whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail', letter: 'Courrier', visit: 'Visite' };
export const PAYMENT_METHODS: Record<string, string> = { cash: 'Espèces', mobile_money: 'Mobile money', bank_transfer: 'Virement', cheque: 'Chèque', card: 'Carte bancaire' };
export const DOC_LABEL = { quote: 'Devis', invoice: 'Facture', credit_note: 'Avoir' } as const;
export type DocType = keyof typeof DOC_LABEL;
export const VAT_RATES = [18, 9, 0];

export const PURCHASE_LABEL = { order: 'Bon de commande', invoice: 'Facture fournisseur' } as const;
export const PURCHASE_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = {
  draft: ['Brouillon', 'mute'], sent: ['Envoyé', 'warn'], cancelled: ['Annulé', 'mute'], invoiced: ['Facturé', 'ok'],
  to_pay: ['À payer', 'warn'], partially_paid: ['Payée en partie', 'warn'], paid: ['Payée', 'ok'],
};
