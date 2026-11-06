import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest } from '../../common/errors';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { ReportsService } from './reports.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date invalide (AAAA-MM-JJ)' });

@ApiTags('Rapports')
@Controller('company/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Rapport de gestion d'une période (366 jours au plus), comparé à la période précédente de même durée. */
  @Permission('reports.read') @AllowWhenReadOnly()
  @Get('management')
  management(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = parse(z.object({ from: isoDate, to: isoDate }), query);
    if (f.from > f.to) throw badRequest('La date de début est postérieure à la date de fin.', undefined, 'bad_period');
    if (Date.parse(f.to) - Date.parse(f.from) > 366 * 86_400_000) throw badRequest('Choisissez une période d’un an au plus.', undefined, 'period_too_long');
    return this.reports.build(t, f.from, f.to);
  }
}
