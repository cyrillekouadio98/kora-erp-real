import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, PlatformRoles } from '../../common/decorators';
import { badRequest, conflict, notFound } from '../../common/errors';
import { FEATURES } from '../../common/features';
import { applyModuleChoices, CORE_MODULES, moduleDef, MODULES } from '../../common/modules';
import type { Trx } from '../../db/database.service';
import { normalizeEntitlements } from '../billing/entitlements';
import { isUuid } from '../../common/ids';
import type { AuthInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';

/** Activation des nouveautés entreprise par entreprise, à la demande du client. */
@ApiTags('Console éditeur')
@Controller('platform/companies/:id/features')
export class FeaturesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @PlatformRoles('super_admin', 'sales_admin', 'support')
  @Get()
  list(@Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Entreprise');
    return this.db.platform(async (trx) => {
      const c = await trx.selectFrom('company').select(['id', 'name']).where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Entreprise');
      const on = await trx.selectFrom('company_feature as f').leftJoin('user_account as u', 'u.id', 'f.enabled_by')
        .select(['f.feature', 'f.enabled_at', 'u.full_name']).where('f.company_id', '=', id).execute();
      const features = [];
      for (const f of FEATURES) {
        const row = on.find((o) => o.feature === f.key);
        features.push({ key: f.key, label: f.label, description: f.description, version: f.version, enabled: !!row,
          enabledAt: row?.enabled_at ?? null, enabledBy: row?.full_name ?? null, inUse: row && f.inUse ? await f.inUse(trx, id) : false });
      }
      return { company: c, features };
    });
  }

  @PlatformRoles('super_admin', 'sales_admin') @HttpCode(200)
  @Put(':key')
  set(@Auth() auth: AuthInfo, @Param('id') id: string, @Param('key') key: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Entreprise');
    const def = FEATURES.find((f) => f.key === key);
    if (!def) throw notFound('Fonctionnalité');
    const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), body);
    return this.db.platform(async (trx) => {
      const c = await trx.selectFrom('company').select(['id', 'name']).where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Entreprise');
      if (enabled) {
        await trx.insertInto('company_feature').values({ company_id: id, feature: key, enabled_by: auth.userId }).onConflict((oc) => oc.doNothing()).execute();
      } else {
        // Une fonctionnalité qui a déjà servi reste active : la retirer masquerait des données du client.
        if (def.inUse && await def.inUse(trx, id)) throw conflict(`« ${def.label} » est déjà utilisée par ${c.name} : elle ne peut plus être désactivée.`, 'feature_in_use');
        await trx.deleteFrom('company_feature').where('company_id', '=', id).where('feature', '=', key).execute();
      }
      await this.audit.platform(trx, auth.userId, { companyId: id, action: enabled ? 'feature.enabled' : 'feature.disabled', entityType: 'company', entityId: id, data: { feature: key, label: def.label } });
      return { ok: true };
    });
  }
}


/** Vue d'ensemble : quelles nouveautés sont activées dans quelles entreprises. */
@ApiTags('Console éditeur')
@Controller('platform/features')
export class FeaturesOverviewController {
  constructor(private readonly db: DatabaseService) {}

  @PlatformRoles('super_admin', 'sales_admin', 'support')
  @Get()
  overview() {
    return this.db.platform(async (trx) => {
      const companies = await trx.selectFrom('company').select(['id', 'name', 'status']).orderBy('name').execute();
      const on = await trx.selectFrom('company_feature').select(['company_id', 'feature']).execute();
      const off = await trx.selectFrom('company_module').select(['company_id', 'module']).where('enabled', '=', false).execute();
      return {
        features: FEATURES.map((f) => ({ key: f.key, label: f.label, description: f.description, version: f.version, companies: on.filter((o) => o.feature === f.key).length })),
        modules: MODULES.map((m) => ({ key: m.key, label: m.label })),
        companies: companies.map((c) => ({ ...c, enabled: on.filter((o) => o.company_id === c.id).map((o) => o.feature), modulesOff: off.filter((o) => o.company_id === c.id).map((o) => o.module) })),
      };
    });
  }
}


/** État des modules d'une entreprise : formule souscrite, choix de la console, dépendances. */
async function moduleState(trx: Trx, companyId: string) {
  const sub = await trx.selectFrom('subscription as s').innerJoin('plan_version as v', 'v.id', 's.plan_version_id').innerJoin('plan as p', 'p.id', 'v.plan_id')
    .select(['v.entitlements', 's.overrides', 'p.name as plan']).where('s.company_id', '=', companyId).executeTakeFirst();
  const rows = await trx.selectFrom('company_module as m').leftJoin('user_account as u', 'u.id', 'm.changed_by')
    .select(['m.module', 'm.enabled', 'm.changed_at', 'u.full_name']).where('m.company_id', '=', companyId).execute();
  const applied = applyModuleChoices(normalizeEntitlements(sub?.entitlements, sub?.overrides), Object.fromEntries(rows.map((r) => [r.module, r.enabled])));
  const modules = MODULES.map((m) => {
    const st = applied.state(m);
    const row = rows.find((r) => r.module === m.key);
    return { key: m.key, label: m.label, description: m.description, requires: m.requires, dependents: MODULES.filter((d) => d.requires.includes(m.key)).map((d) => d.key),
      inPlan: st.inPlan, enabled: st.enabled, choice: st.choice, changedAt: row?.changed_at ?? null, changedBy: row?.full_name ?? null };
  });
  return { plan: sub?.plan ?? null, modules };
}

/** Modules activables entreprise par entreprise : le socle reste toujours actif, les autres suivent la formule sauf choix contraire. */
@ApiTags('Console éditeur')
@Controller('platform/companies/:id/modules')
export class ModulesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @PlatformRoles('super_admin', 'sales_admin', 'support')
  @Get()
  list(@Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Entreprise');
    return this.db.platform(async (trx) => {
      const c = await trx.selectFrom('company').select(['id', 'name']).where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Entreprise');
      return { company: c, core: CORE_MODULES, ...await moduleState(trx, id) };
    });
  }

  /** enabled : true ajoute ou rouvre le module, false le retire, null le rend à la formule. */
  @PlatformRoles('super_admin', 'sales_admin') @HttpCode(200)
  @Put(':key')
  set(@Auth() auth: AuthInfo, @Param('id') id: string, @Param('key') key: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Entreprise');
    const def = moduleDef(key);
    if (!def) {
      if (CORE_MODULES.some((m) => m.key === key)) throw badRequest('Ce module fait partie du socle de Kora : il ne peut pas être retiré.', undefined, 'core_module');
      throw notFound('Module');
    }
    const { enabled } = parse(z.object({ enabled: z.boolean().nullable() }).strict(), body);
    return this.db.platform(async (trx) => {
      const c = await trx.selectFrom('company').select(['id', 'name']).where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Entreprise');
      const before = await moduleState(trx, id);
      const label = (k: string) => moduleDef(k)!.label;
      const will = enabled ?? before.modules.find((m) => m.key === key)!.inPlan;
      // Dépendances : on n'ouvre pas un module dont un prérequis est fermé, on ne ferme pas un prérequis encore utilisé.
      if (will) {
        const missing = def.requires.filter((r) => !before.modules.find((m) => m.key === r)!.enabled);
        if (missing.length) throw conflict(`Activez d'abord : ${missing.map(label).join(', ')}.`, 'module_requires');
      } else {
        const users = before.modules.filter((m) => m.requires.includes(key) && m.enabled).map((m) => m.key);
        if (users.length) throw conflict(`Retirez d'abord : ${users.map(label).join(', ')} (${users.length > 1 ? 'ils dépendent' : 'il dépend'} de ${def.label}).`, 'module_required_by');
      }
      if (enabled === null) await trx.deleteFrom('company_module').where('company_id', '=', id).where('module', '=', key).execute();
      else await trx.insertInto('company_module').values({ company_id: id, module: key, enabled, changed_by: auth.userId })
        .onConflict((oc) => oc.columns(['company_id', 'module']).doUpdateSet({ enabled, changed_by: auth.userId, changed_at: new Date() })).execute();
      await this.audit.platform(trx, auth.userId, { companyId: id, action: enabled === null ? 'module.reset' : enabled ? 'module.enabled' : 'module.disabled', entityType: 'company', entityId: id, data: { module: key, label: def.label } });
      return { ok: true };
    });
  }
}
