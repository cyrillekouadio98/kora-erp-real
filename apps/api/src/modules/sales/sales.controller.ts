import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { toCsv } from '../exports/export.controller';
import { VAT_RATES } from './products.controller';
import { SalesService } from './sales.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date attendue au format AAAA-MM-JJ' });
const type = z.enum(['quote', 'invoice'], { message: 'Type de document : devis ou facture' });
const anyType = z.enum(['quote', 'invoice', 'credit_note'], { message: 'Type de document : devis, facture ou avoir' });

const LineSchema = z.object({
  productId: z.string().uuid({ message: 'Article invalide' }).nullable().optional(),
  description: z.string().trim().min(1, { message: 'Chaque ligne doit avoir une désignation' }).max(500),
  quantity: z.coerce.number().positive({ message: 'La quantité doit être positive' }).max(1e9).transform((v) => Math.round(v * 1000) / 1000),
  unit: z.string().trim().max(20).nullable().optional(),
  unitPrice: z.coerce.number().min(0, { message: 'Le prix ne peut pas être négatif' }).max(1e13).transform((v) => Math.round(v * 100) / 100),
  discountPct: z.coerce.number().min(0).max(100, { message: 'La remise ne peut pas dépasser 100 %' }).optional(),
  vatRate: z.coerce.number().refine((v) => VAT_RATES.includes(v), { message: 'Taux de TVA : 18 %, 9 % ou 0 %' }),
}).strict();

const DocSchema = z.object({
  contactId: z.string().min(1, { message: 'Choisissez un client' }),
  issueDate: isoDate.optional(),
  dueDate: isoDate.nullable().optional(),
  validUntil: isoDate.nullable().optional(),
  notes: z.string().trim().max(2000).transform((v) => v || null).nullable().optional(),
  lines: z.array(LineSchema).min(1, { message: 'Ajoutez au moins une ligne' }).max(200),
}).strict();

@ApiTags('Ventes')
@Controller('company/sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Permission('sales.read') @AllowWhenReadOnly()
  @Get('summary')
  summary(@Tenant() t: TenantInfo) { return this.sales.summary(t); }

  /** Créances clients par ancienneté (balance âgée), pour organiser les relances. */
  @Permission('sales.read') @AllowWhenReadOnly()
  @Get('receivables')
  receivables(@Tenant() t: TenantInfo) { return this.sales.receivables(t); }

  @Permission('sales.read') @AllowWhenReadOnly()
  @Get('documents')
  list(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.sales.list(t, parse(z.object({ type: anyType, status: z.string().max(20).optional(), q: z.string().trim().max(100).optional() }), query));
  }

  /** Journal des ventes au format CSV (point-virgule, UTF-8), ouvrable dans Excel. */
  @Permission('sales.export') @AllowWhenReadOnly()
  @Get('documents/export')
  async export(@Tenant() t: TenantInfo, @Query() query: unknown, @Res() res: Response) {
    const q = parse(z.object({ type: anyType }), query);
    const rows = await this.sales.exportRows(t, q.type);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${{ invoice: 'factures', quote: 'devis', credit_note: 'avoirs' }[q.type]}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  }

  @Permission('sales.read') @AllowWhenReadOnly()
  @Get('documents/:id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.sales.get(t, id); }

  @Permission('sales.create')
  @Post('documents')
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const { type: docType, ...rest } = parse(DocSchema.extend({ type }), body);
    return this.sales.create(t, docType, rest);
  }

  @Permission('sales.update')
  @Patch('documents/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.sales.update(t, id, parse(DocSchema.partial(), body)); }

  @Permission('sales.cancel')
  @Delete('documents/:id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.sales.remove(t, id); }

  @Permission('sales.validate') @HttpCode(200)
  @Post('documents/:id/validate')
  validate(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.sales.validate(t, id); }

  @Permission('sales.validate') @HttpCode(200)
  @Post('documents/:id/accept')
  accept(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.sales.decideQuote(t, id, true); }

  @Permission('sales.validate') @HttpCode(200)
  @Post('documents/:id/refuse')
  refuse(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.sales.decideQuote(t, id, false); }

  @Permission('sales.create') @HttpCode(200)
  @Post('documents/:id/convert')
  convert(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.sales.convert(t, id); }

  /** Avoir sur une facture émise : brouillon reprenant ses lignes, à valider ensuite. */
  @Permission('sales.create') @HttpCode(200)
  @Post('documents/:id/credit-note')
  creditNote(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.sales.createCreditNote(t, id); }

  @Permission('sales.update')
  @Post('documents/:id/reminders')
  remind(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.sales.addReminder(t, id, parse(z.object({
      channel: z.enum(['phone', 'whatsapp', 'sms', 'email', 'letter', 'visit'], { message: 'Moyen de relance invalide' }),
      note: z.string().trim().max(1000).transform((v) => v || null).nullable().optional(),
      promisedOn: isoDate.nullable().optional(),
    }).strict(), body));
  }

  /** Encaissement d'une facture : réservé aux personnes autorisées à saisir en caisse. */
  @Permission('cash.create')
  @Post('documents/:id/payments')
  pay(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.sales.addPayment(t, id, parse(z.object({
      amount: z.coerce.number().positive({ message: 'Le montant doit être positif' }).max(1e13).transform((v) => Math.round(v)),
      paidOn: isoDate.optional(),
      method: z.enum(['cash', 'mobile_money', 'bank_transfer', 'cheque', 'card'], { message: 'Mode de paiement invalide' }),
      reference: z.string().trim().max(100).transform((v) => v || null).nullable().optional(),
    }).strict(), body));
  }
}
