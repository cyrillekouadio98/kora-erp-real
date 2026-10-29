import { Injectable } from '@nestjs/common';
import { config } from '../../config';
import { randomToken, sha256 } from '../../common/crypto';
import { DatabaseService, Trx } from '../../db/database.service';
import type { AuthInfo } from '../../common/request-context';

/** Sessions opaques stockées côté serveur : révocables immédiatement. */
@Injectable()
export class SessionService {
  constructor(private readonly db: DatabaseService) {}

  async create(trx: Trx, userId: string, opts: { mfaVerified: boolean; activeCompanyId: string | null; ip?: string | null; userAgent?: string | null }) {
    const token = randomToken(32);
    const expires = new Date(Date.now() + config.session.ttlHours * 3600_000);
    const row = await trx.insertInto('user_session').values({
      user_id: userId, token_hash: sha256(token), active_company_id: opts.activeCompanyId, mfa_verified: opts.mfaVerified,
      ip: opts.ip ?? null, user_agent: opts.userAgent?.slice(0, 300) ?? null, expires_at: expires,
    }).returning(['id']).executeTakeFirstOrThrow();
    return { token, sessionId: row.id, expiresAt: expires };
  }

  async resolve(token: string): Promise<AuthInfo | null> {
    if (!token || token.length > 200) return null;
    return this.db.identity(async (trx) => {
      const s = await trx.selectFrom('user_session as s').innerJoin('user_account as u', 'u.id', 's.user_id')
        .select(['s.id', 's.user_id', 's.active_company_id', 's.mfa_verified', 's.expires_at', 's.revoked_at', 's.last_seen_at', 'u.email', 'u.mfa_enabled'])
        .where('s.token_hash', '=', sha256(token)).executeTakeFirst();
      if (!s || s.revoked_at || new Date(s.expires_at) <= new Date()) return null;
      if (Date.now() - new Date(s.last_seen_at).getTime() > 5 * 60_000) {
        await trx.updateTable('user_session').set({ last_seen_at: new Date() }).where('id', '=', s.id).execute();
      }
      const roles = await trx.selectFrom('platform_role_assignment').select('role').where('user_id', '=', s.user_id).execute();
      return {
        userId: s.user_id, sessionId: s.id, email: s.email, activeCompanyId: s.active_company_id,
        mfaEnabled: s.mfa_enabled, mfaVerified: s.mfa_verified, platformRoles: roles.map((r) => r.role),
      };
    });
  }

  async revoke(trx: Trx, sessionId: string) {
    await trx.updateTable('user_session').set({ revoked_at: new Date() }).where('id', '=', sessionId).where('revoked_at', 'is', null).execute();
  }

  /** Retire l'entreprise active de toutes les sessions d'un utilisateur (adhésion désactivée). */
  async detachCompany(trx: Trx, userId: string, companyId: string) {
    await trx.updateTable('user_session').set({ active_company_id: null })
      .where('user_id', '=', userId).where('active_company_id', '=', companyId).execute();
  }
}
