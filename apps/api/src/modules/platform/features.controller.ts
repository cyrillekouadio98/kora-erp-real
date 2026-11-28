import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, PlatformRoles } from '../../common/decorators';
import { badRequest, conflict, notFound } from '../../common/errors';
import { FEATURES } from '../../common/features';
import { applyModuleChoices, CORE_MODULES, moduleDef, MODULES } from '../../common/modules';
import type { Trx } from '../../db/database.service';
import { normalizeEntitlements } from '../billing/entitlements';
import { SetupService } from './setup.service';
import { isUuid } from '../../common/ids';
import { AuthInfo, clientIp, KoraRequest } from '../../common/request-context';
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
      if (!(await trx.selectFrom('company').select('id').where('id', '=', id).executeTakeFirst())) throw notFound('Entreprise');
      await changeModule(trx, this.audit, auth.userId, id, key, enabled);
      return { ok: true };
    });
  }
}

/**
 * Change l'état d'un module (true ajouté, false retiré, null selon la formule) après contrôle des dépendances :
 * on n'ouvre pas un module dont un prérequis est fermé, on ne ferme pas un prérequis encore utilisé.
 */
async function changeModule(trx: Trx, audit: AuditService, userId: string, id: string, key: string, enabled: boolean | null) {
  const def = moduleDef(key)!;
  const before = await moduleState(trx, id);
  const label = (k: string) => moduleDef(k)!.label;
  const will = enabled ?? before.modules.find((m) => m.key === key)!.inPlan;
  if (will) {
    const missing = def.requires.filter((r) => !before.modules.find((m) => m.key === r)!.enabled);
    if (missing.length) throw conflict(`Activez d'abord : ${missing.map(label).join(', ')}.`, 'module_requires');
  } else {
    const users = before.modules.filter((m) => m.requires.includes(key) && m.enabled).map((m) => m.key);
    if (users.length) throw conflict(`Retirez d'abord : ${users.map(label).join(', ')} (${users.length > 1 ? 'ils dépendent' : 'il dépend'} de ${def.label}).`, 'module_required_by');
  }
  if (enabled === null) await trx.deleteFrom('company_module').where('company_id', '=', id).where('module', '=', key).execute();
  else await trx.insertInto('company_module').values({ company_id: id, module: key, enabled, changed_by: userId })
    .onConflict((oc) => oc.columns(['company_id', 'module']).doUpdateSet({ enabled, changed_by: userId, changed_at: new Date() })).execute();
  await audit.platform(trx, userId, { companyId: id, action: enabled === null ? 'module.reset' : enabled ? 'module.enabled' : 'module.disabled', entityType: 'company', entityId: id, data: { module: key, label: def.label } });
}

/**
 * Profils types : modules gardés et retirés pour un métier, options cochées dans la console
 * (chaque option garde ses modules si elle est cochée, les retire sinon), caisses de vente à créer.
 */
interface ProfileDef { key: string; label: string; description: string; note?: string; off: string[]; on: string[]; options: { key: string; label: string; modules: string[]; default: boolean }[] }
export const PROFILES: ProfileDef[] = [
  {
    key: 'boutique', label: 'Profil Boutique',
    description: 'Ce dont une boutique se sert chaque jour : point de vente, stocks, rapports et point journalier. Employés, Congés, Évaluations, Paie et Calendrier sont retirés.',
    off: ['employees', 'leave', 'evaluations', 'payroll', 'calendar'], on: ['stock', 'pos', 'reports'],
    options: [
      { key: 'purchases', label: 'Garder les Achats (fournisseurs avec factures)', modules: ['purchases'], default: true },
      { key: 'accounting', label: 'Garder la Comptabilité (un comptable s’en sert)', modules: ['accounting'], default: false },
    ],
  },
  {
    key: 'restaurant', label: 'Profil Restaurant',
    description: 'Point de vente pour encaisser en salle et à emporter, stocks des boissons et des denrées, achats aux fournisseurs, rapports et point journalier ; le personnel (employés, congés, paie) au choix. Évaluations et Calendrier sont retirés.',
    note: 'Pensez à activer les nouveautés « Lots et dates de péremption » (denrées) et « Unités de mesure » (casier, carton, kg) si le client en a besoin. Kora ne gère pas encore les tables, l’envoi en cuisine ni les fiches techniques (un plat vendu ne déduit pas ses ingrédients) : les denrées utilisées se sortent par un bon de sortie « Consommation interne ».',
    off: ['evaluations', 'calendar'], on: ['stock', 'pos', 'reports'],
    options: [
      { key: 'purchases', label: 'Garder les Achats (fournisseurs avec factures)', modules: ['purchases'], default: true },
      { key: 'staff', label: 'Garder le personnel : Employés, Congés et Paie (serveurs et cuisiniers déclarés)', modules: ['employees', 'leave', 'payroll'], default: true },
      { key: 'accounting', label: 'Garder la Comptabilité (un comptable s’en sert)', modules: ['accounting'], default: false },
    ],
  },
];
/** Ordre des changements : on retire un module avant ses prérequis, on ouvre un prérequis avant ce qui en dépend. */
const OFF_ORDER = ['payroll', 'evaluations', 'leave', 'employees', 'calendar', 'pos', 'stock', 'purchases', 'accounting', 'reports', 'bank'];
const byOrder = (keys: string[], order: string[]) => [...new Set(keys)].sort((a, b) => order.indexOf(a) - order.indexOf(b));

/** Profils types appliqués en un clic depuis la console. */
@ApiTags('Console éditeur')
@Controller('platform/companies/:id/profiles')
export class ProfilesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly setup: SetupService) {}

  @PlatformRoles('super_admin', 'sales_admin', 'support')
  @Get()
  list() {
    return PROFILES.map(({ key, label, description, note, options }) => ({ key, label, description, note: note ?? null, options: options.map(({ key: k, label: l, default: d }) => ({ key: k, label: l, default: d })) }));
  }

  /**
   * Applique un profil : modules du métier (options au choix), puis, pour une entreprise encore en préparation,
   * une caisse de vente par poste avec son compte de caisse. Une entreprise en service garde la main sur ses caisses :
   * la console ne les crée pas pour elle. Un module absent de la formule n'est jamais donné par un profil.
   */
  @PlatformRoles('super_admin', 'sales_admin') @HttpCode(200)
  @Post(':profile')
  async apply(@Auth() auth: AuthInfo, @Param('id') id: string, @Param('profile') key: string, @Body() body: unknown, @Req() req: KoraRequest) {
    if (!isUuid(id)) throw notFound('Entreprise');
    const def = PROFILES.find((p) => p.key === key);
    if (!def) throw notFound('Profil');
    const input = parse(z.object({ registers: z.number().int().min(1).max(3), ...Object.fromEntries(def.options.map((o) => [o.key, z.boolean()])) }).strict(), body) as { registers: number } & Record<string, boolean>;
    const chosen = def.options.filter((o) => input[o.key]).flatMap((o) => o.modules);
    const dropped = def.options.filter((o) => !input[o.key]).flatMap((o) => o.modules);
    const off = byOrder([...def.off, ...dropped].filter((k) => !chosen.includes(k)), OFF_ORDER);
    const on = byOrder([...def.on, ...chosen], [...OFF_ORDER].reverse());
    const { company, modules, preparing } = await this.db.platform(async (trx) => {
      const c = await trx.selectFrom('company').select(['id', 'name']).where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Entreprise');
      const out: { key: string; label: string; result: 'removed' | 'enabled' | 'unchanged' | 'not_in_plan' }[] = [];
      const state = async (k: string) => (await moduleState(trx, id)).modules.find((m) => m.key === k)!;
      for (const k of off) {
        const m = await state(k);
        if (m.enabled) { await changeModule(trx, this.audit, auth.userId, id, k, false); out.push({ key: k, label: m.label, result: 'removed' }); }
        else out.push({ key: k, label: m.label, result: 'unchanged' });
      }
      for (const k of on) {
        const m = await state(k);
        // Le profil ne donne pas un module que la formule n'inclut pas : cela se décide à part (facturation).
        if (m.enabled) out.push({ key: k, label: m.label, result: 'unchanged' });
        else if (!m.inPlan) out.push({ key: k, label: m.label, result: 'not_in_plan' });
        else if (m.requires.some((r) => out.find((o) => o.key === r)?.result === 'not_in_plan')) out.push({ key: k, label: m.label, result: 'not_in_plan' });
        else { await changeModule(trx, this.audit, auth.userId, id, k, null); out.push({ key: k, label: m.label, result: 'enabled' }); }
      }
      const setup = await trx.selectFrom('company_setup').select('handed_over_at').where('company_id', '=', id).executeTakeFirst();
      await this.audit.platform(trx, auth.userId, { companyId: id, action: 'profile.applied', entityType: 'company', entityId: id, data: { profile: def.key, ...input } });
      return { company: c, modules: out, preparing: !!setup && !setup.handed_over_at };
    });
    const registers = preparing ? await this.setup.shopRegisters(auth, id, input.registers, clientIp(req)) : null;
    return { company, modules, registers, preparing, note: def.note ?? null };
  }
}
