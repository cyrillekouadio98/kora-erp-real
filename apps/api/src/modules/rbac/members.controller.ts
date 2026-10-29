import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { verify } from '@node-rs/argon2';
import { z } from 'zod';
import { config } from '../../config';
import { Permission, Public, Tenant } from '../../common/decorators';
import { randomToken, safeEqual, sha256 } from '../../common/crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { clientIp, KoraRequest, TenantInfo } from '../../common/request-context';
import { email, parse, password } from '../../common/validation';
import { DatabaseService, setTenantContext, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { setSessionCookie } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { EntitlementService } from '../billing/entitlement.service';
import { QuotaService } from '../billing/quota.service';
import { isSensitive } from './permissions';

const INVITE_DAYS = 7;

async function assertRolesAssignable(trx: TenantTrx, t: TenantInfo, roleIds: string[]) {
  if (!roleIds.every(isUuid)) throw badRequest('Rôle invalide.');
  const roles = await trx.selectFrom('role').select(['id', 'key', 'permissions']).where('id', 'in', roleIds).execute();
  if (roles.length !== new Set(roleIds).size) throw badRequest('Un ou plusieurs rôles sont introuvables dans cette entreprise.', undefined, 'unknown_role');
  if (!t.isOwner && roles.some((r) => r.key === 'owner' || r.permissions.some(isSensitive))) {
    throw forbidden('Seul un propriétaire peut attribuer un rôle comportant des permissions sensibles.', 'sensitive_permission');
  }
  return roles;
}

@ApiTags('Utilisateurs et invitations')
@Controller()
export class MembersController {
  constructor(
    private readonly db: DatabaseService, private readonly audit: AuditService, private readonly quotas: QuotaService,
    private readonly sessions: SessionService, private readonly auth: AuthService, private readonly entitlements: EntitlementService,
  ) {}

  @Permission('users.read')
  @Get('company/members')
  async list(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.status', 'm.valid_until as validUntil', 'm.is_owner as isOwner', 'm.created_at as createdAt', 'u.full_name as fullName', 'u.email', 'u.mfa_enabled as mfaEnabled'])
        .where('m.company_id', '=', t.companyId).orderBy('u.full_name').execute();
      const links = await trx.selectFrom('membership_role as mr').innerJoin('role as r', (j) => j.onRef('r.id', '=', 'mr.role_id').onRef('r.company_id', '=', 'mr.company_id'))
        .select(['mr.membership_id', 'r.id', 'r.name', 'r.key']).execute();
      return rows.map((m) => ({ ...m, roles: links.filter((l) => l.membership_id === m.id).map((l) => ({ id: l.id, name: l.name, key: l.key })) }));
    });
  }

  @Permission('users.admin')
  @Patch('company/members/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Utilisateur');
    const input = parse(z.object({
      roleIds: z.array(z.string()).min(1).max(20).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const m = await trx.selectFrom('company_membership').selectAll().where('id', '=', id).executeTakeFirst();
      if (!m) throw notFound('Utilisateur');
      if (m.is_owner && !t.isOwner) throw forbidden("Seul un propriétaire peut modifier l'accès d'un propriétaire.");
      if (m.user_id === t.ctx.userId && (input.status === 'disabled' || input.roleIds)) {
        throw forbidden('Vous ne pouvez pas modifier vos propres rôles ni désactiver votre propre accès.', 'self_change');
      }
      if (input.status === 'disabled' && m.is_owner) {
        const owners = await trx.selectFrom('company_membership').select('id').where('is_owner', '=', true).where('status', '=', 'active').execute();
        if (owners.length <= 1) throw conflict("L'entreprise doit garder au moins un propriétaire actif.", 'last_owner');
      }
      if (input.status === 'active' && m.status === 'disabled') {
        await this.quotas.assertUsers(trx, t.companyId, t.entitlements, { includePending: false });
      }
      const before = await trx.selectFrom('membership_role').select('role_id').where('membership_id', '=', id).execute();
      if (input.roleIds) {
        await assertRolesAssignable(trx, t, input.roleIds);
        await trx.deleteFrom('membership_role').where('membership_id', '=', id).execute();
        await trx.insertInto('membership_role').values([...new Set(input.roleIds)].map((role_id) => ({ company_id: t.companyId, membership_id: id, role_id }))).execute();
      }
      const patch: Record<string, unknown> = {};
      if (input.status) patch.status = input.status;
      if (input.validUntil !== undefined) patch.valid_until = input.validUntil;
      if (Object.keys(patch).length) await trx.updateTable('company_membership').set(patch).where('id', '=', id).execute();
      if (input.status === 'disabled') await this.sessions.detachCompany(trx, m.user_id, t.companyId);
      await this.audit.tenant(trx, t.ctx, { action: 'member.updated', entityType: 'membership', entityId: id, data: {
        user_id: m.user_id, status: input.status ? { from: m.status, to: input.status } : undefined,
        roles: input.roleIds ? { from: before.map((b) => b.role_id), to: input.roleIds } : undefined,
        valid_until: input.validUntil !== undefined ? { from: m.valid_until, to: input.validUntil } : undefined,
      } });
      return { ok: true };
    });
  }

  @Permission('users.admin')
  @Get('company/invitations')
  invitations(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, (trx) => trx.selectFrom('invitation')
      .select(['id', 'email', 'role_ids as roleIds', 'expires_at as expiresAt', 'accepted_at as acceptedAt', 'revoked_at as revokedAt', 'created_at as createdAt'])
      .orderBy('created_at', 'desc').limit(200).execute());
  }

  @Permission('users.admin')
  @Post('company/invitations')
  invite(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(z.object({ email, roleIds: z.array(z.string()).min(1).max(20) }), body);
    return this.db.tenant(t.ctx, async (trx) => {
      await assertRolesAssignable(trx, t, input.roleIds);
      const already = await trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
        .select('m.id').where('u.email', '=', input.email).executeTakeFirst();
      if (already) throw conflict('Cette personne a déjà un accès à cette entreprise.', 'already_member');
      await this.quotas.assertUsers(trx, t.companyId, t.entitlements, { includePending: true });
      const secret = randomToken(24);
      const inv = await trx.insertInto('invitation').values({
        company_id: t.companyId, email: input.email, role_ids: [...new Set(input.roleIds)], token_hash: sha256(secret),
        invited_by: t.ctx.userId, expires_at: new Date(Date.now() + INVITE_DAYS * 86400_000),
      }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
      const token = `${t.companyId}.${inv.id}.${secret}`;
      await this.audit.tenant(trx, t.ctx, { action: 'invitation.created', entityType: 'invitation', entityId: inv.id, data: { email: input.email, role_ids: input.roleIds } });
      // L'envoi de l'e-mail sera branché sur le service de notification ; le lien est aussi rendu à l'administrateur.
      return { id: inv.id, expiresAt: inv.expires_at, inviteUrl: `${config.webUrl}/invitation?token=${encodeURIComponent(token)}` };
    });
  }

  @Permission('users.admin')
  @Delete('company/invitations/:id')
  revokeInvitation(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Invitation');
    return this.db.tenant(t.ctx, async (trx) => {
      const r = await trx.updateTable('invitation').set({ revoked_at: new Date() }).where('id', '=', id)
        .where('accepted_at', 'is', null).where('revoked_at', 'is', null).executeTakeFirst();
      if (!r.numUpdatedRows) throw notFound('Invitation');
      await this.audit.tenant(trx, t.ctx, { action: 'invitation.revoked', entityType: 'invitation', entityId: id });
      return { ok: true };
    });
  }

  private parseToken(token: string) {
    const [companyId, invitationId, secret] = (token ?? '').split('.');
    if (!isUuid(companyId) || !isUuid(invitationId) || !secret) throw notFound('Invitation');
    return { companyId, invitationId, secret };
  }

  private async loadInvitation(trx: TenantTrx, token: { invitationId: string; secret: string }) {
    const inv = await trx.selectFrom('invitation as i').innerJoin('company as c', 'c.id', 'i.company_id')
      .select(['i.id', 'i.email', 'i.role_ids', 'i.token_hash', 'i.expires_at', 'i.accepted_at', 'i.revoked_at', 'c.name as companyName', 'c.status as companyStatus'])
      .where('i.id', '=', token.invitationId).executeTakeFirst();
    if (!inv || !safeEqual(inv.token_hash, sha256(token.secret)) || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      throw notFound('Invitation');
    }
    return inv;
  }

  @Public()
  @Get('invitations/preview')
  preview(@Query('token') raw: string) {
    const tk = this.parseToken(raw);
    return this.db.identity(async (trx) => {
      const t = await setTenantContext(trx, tk.companyId, '00000000-0000-0000-0000-000000000000');
      const inv = await this.loadInvitation(t, tk);
      const account = await trx.selectFrom('user_account').select('id').where('email', '=', inv.email).executeTakeFirst();
      return { companyName: inv.companyName, email: inv.email, hasAccount: !!account };
    });
  }

  @Public()
  @Post('invitations/accept')
  async accept(@Body() body: unknown, @Req() req: KoraRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ token: z.string().max(400), fullName: z.string().trim().min(2).max(120).optional(), password: z.string().max(200).optional() }), body);
    const tk = this.parseToken(input.token);
    const result = await this.db.identity(async (trx) => {
      let t = await setTenantContext(trx, tk.companyId, '00000000-0000-0000-0000-000000000000');
      const inv = await this.loadInvitation(t, tk);
      let user = await trx.selectFrom('user_account').select(['id', 'password_hash', 'mfa_enabled']).where('email', '=', inv.email).executeTakeFirst();
      let userId: string;
      let mfaEnabled = false;
      if (user) {
        const sameUser = req.auth?.userId === user.id;
        if (!sameUser && !(input.password && (await verify(user.password_hash, input.password).catch(() => false)))) {
          throw unauthorized('Connectez-vous avec le compte invité ou saisissez son mot de passe.', 'invitation_auth_required');
        }
        userId = user.id;
        mfaEnabled = user.mfa_enabled;
      } else {
        const pw = parse(z.object({ fullName: z.string().trim().min(2), password }), input);
        const created = await trx.insertInto('user_account').values({
          email: inv.email, full_name: pw.fullName, password_hash: await this.auth.hashPassword(pw.password), phone: null, totp_secret_enc: null,
        }).returning('id').executeTakeFirstOrThrow();
        userId = created.id;
      }
      t = await setTenantContext(trx, tk.companyId, userId);
      const { entitlements } = await this.entitlements.forCompany(t, tk.companyId);
      await this.quotas.assertUsers(t, tk.companyId, entitlements, { includePending: false });
      const existing = await t.selectFrom('company_membership').select(['id', 'status']).where('user_id', '=', userId).executeTakeFirst();
      let membershipId = existing?.id;
      if (existing?.status === 'active') throw conflict('Vous avez déjà accès à cette entreprise.', 'already_member');
      if (existing) await t.updateTable('company_membership').set({ status: 'active' }).where('id', '=', existing.id).execute();
      else membershipId = (await t.insertInto('company_membership').values({ company_id: tk.companyId, user_id: userId }).returning('id').executeTakeFirstOrThrow()).id;
      const roles = await t.selectFrom('role').select('id').where('id', 'in', inv.role_ids).execute();
      await t.deleteFrom('membership_role').where('membership_id', '=', membershipId!).execute();
      if (roles.length) await t.insertInto('membership_role').values(roles.map((r) => ({ company_id: tk.companyId, membership_id: membershipId!, role_id: r.id }))).execute();
      await t.updateTable('invitation').set({ accepted_at: new Date() }).where('id', '=', inv.id).execute();
      const ctx = { companyId: tk.companyId, userId, actorType: 'user' as const, ip: clientIp(req) };
      await this.audit.tenant(t, ctx, { action: 'invitation.accepted', entityType: 'invitation', entityId: inv.id, data: { membership_id: membershipId } });
      let session = null;
      if (!req.auth || req.auth.userId !== userId) {
        session = await this.sessions.create(trx, userId, { mfaVerified: !mfaEnabled, activeCompanyId: tk.companyId, ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null });
      } else {
        await trx.updateTable('user_session').set({ active_company_id: tk.companyId }).where('id', '=', req.auth.sessionId).execute();
      }
      return { companyId: tk.companyId, session };
    });
    if (result.session) setSessionCookie(res, result.session.token, result.session.expiresAt);
    return { companyId: result.companyId };
  }
}
