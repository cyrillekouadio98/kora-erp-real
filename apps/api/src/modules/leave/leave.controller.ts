import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { isoDate } from '../sales/sales.controller';
import { LeaveService } from './leave.service';

const type = z.enum(['annual', 'sick', 'maternity', 'family_event', 'unpaid', 'other'], { message: 'Type de congé invalide' });
const RequestSchema = z.object({
  type, startDate: isoDate, endDate: isoDate,
  reason: z.string().trim().max(500).transform((v) => v || null).nullable().optional(),
}).strict();
const note = z.object({ note: z.string().trim().max(500).transform((v) => v || null).nullable().optional() }).strict();

@ApiTags('Congés et espace employé')
@Controller('company')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  // ------------------------------------------------------------------ responsables
  @Permission('leave.read') @AllowWhenReadOnly()
  @Get('leave')
  list(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.leave.list(t, parse(z.object({ status: z.enum(['pending', 'approved', 'refused', 'cancelled']).optional(), employeeId: z.string().uuid().optional(),
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }), query));
  }

  @Permission('leave.read') @AllowWhenReadOnly()
  @Get('leave/balances')
  balances(@Tenant() t: TenantInfo) { return this.leave.balances(t); }

  /** Report du solde de congés au démarrage dans Kora (jours encore dus à l'employé). */
  @Permission('leave.admin')
  @Patch('leave/balances/:employeeId')
  setOpening(@Tenant() t: TenantInfo, @Param('employeeId') employeeId: string, @Body() body: unknown) {
    return this.leave.setOpening(t, employeeId, parse(z.object({ balance: z.coerce.number().min(0).max(365), date: isoDate.nullable().optional() }).strict(), body));
  }

  @Permission('leave.create')
  @Post('leave')
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(RequestSchema.extend({ employeeId: z.string().uuid({ message: 'Choisissez un employé' }) }), body);
    return this.leave.request(t, input, false);
  }

  @Permission('leave.validate') @HttpCode(200)
  @Post('leave/:id/approve')
  approve(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.leave.decide(t, id, true, parse(note, body ?? {}).note); }

  @Permission('leave.validate') @HttpCode(200)
  @Post('leave/:id/refuse')
  refuse(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.leave.decide(t, id, false, parse(note, body ?? {}).note); }

  @Permission('leave.cancel') @HttpCode(200)
  @Post('leave/:id/cancel')
  cancel(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.leave.cancel(t, id, false); }

  // ------------------------------------------------------------------ espace employé
  @Permission('employees.self') @AllowWhenReadOnly()
  @Get('me')
  me(@Tenant() t: TenantInfo) { return this.leave.mySpace(t); }

  @Permission('leave.self')
  @Post('me/leave')
  myRequest(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.leave.request(t, parse(RequestSchema, body), true); }

  @Permission('leave.self') @HttpCode(200)
  @Post('me/leave/:id/cancel')
  myCancel(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.leave.cancel(t, id, true); }

  @Permission('payroll.self') @AllowWhenReadOnly()
  @Get('me/payslips')
  myPayslips(@Tenant() t: TenantInfo) { return this.leave.myPayslips(t); }

  @Permission('payroll.self') @AllowWhenReadOnly()
  @Get('me/payslips/:id')
  myPayslip(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.leave.myPayslip(t, id); }
}
