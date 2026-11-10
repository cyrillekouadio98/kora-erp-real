import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { badRequest } from '../../common/errors';
import { parse } from '../../common/validation';
import { toCsv } from '../exports/export.controller';
import { isoDate } from '../sales/sales.controller';
import { AccountingService } from './accounting.service';
import { BalancesService } from './balances.service';
import { FinancialService } from './financial.service';
import { FormationService, LEGAL_FORMS, STEPS } from './formation.service';

// Numéros sur 6 chiffres ; un numéro plus court est complété par des zéros (411 → 411000).
const accountCode = z.string().trim().regex(/^[1-9][0-9]{1,5}$/, { message: 'Numéro de compte invalide : 6 chiffres au plus' }).transform((c) => c.padEnd(6, '0'));
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
  constructor(private readonly accounting: AccountingService, private readonly financial: FinancialService, private readonly balances: BalancesService, private readonly formation: FormationService) {}

  /** Fiche de constitution de la société et aperçu des écritures de chaque étape. */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('formation')
  getFormation(@Tenant() t: TenantInfo) { return this.formation.get(t); }

  @Permission('accounting.create')
  @Put('formation')
  saveFormation(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const amount = z.coerce.number().min(0).max(1e13);
    return this.formation.save(t, parse(z.object({
      legalForm: z.enum(LEGAL_FORMS), date: isoDate, capital: z.coerce.number().positive({ message: 'Indiquez le capital' }).max(1e13),
      nature: z.array(z.object({ account: accountCode, label: z.string().trim().max(200).default(''), amount: amount.positive({ message: 'Montant de l’apport en nature' }) }).strict()).max(50).default([]),
      cashPaid: amount.default(0), deposit: z.enum(['bank', 'notary']).default('bank'), bankAccountId: z.string().uuid().nullable().optional(),
    }).strict(), body));
  }

  /** Passe une étape : ses écritures d'OD sont validées, ses versements et frais passent en trésorerie (journal TR). */
  @Permission('accounting.validate') @HttpCode(200)
  @Post('formation/steps/:key')
  passFormationStep(@Tenant() t: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    const step = parse(z.enum(STEPS), key);
    return this.formation.pass(t, step, parse(z.object({
      date: isoDate, amount: z.coerce.number().positive().max(1e13).optional(), accountId: z.string().uuid().nullable().optional(),
      fees: z.array(z.object({ account: accountCode, label: z.string().trim().min(2, { message: 'Libellé du frais' }).max(200), amount: z.coerce.number().min(0).max(1e13) }).strict()).max(30).optional(),
    }).strict(), body ?? {}));
  }

  @Permission('accounting.reverse') @HttpCode(200)
  @Post('formation/steps/:id/cancel')
  cancelFormationStep(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.formation.cancel(t, id); }

  /** Bilan à une date (présentation simplifiée du système normal SYSCOHADA). */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('balance-sheet')
  balanceSheet(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.financial.balanceSheet(t, parse(z.object({ date: isoDate }), query).date); }

  /** Soldes significatifs de gestion : marge commerciale, valeur ajoutée, EBE, résultats. */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('management-balances')
  managementBalances(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.financial.managementBalances(t, parse(z.object({ from: isoDate, to: isoDate }), query)); }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('fiscal-years')
  years(@Tenant() t: TenantInfo) { return this.financial.years(t); }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('fiscal-years/:year/checklist')
  checklist(@Tenant() t: TenantInfo, @Param('year') year: string) { this.financial.assertYear(Number(year)); return this.financial.checklist(t, Number(year)); }

  /** Clôture d'exercice : détermination du résultat et verrouillage, irréversibles. */
  @Permission('accounting.close') @HttpCode(200)
  @Post('fiscal-years/:year/close')
  close(@Tenant() t: TenantInfo, @Param('year') year: string, @Body() body: unknown) {
    this.financial.assertYear(Number(year));
    return this.financial.close(t, Number(year), parse(z.object({ acknowledgeWarnings: z.boolean().default(false) }).strict(), body ?? {}).acknowledgeWarnings);
  }

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

  /** Remise en brouillon d'une écriture validée (contre-passation automatique et copie en brouillon). */
  @Permission('accounting.reverse') @HttpCode(200)
  @Post('entries/:id/reset-to-draft')
  resetToDraft(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.accounting.resetToDraft(t, id); }

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

  /** Grand livre complet : tous les comptes de la période, pour l'impression. */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('general-ledger')
  generalLedger(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.accounting.generalLedger(t, parse(Period, query)); }

  /** Grand livre auxiliaire : état de chaque client ou fournisseur. */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('third-party-ledger')
  thirdPartyLedger(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.accounting.thirdPartyLedger(t, parse(Period.extend({ kind: z.enum(['customer', 'supplier']), contactId: z.string().uuid().optional() }), query));
  }

  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('trial-balance')
  trialBalance(@Tenant() t: TenantInfo, @Query() query: unknown) { return this.accounting.trialBalance(t, parse(Period, query)); }

  /**
   * Balance des comptes (4, 6, 8 colonnes ou développée) : mouvements antérieurs, de la période, soldes de la période et cumulés,
   * et, si compareTo est donné, le solde de la période comparée. accountFrom / accountTo limitent la plage de comptes.
   */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('account-balance')
  accountBalance(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const code = z.string().trim().regex(/^\d{1,6}$/, { message: 'Numéro de compte invalide' }).optional();
    return this.balances.accountBalance(t, parse(Period.extend({
      accountFrom: code, accountTo: code, compareFrom: isoDate.optional(), compareTo: isoDate.optional(),
      withClosing: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
    }), query));
  }

  /** Balance des tiers : un solde par tiers et par compte collectif. */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('third-party-balance')
  thirdPartyBalance(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.balances.thirdPartyBalance(t, parse(Period.extend({ kind: z.enum(['all', 'customer', 'supplier']).default('all') }), query));
  }

  /** Balance âgée des clients ou des fournisseurs à une date, par tranches de retard (30, 45, 60 jours par défaut). */
  @Permission('accounting.read') @AllowWhenReadOnly()
  @Get('aged-balance')
  agedBalance(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(z.object({
      date: isoDate.optional(), kind: z.enum(['customer', 'supplier']).default('customer'),
      steps: z.string().regex(/^\d{1,3}(,\d{1,3}){0,5}$/, { message: 'Tranches attendues sous la forme 30,45,60' }).default('30,45,60'),
    }), query);
    const steps = [...new Set(q.steps.split(',').map(Number).filter((n) => n > 0))];
    if (!steps.length) throw badRequest('Indiquez au moins une tranche.', undefined, 'invalid_steps');
    return this.balances.agedBalance(t, { date: q.date ?? new Date().toISOString().slice(0, 10), kind: q.kind, steps });
  }

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
