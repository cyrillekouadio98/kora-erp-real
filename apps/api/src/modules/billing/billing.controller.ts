import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { config } from '../../config';
import { AllowWhenReadOnly, Permission, Public, Tenant } from '../../common/decorators';
import type { KoraRequest, TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { BillingService } from './billing.service';
import { SandboxProvider } from './payment-provider';

@ApiTags('Abonnement')
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get('plans')
  plans() { return this.billing.publicPlans(); }

  @Permission('billing.read') @AllowWhenReadOnly()
  @Get('company/subscription')
  overview(@Tenant() t: TenantInfo) { return this.billing.overview(t); }

  @Permission('billing.read') @AllowWhenReadOnly()
  @Get('company/invoices')
  invoices(@Tenant() t: TenantInfo) { return this.billing.invoices(t); }

  @Permission('billing.admin') @AllowWhenReadOnly() @HttpCode(200)
  @Post('company/subscription/change')
  change(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.billing.changePlan(t, parse(z.object({ planCode: z.string().min(2).max(40), billingCycle: z.enum(['monthly', 'yearly']) }), body));
  }

  @Permission('billing.admin') @HttpCode(200)
  @Post('company/subscription/cancel')
  cancel(@Tenant() t: TenantInfo) { return this.billing.cancel(t); }

  @Permission('billing.admin') @HttpCode(200)
  @Post('company/subscription/resume')
  resume(@Tenant() t: TenantInfo) { return this.billing.resume(t); }

  @Permission('billing.admin') @AllowWhenReadOnly() @HttpCode(200)
  @Post('company/invoices/:id/checkout')
  checkout(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const { provider } = parse(z.object({ provider: z.string().default('sandbox') }), body ?? {});
    return this.billing.checkout(t, id, provider);
  }
}

/** Notifications des prestataires de paiement : authentifiées par signature, jamais par session. */
@ApiTags('Paiements')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly billing: BillingService) {}

  @Public() @HttpCode(200)
  @Post('payments/:provider')
  receive(@Param('provider') provider: string, @Req() req: KoraRequest) {
    return this.billing.handleNotification(provider, req.rawBody, req.headers);
  }
}

/** Outil de développement : simule le prestataire de test qui confirme un paiement. Désactivé en production. */
@ApiTags('Développement')
@Controller('dev')
export class DevController {
  constructor(private readonly billing: BillingService, private readonly db: DatabaseService) {}

  @Permission('billing.admin') @AllowWhenReadOnly() @HttpCode(200)
  @Post('sandbox/pay/:invoiceId')
  async pay(@Tenant() t: TenantInfo, @Param('invoiceId') invoiceId: string) {
    if (config.isProd) throw new ForbiddenException();
    const inv = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('platform_invoice').select(['id', 'amount', 'currency']).where('id', '=', invoiceId).executeTakeFirst());
    if (!inv) return { status: 'unknown_invoice' };
    const raw = Buffer.from(JSON.stringify({ event_id: `evt_${Date.now()}`, invoice_id: inv.id, reference: `sbx_${Date.now()}`, amount: Number(inv.amount), currency: inv.currency, status: 'succeeded' }));
    return this.billing.handleNotification('sandbox', raw, { 'x-kora-signature': SandboxProvider.sign(raw) });
  }
}
