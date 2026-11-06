import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, paymentRequired } from '../../common/errors';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { ReportsService } from './reports.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date invalide (AAAA-MM-JJ)' });

/** Période demandée : du … au …, dans l'ordre, sur un an au plus. */
function period(query: unknown) {
  const f = parse(z.object({ from: isoDate, to: isoDate }).passthrough(), query);
  if (f.from > f.to) throw badRequest('La date de début est postérieure à la date de fin.', undefined, 'bad_period');
  if (Date.parse(f.to) - Date.parse(f.from) > 366 * 86_400_000) throw badRequest('Choisissez une période d’un an au plus.', undefined, 'period_too_long');
  return f;
}

@ApiTags('Rapports')
@Controller('company/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Rapport de gestion d'une période, comparé à la période précédente de même durée. */
  @Permission('reports.read') @AllowWhenReadOnly()
  @Get('management')
  management(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = period(query);
    return this.reports.build(t, f.from, f.to);
  }

  /** Stocks : valeur au début et à la fin, flux, rotation, couverture et détail par article. */
  @Permission('reports.read') @AllowWhenReadOnly()
  @Get('stock')
  stock(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = period(query);
    return this.reports.stock(t, f.from, f.to);
  }

  /** Clients : ventes par client, encaissements, encours, retards et délai de paiement. */
  @Permission('reports.read') @AllowWhenReadOnly()
  @Get('customers')
  customers(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = period(query);
    return this.reports.customers(t, f.from, f.to);
  }

  /** Trésorerie : vue d'ensemble ou un type de compte (caisse, banque, mobile money). */
  @Permission('reports.read') @AllowWhenReadOnly()
  @Get('treasury')
  treasury(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = period(query);
    const { kind } = parse(z.object({ kind: z.enum(['all', 'cash', 'bank', 'mobile_money']).default('all') }), query);
    if (!t.entitlements.modules.includes('cash')) throw paymentRequired("Le module Trésorerie n'est pas inclus dans votre formule.", 'module_not_in_plan', { module: 'cash' });
    if (kind === 'bank' && !t.entitlements.modules.includes('bank')) throw paymentRequired("Le module Banque n'est pas inclus dans votre formule.", 'module_not_in_plan', { module: 'bank' });
    return this.reports.treasury(t, f.from, f.to, kind === 'all' ? null : kind);
  }

  /** Fournisseurs : achats par fournisseur, règlements, dettes et échéancier (module Achats). */
  @Permission('reports.read') @AllowWhenReadOnly()
  @Get('suppliers')
  suppliers(@Tenant() t: TenantInfo, @Query() query: unknown) {
    if (!t.entitlements.modules.includes('purchases')) throw paymentRequired("Le module Achats n'est pas inclus dans votre formule.", 'module_not_in_plan', { module: 'purchases' });
    const f = period(query);
    return this.reports.suppliers(t, f.from, f.to);
  }
}
