import { Injectable } from '@nestjs/common';
import type { Trx } from '../../db/database.service';
import { normalizeEntitlements } from './entitlements';

/** Calcule les droits effectifs d'une entreprise : formule souscrite + dérogations. */
@Injectable()
export class EntitlementService {
  async forCompany(trx: Trx, companyId: string) {
    const row = await trx.selectFrom('subscription as s').innerJoin('plan_version as v', 'v.id', 's.plan_version_id')
      .innerJoin('plan as p', 'p.id', 'v.plan_id')
      .select(['s.id', 's.status', 's.overrides', 's.current_period_end', 's.billing_cycle', 'v.entitlements', 'v.id as plan_version_id', 'p.code as plan_code', 'p.name as plan_name'])
      .where('s.company_id', '=', companyId).executeTakeFirst();
    return {
      subscription: row ?? null,
      entitlements: normalizeEntitlements(row?.entitlements, row?.overrides),
    };
  }
}
