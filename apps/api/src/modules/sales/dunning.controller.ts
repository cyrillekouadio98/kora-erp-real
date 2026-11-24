import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { AUTO_REMINDERS, DEFAULT_STEPS, DunningService } from './dunning.service';

const StepsSchema = z.object({
  enabled: z.boolean(),
  copyTo: z.string().trim().toLowerCase().email({ message: 'Adresse de copie invalide' }).max(254).nullable().optional().or(z.literal('').transform(() => null)),
  steps: z.array(z.object({
    days: z.coerce.number().int().min(1, { message: 'Au moins 1 jour après l’échéance' }).max(365),
    subject: z.string().trim().min(3).max(150), message: z.string().trim().min(10, { message: 'Le message est trop court' }).max(3000),
  }).strict()).min(1, { message: 'Au moins une étape' }).max(5),
}).strict();

/** Réglages et aperçu des relances automatiques des factures en retard. */
@ApiTags('Ventes')
@Controller('company/dunning')
export class DunningController {
  constructor(private readonly db: DatabaseService, private readonly dunning: DunningService, private readonly audit: AuditService) {}

  @Permission('sales.read') @RequireFeature(AUTO_REMINDERS) @AllowWhenReadOnly()
  @Get()
  get(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const s = await this.dunning.settings(trx);
      const due = await this.dunning.due(trx, s.steps);
      return { ...s, defaults: DEFAULT_STEPS, preview: due.map(({ template: _t, ...d }) => d) };
    });
  }

  @Permission('sales.update') @RequireFeature(AUTO_REMINDERS) @HttpCode(200)
  @Put()
  save(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(StepsSchema, body);
    const days = input.steps.map((s) => s.days);
    if (new Set(days).size !== days.length) throw badRequest('Deux étapes ont le même délai.', undefined, 'duplicate_step');
    const steps = [...input.steps].sort((a, b) => a.days - b.days);
    return this.db.tenant(t.ctx, async (trx) => {
      await trx.insertInto('dunning_settings').values({ company_id: t.companyId, enabled: input.enabled, steps: JSON.stringify(steps), copy_to: input.copyTo ?? null, updated_by: t.ctx.userId })
        .onConflict((oc) => oc.column('company_id').doUpdateSet({ enabled: input.enabled, steps: JSON.stringify(steps), copy_to: input.copyTo ?? null, updated_by: t.ctx.userId, updated_at: new Date() })).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'dunning.settings_updated', entityType: 'company', entityId: t.companyId, data: { enabled: input.enabled, steps: steps.map((s) => s.days) } });
      return { ok: true };
    });
  }

  /** Envoie tout de suite les relances dues aujourd'hui (sans attendre la tournée du matin). */
  @Permission('sales.update') @RequireFeature(AUTO_REMINDERS) @HttpCode(200)
  @Post('run')
  async run(@Tenant() t: TenantInfo) {
    const s = await this.db.tenant(t.ctx, (trx) => this.dunning.settings(trx));
    if (!s.enabled || !s.configured) throw badRequest('Activez et enregistrez d’abord les relances automatiques.', undefined, 'dunning_disabled');
    return this.dunning.runCompany(t.companyId);
  }
}
