const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
export const money = (n: number, currency = 'XOF') => `${nf.format(Math.round(n))} ${currency === 'XOF' ? 'FCFA' : currency}`;
export const date = (v?: string | null) => (v ? new Date(v).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (v?: string | null) => (v ? new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** Entreprise préparée par l'éditeur (console). */
export const SETUP_STATUS: Record<string, [string, 'ok' | 'warn' | 'mute']> = {
  preparing: ['En préparation', 'warn'], handed_over: ['Remise, en attente du client', 'mute'], active: ['Prise en main', 'ok'],
};
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
  'quote.ordered': 'Devis transformé en bon de commande', 'order.created': 'Bon de commande client créé', 'order.updated': 'Bon de commande client modifié',
  'order.deleted': 'Brouillon de bon de commande client supprimé', 'order.validated': 'Bon de commande client confirmé', 'order.invoiced': 'Bon de commande client transformé en facture',
  'order.cancelled': 'Bon de commande client annulé', 'order.exported': 'Bons de commande clients exportés',
  'invoice.created': 'Facture créée', 'invoice.updated': 'Facture modifiée', 'invoice.deleted': 'Brouillon de facture supprimé', 'invoice.validated': 'Facture émise',
  'invoice.payment_recorded': 'Encaissement enregistré', 'invoice.exported': 'Factures exportées', 'invoice.reminder_recorded': 'Relance client enregistrée',
  'credit_note.created': 'Avoir créé', 'credit_note.updated': 'Avoir modifié', 'credit_note.deleted': 'Brouillon d’avoir supprimé', 'credit_note.validated': 'Avoir émis',
  'credit_note.exported': 'Avoirs exportés',
  'purchase_order.created': 'Bon de commande créé', 'purchase_order.updated': 'Bon de commande modifié', 'purchase_order.deleted': 'Brouillon de bon de commande supprimé',
  'purchase_order.validated': 'Bon de commande envoyé', 'purchase_order.cancelled': 'Bon de commande annulé', 'purchase_order.invoiced': 'Bon de commande facturé',
  'purchase_order.exported': 'Bons de commande exportés', 'purchase_invoice.created': 'Facture fournisseur saisie', 'purchase_invoice.updated': 'Facture fournisseur modifiée',
  'purchase_invoice.deleted': 'Brouillon de facture fournisseur supprimé', 'purchase_invoice.validated': 'Facture fournisseur validée',
  'purchase_invoice.payment_recorded': 'Règlement fournisseur enregistré', 'purchase_invoice.exported': 'Factures fournisseurs exportées',
  'invoice.refund_recorded': 'Trop-perçu remboursé au client', 'treasury_account.created': 'Compte de trésorerie créé', 'treasury_account.updated': 'Compte de trésorerie modifié',
  'treasury_account.archived': 'Compte de trésorerie archivé', 'treasury_account.restored': 'Compte de trésorerie restauré', 'treasury.expense_recorded': 'Dépense enregistrée',
  'treasury.income_recorded': 'Recette enregistrée', 'treasury.transfer_recorded': 'Virement interne', 'treasury.cash_counted': 'Arrêté de caisse',
  'treasury.movement_reversed': 'Mouvement contre-passé',
  'accounting.synced': 'Historique comptabilisé', 'accounting.entry_created': 'Écriture saisie', 'accounting.entry_deleted': 'Brouillon d’écriture supprimé',
  'accounting.entry_posted': 'Écriture validée', 'accounting.entry_reversed': 'Écriture contre-passée', 'accounting.account_created': 'Compte ajouté au plan comptable',
  'accounting.period_locked': 'Période comptable clôturée', 'accounting.year_closed': 'Exercice comptable clôturé', 'accounting.exported': 'Écritures exportées',
  'stock.opening_recorded': 'Stock initial enregistré', 'stock.counted': 'Inventaire de stock', 'stock.settings_updated': 'Paramètres de stock modifiés',
  'stock.variation_posted': 'Variation de stock comptabilisée',
  'stock_receipt.created': 'Bon d’entrée créé', 'stock_receipt.updated': 'Bon d’entrée modifié', 'stock_receipt.deleted': 'Brouillon de bon d’entrée supprimé', 'stock_receipt.validated': 'Bon d’entrée validé',
  'stock_issue.created': 'Bon de sortie créé', 'stock_issue.updated': 'Bon de sortie modifié', 'stock_issue.deleted': 'Brouillon de bon de sortie supprimé', 'stock_issue.validated': 'Bon de sortie validé',
  'stock_transfer.created': 'Bon de transfert créé', 'stock_transfer.updated': 'Bon de transfert modifié', 'stock_transfer.deleted': 'Brouillon de bon de transfert supprimé', 'stock_transfer.validated': 'Bon de transfert validé',
  'stock_inventory.created': 'Inventaire créé', 'stock_inventory.updated': 'Inventaire modifié', 'stock_inventory.deleted': 'Brouillon d’inventaire supprimé', 'stock_inventory.validated': 'Inventaire validé',
  'warehouse.created': 'Entrepôt créé', 'warehouse.updated': 'Entrepôt modifié',
  'employee.created': 'Employé créé', 'employee.updated': 'Fiche employé modifiée', 'payroll.settings_updated': 'Paramètres de paie modifiés',
  'sales_document.sent': 'Document envoyé au client par e-mail',
  'leave.requested': 'Demande de congé', 'leave.approved': 'Congé validé', 'leave.refused': 'Congé refusé', 'leave.cancelled': 'Congé annulé',
  'leave.opening_set': 'Report de congés modifié', 'payroll.run_created': 'Paie préparée', 'payroll.run_deleted': 'Paie en brouillon supprimée', 'payroll.run_validated': 'Paie validée', 'payroll.salaries_paid': 'Salaires payés',
};

export const DOC_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = {
  draft: ['Brouillon', 'mute'], sent: ['Envoyé', 'warn'], accepted: ['Accepté', 'ok'], refused: ['Refusé', 'crit'], invoiced: ['Facturé', 'ok'],
  ordered: ['Commandé', 'ok'], confirmed: ['À facturer', 'warn'], cancelled: ['Annulé', 'mute'],
  issued: ['À encaisser', 'warn'], partially_paid: ['Partiellement réglée', 'warn'], paid: ['Payée', 'ok'], credited: ['Annulée par avoir', 'mute'],
};
/** Libellé et ton d'un statut selon le type de document (« émis » n'a pas le même sens pour une facture et un avoir). */
export const docStatus = (type: string, status: string): [string, 'ok' | 'warn' | 'crit' | 'mute'] =>
  type === 'credit_note' && status === 'issued' ? ['Émis', 'ok'] : DOC_STATUS[status];
/** Ordre de la chaîne commerciale : devis → bon de commande → facture. */
export const CHAIN_ORDER = ['quote', 'order', 'invoice'];
export const REMINDER_CHANNELS: Record<string, string> = { phone: 'Appel téléphonique', whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail', letter: 'Courrier', visit: 'Visite' };
export const PAYMENT_METHODS: Record<string, string> = { cash: 'Espèces', mobile_money: 'Mobile money', bank_transfer: 'Virement', cheque: 'Chèque', card: 'Carte bancaire' };
/** Modes de paiement proposés : virement, chèque et carte demandent le module Banque de la formule. */
export const paymentMethods = (modules: string[]) => Object.entries(PAYMENT_METHODS).filter(([k]) => modules.includes('bank') || !['bank_transfer', 'cheque', 'card'].includes(k));
export const DOC_LABEL = { quote: 'Devis', order: 'Bon de commande', invoice: 'Facture', credit_note: 'Avoir' } as const;
export type DocType = keyof typeof DOC_LABEL;
export const VAT_RATES = [18, 9, 0];

export const PURCHASE_LABEL = { order: 'Bon de commande', invoice: 'Facture fournisseur' } as const;
export const PURCHASE_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = {
  draft: ['Brouillon', 'mute'], sent: ['Envoyé', 'warn'], cancelled: ['Annulé', 'mute'], invoiced: ['Facturé', 'ok'],
  to_pay: ['À payer', 'warn'], partially_paid: ['Payée en partie', 'warn'], paid: ['Payée', 'ok'],
};

export const ACCOUNT_KINDS: Record<string, string> = { cash: 'Caisse', bank: 'Banque', mobile_money: 'Mobile money' };
/** Compte proposé par défaut pour un mode de paiement (même règle que l'API). */
export const KIND_FOR_METHOD: Record<string, string> = { cash: 'cash', mobile_money: 'mobile_money', bank_transfer: 'bank', cheque: 'bank', card: 'bank' };
export const EXPENSE_CATEGORIES: Record<string, string> = {
  rent: 'Loyer', electricity: 'Électricité (CIE)', water: 'Eau (SODECI)', fuel: 'Carburant', transport: 'Transport et déplacements', telecom: 'Téléphone et internet',
  supplies: 'Fournitures de bureau', maintenance: 'Entretien et réparations', salaries: 'Salaires et avances', taxes: 'Impôts et taxes', bank_fees: 'Frais bancaires',
  owner_withdrawal: 'Retrait de l’exploitant', other_expense: 'Autre dépense',
};
export const INCOME_CATEGORIES: Record<string, string> = { capital: 'Apport (capital, exploitant)', loan: 'Emprunt reçu', other_income: 'Autre recette' };
export const MOVEMENT_CATEGORIES: Record<string, string> = {
  ...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES, customer_payment: 'Encaissement client', supplier_payment: 'Règlement fournisseur', customer_refund: 'Remboursement client', goods_purchase: 'Achat comptant de marchandises',
  transfer: 'Virement interne', cash_difference: 'Écart de caisse', net_salary: 'Salaire net',
};

export const JOURNALS: Record<string, string> = { VT: 'Ventes', AC: 'Achats', TR: 'Trésorerie', OD: 'Opérations diverses', AN: 'À-nouveaux' };

export const CONTRACTS: Record<string, string> = { cdi: 'CDI', cdd: 'CDD', stage: 'Stage', journalier: 'Journalier' };
export const MARITAL: Record<string, string> = { single: 'Célibataire', married: 'Marié(e)', divorced: 'Divorcé(e)', widowed: 'Veuf / veuve' };
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** « 2026-10 » → « octobre 2026 » */
export const periodLabel = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
export const LEAVE_TYPES: Record<string, string> = {
  annual: 'Congé payé', sick: 'Maladie', maternity: 'Maternité', family_event: 'Permission exceptionnelle', unpaid: 'Congé sans solde', other: 'Autre absence',
};
export const LEAVE_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = {
  pending: ['En attente', 'warn'], approved: ['Validé', 'ok'], refused: ['Refusé', 'crit'], cancelled: ['Annulé', 'mute'],
};

/** Mention apposée sur une facture émise selon ses encaissements : « Payée » ou « Partiellement réglée ». */
export function paymentStamp(doc: { type: string; status: string; paidAmount: number; remaining: number; lastPaidOn?: string | null }) {
  if (doc.type !== 'invoice') return null;
  if (doc.status === 'paid') return { tone: 'ok', label: 'Payée', detail: doc.lastPaidOn ? `le ${date(doc.lastPaidOn)}` : null };
  if (doc.status === 'partially_paid' && doc.paidAmount > 0) return { tone: 'warn', label: 'Partiellement réglée', detail: `${money(doc.paidAmount)} réglés · reste ${money(doc.remaining)}` };
  return null;
}

export const qty = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
export const STOCK_MOVES: Record<string, string> = {
  opening: 'Stock initial', purchase: 'Achat', sale: 'Vente', sale_return: 'Retour client', adjustment: 'Inventaire', receipt: 'Entrée', issue: 'Sortie', transfer: 'Transfert', cancellation: 'Annulation',
};
export const STOCK_DOC: Record<string, string> = { receipt: 'Bon d’entrée', issue: 'Bon de sortie', transfer: 'Bon de transfert', inventory: 'Inventaire' };
export const RECEIPT_REASONS: Record<string, string> = {
  cash_purchase: 'Achat comptant (payé en caisse, banque ou mobile money)', production: 'Production / fabrication', return: 'Retour hors facture',
  gift: 'Don reçu', found: 'Marchandise retrouvée', other: 'Autre entrée',
};
export const ISSUE_REASONS: Record<string, string> = {
  consumption: 'Consommation interne', loss: 'Casse / perte', theft: 'Vol', expired: 'Produit périmé', gift: 'Don', sample: 'Échantillon gratuit', other: 'Autre sortie',
};
export const stockReason = (type: string, reason: string) =>
  type === 'receipt' ? RECEIPT_REASONS[reason]?.split(' (')[0] : type === 'issue' ? ISSUE_REASONS[reason] : null;

/** Paie : état d'un lot (une paie mensuelle), type et situation des contrats, motifs de départ. */
export const LOT_STATES: Record<string, [string, 'ok' | 'warn' | 'mute']> = {
  draft: ['Brouillon', 'warn'], validated: ['Validé', 'mute'], partly_paid: ['Partiellement payé', 'warn'], paid: ['Payé', 'ok'],
};
export const CONTRACT_STATUS: Record<string, [string, 'ok' | 'warn' | 'mute' | 'crit']> = {
  running: ['En cours', 'ok'], ending: ['Se termine bientôt', 'warn'], upcoming: ['À venir', 'mute'], ended: ['Terminé', 'mute'],
};
export const SETTLEMENT_REASONS: Record<string, string> = {
  dismissal: 'Licenciement', resignation: 'Démission', end_of_contract: 'Fin de CDD', mutual: "Rupture d'un commun accord", retirement: 'Départ à la retraite', serious_misconduct: 'Licenciement pour faute lourde',
};
export const EVAL_STATUS: Record<string, [string, 'ok' | 'warn' | 'crit' | 'mute']> = {
  draft: ['À remplir', 'mute'], submitted: ['À approuver', 'warn'], approved: ['Approuvée', 'ok'], refused: ['Refusée', 'crit'],
};
export const RATINGS: Record<string, string> = { insufficient: 'Insuffisant', improve: 'À améliorer', good: 'Satisfaisant', very_good: 'Très bien', excellent: 'Excellent' };
