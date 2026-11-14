import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { Permission, Public, Tenant } from '../../common/decorators';
import { randomToken, safeEqual, sha256 } from '../../common/crypto';
import { badRequest, conflict, forbidden, locked, notFound, unauthorized } from '../../common/errors';
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
import { MailService } from '../mail/mail.service';
import { isSensitive } from './permissions';

const INVITE_DAYS = 7;

/** Nom sans accents ni casse, mots séparés par une espace (comparaison fiche employé / compte). */
const normalize = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Distance d'édition (Levenshtein), pour repérer un e-mail saisi avec une faute de frappe. */
function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const rank = (m: string | null) => ({ email: 0, similar_email: 1, name: 2 } as Record<string, number>)[m ?? ''] ?? 3;

async function assertRolesAssignable(trx: TenantTrx, t: TenantInfo, roleIds: string[]) {
  if (!roleIds.every(isUuid)) throw badRequest('Rôle invalide.');
  const roles = await trx.selectFrom('role').select(['id', 'key', 'permissions']).where('company_id', '=', t.companyId).where('id', 'in', roleIds).execute();
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
    private readonly mail: MailService,
  ) {}

  @Permission('users.read')
  @Get('company/members')
  async list(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.status', 'm.valid_until as validUntil', 'm.is_owner as isOwner', 'm.site_ids as siteIds', 'm.created_at as createdAt', 'u.full_name as fullName', 'u.email', 'u.mfa_enabled as mfaEnabled'])
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
      siteIds: z.array(z.string().uuid()).min(1, { message: 'Choisissez au moins un site' }).max(100).nullable().optional(),
    }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const m = await trx.selectFrom('company_membership').selectAll().where('id', '=', id).executeTakeFirst();
      if (input.siteIds) {
        const found = await trx.selectFrom('site').select('id').where('id', 'in', input.siteIds).where('archived_at', 'is', null).execute();
        if (found.length !== new Set(input.siteIds).size) throw badRequest('Un ou plusieurs sites sont introuvables ou archivés.', undefined, 'unknown_site');
        if (m?.is_owner) throw forbidden("Un propriétaire voit toujours tous les sites.", 'owner_all_sites');
        if (m?.user_id === t.ctx.userId) throw forbidden('Vous ne pouvez pas limiter vos propres sites.', 'self_change');
        if (t.allowedSiteIds && input.siteIds.some((s) => !t.allowedSiteIds!.includes(s))) throw forbidden("Vous ne pouvez donner accès qu'à vos propres sites.", 'site_forbidden');
      }
      if (input.siteIds === null && t.allowedSiteIds) throw forbidden('Seul un utilisateur qui voit tous les sites peut en donner l’accès complet.', 'site_forbidden');
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
      if (input.siteIds !== undefined) patch.site_ids = input.siteIds ? [...new Set(input.siteIds)] : null;
      if (Object.keys(patch).length) await trx.updateTable('company_membership').set(patch).where('id', '=', id).execute();
      if (input.status === 'disabled') await this.sessions.detachCompany(trx, m.user_id, t.companyId);
      await this.audit.tenant(trx, t.ctx, { action: 'member.updated', entityType: 'membership', entityId: id, data: {
        user_id: m.user_id, status: input.status ? { from: m.status, to: input.status } : undefined,
        roles: input.roleIds ? { from: before.map((b) => b.role_id), to: input.roleIds } : undefined,
        valid_until: input.validUntil !== undefined ? { from: m.valid_until, to: input.validUntil } : undefined,
        sites: input.siteIds !== undefined ? { from: m.site_ids, to: input.siteIds } : undefined,
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
    const input = parse(z.object({ email, roleIds: z.array(z.string()).min(1).max(20), siteIds: z.array(z.string().uuid()).min(1).max(100).nullable().optional() }), body);
    return this.db.tenant(t.ctx, (trx) => this.createInvitation(trx, t, input));
  }

  /**
   * Comptes de l'entreprise auxquels rattacher la fiche d'un employé : comptes actifs sans fiche, les plus probables
   * d'abord (même e-mail, e-mail presque identique — faute de frappe —, même nom).
   */
  @Permission('users.admin')
  @Get('company/employees/:id/accounts')
  employeeAccounts(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Employé');
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await trx.selectFrom('employee').select(['id', 'first_name', 'last_name', 'email', 'user_id']).where('id', '=', id).executeTakeFirst();
      if (!e) throw notFound('Employé');
      const members = await trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.user_id', 'u.full_name', 'u.email', 'm.is_owner']).where('m.company_id', '=', t.companyId).where('m.status', '=', 'active')
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('employee as x').select('x.id').whereRef('x.user_id', '=', 'm.user_id')))).execute();
      const email = e.email?.trim().toLowerCase() ?? '';
      const names = new Set(normalize(`${e.first_name} ${e.last_name}`).split(' ').filter((w) => w.length > 1));
      return members.map((m) => {
        const words = normalize(m.full_name).split(' ').filter((w) => w.length > 1);
        const common = words.filter((w) => names.has(w)).length;
        const match = email && m.email === email ? 'email' : email && editDistance(m.email, email) <= 2 ? 'similar_email' : common >= 2 || (common === 1 && words.length === 1) ? 'name' : null;
        return { userId: m.user_id, name: m.full_name, email: m.email, isOwner: m.is_owner, match };
      }).sort((a, b) => rank(a.match) - rank(b.match) || a.name.localeCompare(b.name));
    });
  }

  /**
   * Ouvre l'espace personnel d'un employé (rôle « Employé »), avec un accès immédiat dès qu'un compte existe :
   * - userId fourni : la fiche est rattachée à ce compte de l'entreprise (choisi par le responsable) ;
   * - sinon, compte de l'entreprise au même e-mail que la fiche : rattachement immédiat ;
   * - sinon, invitation à l'e-mail de la fiche, rattachée à l'acceptation.
   */
  @Permission('users.admin')
  @Post('company/employees/:id/invite')
  inviteEmployee(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Employé');
    const input = parse(z.object({ userId: z.string().uuid({ message: 'Compte introuvable' }).optional() }).strict(), body ?? {});
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await trx.selectFrom('employee').select(['id', 'email', 'user_id', 'site_id']).where('id', '=', id).executeTakeFirst();
      if (!e) throw notFound('Employé');
      if (e.user_id) throw conflict('Cet employé a déjà accès à son espace.', 'already_linked');
      const role = await trx.selectFrom('role').select('id').where('company_id', '=', t.companyId).where('key', '=', 'employee').executeTakeFirst();
      if (!role) throw badRequest('Le rôle « Employé » a été supprimé.', undefined, 'no_employee_role');
      const email = e.email?.trim().toLowerCase() ?? null;
      const members = trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.user_id', 'm.status', 'm.site_ids', 'u.email']).where('m.company_id', '=', t.companyId);
      const member = input.userId ? await members.where('m.user_id', '=', input.userId).executeTakeFirst()
        : email ? await members.where('u.email', '=', email).executeTakeFirst() : undefined;
      if (input.userId && !member) throw notFound('Compte');
      if (member) {
        if (member.status !== 'active') throw conflict("Le compte de cette personne est désactivé : réactivez-le d'abord dans Utilisateurs.", 'member_disabled');
        const other = await trx.selectFrom('employee').select('number').where('user_id', '=', member.user_id).executeTakeFirst();
        if (other) throw conflict(`Ce compte est déjà rattaché à la fiche ${other.number}.`, 'user_already_linked');
        // L'e-mail de la fiche suit celui du compte (corrige une faute de frappe) ; le site de la fiche est ouvert au compte s'il est limité.
        await trx.updateTable('employee').set({ user_id: member.user_id, email: member.email }).where('id', '=', id).execute();
        if (member.site_ids && !member.site_ids.includes(e.site_id)) {
          await trx.updateTable('company_membership').set({ site_ids: [...member.site_ids, e.site_id] }).where('id', '=', member.id).execute();
        }
        await trx.insertInto('membership_role').values({ company_id: t.companyId, membership_id: member.id, role_id: role.id }).onConflict((oc) => oc.doNothing()).execute();
        // Les invitations encore ouvertes pour cette fiche n'ont plus d'objet.
        await trx.updateTable('invitation').set({ revoked_at: new Date() }).where('employee_id', '=', id).where('accepted_at', 'is', null).where('revoked_at', 'is', null).execute();
        await this.audit.tenant(trx, t.ctx, { action: 'employee.account_linked', entityType: 'employee', entityId: id, data: { email: member.email, previousEmail: email !== member.email ? email : undefined } });
        return { linked: true as const, email: member.email, emailCorrected: !!email && email !== member.email };
      }
      if (!email) throw badRequest("Renseignez l'adresse e-mail de l'employé, ou choisissez son compte existant.", undefined, 'no_email');
      const pending = await trx.selectFrom('invitation').select('id').where('employee_id', '=', id).where('accepted_at', 'is', null).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirst();
      if (pending) throw conflict('Une invitation est déjà en attente pour cet employé.', 'invitation_pending');
      return this.createInvitation(trx, t, { email, roleIds: [role.id], employeeId: id, siteIds: [e.site_id] });
    });
  }

  private async createInvitation(trx: TenantTrx, t: TenantInfo, input: { email: string; roleIds: string[]; employeeId?: string; siteIds?: string[] | null }) {
    await assertRolesAssignable(trx, t, input.roleIds);
    // Sites de l'invité : ceux choisis (parmi les siens pour un utilisateur limité), sinon ceux de l'invitant.
    let siteIds = input.siteIds ?? t.allowedSiteIds;
    if (siteIds) {
      siteIds = [...new Set(siteIds)];
      if (t.allowedSiteIds && siteIds.some((s) => !t.allowedSiteIds!.includes(s))) throw forbidden("Vous ne pouvez donner accès qu'à vos propres sites.", 'site_forbidden');
      const found = await trx.selectFrom('site').select('id').where('id', 'in', siteIds).where('archived_at', 'is', null).execute();
      if (found.length !== siteIds.length) throw badRequest('Un ou plusieurs sites sont introuvables ou archivés.', undefined, 'unknown_site');
    }
    const already = await trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
      .select('m.id').where('m.company_id', '=', t.companyId).where('u.email', '=', input.email).executeTakeFirst();
    if (already) throw conflict('Cette personne a déjà un accès à cette entreprise.', 'already_member');
    await this.quotas.assertUsers(trx, t.companyId, t.entitlements, { includePending: true });
    const secret = randomToken(24);
    const inv = await trx.insertInto('invitation').values({
      company_id: t.companyId, email: input.email, role_ids: [...new Set(input.roleIds)], token_hash: sha256(secret),
      invited_by: t.ctx.userId, expires_at: new Date(Date.now() + INVITE_DAYS * 86400_000), employee_id: input.employeeId ?? null, site_ids: siteIds,
    }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
    const token = `${t.companyId}.${inv.id}.${secret}`;
    const inviteUrl = `${config.webUrl}/invitation?token=${encodeURIComponent(token)}`;
    const company = await trx.selectFrom('company').select('name').where('id', '=', t.companyId).executeTakeFirstOrThrow();
    const inviter = await trx.selectFrom('user_account').select(['full_name', 'email']).where('id', '=', t.ctx.userId).executeTakeFirstOrThrow();
    const roles = await trx.selectFrom('role').select('name').where('company_id', '=', t.companyId).where('id', 'in', input.roleIds).execute();
    await this.mail.enqueue(trx, {
      companyId: t.companyId, to: input.email, kind: 'invitation', entityId: inv.id, fromName: company.name, replyTo: inviter.email, createdBy: t.ctx.userId,
      subject: `${inviter.full_name} vous invite à rejoindre ${company.name} sur Kora ERP`,
      paragraphs: [
        'Bonjour,',
        `${inviter.full_name} vous invite à rejoindre l'espace de ${company.name} sur Kora ERP, avec le rôle : ${roles.map((r) => r.name).join(', ')}.`,
        `Cette invitation est valable ${INVITE_DAYS} jours. Si vous n'attendiez pas ce message, ignorez-le simplement.`,
      ],
      action: { label: "Accepter l'invitation", url: inviteUrl },
    });
    await this.audit.tenant(trx, t.ctx, { action: 'invitation.created', entityType: 'invitation', entityId: inv.id, data: { email: input.email, role_ids: input.roleIds } });
    // Le lien est aussi rendu à l'administrateur, pour un envoi par un autre canal (WhatsApp…).
    return { id: inv.id, expiresAt: inv.expires_at, inviteUrl, emailQueued: true };
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
      .select(['i.id', 'i.email', 'i.role_ids', 'i.site_ids', 'i.employee_id', 'i.is_owner', 'i.token_hash', 'i.expires_at', 'i.accepted_at', 'i.revoked_at', 'c.name as companyName', 'c.status as companyStatus'])
      .where('i.id', '=', token.invitationId).executeTakeFirst();
    if (!inv || !safeEqual(inv.token_hash, sha256(token.secret)) || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      throw notFound('Invitation');
    }
    return inv;
  }

  @Public() @UseGuards(ThrottlerGuard)
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

  @Public() @UseGuards(ThrottlerGuard)
  @Post('invitations/accept')
  async accept(@Body() body: unknown, @Req() req: KoraRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ token: z.string().max(400), fullName: z.string().trim().min(2).max(120).optional(), password: z.string().max(200).optional() }), body);
    const tk = this.parseToken(input.token);
    // Session déjà pleinement authentifiée (double authentification comprise) du compte invité.
    const signedInUserId = req.auth && (!req.auth.mfaEnabled || req.auth.mfaVerified) ? req.auth.userId : null;

    // Compte existant : son mot de passe est vérifié avec le même compteur d'échecs et le même verrouillage
    // qu'à la connexion, dans une transaction validée avant de répondre (sinon l'échec serait annulé).
    const check = await this.db.identity(async (trx) => {
      const t = await setTenantContext(trx, tk.companyId, '00000000-0000-0000-0000-000000000000');
      const inv = await this.loadInvitation(t, tk);
      const user = await trx.selectFrom('user_account').select(['id', 'password_hash', 'failed_logins', 'locked_until']).where('email', '=', inv.email).executeTakeFirst();
      if (!user || user.id === signedInUserId) return { status: 'ok' as const, verifiedUserId: user?.id ?? null };
      if (!input.password) return { status: 'auth_required' as const };
      const r = await this.auth.passwordAttempt(trx, user, input.password);
      return r === 'ok' ? { status: 'ok' as const, verifiedUserId: user.id } : { status: r === 'locked' ? 'locked' as const : 'auth_required' as const };
    });
    if (check.status === 'locked') throw locked('Trop de tentatives échouées. Réessayez dans quelques minutes.', 'account_locked');
    if (check.status === 'auth_required') throw unauthorized('Connectez-vous avec le compte invité ou saisissez son mot de passe.', 'invitation_auth_required');

    const result = await this.db.identity(async (trx) => {
      let t = await setTenantContext(trx, tk.companyId, '00000000-0000-0000-0000-000000000000');
      const inv = await this.loadInvitation(t, tk);
      let user = await trx.selectFrom('user_account').select(['id', 'mfa_enabled']).where('email', '=', inv.email).executeTakeFirst();
      let userId: string;
      let mfaEnabled = false;
      if (user) {
        // Le compte a pu être créé entre les deux transactions : il doit être celui qui vient d'être vérifié.
        if (user.id !== check.verifiedUserId) {
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
      // Filtre explicite sur l'entreprise : la RLS laisse aussi voir à l'utilisateur ses adhésions dans ses autres entreprises.
      const existing = await t.selectFrom('company_membership').select(['id', 'status']).where('company_id', '=', tk.companyId).where('user_id', '=', userId).executeTakeFirst();
      let membershipId = existing?.id;
      if (existing?.status === 'active') throw conflict('Vous avez déjà accès à cette entreprise.', 'already_member');
      // Invitation du propriétaire (entreprise préparée par l'éditeur) : l'adhésion devient propriétaire.
      const owner = inv.is_owner ? { is_owner: true } : {};
      if (existing) await t.updateTable('company_membership').set({ status: 'active', site_ids: inv.site_ids, ...owner }).where('id', '=', existing.id).execute();
      else membershipId = (await t.insertInto('company_membership').values({ company_id: tk.companyId, user_id: userId, site_ids: inv.site_ids, ...owner }).returning('id').executeTakeFirstOrThrow()).id;
      const roles = await t.selectFrom('role').select('id').where('company_id', '=', tk.companyId).where('id', 'in', inv.role_ids).execute();
      await t.deleteFrom('membership_role').where('membership_id', '=', membershipId!).execute();
      if (roles.length) await t.insertInto('membership_role').values(roles.map((r) => ({ company_id: tk.companyId, membership_id: membershipId!, role_id: r.id }))).execute();
      await t.updateTable('invitation').set({ accepted_at: new Date() }).where('id', '=', inv.id).execute();
      // Invitation à l'espace employé : la fiche de l'employé est rattachée à ce compte.
      if (inv.employee_id) await t.updateTable('employee').set({ user_id: userId }).where('id', '=', inv.employee_id).where('user_id', 'is', null).execute();
      const ctx = { companyId: tk.companyId, userId, actorType: 'user' as const, ip: clientIp(req) };
      await this.audit.tenant(t, ctx, { action: 'invitation.accepted', entityType: 'invitation', entityId: inv.id, data: { membership_id: membershipId } });
      let session = null;
      if (!req.auth || signedInUserId !== userId) {
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
