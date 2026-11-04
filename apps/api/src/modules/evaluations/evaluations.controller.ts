import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { toCsv } from '../exports/export.controller';
import { isoDate } from '../sales/sales.controller';
import { EvaluationsService } from './evaluations.service';

const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const money = z.coerce.number().min(0, { message: 'Le montant ne peut pas être négatif' }).max(1e12).transform((v) => Math.round(v));
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Mois au format AAAA-MM' });
const userId = z.string().uuid({ message: 'Évaluateur invalide' }).nullable().optional();
const CriteriaSchema = z.array(z.object({
  key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/, { message: 'Clé de critère invalide' }),
  label: z.string().trim().min(2, { message: 'Nommez chaque critère' }).max(80),
  weight: z.coerce.number().int().min(1, { message: 'Coefficient de 1 à 5' }).max(5, { message: 'Coefficient de 1 à 5' }),
}).strict()).min(1, { message: 'Ajoutez au moins un critère' }).max(15);
const CampaignSchema = z.object({
  name: z.string().trim().min(2, { message: 'Nommez la campagne' }).max(120),
  periodStart: isoDate, periodEnd: isoDate, dueDate: isoDate.nullable().optional(),
  criteria: CriteriaSchema.optional(), employeeIds: z.array(z.string().uuid()).max(2000).optional(), evaluatorId: userId,
}).strict();
const Money = { bonusAmount: money.optional(), bonusPeriod: period.nullable().optional(), newBaseSalary: money.nullable().optional(), raisePeriod: period.nullable().optional() };
const EvaluationSchema = z.object({
  scores: z.record(z.string().max(40), z.object({ score: z.number().int().min(1).max(5).nullable(), comment: text(1000) }).strict()).optional(),
  strengths: text(3000), improvements: text(3000), goals: text(3000), comment: text(3000), evaluatorId: userId, ...Money,
}).strict();

@ApiTags('Évaluations')
@Controller('company')
export class EvaluationsController {
  constructor(private readonly evaluations: EvaluationsService) {}

  @Permission('evaluations.read') @AllowWhenReadOnly()
  @Get('evaluations/defaults')
  defaults() { return this.evaluations.defaults(); }

  @Permission('evaluations.read') @AllowWhenReadOnly()
  @Get('evaluations/people')
  people(@Tenant() t: TenantInfo) { return this.evaluations.people(t); }

  @Permission('evaluations.read') @AllowWhenReadOnly()
  @Get('evaluations/campaigns')
  campaigns(@Tenant() t: TenantInfo) { return this.evaluations.campaigns(t); }

  @Permission('evaluations.create')
  @Post('evaluations/campaigns')
  createCampaign(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.evaluations.createCampaign(t, parse(CampaignSchema, body)); }

  @Permission('evaluations.read') @AllowWhenReadOnly()
  @Get('evaluations/campaigns/:id')
  campaign(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.evaluations.campaign(t, id); }

  @Permission('evaluations.export') @AllowWhenReadOnly()
  @Get('evaluations/campaigns/:id/export')
  async export(@Tenant() t: TenantInfo, @Param('id') id: string, @Res() res: Response) {
    const rows = await this.evaluations.exportRows(t, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="evaluations-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  }

  @Permission('evaluations.update')
  @Patch('evaluations/campaigns/:id')
  updateCampaign(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.evaluations.updateCampaign(t, id, parse(z.object({
      name: z.string().trim().min(2).max(120).optional(), dueDate: isoDate.nullable().optional(), criteria: CriteriaSchema.optional(), status: z.enum(['open', 'closed']).optional(),
    }).strict(), body));
  }

  @Permission('evaluations.cancel')
  @Delete('evaluations/campaigns/:id')
  deleteCampaign(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.evaluations.deleteCampaign(t, id); }

  @Permission('evaluations.create')
  @Post('evaluations/campaigns/:id/employees')
  addEmployees(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ employeeIds: z.array(z.string().uuid()).min(1, { message: 'Choisissez au moins un employé' }).max(2000), evaluatorId: userId }).strict(), body);
    return this.evaluations.addEmployees(t, id, b.employeeIds, b.evaluatorId ?? null);
  }

  @Permission('evaluations.read') @AllowWhenReadOnly()
  @Get('evaluations')
  list(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.evaluations.forEmployee(t, parse(z.object({ employeeId: z.string().uuid({ message: "Choisissez l'employé" }) }), query).employeeId);
  }

  @Permission('evaluations.read') @AllowWhenReadOnly()
  @Get('evaluations/:id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.evaluations.get(t, id); }

  @Permission('evaluations.update')
  @Patch('evaluations/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.evaluations.update(t, id, parse(EvaluationSchema, body)); }

  @Permission('evaluations.update') @HttpCode(200)
  @Post('evaluations/:id/submit')
  submit(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.evaluations.submit(t, id); }

  @Permission('evaluations.validate') @HttpCode(200)
  @Post('evaluations/:id/decide')
  decide(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.evaluations.decide(t, id, parse(z.object({ approve: z.boolean(), note: text(1000), ...Money }).strict(), body));
  }

  @Permission('evaluations.validate') @HttpCode(200)
  @Post('evaluations/:id/reopen')
  reopen(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.evaluations.reopen(t, id); }

  @Permission('evaluations.cancel')
  @Delete('evaluations/:id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.evaluations.remove(t, id); }

  @Permission('evaluations.self') @AllowWhenReadOnly()
  @Get('me/evaluations')
  mine(@Tenant() t: TenantInfo) { return this.evaluations.mine(t); }
}
