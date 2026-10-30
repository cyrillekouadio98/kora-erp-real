import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { sql } from 'kysely';
import { config } from '../../config';
import { decrypt, encrypt, randomToken, sha256 } from '../../common/crypto';
import { badRequest, conflict, forbidden, locked, notFound, unauthorized } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { AuthInfo } from '../../common/request-context';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { ProvisioningService } from '../companies/provisioning.service';
import { MailService } from '../mail/mail.service';
import { SessionService } from './session.service';

authenticator.options = { window: 1 };
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Z1uX3tq3M8y4QBkP0o8iD8e6r2t5yJjvWZbS0k6l5mE';
const BAD_CREDENTIALS = 'Adresse e-mail ou mot de passe incorrect.';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: SessionService,
    private readonly provisioning: ProvisioningService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  hashPassword = (pw: string) => hash(pw, ARGON);

  async signup(input: { fullName: string; email: string; password: string; companyName: string }, meta: { ip?: string | null; ua?: string | null }) {
    return this.db.identity(async (trx) => {
      const exists = await trx.selectFrom('user_account').select('id').where('email', '=', input.email).executeTakeFirst();
      if (exists) throw conflict('Un compte existe déjà avec cette adresse e-mail. Connectez-vous.', 'email_taken');
      const user = await trx.insertInto('user_account').values({
        email: input.email, full_name: input.fullName.trim(), password_hash: await this.hashPassword(input.password), phone: null, totp_secret_enc: null,
      }).returning('id').executeTakeFirstOrThrow();
      const { companyId } = await this.provisioning.provision(trx, user.id, { name: input.companyName }, meta.ip);
      const session = await this.sessions.create(trx, user.id, { mfaVerified: true, activeCompanyId: companyId, ip: meta.ip, userAgent: meta.ua });
      return { userId: user.id, companyId, session };
    });
  }

  async login(input: { email: string; password: string; code?: string }, meta: { ip?: string | null; ua?: string | null }) {
    // Les échecs sont enregistrés dans une transaction validée AVANT de répondre en erreur,
    // sinon le compteur de tentatives serait annulé avec elle.
    const r = await this.db.identity(async (trx) => {
      const u = await trx.selectFrom('user_account').selectAll().where('email', '=', input.email).executeTakeFirst();
      if (!u) { await verify(DUMMY_HASH, input.password).catch(() => false); return { fail: 'credentials' as const }; }
      if (u.locked_until && new Date(u.locked_until) > new Date()) return { fail: 'locked' as const };
      const ok = await verify(u.password_hash, input.password).catch(() => false);
      if (!ok) {
        const failed = u.failed_logins + 1;
        const lock = failed >= config.security.maxFailedLogins ? new Date(Date.now() + config.security.lockMinutes * 60_000) : null;
        await trx.updateTable('user_account').set({ failed_logins: lock ? 0 : failed, locked_until: lock }).where('id', '=', u.id).execute();
        return { fail: 'credentials' as const };
      }
      let mfaVerified = !u.mfa_enabled;
      if (u.mfa_enabled && input.code) {
        if (!authenticator.check(input.code, decrypt(u.totp_secret_enc!))) return { fail: 'mfa' as const };
        mfaVerified = true;
      }
      await trx.updateTable('user_account').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', u.id).execute();
      await sql`select set_config('app.user_id', ${u.id}, true)`.execute(trx);
      const first = await trx.selectFrom('company_membership').select('company_id').where('user_id', '=', u.id).where('status', '=', 'active')
        .orderBy('created_at', 'asc').limit(1).executeTakeFirst();
      const session = await this.sessions.create(trx, u.id, { mfaVerified, activeCompanyId: first?.company_id ?? null, ip: meta.ip, userAgent: meta.ua });
      return { session, mfaRequired: !mfaVerified };
    });
    if ('fail' in r) {
      if (r.fail === 'locked') throw locked('Trop de tentatives échouées. Réessayez dans quelques minutes.', 'account_locked');
      if (r.fail === 'mfa') throw unauthorized('Code de double authentification incorrect.', 'invalid_mfa_code');
      throw unauthorized(BAD_CREDENTIALS, 'invalid_credentials');
    }
    return r;
  }

  async verifyMfa(auth: AuthInfo, code: string) {
    return this.db.asUser(auth.userId, async (trx) => {
      const u = await trx.selectFrom('user_account').select(['totp_secret_enc', 'mfa_enabled']).where('id', '=', auth.userId).executeTakeFirstOrThrow();
      if (!u.mfa_enabled || !u.totp_secret_enc) throw badRequest("La double authentification n'est pas activée.");
      if (!authenticator.check(code, decrypt(u.totp_secret_enc))) throw unauthorized('Code de double authentification incorrect.', 'invalid_mfa_code');
      await trx.updateTable('user_session').set({ mfa_verified: true }).where('id', '=', auth.sessionId).execute();
    });
  }

  async setupMfa(auth: AuthInfo) {
    return this.db.asUser(auth.userId, async (trx) => {
      if (auth.mfaEnabled) throw conflict('La double authentification est déjà activée.');
      const secret = authenticator.generateSecret();
      await trx.updateTable('user_account').set({ totp_secret_enc: encrypt(secret) }).where('id', '=', auth.userId).execute();
      return { secret, otpauthUrl: authenticator.keyuri(auth.email, 'Kora ERP', secret) };
    });
  }

  async enableMfa(auth: AuthInfo, code: string) {
    return this.db.asUser(auth.userId, async (trx) => {
      const u = await trx.selectFrom('user_account').select('totp_secret_enc').where('id', '=', auth.userId).executeTakeFirstOrThrow();
      if (!u.totp_secret_enc) throw badRequest("Commencez par générer un secret (étape de configuration).");
      if (!authenticator.check(code, decrypt(u.totp_secret_enc))) throw unauthorized('Code de double authentification incorrect.', 'invalid_mfa_code');
      await trx.updateTable('user_account').set({ mfa_enabled: true }).where('id', '=', auth.userId).execute();
      await trx.updateTable('user_session').set({ mfa_verified: true }).where('id', '=', auth.sessionId).execute();
    });
  }

  async me(auth: AuthInfo) {
    return this.db.asUser(auth.userId, async (trx) => {
      const u = await trx.selectFrom('user_account').select(['id', 'email', 'full_name', 'phone', 'mfa_enabled']).where('id', '=', auth.userId).executeTakeFirstOrThrow();
      const memberships = await trx.selectFrom('company_membership as m').innerJoin('company as c', 'c.id', 'm.company_id')
        .select(['c.id as companyId', 'c.name', 'c.status', 'm.is_owner as isOwner'])
        .where('m.user_id', '=', auth.userId).where('m.status', '=', 'active').orderBy('c.name').execute();
      return {
        user: { id: u.id, email: u.email, fullName: u.full_name, phone: u.phone, mfaEnabled: u.mfa_enabled },
        platformRoles: auth.platformRoles, activeCompanyId: auth.activeCompanyId, mfaVerified: auth.mfaVerified, companies: memberships,
      };
    });
  }

  async switchCompany(auth: AuthInfo, companyId: string, ip?: string | null) {
    if (!isUuid(companyId)) throw notFound('Entreprise');
    await this.db.asUser(auth.userId, async (trx) => {
      const m = await trx.selectFrom('company_membership').select(['id', 'valid_until']).where('company_id', '=', companyId)
        .where('user_id', '=', auth.userId).where('status', '=', 'active').executeTakeFirst();
      if (!m || (m.valid_until && m.valid_until < new Date().toISOString().slice(0, 10))) throw notFound('Entreprise');
      await trx.updateTable('user_session').set({ active_company_id: companyId }).where('id', '=', auth.sessionId).execute();
    });
    await this.db.tenant({ companyId, userId: auth.userId, actorType: 'user', ip }, (t) =>
      this.audit.tenant(t, { companyId, userId: auth.userId, actorType: 'user', ip }, { action: 'session.company_selected' }));
  }

  async listSessions(auth: AuthInfo) {
    return this.db.asUser(auth.userId, (trx) => trx.selectFrom('user_session')
      .select(['id', 'ip', 'user_agent as userAgent', 'created_at as createdAt', 'last_seen_at as lastSeenAt', 'expires_at as expiresAt'])
      .where('user_id', '=', auth.userId).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).orderBy('last_seen_at', 'desc').execute()
      .then((rows) => rows.map((r) => ({ ...r, current: r.id === auth.sessionId }))));
  }

  async revokeSession(auth: AuthInfo, sessionId: string) {
    if (!isUuid(sessionId)) throw notFound('Session');
    await this.db.asUser(auth.userId, async (trx) => {
      const r = await trx.updateTable('user_session').set({ revoked_at: new Date() })
        .where('id', '=', sessionId).where('user_id', '=', auth.userId).where('revoked_at', 'is', null).executeTakeFirst();
      if (!r.numUpdatedRows) throw notFound('Session');
    });
  }

  async logout(auth: AuthInfo) {
    await this.db.asUser(auth.userId, (trx) => this.sessions.revoke(trx, auth.sessionId));
  }

  /**
   * Mot de passe oublié : la réponse est identique que le compte existe ou non (aucune énumération).
   * Le lien est valable une heure et ne sert qu'une fois ; seule son empreinte est conservée.
   */
  async requestPasswordReset(email: string, ip?: string | null) {
    await this.db.identity(async (trx) => {
      const u = await trx.selectFrom('user_account').select(['id', 'full_name']).where('email', '=', email).executeTakeFirst();
      if (!u) return;
      const recent = await trx.selectFrom('password_reset').select('id').where('user_id', '=', u.id).where('created_at', '>', new Date(Date.now() - 60_000)).executeTakeFirst();
      if (recent) return; // une demande par minute au plus
      const secret = randomToken(32);
      await trx.insertInto('password_reset').values({ user_id: u.id, token_hash: sha256(secret), expires_at: new Date(Date.now() + 3600_000), ip: ip ?? null, used_at: null }).execute();
      await this.mail.enqueue(trx, {
        companyId: null, to: email, kind: 'password_reset', subject: 'Réinitialisation de votre mot de passe Kora ERP',
        paragraphs: [`Bonjour ${u.full_name},`, 'Une réinitialisation du mot de passe de votre compte Kora ERP a été demandée. Le lien ci-dessous est valable une heure et ne peut servir qu\'une fois.',
          "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé."],
        action: { label: 'Choisir un nouveau mot de passe', url: `${config.webUrl}/mot-de-passe?token=${secret}` },
      });
    });
  }

  async confirmPasswordReset(token: string, password: string) {
    await this.db.identity(async (trx) => {
      const r = await trx.selectFrom('password_reset').selectAll().where('token_hash', '=', sha256(token)).forUpdate().executeTakeFirst();
      if (!r || r.used_at || new Date(r.expires_at) < new Date()) throw badRequest('Ce lien de réinitialisation est invalide ou a expiré. Faites une nouvelle demande.', undefined, 'invalid_reset_token');
      await trx.updateTable('password_reset').set({ used_at: new Date() }).where('id', '=', r.id).execute();
      // Les autres liens encore valides de ce compte deviennent inutilisables.
      await trx.updateTable('password_reset').set({ used_at: new Date() }).where('user_id', '=', r.user_id).where('used_at', 'is', null).execute();
      await trx.updateTable('user_account').set({ password_hash: await this.hashPassword(password), failed_logins: 0, locked_until: null }).where('id', '=', r.user_id).execute();
      await trx.updateTable('user_session').set({ revoked_at: new Date() }).where('user_id', '=', r.user_id).where('revoked_at', 'is', null).execute();
    });
  }

  async changePassword(auth: AuthInfo, current: string, next: string) {
    await this.db.asUser(auth.userId, async (trx) => {
      const u = await trx.selectFrom('user_account').select('password_hash').where('id', '=', auth.userId).executeTakeFirstOrThrow();
      if (!(await verify(u.password_hash, current).catch(() => false))) throw forbidden('Mot de passe actuel incorrect.', 'invalid_password');
      await trx.updateTable('user_account').set({ password_hash: await this.hashPassword(next) }).where('id', '=', auth.userId).execute();
      // Toutes les autres sessions sont fermées après un changement de mot de passe.
      await trx.updateTable('user_session').set({ revoked_at: new Date() }).where('user_id', '=', auth.userId).where('id', '!=', auth.sessionId).where('revoked_at', 'is', null).execute();
    });
  }
}
