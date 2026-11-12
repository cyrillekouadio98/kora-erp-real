import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DashboardService } from './dashboard.service';

@ApiTags('Tableau de bord')
@Controller('company/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Séries mensuelles, palmarès et alertes ; chaque section suit les permissions de l'utilisateur. */
  @Permission(null) @AllowWhenReadOnly()
  @Get()
  get(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const { months } = parse(z.object({ months: z.coerce.number().int().refine((n) => [3, 6, 12].includes(n), { message: 'Période : 3, 6 ou 12 mois' }).default(12) }), query);
    return this.dashboard.build(t, months);
  }
}
