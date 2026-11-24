import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, PlatformRoles } from '../../common/decorators';
import { conflict, notFound } from '../../common/errors';
import { FEATURES } from '../../common/features';
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
      return {
        features: FEATURES.map((f) => ({ key: f.key, label: f.label, description: f.description, version: f.version, companies: on.filter((o) => o.feature === f.key).length })),
        companies: companies.map((c) => ({ ...c, enabled: on.filter((o) => o.company_id === c.id).map((o) => o.feature) })),
      };
    });
  }
}
