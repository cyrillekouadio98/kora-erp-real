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
import { ProductsController } from './modules/sales/products.controller';
import { SalesController } from './modules/sales/sales.controller';
import { SalesService } from './modules/sales/sales.service';
import { PurchasesController } from './modules/purchases/purchases.controller';
import { PurchasesService } from './modules/purchases/purchases.service';
import { TreasuryController } from './modules/treasury/treasury.controller';
import { TreasuryService } from './modules/treasury/treasury.service';
import { AccountingController } from './modules/accounting/accounting.controller';
import { AccountingService } from './modules/accounting/accounting.service';
import { FinancialService } from './modules/accounting/financial.service';
import { StockController } from './modules/stock/stock.controller';
import { StockService } from './modules/stock/stock.service';
import { PayrollController } from './modules/payroll/payroll.controller';
import { PayrollInsightsService } from './modules/payroll/payroll-insights.service';
import { PayrollService } from './modules/payroll/payroll.service';
import { MailService } from './modules/mail/mail.service';
import { EmailsController } from './modules/mail/emails.controller';
import { PublicDocumentsController } from './modules/sales/public.controller';
import { LeaveController } from './modules/leave/leave.controller';
import { LeaveService } from './modules/leave/leave.service';
import { DashboardController } from './modules/dashboard/dashboard.controller';
import { DashboardService } from './modules/dashboard/dashboard.service';
import { JobsController } from './modules/jobs/jobs.controller';
import { ReportsController } from './modules/reports/reports.controller';
import { ReportsService } from './modules/reports/reports.service';
import { ContactsController } from './modules/contacts/contacts.controller';
import { SitesController } from './modules/sites/sites.controller';
import { SitesService } from './modules/sites/sites.service';
import { CalendarController } from './modules/calendar/calendar.controller';
import { CalendarService } from './modules/calendar/calendar.service';
import { EvaluationsController } from './modules/evaluations/evaluations.controller';
import { EvaluationsService } from './modules/evaluations/evaluations.service';
import { CompaniesController } from './modules/companies/companies.controller';
import { ProvisioningService } from './modules/companies/provisioning.service';
import { ExportController } from './modules/exports/export.controller';
import { HealthController } from './modules/platform/health.controller';
import { PlatformController } from './modules/platform/platform.controller';
import { SetupController } from './modules/platform/setup.controller';
import { SetupService } from './modules/platform/setup.service';
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
    DevController, AuditController, SupportAccessController, PlatformSupportController, PlatformController, SetupController, ExportController,
    ContactsController, ProductsController, SalesController, PurchasesController, TreasuryController, AccountingController, StockController, PayrollController, PublicDocumentsController, EmailsController, LeaveController, DashboardController, JobsController, ReportsController, SitesController, CalendarController, EvaluationsController,
  ],
  providers: [
    AuditService, SessionService, AuthService, ProvisioningService, EntitlementService, QuotaService, BillingService, BillingScheduler, SalesService, PurchasesService, TreasuryService, AccountingService, FinancialService, StockService, PayrollService, PayrollInsightsService, MailService, LeaveService, DashboardService, ReportsService, CalendarService, EvaluationsService, SitesService, SetupService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
