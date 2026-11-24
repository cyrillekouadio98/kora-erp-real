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
];

export const featureKeys = () => FEATURES.map((f) => f.key);
export const META_FEATURE = 'kora:feature';
/** Route d'une nouveauté : refusée tant que la fonctionnalité n'est pas activée pour l'entreprise. */
export const RequireFeature = (key: string) => SetMetadata(META_FEATURE, key);
