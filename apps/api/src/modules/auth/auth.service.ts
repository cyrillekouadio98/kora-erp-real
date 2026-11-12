import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { sql } from 'kysely';
import { config } from '../../config';
import { decrypt, encrypt } from '../../common/crypto';
import { badRequest, conflict, forbidden, locked, notFound, unauthorized } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { AuthInfo } from '../../common/request-context';
import { DatabaseService, Trx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { ProvisioningService } from '../companies/provisioning.service';
import { SessionService } from './session.service';

authenticator.options = { window: 1 };
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Z1uX3tq3M8y4QBkP0o8iD8e6r2t5yJjvWZbS0k6l5mE';
const BAD_CREDENTIALS = 'Adresse e-mail ou mot de passe incorrect.';
const TOTP_STEP_SECONDS = 30;

const isLocked = (u: { locked_until: Date | string | null }) => !!u.locked_until && new Date(u.locked_until) > new Date();

/** Compte un échec d'authentification (mot de passe ou code) ; au 5e, le compte est verrouillé 15 minutes. */
async function recordFailure(trx: Trx, u: { id: string; failed_logins: number }) {
  const failed = u.failed_logins + 1;
  const lock = failed >= config.security.maxFailedLogins ? new Date(Date.now() + config.security.lockMinutes * 60_000) : null;
  await trx.updateTable('user_account').set({ failed_logins: lock ? 0 : failed, locked_until: lock }).where('id', '=', u.id).execute();
}

/**
 * Vérifie un code TOTP et le consomme : chaque pas de temps n'est accepté qu'une fois, et jamais un pas
 * antérieur au dernier utilisé (un code intercepté ne peut pas être rejoué). La mise à jour conditionnelle
 * empêche aussi deux requêtes simultanées d'utiliser le même code.
 */
async function consumeTotp(trx: Trx, u: { id: string; totp_secret_enc: string | null; totp_last_step: number | null }, code: string): Promise<boolean> {
  if (!u.totp_secret_enc) return false;
  const now = Date.now();
  const delta = authenticator.clone({ epoch: now, window: 1 }).checkDelta(code, decrypt(u.totp_secret_enc));
  if (delta === null) return false;
  const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS) + delta;
  const r = await trx.updateTable('user_account').set({ totp_last_step: step }).where('id', '=', u.id)
    .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)])).executeTakeFirst();
  return r.numUpdatedRows > 0n;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: SessionService,
    private readonly provisioning: ProvisioningService,
    private readonly audit: AuditService,
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

  /**
   * Vérifie un mot de passe en tenant le compteur d'échecs et le verrouillage du compte.
   * À appeler dans une transaction validée même en cas d'échec (le compteur serait sinon annulé avec elle).
   */
  async passwordAttempt(trx: Trx, u: { id: string; password_hash: string; failed_logins: number; locked_until: Date | string | null }, password: string) {
    if (isLocked(u)) return 'locked' as const;
    if (await verify(u.password_hash, password).catch(() => false)) return 'ok' as const;
    await recordFailure(trx, u);
    return 'invalid' as const;
  }

  async login(input: { email: string; password: string; code?: string }, meta: { ip?: string | null; ua?: string | null }) {
    // Les échecs sont enregistrés dans une transaction validée AVANT de répondre en erreur,
    // sinon le compteur de tentatives serait annulé avec elle.
    const r = await this.db.identity(async (trx) => {
      const u = await trx.selectFrom('user_account').selectAll().where('email', '=', input.email).executeTakeFirst();
      if (!u) { await verify(DUMMY_HASH, input.password).catch(() => false); return { fail: 'credentials' as const }; }
      const pw = await this.passwordAttempt(trx, u, input.password);
      if (pw === 'locked') return { fail: 'locked' as const };
      if (pw === 'invalid') return { fail: 'credentials' as const };
      let mfaVerified = !u.mfa_enabled;
      if (u.mfa_enabled && input.code) {
        // Un mauvais code compte comme un échec de connexion : 5 essais, puis verrouillage.
        if (!(await consumeTotp(trx, u, input.code))) { await recordFailure(trx, u); return { fail: 'mfa' as const }; }
        mfaVerified = true;
      }
      // Le compteur n'est remis à zéro qu'une fois l'authentification complète : sinon, un attaquant qui connaît
      // le mot de passe pourrait le réinitialiser à chaque connexion et essayer indéfiniment des codes.
      await trx.updateTable('user_account').set({ ...(mfaVerified ? { failed_logins: 0, locked_until: null } : {}), last_login_at: new Date() }).where('id', '=', u.id).execute();
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
    // Comme pour la connexion, l'échec est validé en base avant de répondre en erreur.
    const r = await this.db.asUser(auth.userId, async (trx) => {
      const u = await trx.selectFrom('user_account').select(['id', 'totp_secret_enc', 'totp_last_step', 'mfa_enabled', 'failed_logins', 'locked_until'])
        .where('id', '=', auth.userId).executeTakeFirstOrThrow();
      if (!u.mfa_enabled || !u.totp_secret_enc) return 'not_enabled' as const;
      if (isLocked(u)) return 'locked' as const;
      if (!(await consumeTotp(trx, u, code))) { await recordFailure(trx, u); return 'invalid' as const; }
      await trx.updateTable('user_account').set({ failed_logins: 0, locked_until: null }).where('id', '=', u.id).execute();
      await trx.updateTable('user_session').set({ mfa_verified: true }).where('id', '=', auth.sessionId).execute();
      return 'ok' as const;
    });
    if (r === 'not_enabled') throw badRequest("La double authentification n'est pas activée.");
    if (r === 'locked') throw locked('Trop de tentatives échouées. Réessayez dans quelques minutes.', 'account_locked');
    if (r === 'invalid') throw unauthorized('Code de double authentification incorrect.', 'invalid_mfa_code');
  }

  async setupMfa(auth: AuthInfo) {
    return this.db.asUser(auth.userId, async (trx) => {
      if (auth.mfaEnabled) throw conflict('La double authentification est déjà activée.');
      const secret = authenticator.generateSecret();
      await trx.updateTable('user_account').set({ totp_secret_enc: encrypt(secret), totp_last_step: null }).where('id', '=', auth.userId).execute();
      const otpauthUrl = authenticator.keyuri(auth.email, 'Kora ERP', secret);
      // QR code généré sur le serveur (image SVG) : la clé n'est jamais envoyée à un service tiers.
      const qrSvg = await QRCode.toString(otpauthUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
      return { secret, otpauthUrl, qrCode: `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}` };
    });
  }

  async enableMfa(auth: AuthInfo, code: string) {
    return this.db.asUser(auth.userId, async (trx) => {
      const u = await trx.selectFrom('user_account').select(['id', 'totp_secret_enc', 'totp_last_step']).where('id', '=', auth.userId).executeTakeFirstOrThrow();
      if (!u.totp_secret_enc) throw badRequest("Commencez par générer un secret (étape de configuration).");
      if (!(await consumeTotp(trx, u, code))) throw unauthorized('Code de double authentification incorrect.', 'invalid_mfa_code');
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
