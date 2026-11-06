import { Body, Controller, Get, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Auth, Permission, Tenant } from '../../common/decorators';
import { forbidden, notFound } from '../../common/errors';
import { AuthInfo, clientIp, KoraRequest, TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { logoUrl, parseLogo, saveLogo } from './company-logo';
import { ProvisioningService } from './provisioning.service';

const opt = (max: number) => z.string().trim().max(max).nullable().optional();
const UpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  legalForm: opt(40), rccm: opt(60), taxId: opt(40), taxRegime: opt(60),
  address: opt(300), city: opt(80), phone: opt(40), email: z.string().trim().toLowerCase().email().nullable().optional(),
}).strict();

const COLUMNS = { name: 'name', legalForm: 'legal_form', rccm: 'rccm', taxId: 'tax_id', taxRegime: 'tax_regime', address: 'address', city: 'city', phone: 'phone', email: 'email' } as const;
const TAX_FIELDS = ['taxId', 'taxRegime'];

@ApiTags('Entreprise')
@Controller()
export class CompaniesController {
  constructor(private readonly db: DatabaseService, private readonly provisioning: ProvisioningService, private readonly audit: AuditService) {}

  /** Crée une entreprise supplémentaire dont l'utilisateur devient propriétaire. */
  @Post('companies')
  async create(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: KoraRequest) {
    const input = parse(z.object({ name: z.string().trim().min(2).max(160), legalForm: opt(40), taxId: opt(40), city: opt(80) }), body);
    return this.db.asUser(auth.userId, (trx) => this.provisioning.provision(trx, auth.userId, input, clientIp(req)));
  }

  /** Contexte de l'entreprise active : droits, formule, état de l'abonnement. */
  @Permission(null) @AllowWhenReadOnly()
  @Get('company/context')
  async context(@Tenant() t: TenantInfo) {
    const { company, sites } = await this.db.tenant(t.ctx, async (trx) => ({
      company: { ...await trx.selectFrom('company').select(['id', 'name', 'currency', 'country_code', 'status']).where('id', '=', t.companyId).executeTakeFirstOrThrow(), logo: await logoUrl(trx) },
      sites: await trx.selectFrom('site').select(['id', 'code', 'name', 'is_default as isDefault']).where('archived_at', 'is', null).orderBy('is_default', 'desc').orderBy('code').execute(),
    }));
    return {
      company, membershipId: t.membershipId, isOwner: t.isOwner, permissions: [...t.permissions].sort(),
      entitlements: t.entitlements, subscriptionStatus: t.subscriptionStatus, readOnly: t.readOnly,
      // Sites proposés dans l'en-tête : ceux permis à l'utilisateur ; site affiché (null : tous).
      sites: t.allowedSiteIds ? sites.filter((s) => t.allowedSiteIds!.includes(s.id)) : sites, siteId: t.siteId, siteRestricted: !!t.allowedSiteIds,
    };
  }

  @Permission(null) @AllowWhenReadOnly()
  @Get('company')
  get(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => ({ ...await trx.selectFrom('company').selectAll().where('id', '=', t.companyId).executeTakeFirstOrThrow(), logo: await logoUrl(trx) }));
  }

  @Permission(null) @AllowWhenReadOnly()
  @Get('company/logo')
  async logo(@Tenant() t: TenantInfo, @Res() res: Response) {
    const l = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('company_logo').select(['mime', 'data']).executeTakeFirst());
    if (!l) throw notFound('Logo');
    res.setHeader('Content-Type', l.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(l.data);
  }

  /** Logo de l'entreprise, repris sur ses documents ; null le retire. */
  @Permission('settings.admin')
  @Put('company/logo')
  setLogo(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const logo = parseLogo(body);
    return this.db.tenant(t.ctx, async (trx) => { await saveLogo(trx, this.audit, t.ctx, logo); return { logo: await logoUrl(trx) }; });
  }

  @Permission('settings.admin')
  @Patch('company')
  async update(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(UpdateSchema, body);
    if (TAX_FIELDS.some((f) => f in input) && !t.permissions.has('settings.tax')) {
      throw forbidden('Modifier les informations fiscales demande la permission « paramètres fiscaux ».');
    }
    const patch: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(COLUMNS)) if (k in input) patch[col] = (input as any)[k];
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await trx.selectFrom('company').selectAll().where('id', '=', t.companyId).executeTakeFirstOrThrow();
      const after = await trx.updateTable('company').set(patch).where('id', '=', t.companyId).returningAll().executeTakeFirstOrThrow();
      const changes = Object.fromEntries(Object.keys(patch).map((c) => [c, { from: (before as any)[c], to: (after as any)[c] }]));
      await this.audit.tenant(trx, t.ctx, { action: 'company.updated', entityType: 'company', entityId: t.companyId, data: { changes } });
      return after;
    });
  }
}
