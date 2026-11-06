import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, PlatformRoles } from '../../common/decorators';
import { AuthInfo, clientIp, KoraRequest } from '../../common/request-context';
import { email, parse } from '../../common/validation';
import { parseLogo } from '../companies/company-logo';
import { SetupService } from './setup.service';

const opt = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const CompanySchema = z.object({
  name: z.string().trim().min(2, { message: 'La raison sociale doit contenir au moins 2 caractères' }).max(160),
  legalForm: opt(40), rccm: opt(60), taxId: opt(40), taxRegime: opt(60), address: opt(300), city: opt(80), phone: opt(40),
  email: z.string().trim().toLowerCase().email({ message: 'Adresse e-mail invalide' }).nullable().optional().or(z.literal('').transform(() => null)),
}).strict();
const Plan = { planCode: z.string().trim().min(1).max(40), billingCycle: z.enum(['monthly', 'yearly']) };
const SiteSchema = z.object({ name: z.string().trim().min(2).max(80), city: opt(80), address: opt(300), phone: opt(40) }).strict();
const AccountSchema = z.object({ name: z.string().trim().min(2).max(80), bankName: opt(80), accountNumber: opt(60) }).strict();
const PeopleSchema = z.object({
  owner: z.object({ name: z.string().trim().min(2, { message: 'Indiquez le nom du propriétaire' }).max(120), email }).nullable(),
  users: z.array(z.object({ name: z.string().trim().min(2).max(120), email, roleKey: z.string().max(40), siteIds: z.array(z.string().uuid()).max(50).nullable() }).strict()).max(200),
  notes: z.string().trim().max(2000).transform((v) => v || null).nullable().optional(),
}).strict();

/**
 * Console : préparation d'une entreprise pour un client (fiche, formule, sites, trésorerie, utilisateurs),
 * puis remise au client. Réservée aux équipes commerciales de l'éditeur.
 */
@ApiTags('Console éditeur')
@Controller('platform/setup')
@PlatformRoles('super_admin', 'sales_admin')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  list() { return this.setup.list(); }

  @Post()
  create(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: KoraRequest) {
    return this.setup.create(auth, parse(CompanySchema.extend(Plan), body), clientIp(req));
  }

  @Get(':id')
  get(@Param('id') id: string) { return this.setup.get(id); }

  @Patch(':id/company')
  company(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown, @Req() req: KoraRequest) {
    return this.setup.updateCompany(auth, id, parse(CompanySchema.partial(), body), clientIp(req));
  }

  @Put(':id/logo')
  logo(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown, @Req() req: KoraRequest) {
    return this.setup.updateLogo(auth, id, parseLogo(body), clientIp(req));
  }

  @Patch(':id/subscription')
  subscription(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.setup.updateSubscription(auth, id, parse(z.object({ ...Plan, trialDays: z.number().int().min(0).max(90) }).partial().strict(), body));
  }

  @Post(':id/sites')
  addSite(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown, @Req() req: KoraRequest) {
    return this.setup.addSite(auth, id, parse(SiteSchema.extend({ withCash: z.boolean().default(true) }), body), clientIp(req));
  }

  @Patch(':id/sites/:siteId')
  updateSite(@Auth() auth: AuthInfo, @Param('id') id: string, @Param('siteId') siteId: string, @Body() body: unknown, @Req() req: KoraRequest) {
    return this.setup.updateSite(auth, id, siteId, parse(SiteSchema.partial(), body), clientIp(req));
  }

  @Post(':id/accounts')
  addAccount(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown, @Req() req: KoraRequest) {
    const input = parse(AccountSchema.extend({ kind: z.enum(['cash', 'bank', 'mobile_money'], { message: 'Type de compte : caisse, banque ou mobile money' }), siteId: z.string().uuid().nullable().optional() }), body);
    return this.setup.addAccount(auth, id, input, clientIp(req));
  }

  @Patch(':id/accounts/:accountId')
  updateAccount(@Auth() auth: AuthInfo, @Param('id') id: string, @Param('accountId') accountId: string, @Body() body: unknown, @Req() req: KoraRequest) {
    return this.setup.updateAccount(auth, id, accountId, parse(AccountSchema.partial(), body), clientIp(req));
  }

  @Put(':id/people')
  people(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.setup.setPeople(auth, id, parse(PeopleSchema, body));
  }

  @Post(':id/hand-over') @HttpCode(200)
  handOver(@Auth() auth: AuthInfo, @Param('id') id: string, @Req() req: KoraRequest) {
    return this.setup.handOver(auth, id, clientIp(req));
  }

  @Post(':id/resend-owner') @HttpCode(200)
  resendOwner(@Auth() auth: AuthInfo, @Param('id') id: string, @Req() req: KoraRequest) {
    return this.setup.resendOwner(auth, id, clientIp(req));
  }
}
