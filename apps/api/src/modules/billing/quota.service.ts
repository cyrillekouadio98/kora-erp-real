import { Injectable } from '@nestjs/common';
import { paymentRequired } from '../../common/errors';
import type { Trx } from '../../db/database.service';
import type { Entitlements } from './entitlements';

/** Vérifie les quotas dans la transaction qui créerait le dépassement. Ne supprime jamais de données. */
@Injectable()
export class QuotaService {
  async usage(trx: Trx, companyId: string, opts: { includePending?: boolean } = {}) {
    const members = await trx.selectFrom('company_membership').select((eb) => eb.fn.countAll<string>().as('c'))
      .where('company_id', '=', companyId).where('status', '=', 'active').executeTakeFirstOrThrow();
    if (opts.includePending === false) return { users: Number(members.c), pendingInvitations: 0 };
    const pending = await trx.selectFrom('invitation').select((eb) => eb.fn.countAll<string>().as('c'))
      .where('company_id', '=', companyId).where('accepted_at', 'is', null).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirstOrThrow();
    return { users: Number(members.c), pendingInvitations: Number(pending.c) };
  }

  async assertUsers(trx: Trx, companyId: string, ent: Entitlements, opts: { includePending: boolean }) {
    const limit = ent.quotas.users;
    if (limit === null) return;
    const u = await this.usage(trx, companyId);
    const used = u.users + (opts.includePending ? u.pendingInvitations : 0);
    if (used + 1 > limit) {
      throw paymentRequired(`Votre formule inclut ${limit} utilisateur${limit > 1 ? 's' : ''} (invitations en attente comprises). Passez à une formule supérieure ou désactivez un utilisateur.`, 'quota_users', { limit, used });
    }
  }
}
