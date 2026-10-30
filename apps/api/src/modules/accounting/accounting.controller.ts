import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { toCsv } from '../exports/export.controller';
import { isoDate } from '../sales/sales.controller';
import { AccountingService } from './accounting.service';

const accountCode = z.string().trim().regex(/^[1-9][0-9]{1,9}$/, { message: 'Numéro de compte invalide (chiffres uniquement)' });
const LineSchema = z.object({
  account: accountCode,
  contactId: z.string().uuid().nullable().optional(),
  label: z.string().trim().min(1, { message: 'Chaque ligne doit avoir un libellé' }).max(200),
  debit: z.coerce.number().min(0).max(1e13).optional(),
  credit: z.coerce.number().min(0).max(1e13).optional(),
}).strict().refine((l) => !((l.debit ?? 0) > 0 && (l.credit ?? 0) > 0), { message: 'Une ligne est soit au débit, soit au crédit' });
const EntrySchema = z.object({
  journal: z.enum(['OD', 'AN']).default('OD'),
  date: isoDate,
  label: z.string().trim().min(2, { message: "Indiquez le libellé de l'écriture" }).max(200),
  reference: z.string().trim().max(60).transform((v) => v || null).nullable().optional(),
  lines: z.array(LineSchema).min(2, { message: 'Une écriture comporte au moins deux lignes' }).max(200),
}).strict();
const Period = z.object({ from: isoDate.optional(), to: isoDate.optional() });

@ApiTags('Comptabilité')
@Controller('company/accounting')
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('status')
  status(@Tenant() t: TenantInfo) { return this.accounting.status(t); }

  /** Comptabilise les opérations validées qui n'ont pas encore d'écriture (historique). */
  @Permission('accounting.admin') @HttpCode(200)
  @Post('sync')
  sync(@Tenant() t: TenantInfo) { return this.accounting.sync(t); }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('accounts')
  accounts(@Tenant() t: TenantInfo) { return this.accounting.accounts(t); }

  @Permission('accounting.admin')
  @Post('accounts')
  addAccount(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.accounting.addAccount(t, parse(z.object({ code: accountCode, name: z.string().trim().min(2).max(120) }).strict(), body));
  }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('entries')
  entries(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.accounting.entries(t, parse(Period.extend({ journal: z.string().max(4).optional(), q: z.string().trim().max(100).optional(), status: z.enum(['draft', 'posted']).optional() }), query));
  }

  /** Écritures validées au format CSV (colonnes du fichier des écritures comptables). */
  @Permission('accounting.export') @AllowWhenReadOnly()
  @Get('entries/export')
  async export(@Tenant() t: TenantInfo, @Query() query: unknown, @Res() res: Response) {
    const rows = await this.accounting.exportRows(t, parse(Period, query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ecritures-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('entries/:id')
  entry(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.accounting.getEntry(t, id); }

  @Permission('accounting.create')
  @Post('entries')
  create(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.accounting.createManual(t, parse(EntrySchema, body)); }

  @Permission('accounting.update')
  @Patch('entries/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.accounting.updateManual(t, id, parse(EntrySchema.omit({ journal: true }).partial(), body));
  }

  @Permission('accounting.cancel')
  @Delete('entries/:id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.accounting.deleteManual(t, id); }

  @Permission('accounting.validate') @HttpCode(200)
  @Post('entries/:id/post')
  post(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.accounting.postManual(t, id); }

  @Permission('accounting.reverse') @HttpCode(200)
  @Post('entries/:id/reverse')
  reverse(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.accounting.reverse(t, id, parse(z.object({ date: isoDate.optional(), reason: z.string().trim().min(3, { message: 'Indiquez le motif' }).max(200) }).strict(), body));
  }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('ledger')
  ledger(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.accounting.ledger(t, parse(Period.extend({ account: accountCode, contactId: z.string().uuid().optional() }), query));
  }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('trial-balance')
  trialBalance(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.accounting.trialBalance(t, parse(Period, query)); }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('vat')
  vat(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.accounting.vat(t, parse(z.object({ from: isoDate, to: isoDate }), query)); }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('income-statement')
  incomeStatement(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.accounting.incomeStatement(t, parse(Period, query)); }

  /** Clôture de période : réservée aux personnes disposant de la permission sensible « clôturer ». */
  @Permission('accounting.close') @HttpCode(200)
  @Post('lock')
  lock(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.accounting.lock(t, parse(z.object({ until: isoDate }).strict(), body).until); }
}
