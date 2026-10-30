import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { toCsv } from '../exports/export.controller';
import { isoDate } from '../sales/sales.controller';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, TreasuryService } from './treasury.service';

const amount = z.coerce.number().positive({ message: 'Le montant doit être positif' }).max(1e13).transform((v) => Math.round(v));
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const AccountSchema = z.object({
  kind: z.enum(['cash', 'bank', 'mobile_money'], { message: 'Type de compte : caisse, banque ou mobile money' }),
  name: z.string().trim().min(2, { message: 'Le nom doit contenir au moins 2 caractères' }).max(80),
  bankName: text(80), accountNumber: text(60),
  openingBalance: z.coerce.number().min(-1e13).max(1e13).transform((v) => Math.round(v)).optional(),
  openingDate: isoDate.optional(),
}).strict();
const MovementsQuery = z.object({
  accountId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional(), category: z.string().max(40).optional(), q: z.string().trim().max(100).optional(),
});

@ApiTags('Trésorerie')
@Controller('company/treasury')
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Permission('cash.read') @AllowWhenReadOnly()
  @Get('summary')
  summary(@Tenant() t: TenantInfo) { return this.treasury.summary(t); }

  @Permission('cash.read') @AllowWhenReadOnly()
  @Get('accounts')
  accounts(@Tenant() t: TenantInfo, @Query('archived') archived?: string) { return this.treasury.accounts(t, archived === 'true'); }

  @Permission('cash.admin')
  @Post('accounts')
  createAccount(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.treasury.createAccount(t, parse(AccountSchema, body));
  }

  @Permission('cash.admin')
  @Patch('accounts/:id')
  updateAccount(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.treasury.updateAccount(t, id, parse(AccountSchema.omit({ kind: true }).partial(), body));
  }

  @Permission('cash.admin') @HttpCode(200)
  @Post('accounts/:id/archive')
  archive(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.treasury.setArchived(t, id, true); }

  @Permission('cash.admin') @HttpCode(200)
  @Post('accounts/:id/restore')
  restore(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.treasury.setArchived(t, id, false); }

  /** Arrêté de caisse : comptage physique des espèces. */
  @Permission('cash.validate') @HttpCode(200)
  @Post('accounts/:id/count')
  count(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.treasury.cashCount(t, id, parse(z.object({
      counted: z.coerce.number().min(0, { message: 'Le montant compté ne peut pas être négatif' }).max(1e13).transform((v) => Math.round(v)), note: text(300),
    }).strict(), body));
  }

  @Permission('cash.read') @AllowWhenReadOnly()
  @Get('movements')
  movements(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.treasury.movements(t, parse(MovementsQuery, query)); }

  /** Journal de trésorerie au format CSV (point-virgule, UTF-8). */
  @Permission('cash.export') @AllowWhenReadOnly()
  @Get('movements/export')
  async export(@Tenant() t: TenantInfo, @Query() query: unknown, @Res() res: Response) {
    const r = await this.treasury.movements(t, parse(MovementsQuery, query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tresorerie-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv([...r.movements].reverse().map((m: any) => ({
      date: m.date, compte: m.accountName, libelle: m.label, categorie: m.category, tiers: m.contactName, reference: m.reference,
      entree: m.direction === 'in' ? m.amount : '', sortie: m.direction === 'out' ? m.amount : '', ...(m.balanceAfter !== undefined ? { solde: m.balanceAfter } : {}),
    }))));
  }

  /** Dépense ou recette courante (loyer, CIE, SODECI, carburant, apport…). */
  @Permission('cash.create')
  @Post('movements')
  addManual(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.treasury.addManual(t, parse(z.object({
      kind: z.enum(['expense', 'income']),
      accountId: z.string().min(1, { message: 'Choisissez un compte' }),
      date: isoDate.optional(), amount,
      category: z.enum([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES] as [string, ...string[]], { message: 'Catégorie inconnue' }),
      label: z.string().trim().min(2, { message: 'Indiquez un libellé' }).max(200),
      contactId: z.string().nullable().optional(), reference: text(100),
    }).strict(), body));
  }

  @Permission('cash.create')
  @Post('transfers')
  transfer(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.treasury.transfer(t, parse(z.object({
      fromAccountId: z.string().min(1), toAccountId: z.string().min(1), amount, date: isoDate.optional(), label: text(200), reference: text(100),
    }).strict(), body));
  }

  @Permission('cash.cancel') @HttpCode(200)
  @Post('movements/:id/reverse')
  reverse(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, { message: 'Indiquez le motif de la contre-passation' }).max(200) }).strict(), body);
    return this.treasury.reverse(t, id, reason);
  }
}
