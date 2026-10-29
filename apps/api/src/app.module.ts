import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccessGuard } from './common/access.guard';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { DatabaseModule } from './db/database.module';
import { AuditController } from './modules/audit/audit.controller';
import { AuditService } from './modules/audit/audit.service';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { SessionService } from './modules/auth/session.service';
import { BillingController, DevController, WebhooksController } from './modules/billing/billing.controller';
import { BillingScheduler } from './modules/billing/billing.scheduler';
import { BillingService } from './modules/billing/billing.service';
import { EntitlementService } from './modules/billing/entitlement.service';
import { QuotaService } from './modules/billing/quota.service';
import { CompaniesController } from './modules/companies/companies.controller';
import { ProvisioningService } from './modules/companies/provisioning.service';
import { ExportController } from './modules/exports/export.controller';
import { HealthController } from './modules/platform/health.controller';
import { PlatformController } from './modules/platform/platform.controller';
import { MembersController } from './modules/rbac/members.controller';
import { RolesController } from './modules/rbac/roles.controller';
import { PlatformSupportController, SupportAccessController } from './modules/support/support.controller';

@Module({
  imports: [
    DatabaseModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 10) }]),
  ],
  controllers: [
    HealthController, AuthController, CompaniesController, MembersController, RolesController, BillingController, WebhooksController,
    DevController, AuditController, SupportAccessController, PlatformSupportController, PlatformController, ExportController,
  ],
  providers: [
    AuditService, SessionService, AuthService, ProvisioningService, EntitlementService, QuotaService, BillingService, BillingScheduler,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
