import { sql } from 'kysely';
import type { TenantTrx } from '../db/database.service';

/**
 * Prochain numéro d'une séquence de l'entreprise (verrouillée jusqu'à la fin de la transaction :
 * deux documents validés en même temps ne peuvent pas recevoir le même numéro, et un échec ne laisse pas de trou).
 * year = 0 pour une séquence continue (référentiels), l'année pour les pièces (FAC-2026-00001).
 */
export async function nextNumber(trx: TenantTrx, companyId: string, docType: string, prefix: string, year = 0): Promise<string> {
  const r = await sql<{ n: string }>`
    INSERT INTO numbering_sequence (company_id, doc_type, year, prefix, next_value) VALUES (${companyId}, ${docType}, ${year}, ${prefix}, 2)
    ON CONFLICT (company_id, doc_type, year) DO UPDATE SET next_value = numbering_sequence.next_value + 1
    RETURNING (next_value - 1)::text AS n`.execute(trx);
  return `${prefix}-${year ? `${year}-` : ''}${r.rows[0].n.padStart(5, '0')}`;
}
