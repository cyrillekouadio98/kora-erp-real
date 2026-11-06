import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import archiver from 'archiver';
import type { Response } from 'express';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n');
}

/**
 * Réversibilité : export complet des données de l'entreprise, toujours possible,
 * y compris quand l'abonnement est suspendu ou résilié.
 */
@ApiTags('Export des données')
@Controller('company/export')
export class ExportController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Permission('data.export_all') @AllowWhenReadOnly()
  @Get()
  async export(@Tenant() t: TenantInfo, @Res() res: Response) {
    const data = await this.db.tenant(t.ctx, async (trx) => {
      const out = {
        company: await trx.selectFrom('company').selectAll().execute(),
        members: await trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
          .select(['m.id', 'u.full_name', 'u.email', 'm.status', 'm.is_owner', 'm.valid_until', 'm.created_at']).execute(),
        roles: await trx.selectFrom('role').select(['id', 'key', 'name', 'description', 'is_system', 'permissions']).execute(),
        member_roles: await trx.selectFrom('membership_role').select(['membership_id', 'role_id']).execute(),
        invitations: await trx.selectFrom('invitation').select(['id', 'email', 'role_ids', 'expires_at', 'accepted_at', 'revoked_at', 'created_at']).execute(),
        subscription: await trx.selectFrom('subscription').selectAll().execute(),
        invoices: await trx.selectFrom('platform_invoice').selectAll().execute(),
        contacts: await trx.selectFrom('contact').selectAll().orderBy('code').execute(),
        products: await trx.selectFrom('product').selectAll().orderBy('code').execute(),
        sales_documents: await trx.selectFrom('sales_document').selectAll().orderBy('created_at').execute(),
        sales_document_lines: await trx.selectFrom('sales_document_line').selectAll().orderBy('document_id').orderBy('position').execute(),
        sales_payments: await trx.selectFrom('sales_payment').selectAll().orderBy('paid_on').execute(),
        sales_reminders: await trx.selectFrom('sales_reminder').selectAll().orderBy('created_at').execute(),
        purchase_documents: await trx.selectFrom('purchase_document').selectAll().orderBy('created_at').execute(),
        purchase_document_lines: await trx.selectFrom('purchase_document_line').selectAll().orderBy('document_id').orderBy('position').execute(),
        purchase_payments: await trx.selectFrom('purchase_payment').selectAll().orderBy('paid_on').execute(),
        treasury_accounts: await trx.selectFrom('treasury_account').selectAll().orderBy('created_at').execute(),
        treasury_movements: await trx.selectFrom('treasury_movement').selectAll().orderBy('date').orderBy('created_at').execute(),
        ledger_accounts: await trx.selectFrom('ledger_account').selectAll().orderBy('code').execute(),
        journal_entries: await trx.selectFrom('journal_entry').selectAll().orderBy('date').orderBy('number').execute(),
        journal_lines: await trx.selectFrom('journal_line').selectAll().orderBy('entry_id').orderBy('position').execute(),
        stock_movements: await trx.selectFrom('stock_movement').selectAll().orderBy('date').orderBy('created_at').execute(),
        // Le RIB chiffré des employés n'est pas exporté en clair.
        employees: await trx.selectFrom('employee').select(['id', 'number', 'first_name', 'last_name', 'job_title', 'department', 'hire_date', 'end_date', 'contract_type',
          'cnps_number', 'marital_status', 'children', 'parts_override', 'base_salary', 'housing_allowance', 'transport_allowance', 'other_allowances', 'payment_method', 'phone', 'email']).execute(),
        payroll_runs: await trx.selectFrom('payroll_run').selectAll().orderBy('period').execute(),
        payslips: await trx.selectFrom('payslip').selectAll().orderBy('run_id').execute(),
        fiscal_year_closings: await trx.selectFrom('fiscal_year_closing').selectAll().orderBy('year').execute(),
        leave_requests: await trx.selectFrom('leave_request').selectAll().orderBy('start_date').execute(),
        audit_log: await trx.selectFrom('audit_log').selectAll().orderBy('id').execute(),
      };
      await this.audit.tenant(trx, t.ctx, { action: 'data.exported', data: { tables: Object.keys(out) } });
      return out;
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="kora-export-${stamp}.zip"`);
    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.pipe(res);
    zip.append(JSON.stringify(data, null, 2), { name: 'donnees-completes.json' });
    for (const [name, rows] of Object.entries(data)) zip.append(toCsv(rows as Record<string, unknown>[]), { name: `csv/${name}.csv` });
    zip.append(`Export Kora ERP du ${stamp}\nEntreprise : ${t.companyId}\nFichiers CSV séparés par des points-virgules, encodés en UTF-8.\nLes coordonnées bancaires des employés, chiffrées, ne sont pas exportées.\n`, { name: 'LISEZ-MOI.txt' });
    await zip.finalize();
  }
}
