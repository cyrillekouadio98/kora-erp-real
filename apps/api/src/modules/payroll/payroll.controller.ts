import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { isoDate } from '../sales/sales.controller';
import { PayrollInsightsService, SETTLEMENT_REASONS, SettlementReason } from './payroll-insights.service';
import { PayrollService } from './payroll.service';

const money = z.coerce.number().min(0, { message: 'Le montant ne peut pas être négatif' }).max(1e12).transform((v) => Math.round(v));
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const EmployeeSchema = z.object({
  firstName: z.string().trim().min(1, { message: 'Indiquez le prénom' }).max(80),
  lastName: z.string().trim().min(1, { message: 'Indiquez le nom' }).max(80),
  jobTitle: text(120), department: text(80), hireDate: isoDate, endDate: isoDate.nullable().optional(),
  contractType: z.enum(['cdi', 'cdd', 'stage', 'journalier']).optional(), cnpsNumber: text(40),
  maritalStatus: z.enum(['single', 'married', 'divorced', 'widowed']).optional(),
  children: z.coerce.number().int().min(0).max(20).optional(),
  partsOverride: z.coerce.number().min(1).max(5).multipleOf(0.5).nullable().optional(),
  baseSalary: money.optional(), housingAllowance: money.optional(), transportAllowance: money.optional(), otherAllowances: money.optional(),
  category: text(20), targetNet: money.nullable().optional(), extraSalary: money.optional(),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'mobile_money']).optional(), bankDetails: text(80), phone: text(40),
  email: z.string().trim().toLowerCase().email({ message: 'Adresse e-mail invalide' }).nullable().optional().or(z.literal('').transform(() => null)),
}).strict();
const InputsSchema = z.object({
  overtime: money.optional(), bonus: money.optional(), advanceDeduction: money.optional(), otherDeduction: money.optional(),
  absenceDays: z.coerce.number().min(0).max(31).optional(),
}).strict();
const rate = z.coerce.number().min(0).max(100);
const SettingsSchema = z.object({
  itsBrackets: z.array(z.tuple([z.number().positive().nullable(), rate])).min(1).max(12).optional(),
  itsFamilyReduction: z.record(z.string().regex(/^[1-5](\.5)?$/), z.number().min(0)).optional(),
  cnpsEmployeeRate: rate.optional(), cnpsEmployerRate: rate.optional(), cnpsCeiling: money.optional(),
  familyBenefitsRate: rate.optional(), workAccidentRate: rate.optional(), smallBenefitsCeiling: money.optional(),
  cmuPerPerson: money.optional(), cmuEmployerShare: money.optional(), employerTaxRate: rate.optional(), apprenticeshipTaxRate: rate.optional(),
  trainingTaxRate: rate.optional(), transportExemptCap: money.optional(), workingDays: z.coerce.number().int().min(20).max(31).optional(),
  leaveDaysPerMonth: z.coerce.number().min(0).max(5).optional(), smig: money.optional(),
  categories: z.array(z.object({ code: z.string().trim().min(1).max(20), label: z.string().trim().min(1).max(80), minSalary: money }).strict()).max(40)
    .refine((l) => new Set(l.map((c) => c.code)).size === l.length, { message: 'Deux catégories ont le même code' }).optional(),
}).strict();
const NetToGrossSchema = z.object({
  targetNet: z.coerce.number().positive({ message: 'Indiquez le net à payer' }).max(1e10).transform((v) => Math.round(v)),
  category: text(20), housingAllowance: money.default(0), transportAllowance: money.default(0), otherAllowances: money.default(0),
  maritalStatus: z.enum(['single', 'married', 'divorced', 'widowed']).default('single'), children: z.coerce.number().int().min(0).max(20).default(0),
  partsOverride: z.coerce.number().min(1).max(5).multipleOf(0.5).nullable().optional(),
}).strict();

@ApiTags('Employés et paie')
@Controller('company')
export class PayrollController {
  constructor(private readonly payroll: PayrollService, private readonly insights: PayrollInsightsService) {}

  @Permission('employees.read') @AllowWhenReadOnly()
  @Get('employees')
  employees(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(z.object({ includeLeft: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional() }), query);
    return this.payroll.employees(t, { includeLeft: q.includeLeft === 'true', q: q.q });
  }

  @Permission('employees.read') @AllowWhenReadOnly()
  @Get('employees/:id')
  employee(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.payroll.getEmployee(t, id); }

  @Permission('employees.create')
  @Post('employees')
  createEmployee(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.payroll.createEmployee(t, parse(EmployeeSchema, body)); }

  @Permission('employees.update')
  @Patch('employees/:id')
  updateEmployee(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.payroll.updateEmployee(t, id, parse(EmployeeSchema.partial(), body)); }

  /** Calcul du brut à partir du net : ne modifie rien, renvoie le bulletin simulé. */
  @Permission('employees.read') @AllowWhenReadOnly() @HttpCode(200)
  @Post('payroll/net-to-gross')
  netToGross(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.payroll.netToGross(t, parse(NetToGrossSchema, body)); }

  // ------------------------------------------------------------------ pilotage de la paie
  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/dashboard')
  dashboard(@Tenant() t: TenantInfo) { return this.insights.dashboard(t); }

  /** Notes partagées de l'équipe paie (onglets du tableau de bord). */
  @Permission('payroll.update')
  @Put('payroll/notes')
  saveNotes(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.insights.saveNotes(t, parse(z.object({ notes: z.array(z.object({
      id: z.string().max(40).optional(), title: z.string().trim().min(1, { message: 'Donnez un titre à la note' }).max(40), body: z.string().max(5000),
    }).strict()).max(10) }).strict(), body).notes);
  }

  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/contracts')
  contracts(@Tenant() t: TenantInfo) { return this.insights.contracts(t); }

  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/work-entries')
  workEntries(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.insights.workEntries(t, parse(z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Période au format AAAA-MM' }) }), query).period); }

  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/payslips')
  payslips(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.insights.payslips(t, parse(z.object({ from: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Période au format AAAA-MM' }).optional(), to: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Période au format AAAA-MM' }).optional(), employeeId: z.string().uuid().optional() }), query));
  }

  /** Solde de tout compte : calcul indicatif, rien n'est enregistré. */
  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/final-settlement')
  finalSettlement(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.insights.finalSettlement(t, parse(z.object({
      employeeId: z.string().uuid({ message: "Choisissez l'employé" }), endDate: isoDate,
      reason: z.enum(Object.keys(SETTLEMENT_REASONS) as [SettlementReason, ...SettlementReason[]]), noticeMonths: z.coerce.number().min(0).max(12).optional(), leaveDays: z.coerce.number().min(0).max(400).optional(),
    }), query));
  }

  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/settings')
  settings(@Tenant() t: TenantInfo) { return this.payroll.getSettings(t); }

  @Permission('payroll.admin')
  @Patch('payroll/settings')
  updateSettings(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.payroll.updateSettings(t, parse(SettingsSchema, body)); }

  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/runs')
  runs(@Tenant() t: TenantInfo) { return this.payroll.runs(t); }

  @Permission('payroll.create')
  @Post('payroll/runs')
  createRun(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.payroll.createRun(t, parse(z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Période au format AAAA-MM' }) }).strict(), body).period);
  }

  @Permission('payroll.read') @AllowWhenReadOnly()
  @Get('payroll/runs/:id')
  run(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.payroll.getRun(t, id); }

  @Permission('payroll.cancel')
  @Delete('payroll/runs/:id')
  deleteRun(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.payroll.deleteRun(t, id); }

  @Permission('payroll.update') @HttpCode(200)
  @Post('payroll/runs/:id/recompute')
  recompute(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.payroll.recompute(t, id); }

  @Permission('payroll.update')
  @Patch('payroll/runs/:id/payslips/:payslipId')
  updatePayslip(@Tenant() t: TenantInfo, @Param('id') id: string, @Param('payslipId') payslipId: string, @Body() body: unknown) {
    return this.payroll.updatePayslip(t, id, payslipId, parse(InputsSchema, body));
  }

  @Permission('payroll.validate') @HttpCode(200)
  @Post('payroll/runs/:id/validate')
  validate(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.payroll.validate(t, id); }

  /** Paiement des salaires nets depuis un compte de trésorerie. */
  @Permission('payroll.validate') @HttpCode(200)
  @Post('payroll/runs/:id/pay')
  pay(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.payroll.pay(t, id, parse(z.object({ accountId: z.string().uuid({ message: 'Choisissez le compte de paiement' }), date: isoDate.optional(), payslipIds: z.array(z.string().uuid()).max(1000).optional() }).strict(), body));
  }
}
