import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { toCsv } from '../exports/export.controller';
import { isoDate, LineSchema, PaymentSchema } from '../sales/sales.controller';
import { PurchasesService } from './purchases.service';

const type = z.enum(['order', 'invoice'], { message: 'Type de document : bon de commande ou facture fournisseur' });

const DocSchema = z.object({
  contactId: z.string().min(1, { message: 'Choisissez un fournisseur' }),
  supplierRef: z.string().trim().max(60).transform((v) => v || null).nullable().optional(),
  issueDate: isoDate.optional(),
  dueDate: isoDate.nullable().optional(),
  expectedDate: isoDate.nullable().optional(),
  notes: z.string().trim().max(2000).transform((v) => v || null).nullable().optional(),
  lines: z.array(LineSchema).min(1, { message: 'Ajoutez au moins une ligne' }).max(200),
}).strict();

@ApiTags('Achats')
@Controller('company/purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Permission('purchases.read') @AllowWhenReadOnly()
  @Get('summary')
  summary(@Tenant() t: TenantInfo) { return this.purchases.summary(t); }

  /** Dettes fournisseurs par ancienneté et échéancier des paiements à venir. */
  @Permission('purchases.read') @AllowWhenReadOnly()
  @Get('payables')
  payables(@Tenant() t: TenantInfo) { return this.purchases.payables(t); }

  @Permission('purchases.read') @AllowWhenReadOnly()
  @Get('documents')
  list(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.purchases.list(t, parse(z.object({ type, status: z.string().max(20).optional(), q: z.string().trim().max(100).optional() }), query));
  }

  @Permission('purchases.export') @AllowWhenReadOnly()
  @Get('documents/export')
  async export(@Tenant() t: TenantInfo, @Query() query: unknown, @Res() res: Response) {
    const q = parse(z.object({ type }), query);
    const rows = await this.purchases.exportRows(t, q.type);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${q.type === 'invoice' ? 'factures-fournisseurs' : 'bons-de-commande'}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  }

  @Permission('purchases.read') @AllowWhenReadOnly()
  @Get('documents/:id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.purchases.get(t, id); }

  @Permission('purchases.create')
  @Post('documents')
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const { type: docType, ...rest } = parse(DocSchema.extend({ type }), body);
    return this.purchases.create(t, docType, rest);
  }

  @Permission('purchases.update')
  @Patch('documents/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.purchases.update(t, id, parse(DocSchema.partial(), body)); }

  @Permission('purchases.cancel')
  @Delete('documents/:id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.purchases.remove(t, id); }

  @Permission('purchases.validate') @HttpCode(200)
  @Post('documents/:id/validate')
  validate(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.purchases.validate(t, id); }

  @Permission('purchases.cancel') @HttpCode(200)
  @Post('documents/:id/cancel')
  cancel(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.purchases.cancelOrder(t, id); }

  @Permission('purchases.create') @HttpCode(200)
  @Post('documents/:id/convert')
  convert(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.purchases.convert(t, id); }

  /** Règlement d'une facture fournisseur (décaissement). */
  @Permission('cash.create')
  @Post('documents/:id/payments')
  pay(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.purchases.addPayment(t, id, parse(PaymentSchema, body));
  }
}
