import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { isoDate, LineSchema } from '../sales/sales.controller';
import { PosService } from './pos.service';

const amount = z.coerce.number().min(0, { message: 'Le montant ne peut pas être négatif' }).max(1e13).transform((v) => Math.round(v));
const uuid = (msg: string) => z.string().uuid({ message: msg });
const RegisterSchema = z.object({
  name: z.string().trim().min(2, { message: 'Le nom de la caisse doit contenir au moins 2 caractères' }).max(60),
  siteId: uuid('Site introuvable').nullable().optional(),
  warehouseId: uuid('Entrepôt introuvable').nullable().optional(),
  cashAccountId: uuid('Compte de caisse introuvable').nullable().optional(),
}).strict();
const SaleSchema = z.object({
  contactId: uuid('Client introuvable').nullable().optional(),
  lines: z.array(LineSchema).min(1, { message: 'Le ticket est vide' }).max(300),
  payments: z.array(z.object({
    method: z.enum(['cash', 'mobile_money', 'card'], { message: 'Mode de paiement : espèces, mobile money ou carte' }),
    amount, reference: z.string().trim().max(100).transform((v) => v || null).nullable().optional(),
  }).strict()).min(1, { message: 'Indiquez le paiement' }).max(5),
}).strict();

@ApiTags('Point de vente')
@Controller('company/pos')
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Permission('pos.read') @AllowWhenReadOnly()
  @Get('registers')
  registers(@Tenant() t: TenantInfo, @Query('archived') archived?: string) { return this.pos.registers(t, archived === 'true'); }

  @Permission('pos.admin')
  @Post('registers')
  createRegister(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.pos.createRegister(t, parse(RegisterSchema, body)); }

  @Permission('pos.admin')
  @Patch('registers/:id')
  updateRegister(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.pos.updateRegister(t, id, parse(RegisterSchema.partial().extend({ archived: z.boolean().optional() }).strict(), body));
  }

  @Permission('pos.create') @AllowWhenReadOnly()
  @Get('registers/:id/catalog')
  catalog(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.pos.catalog(t, id); }

  @Permission('pos.create')
  @Post('registers/:id/open')
  open(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.pos.openSession(t, id, parse(z.object({ openingFloat: amount.default(0) }).strict(), body ?? {}));
  }

  @Permission('pos.read') @AllowWhenReadOnly()
  @Get('sessions')
  sessions(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.pos.sessions(t, parse(z.object({ registerId: uuid('Caisse introuvable').optional(), status: z.enum(['open', 'closed']).optional() }), query));
  }

  @Permission('pos.read') @AllowWhenReadOnly()
  @Get('sessions/:id/report')
  report(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.pos.sessionReport(t, id); }

  @Permission('pos.create') @HttpCode(200)
  @Post('sessions/:id/close')
  close(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.pos.closeSession(t, id, parse(z.object({ countedCash: amount, note: z.string().trim().max(300).transform((v) => v || null).nullable().optional() }).strict(), body));
  }

  @Permission('pos.create')
  @Post('sessions/:id/tickets')
  sell(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.pos.sell(t, id, parse(SaleSchema, body)); }

  @Permission('pos.read') @AllowWhenReadOnly()
  @Get('tickets')
  tickets(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.pos.tickets(t, parse(z.object({ sessionId: uuid('Session introuvable').optional(), q: z.string().trim().max(100).optional(), date: isoDate.optional() }), query));
  }

  @Permission('pos.read') @AllowWhenReadOnly()
  @Get('tickets/:id')
  ticket(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.pos.ticket(t, id); }
}
