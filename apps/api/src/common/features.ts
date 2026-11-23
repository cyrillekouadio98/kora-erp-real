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
];

export const featureKeys = () => FEATURES.map((f) => f.key);
export const META_FEATURE = 'kora:feature';
/** Route d'une nouveauté : refusée tant que la fonctionnalité n'est pas activée pour l'entreprise. */
export const RequireFeature = (key: string) => SetMetadata(META_FEATURE, key);
