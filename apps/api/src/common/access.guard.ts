import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { SessionService } from '../modules/auth/session.service';
import { EntitlementService } from '../modules/billing/entitlement.service';
import { entitlementFor } from '../modules/rbac/permissions';
import { META } from './decorators';
import { badRequest, forbidden, locked, paymentRequired, unauthorized } from './errors';
import { clientIp, KoraRequest } from './request-context';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Garde unique, appliquée à toutes les routes, dans cet ordre :
 * session → second facteur → rôle plateforme OU (entreprise active → adhésion → abonnement → permission).
 * L'entreprise active vient toujours de la session, jamais de l'URL.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementService,
  ) {}

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<KoraRequest>();
    const token = req.cookies?.[config.session.cookieName] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
    if (token) req.auth = (await this.sessions.resolve(token)) ?? undefined;

    if (this.meta<boolean>(META.public, ctx)) return true;
    const auth = req.auth;
    if (!auth) throw unauthorized();

    if (auth.mfaEnabled && !auth.mfaVerified && !this.meta<boolean>(META.pendingMfa, ctx)) {
      throw unauthorized('Saisissez le code de double authentification pour continuer.', 'mfa_required');
    }

    const platformRoles = this.meta<string[]>(META.platformRoles, ctx);
    if (platformRoles) {
      if (!auth.platformRoles.some((r) => platformRoles.includes(r))) throw forbidden();
      if (!auth.mfaEnabled) throw forbidden('Activez la double authentification pour accéder à la console éditeur.', 'mfa_setup_required');
      return true;
    }

    const permission = this.meta<string>(META.permission, ctx);
    if (permission === undefined) return true; // route liée au seul compte utilisateur

    if (!auth.activeCompanyId) throw badRequest('Choisissez une entreprise active.', undefined, 'no_active_company');
    const companyId = auth.activeCompanyId;
    const tctx = { companyId, userId: auth.userId, actorType: 'user' as const, ip: clientIp(req) };

    const info = await this.db.tenant(tctx, async (trx) => {
      const m = await trx.selectFrom('company_membership as m').innerJoin('company as c', 'c.id', 'm.company_id')
        .select(['m.id', 'm.status', 'm.valid_until', 'm.is_owner', 'c.status as company_status'])
        .where('m.company_id', '=', companyId).where('m.user_id', '=', auth.userId).executeTakeFirst();
      if (!m || m.status !== 'active' || (m.valid_until && m.valid_until < new Date().toISOString().slice(0, 10))) return null;
      const roles = await trx.selectFrom('membership_role as mr').innerJoin('role as r', (j) => j.onRef('r.id', '=', 'mr.role_id').onRef('r.company_id', '=', 'mr.company_id'))
        .select('r.permissions').where('mr.membership_id', '=', m.id).execute();
      const ent = await this.entitlements.forCompany(trx, companyId);
      return { m, permissions: new Set(roles.flatMap((r) => r.permissions)), ...ent };
    });
    if (!info) throw forbidden("Vous n'avez pas ou plus accès à cette entreprise.", 'no_membership');

    const subStatus = info.subscription?.status ?? null;
    const readOnly = info.m.company_status !== 'active' || !subStatus || ['suspended', 'cancelled', 'archived'].includes(subStatus);
    req.tenant = {
      ctx: tctx, companyId, membershipId: info.m.id, isOwner: info.m.is_owner, permissions: info.permissions,
      entitlements: info.entitlements, companyStatus: info.m.company_status, subscriptionStatus: subStatus, readOnly,
    };

    if (permission) {
      const mod = entitlementFor(permission);
      if (mod && !info.entitlements.modules.includes(mod)) {
        throw paymentRequired("Ce module n'est pas inclus dans votre formule. Passez à une formule supérieure pour y accéder.", 'module_not_in_plan', { module: mod });
      }
      if (!info.permissions.has(permission)) throw forbidden();
    }
    if (readOnly && !READ_METHODS.has(req.method) && !this.meta<boolean>(META.whenReadOnly, ctx)) {
      throw locked("Votre compte est en lecture seule (abonnement suspendu ou résilié). Vous pouvez consulter et exporter vos données, ou régler votre abonnement pour le réactiver.", 'read_only');
    }
    return true;
  }
}
