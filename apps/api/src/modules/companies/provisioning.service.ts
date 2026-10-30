import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { uuidv7 } from '../../common/ids';
import { badRequest } from '../../common/errors';
import { setTenantContext, TenantContext, Trx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_TRIAL_PLAN } from '../billing/entitlements';
import { DEFAULT_ROLES } from '../rbac/permissions';

export interface NewCompany { name: string; legalForm?: string | null; taxId?: string | null; city?: string | null }

/** Crée une entreprise complète : fiche, rôles standard, propriétaire, essai gratuit. */
@Injectable()
export class ProvisioningService {
  constructor(private readonly audit: AuditService) {}

  async provision(trx: Trx, userId: string, input: NewCompany, ip?: string | null) {
    const companyId = uuidv7();
    const t = await setTenantContext(trx, companyId, userId);
    const ctx: TenantContext = { companyId, userId, actorType: 'user', ip };

    await t.insertInto('company').values({
      id: companyId, name: input.name.trim(), legal_form: input.legalForm ?? null, tax_id: input.taxId ?? null,
      city: input.city ?? null, created_by: userId, rccm: null, tax_regime: null, address: null, phone: null, email: null, logo_key: null, status_reason: null,
    }).execute();

    const roles = await t.insertInto('role').values(DEFAULT_ROLES.map((r) => ({
      company_id: companyId, key: r.key, name: r.name, description: r.description, is_system: true, permissions: r.permissions,
    }))).returning(['id', 'key']).execute();

    const membership = await t.insertInto('company_membership').values({ company_id: companyId, user_id: userId, is_owner: true })
      .returning('id').executeTakeFirstOrThrow();
    await t.insertInto('membership_role').values({ company_id: companyId, membership_id: membership.id, role_id: roles.find((r) => r.key === 'owner')!.id }).execute();

    const plan = await t.selectFrom('plan_version as v').innerJoin('plan as p', 'p.id', 'v.plan_id')
      .select(['v.id', 'v.trial_days']).where('p.code', '=', DEFAULT_TRIAL_PLAN).where('v.published_at', 'is not', null)
      .orderBy('v.version', 'desc').limit(1).executeTakeFirst();
    if (!plan) throw badRequest("Aucune formule d'essai n'est publiée. Contactez l'éditeur.", undefined, 'no_trial_plan');
    const start = new Date();
    const end = new Date(start.getTime() + Math.max(plan.trial_days, 1) * 86400_000);
    const sub = await t.insertInto('subscription').values({
      company_id: companyId, plan_version_id: plan.id, status: 'trialing', current_period_start: start, current_period_end: end,
    }).returning('id').executeTakeFirstOrThrow();
    await t.insertInto('subscription_event').values({ subscription_id: sub.id, company_id: companyId, type: 'trial_started', to_status: 'trialing', from_status: null, data: JSON.stringify({ trial_days: plan.trial_days }) }).execute();

    // Plan comptable SYSCOHADA, journaux, puis trois comptes de trésorerie avec leur sous-compte comptable.
    await sql`select seed_accounting(${companyId}::uuid)`.execute(t);
    const treasury = [
      { kind: 'cash' as const, name: 'Caisse principale', ledger_code: '5711' },
      { kind: 'bank' as const, name: 'Banque principale', ledger_code: '5211' },
      { kind: 'mobile_money' as const, name: 'Mobile money', ledger_code: '5521' },
    ];
    await t.insertInto('ledger_account').values(treasury.map((a) => ({ company_id: companyId, code: a.ledger_code, name: a.name, is_system: true }))).execute();
    await t.insertInto('treasury_account').values(treasury.map((a) => ({ ...a, company_id: companyId, bank_name: null, account_number: null }))).execute();

    await this.audit.tenant(t, ctx, { action: 'company.created', entityType: 'company', entityId: companyId, data: { name: input.name } });
    await sql`select set_config('app.company_id', '', true)`.execute(trx);
    return { companyId, membershipId: membership.id };
  }
}
