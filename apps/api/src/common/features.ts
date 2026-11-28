import { SetMetadata } from '@nestjs/common';
import type { Trx } from '../db/database.service';

/**
 * Nouveautés activées entreprise par entreprise depuis la console éditeur (désactivées par défaut).
 * Tant qu'une fonctionnalité n'est pas activée, ses écrans sont masqués et ses routes refusées :
 * l'entreprise garde exactement le comportement qu'elle connaissait.
 */
export interface FeatureDef {
  key: string; label: string; description: string; version: string;
  /** La fonctionnalité sert-elle déjà dans l'entreprise ? Elle ne peut alors plus être désactivée. */
  inUse?: (trx: Trx, companyId: string) => Promise<boolean>;
}

export const FEATURES: FeatureDef[] = [
  {
    key: 'stock_lots', version: '1.2', label: 'Lots et dates de péremption',
    description: "Numéro de lot et date limite à chaque entrée en stock, alerte avant péremption, sortie du lot le plus ancien en premier.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('stock_lot').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'units', version: '1.2', label: 'Unités de mesure',
    description: "Acheter et vendre un article dans plusieurs unités (sac, carton, kg…), avec conversion automatique vers l'unité de stock et un prix par unité.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('product_unit').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'price_lists', version: '1.2', label: 'Listes de prix',
    description: "Prix grossiste, demi-gros ou détail par client : prix par article, paliers de quantité et remise générale, proposés automatiquement sur les devis et factures.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('price_list').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'bank_reconciliation', version: '1.2', label: 'Rapprochement bancaire',
    description: "Import du relevé de la banque ou du mobile money (Excel, CSV ou PDF) et pointage de chaque ligne avec les mouvements de Kora, automatiquement quand le montant et la date concordent.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('bank_statement_line').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'fixed_assets', version: '1.2', label: 'Immobilisations et amortissements',
    description: "Registre des biens durables (véhicules, matériel, mobilier, logiciels), plan d'amortissement linéaire, dotations annuelles passées en comptabilité et sortie de l'actif.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('fixed_asset').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'social_declarations', version: '1.3', label: 'Déclarations CNPS, ITS et DISA',
    description: "États préparatoires des déclarations à partir des bulletins validés : cotisations CNPS par salarié (mensuelles ou trimestrielles), ITS et taxes patronales, DISA annuelle ; impression et export CSV.",
  },
  {
    key: 'crm', version: '1.3', label: 'CRM',
    description: "Module CRM : opportunités du prospect au devis gagné sur un tableau par étapes, actions et relances à faire de chaque commercial, analyse du taux de réussite, des motifs de perte et des résultats par commercial et par origine.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('opportunity').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'auto_reminders', version: '1.3', label: 'Relances automatiques',
    description: "Les factures en retard sont relancées par e-mail chaque matin selon les étapes choisies (par exemple 3, 15 et 30 jours après l'échéance), sauf promesse de paiement en cours.",
  },
  {
    key: 'restock', version: '1.3', label: 'Réapprovisionnement',
    description: "Les articles sous leur seuil sont regroupés par fournisseur habituel, avec la quantité conseillée et le dernier prix d'achat : un bon de commande en brouillon par fournisseur, en un clic.",
  },
  {
    key: 'expenses', version: '1.3', label: 'Notes de frais',
    description: "Chaque utilisateur déclare ses dépenses avancées avec la photo du justificatif ; un responsable les valide ou les refuse, puis les rembourse depuis la caisse, la banque ou le mobile money.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('expense_claim').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'restaurant_tables', version: '1.4', label: 'Restaurant : plan de salle et tables',
    description: "Plan de salle par site (salles, terrasse, tables placées sur une grille) ; une commande ouverte par table, complétée au fil du repas, transférable d'une table à l'autre, puis encaissée en ticket de caisse.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('dining_table').select('id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'recipes', version: '1.4', label: 'Fiches techniques',
    description: "Ingrédients d'un plat pour une portion : chaque plat vendu (caisse, table ou facture) sort ses ingrédients du stock, la caisse affiche les portions encore possibles et la fiche donne le coût de revient et la marge.",
    inUse: async (trx, companyId) => !!(await trx.selectFrom('product_recipe').select('product_id').where('company_id', '=', companyId).limit(1).executeTakeFirst()),
  },
  {
    key: 'odoo_import', version: '1.3', label: 'Reprise depuis Odoo',
    description: "Assistant de reprise des exports Excel d'Odoo, dans l'ordre : contacts, articles avec leur stock, factures non soldées, soldes des comptes ; contrôle final par le compte d'attente 471000.",
  },
];

export const featureKeys = () => FEATURES.map((f) => f.key);
export const META_FEATURE = 'kora:feature';
/** Route d'une nouveauté : refusée tant que la fonctionnalité n'est pas activée pour l'entreprise. */
export const RequireFeature = (key: string) => SetMetadata(META_FEATURE, key);
