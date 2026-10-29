import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, Permission, PlatformRoles, Tenant } from '../../common/decorators';
import { conflict, forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { AuthInfo, TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantContext } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';

export const SUPPORT_SCOPES = ['users', 'settings', 'billing', 'audit'] as const;

/** Côté entreprise : l'administrateur accepte, refuse ou révoque les demandes d'accès du support. */
@ApiTags('Accès exceptionnel du support')
@Controller('company/support-access')
export class SupportAccessController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Permission('settings.admin')
  @Get()
  list(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, (trx) => trx.selectFrom('support_access_grant')
      .select(['id', 'reason', 'scope', 'duration_minutes as durationMinutes', 'status', 'decided_at as decidedAt', 'expires_at as expiresAt', 'created_at as createdAt'])
      .orderBy('created_at', 'desc').limit(100).execute());
  }

  private decide(t: TenantInfo, id: string, from: string[], to: 'approved' | 'denied' | 'revoked') {
    if (!isUuid(id)) throw notFound('Demande');
    return this.db.tenant(t.ctx, async (trx) => {
      const g = await trx.selectFrom('support_access_grant').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!g) throw notFound('Demande');
      if (!from.includes(g.status)) throw conflict('Cette demande a déjà été traitée.', 'invalid_state');
      const now = new Date();
      const expires = to === 'approved' ? new Date(now.getTime() + g.duration_minutes * 60_000) : to === 'revoked' ? now : null;
      await trx.updateTable('support_access_grant').set({ status: to, decided_by: t.ctx.userId, decided_at: now, expires_at: expires }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `support_access.${to}`, entityType: 'support_access_grant', entityId: id, data: { scope: g.scope, expires_at: expires } });
      return { ok: true, expiresAt: expires };
    });
  }

  @Permission('settings.admin') @HttpCode(200) @Post(':id/approve')
  approve(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.decide(t, id, ['requested'], 'approved'); }

  @Permission('settings.admin') @HttpCode(200) @Post(':id/deny')
  deny(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.decide(t, id, ['requested'], 'denied'); }

  @Permission('settings.admin') @HttpCode(200) @Post(':id/revoke')
  revoke(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.decide(t, id, ['approved'], 'revoked'); }
}

/** Côté éditeur : le support demande un accès, puis consulte uniquement le périmètre accordé, sous journalisation. */
@ApiTags('Console éditeur — support')
@Controller('platform')
export class PlatformSupportController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @PlatformRoles('support', 'super_admin')
  @Post('support-access')
  request(@Auth() auth: AuthInfo, @Body() body: unknown) {
    const input = parse(z.object({
      companyId: z.string().uuid(), reason: z.string().trim().min(10).max(500),
      scope: z.array(z.enum(SUPPORT_SCOPES)).min(1), durationMinutes: z.number().int().min(15).max(1440).default(240),
    }), body);
    return this.db.platform(async (trx) => {
      const c = await trx.selectFrom('company').select('id').where('id', '=', input.companyId).executeTakeFirst();
      if (!c) throw notFound('Entreprise');
      const g = await trx.insertInto('support_access_grant').values({
        company_id: input.companyId, requested_by: auth.userId, reason: input.reason, scope: input.scope, duration_minutes: input.durationMinutes,
      }).returning(['id', 'status']).executeTakeFirstOrThrow();
      await this.audit.platform(trx, auth.userId, { companyId: input.companyId, action: 'support_access.requested', entityType: 'support_access_grant', entityId: g.id, data: { reason: input.reason, scope: input.scope } });
      return g;
    });
  }

  @PlatformRoles('support', 'super_admin')
  @Get('support-access')
  mine(@Auth() auth: AuthInfo) {
    return this.db.platform((trx) => trx.selectFrom('support_access_grant as g').innerJoin('company as c', 'c.id', 'g.company_id')
      .select(['g.id', 'g.company_id as companyId', 'c.name as companyName', 'g.scope', 'g.status', 'g.expires_at as expiresAt', 'g.created_at as createdAt'])
      .where('g.requested_by', '=', auth.userId).orderBy('g.created_at', 'desc').limit(100).execute());
  }

  /** Ouvre un contexte entreprise en lecture pour le support, si un accès accordé et non expiré couvre ce périmètre. */
  private async withGrant<T>(auth: AuthInfo, companyId: string, scope: string, fn: (ctx: TenantContext) => Promise<T>) {
    if (!isUuid(companyId)) throw notFound('Entreprise');
    const grant = await this.db.platform((trx) => trx.selectFrom('support_access_grant').select(['id', 'scope', 'expires_at'])
      .where('company_id', '=', companyId).where('requested_by', '=', auth.userId).where('status', '=', 'approved')
      .where('expires_at', '>', new Date()).orderBy('expires_at', 'desc').limit(1).executeTakeFirst());
    if (!grant || !grant.scope.includes(scope)) throw forbidden("Aucun accès accordé par le client ne couvre cette consultation.", 'no_support_grant');
    const ctx: TenantContext = { companyId, userId: auth.userId, actorType: 'support' };
    return fn(ctx).then(async (r) => {
      await this.db.tenant(ctx, (trx) => this.audit.tenant(trx, ctx, { action: 'support.viewed', entityType: 'support_access_grant', entityId: grant.id, data: { scope } }));
      return r;
    });
  }

  @PlatformRoles('support', 'super_admin')
  @Get('support/companies/:companyId/members')
  members(@Auth() auth: AuthInfo, @Param('companyId') companyId: string) {
    return this.withGrant(auth, companyId, 'users', (ctx) => this.db.tenant(ctx, (trx) => trx.selectFrom('company_membership as m')
      .innerJoin('user_account as u', 'u.id', 'm.user_id').select(['m.id', 'm.status', 'u.full_name as fullName', 'u.email', 'u.mfa_enabled as mfaEnabled']).execute()));
  }

  @PlatformRoles('support', 'super_admin')
  @Get('support/companies/:companyId/audit')
  auditTrail(@Auth() auth: AuthInfo, @Param('companyId') companyId: string) {
    return this.withGrant(auth, companyId, 'audit', (ctx) => this.db.tenant(ctx, (trx) => trx.selectFrom('audit_log')
      .select(['id', 'actor_type', 'action', 'entity_type', 'created_at']).orderBy('id', 'desc').limit(100).execute()));
  }
}
