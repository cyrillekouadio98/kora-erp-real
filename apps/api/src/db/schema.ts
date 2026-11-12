import type { ColumnType, Generated } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Num = ColumnType<string, number | string, number | string>;
type Json<T = unknown> = ColumnType<T, T | string, T | string>;
type JsonDefault<T = unknown> = ColumnType<T, T | string | undefined, T | string>;

export interface UserAccountTable {
  id: Generated<string>; email: string; password_hash: string; full_name: string; phone: string | null;
  mfa_enabled: Generated<boolean>; totp_secret_enc: string | null; totp_last_step: number | null; failed_logins: Generated<number>;
  locked_until: TsNullable; last_login_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface PlatformRoleAssignmentTable { user_id: string; role: string; granted_by: string | null; created_at: Generated<Date>; }
export interface UserSessionTable {
  id: Generated<string>; user_id: string; token_hash: string; active_company_id: string | null; mfa_verified: Generated<boolean>;
  ip: string | null; user_agent: string | null; created_at: Generated<Date>; last_seen_at: Generated<Date>; expires_at: Ts; revoked_at: TsNullable;
  active_site_id: string | null;
}
export interface CompanyTable {
  id: string; name: string; legal_form: string | null; rccm: string | null; tax_id: string | null; tax_regime: string | null;
  address: string | null; city: string | null; phone: string | null; email: string | null; country_code: Generated<string>;
  currency: Generated<string>; logo_key: string | null; activity: Generated<'trade' | 'services' | 'mixed'>; status: Generated<'active' | 'suspended' | 'closed'>; status_reason: string | null; accounting_locked_until: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface CompanyMembershipTable {
  company_id: string; id: Generated<string>; user_id: string; status: Generated<'active' | 'disabled'>; valid_until: ColumnType<string | null, string | null | undefined, string | null>;
  is_owner: Generated<boolean>; site_ids: string[] | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface RoleTable {
  company_id: string; id: Generated<string>; key: string; name: string; description: string | null; is_system: Generated<boolean>;
  permissions: string[]; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface MembershipRoleTable { company_id: string; membership_id: string; role_id: string; }
export interface InvitationTable {
  company_id: string; id: Generated<string>; email: string; role_ids: string[]; token_hash: string; invited_by: string;
  expires_at: Ts; accepted_at: TsNullable; revoked_at: TsNullable; created_at: Generated<Date>; employee_id: Generated<string | null>;
  site_ids: string[] | null; is_owner: Generated<boolean>;
}
export interface CompanySetupTable {
  company_id: string; owner_name: string | null; owner_email: string | null; users: JsonDefault; trial_days: number | null; notes: string | null;
  prepared_by: string; handed_over_at: TsNullable; handed_over_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface PlanTable { id: Generated<string>; code: string; name: string; is_public: Generated<boolean>; sort_order: Generated<number>; created_at: Generated<Date>; }
export interface PlanVersionTable {
  id: Generated<string>; plan_id: string; version: number; currency: Generated<string>; price_monthly: Num; price_yearly: Num;
  trial_days: Generated<number>; grace_days: Generated<number>; entitlements: Json; published_at: TsNullable; created_at: Generated<Date>;
}
export type SubscriptionStatus = 'trialing' | 'active' | 'grace' | 'suspended' | 'cancelled' | 'archived';
export interface SubscriptionTable {
  id: Generated<string>; company_id: string; plan_version_id: string; status: SubscriptionStatus; billing_cycle: Generated<'monthly' | 'yearly'>;
  current_period_start: Ts; current_period_end: Ts; grace_until: TsNullable; cancel_at_period_end: Generated<boolean>;
  cancelled_at: TsNullable; auto_renew: Generated<boolean>; overrides: JsonDefault<Record<string, unknown>>; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface SubscriptionEventTable {
  id: Generated<string>; subscription_id: string; company_id: string; type: string; from_status: string | null; to_status: string | null;
  data: JsonDefault; created_at: Generated<Date>;
}
export interface PlatformInvoiceTable {
  id: Generated<string>; number: string; company_id: string; subscription_id: string; kind: 'invoice' | 'credit_note';
  status: 'open' | 'paid' | 'void'; currency: string; amount: Num; lines: Json; period_start: TsNullable; period_end: TsNullable;
  issued_at: Generated<Date>; due_at: Ts; paid_at: TsNullable;
}
export interface PlatformPaymentTable {
  id: Generated<string>; invoice_id: string; company_id: string; provider: string; provider_ref: string; amount: Num; currency: string;
  status: 'succeeded' | 'unapplied' | 'refunded'; unapplied_reason: string | null; received_at: Generated<Date>;
}
export interface PaymentWebhookEventTable {
  id: Generated<string>; provider: string; event_id: string; payload: Json; received_at: Generated<Date>; processed_at: TsNullable; outcome: string | null;
}
export interface NotificationTable { id: Generated<string>; company_id: string | null; type: string; dedupe_key: string; payload: JsonDefault; created_at: Generated<Date>; sent_at: TsNullable; }
export interface SupportAccessGrantTable {
  company_id: string; id: Generated<string>; requested_by: string; reason: string; scope: string[]; duration_minutes: number;
  status: Generated<'requested' | 'approved' | 'denied' | 'revoked'>; decided_by: string | null; decided_at: TsNullable; expires_at: TsNullable; created_at: Generated<Date>;
}
export interface AuditLogTable {
  id: Generated<string>; company_id: string | null; actor_type: 'user' | 'support' | 'platform' | 'system'; actor_id: string | null;
  action: string; entity_type: string | null; entity_id: string | null; data: JsonDefault; ip: string | null; created_at: Generated<Date>;
}
export interface NumberingSequenceTable { company_id: string; doc_type: string; year: number; prefix: string; next_value: Generated<string>; }
export interface OutboxEventTable { company_id: string; id: Generated<string>; type: string; payload: Json; dedupe_key: string; created_at: Generated<Date>; processed_at: TsNullable; }

export interface PosRegisterTable {
  company_id: string; id: Generated<string>; site_id: string; name: string; warehouse_id: string; cash_account_id: string; customer_id: string;
  archived_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface PosSessionTable {
  company_id: string; id: Generated<string>; site_id: string; register_id: string; number: string; status: Generated<'open' | 'closed'>;
  opening_float: NumDefault; opened_by: string; opened_at: Generated<Date>; expected_cash: ColumnType<string | null, number | null | undefined, number | null>;
  counted_cash: ColumnType<string | null, number | null | undefined, number | null>; difference: ColumnType<string | null, number | null | undefined, number | null>;
  closing_note: string | null; closed_by: string | null; closed_at: TsNullable;
}
export interface ContactTable {
  company_id: string; id: Generated<string>; code: string; kind: 'customer' | 'supplier' | 'both'; legal_type: Generated<'company' | 'individual'>;
  name: string; tax_id: string | null; rccm: string | null; email: string | null; phone: string | null; address: string | null; city: string | null;
  country_code: Generated<string>; payment_terms_days: Generated<number>; notes: string | null; archived_at: TsNullable;
  created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}

type DateCol = ColumnType<string, string | undefined, string>;
type DateNullable = ColumnType<string | null, string | null | undefined, string | null>;

export interface ProductTable {
  company_id: string; id: Generated<string>; code: string; kind: Generated<'good' | 'service'>; name: string; description: string | null;
  unit: Generated<string>; sale_price: ColumnType<string, number | string | undefined, number | string>; purchase_price: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  vat_rate: ColumnType<string, number | string | undefined, number | string>; archived_at: TsNullable; created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
  track_stock: Generated<boolean>; barcode: ColumnType<string | null, string | null | undefined, string | null>; min_stock: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  stock_qty: NumDefault; stock_value: NumDefault; avg_cost: NumDefault;
}
export type SalesDocType = 'quote' | 'order' | 'invoice' | 'credit_note';
export type SalesDocStatus = 'draft' | 'sent' | 'accepted' | 'refused' | 'ordered' | 'invoiced' | 'confirmed' | 'cancelled' | 'issued' | 'partially_paid' | 'paid' | 'credited';
type NumDefault = ColumnType<string, number | string | undefined, number | string>;
export interface SalesDocumentTable {
  company_id: string; site_id: Generated<string>; id: Generated<string>; type: SalesDocType; status: Generated<SalesDocStatus>; number: string | null; contact_id: string;
  customer: JsonDefault<Record<string, unknown>>; issue_date: DateCol; due_date: DateNullable; valid_until: DateNullable; currency: Generated<string>; notes: string | null;
  total_ht: NumDefault; total_vat: NumDefault; total_ttc: NumDefault; paid_amount: NumDefault; credited_amount: NumDefault; refunded_amount: NumDefault; restock: Generated<boolean>; source_quote_id: string | null; source_invoice_id: string | null;
  source_order_id: string | null; delivery_date: DateNullable; customer_ref: string | null; warehouse_id: string | null;
  pos_session_id: ColumnType<string | null, string | null | undefined, string | null>; cash_tendered: ColumnType<string | null, number | null | undefined, number | null>;
  validated_at: TsNullable; validated_by: string | null; created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface SalesDocumentLineTable {
  company_id: string; id: Generated<string>; document_id: string; position: number; product_id: string | null; description: string;
  quantity: Num; unit: string | null; unit_price: Num; discount_pct: NumDefault; vat_rate: Num; total_ht: Num; total_vat: Num;
}
export type PaymentMethod = 'cash' | 'mobile_money' | 'bank_transfer' | 'cheque' | 'card';
export interface SalesPaymentTable {
  company_id: string; id: Generated<string>; document_id: string; amount: Num; paid_on: DateCol; method: PaymentMethod; reference: string | null;
  created_by: string | null; created_at: Generated<Date>;
}

export type ReminderChannel = 'phone' | 'whatsapp' | 'sms' | 'email' | 'letter' | 'visit';
export interface SalesReminderTable {
  company_id: string; id: Generated<string>; document_id: string; channel: ReminderChannel; note: string | null; promised_on: DateNullable;
  created_by: string | null; created_at: Generated<Date>;
}

export type PurchaseDocType = 'order' | 'invoice';
export type PurchaseDocStatus = 'draft' | 'sent' | 'cancelled' | 'invoiced' | 'to_pay' | 'partially_paid' | 'paid';
export interface PurchaseDocumentTable {
  company_id: string; site_id: Generated<string>; id: Generated<string>; type: PurchaseDocType; status: Generated<PurchaseDocStatus>; number: string | null; contact_id: string;
  supplier: JsonDefault<Record<string, unknown>>; supplier_ref: string | null; issue_date: DateCol; due_date: DateNullable; expected_date: DateNullable;
  currency: Generated<string>; notes: string | null; total_ht: NumDefault; total_vat: NumDefault; total_ttc: NumDefault; paid_amount: NumDefault;
  source_order_id: string | null; warehouse_id: string | null; validated_at: TsNullable; validated_by: string | null; created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export type PurchaseDocumentLineTable = SalesDocumentLineTable;
export type PurchasePaymentTable = SalesPaymentTable;

export type TreasuryKind = 'cash' | 'bank' | 'mobile_money';
export interface TreasuryAccountTable {
  company_id: string; site_id: Generated<string>; id: Generated<string>; kind: TreasuryKind; name: string; bank_name: string | null; account_number: string | null; ledger_code: string;
  opening_balance: NumDefault; opening_date: ColumnType<string, string | undefined, string>; archived_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export type MovementSource = 'sales_payment' | 'purchase_payment' | 'sales_refund' | 'payroll' | 'expense' | 'income' | 'transfer' | 'cash_count' | 'stock_purchase' | 'formation' | 'reversal';
export interface TreasuryMovementTable {
  company_id: string; id: Generated<string>; account_id: string; date: DateCol; direction: 'in' | 'out'; amount: Num; category: string; label: string;
  contact_id: string | null; source_type: MovementSource; source_id: string | null; transfer_id: string | null; reversal_of: string | null; reversed_by: string | null;
  reference: string | null; counterpart_code: Generated<string | null>; status: Generated<'posted' | 'draft'>; created_by: string | null; created_at: Generated<Date>;
}

export interface CompanyFormationTable {
  company_id: string; legal_form: string; formation_date: DateCol; capital: Num; nature: Generated<any>; cash_paid: NumDefault; deposit: Generated<'bank' | 'notary'>;
  bank_account_id: string | null; updated_by: string | null; updated_at: Generated<Date>;
}
export interface CompanyFormationStepTable {
  company_id: string; id: Generated<string>; step: string; date: DateCol; amount: NumDefault; data: Generated<any>; entry_ids: Generated<string[]>; movement_ids: Generated<string[]>;
  created_by: string | null; created_at: Generated<Date>; cancelled_by: string | null; cancelled_at: TsNullable;
}

export interface LedgerAccountTable { company_id: string; code: string; name: string; is_system: Generated<boolean>; archived_at: TsNullable; created_at: Generated<Date>; }
export interface JournalTable { company_id: string; code: string; name: string; }
export type EntrySource = 'manual' | 'sales_document' | 'purchase_document' | 'treasury_movement' | 'treasury_opening' | 'stock_opening' | 'stock_variation' | 'payroll_run' | 'year_closing' | 'formation' | 'reversal';
export interface JournalEntryTable {
  company_id: string; site_id: string | null; id: Generated<string>; journal_code: string; number: string | null; date: string; label: string; reference: string | null;
  status: Generated<'draft' | 'posted'>; source_type: EntrySource; source_id: string | null; reversal_of: string | null; reversed_by: string | null;
  created_by: string | null; posted_by: string | null; posted_at: TsNullable; created_at: Generated<Date>;
}
export interface JournalLineTable {
  company_id: string; id: Generated<string>; entry_id: string; position: number; account_code: string; contact_id: string | null; label: string; debit: NumDefault; credit: NumDefault;
}

export type StockReason = 'opening' | 'purchase' | 'sale' | 'sale_return' | 'adjustment' | 'receipt' | 'issue' | 'transfer' | 'cancellation';
export interface StockMovementTable {
  company_id: string; id: Generated<string>; product_id: string; warehouse_id: string; date: DateCol; direction: 'in' | 'out'; quantity: Num; value: Num;
  qty_after: Num; value_after: Num; wh_qty_after: Num; reason: StockReason; source_id: string | null; document_id: string | null; label: string; created_by: string | null; created_at: Generated<Date>;
}
export interface WarehouseTable {
  company_id: string; site_id: Generated<string>; id: Generated<string>; code: string; name: string; address: string | null; is_default: Generated<boolean>;
  archived_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface StockLevelTable { company_id: string; product_id: string; warehouse_id: string; quantity: NumDefault; }
export type StockDocType = 'receipt' | 'issue' | 'transfer' | 'inventory';
export interface StockDocumentTable {
  company_id: string; site_id: Generated<string>; id: Generated<string>; type: StockDocType; status: Generated<'draft' | 'done'>; number: string | null; date: DateCol;
  warehouse_id: string; dest_warehouse_id: string | null; reason: string; contact_id: string | null; treasury_account_id: string | null; treasury_movement_id: string | null;
  reference: string | null; notes: string | null; total_value: NumDefault; validated_at: TsNullable; validated_by: string | null; created_by: string | null;
  created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface StockDocumentLineTable {
  company_id: string; id: Generated<string>; document_id: string; position: number; product_id: string;
  quantity: ColumnType<string | null, number | string | null | undefined, number | string | null>; expected: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  unit_cost: ColumnType<string | null, number | string | null | undefined, number | string | null>; value: ColumnType<string | null, number | string | null | undefined, number | string | null>; note: string | null;
}

type NumNullable = ColumnType<string | null, number | string | null | undefined, number | string | null>;
export interface EmployeeTable {
  company_id: string; site_id: Generated<string>; id: Generated<string>; number: string; first_name: string; last_name: string; job_title: string | null; department: string | null;
  hire_date: string; end_date: DateNullable; contract_type: Generated<'cdi' | 'cdd' | 'stage' | 'journalier'>; cnps_number: string | null;
  marital_status: Generated<'single' | 'married' | 'divorced' | 'widowed'>; children: Generated<number>; parts_override: NumNullable;
  base_salary: NumDefault; housing_allowance: NumDefault; transport_allowance: NumDefault; other_allowances: NumDefault;
  category: string | null; target_net: NumNullable; extra_salary: NumDefault;
  payment_method: Generated<'cash' | 'bank_transfer' | 'mobile_money'>; bank_details_enc: string | null; phone: string | null; email: string | null;
  user_id: string | null; leave_opening_balance: NumDefault; leave_opening_date: DateNullable;
  created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface EmployeePhotoTable { company_id: string; employee_id: string; mime: string; data: Buffer; updated_at: Generated<Date>; }
export interface SiteTable {
  company_id: string; id: Generated<string>; code: string; name: string; address: string | null; city: string | null; phone: string | null;
  is_default: Generated<boolean>; archived_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export type AppointmentKind = 'meeting' | 'call' | 'visit' | 'delivery' | 'other';
export interface AppointmentTable {
  company_id: string; id: Generated<string>; site_id: Generated<string>; title: string; kind: Generated<AppointmentKind>; start_at: Date; end_at: Date; all_day: Generated<boolean>;
  location: string | null; notes: string | null; contact_id: string | null; status: Generated<'planned' | 'done' | 'cancelled'>;
  reminder_minutes: number | null; reminded_at: TsNullable; created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface AppointmentAttendeeTable { company_id: string; appointment_id: string; user_id: string; }
export interface EvaluationCampaignTable {
  company_id: string; id: Generated<string>; name: string; period_start: string; period_end: string; due_date: DateNullable; criteria: Json;
  status: Generated<'open' | 'closed'>; created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface EvaluationTable {
  company_id: string; id: Generated<string>; campaign_id: string; employee_id: string; evaluator_id: string | null; scores: JsonDefault; score: NumNullable;
  strengths: string | null; improvements: string | null; goals: string | null; comment: string | null;
  status: Generated<'draft' | 'submitted' | 'approved' | 'refused'>; submitted_at: TsNullable;
  bonus_amount: NumDefault; bonus_period: string | null; new_base_salary: NumNullable; previous_base_salary: NumNullable; raise_period: string | null; raise_applied_at: TsNullable;
  proposed_bonus: NumNullable; proposed_raise_percent: NumNullable;
  decided_by: string | null; decided_at: TsNullable; decision_note: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface ContactLogoTable { company_id: string; contact_id: string; mime: string; data: Buffer; updated_at: Generated<Date>; }
export interface CompanyLogoTable { company_id: string; mime: string; data: Buffer; updated_at: Generated<Date>; }
export type LeaveType = 'annual' | 'sick' | 'maternity' | 'family_event' | 'unpaid' | 'other';
export interface LeaveRequestTable {
  company_id: string; id: Generated<string>; employee_id: string; type: LeaveType; start_date: string; end_date: string; days: Num; reason: string | null;
  status: Generated<'pending' | 'approved' | 'refused' | 'cancelled'>; decided_by: string | null; decided_at: TsNullable; decision_note: string | null;
  created_by: string | null; created_at: Generated<Date>;
}
export interface PayrollSettingsTable { company_id: string; params: Json; notes: JsonDefault<unknown[]>; updated_by: string | null; updated_at: Generated<Date>; }
export interface PayrollRunTable {
  company_id: string; id: Generated<string>; period: string; status: Generated<'draft' | 'validated'>; params: Json;
  validated_at: TsNullable; validated_by: string | null; created_by: string | null; created_at: Generated<Date>;
}
export interface PayslipTable {
  company_id: string; id: Generated<string>; run_id: string; employee_id: string; employee: Json; inputs: Json; lines: Json; totals: Json;
  gross: Num; taxable: Num; net: Num; employer_cost: Num; paid_at: DateNullable;
}

export interface EmailMessageTable {
  id: Generated<string>; company_id: string | null; to_address: string; reply_to: string | null; from_name: string; subject: string; text_body: string; html_body: string;
  kind: string; entity_id: string | null; status: Generated<'queued' | 'sent' | 'failed'>; attempts: Generated<number>; next_attempt_at: Generated<Date>;
  last_error: string | null; sent_at: TsNullable; created_by: string | null; created_at: Generated<Date>;
}
export interface PasswordResetTable { id: Generated<string>; user_id: string; token_hash: string; expires_at: Ts; used_at: TsNullable; ip: string | null; created_at: Generated<Date>; }
export interface DocumentShareTable {
  company_id: string; id: Generated<string>; document_id: string; token_hash: string; expires_at: Ts; views: Generated<number>; last_viewed_at: TsNullable;
  created_by: string | null; created_at: Generated<Date>;
}

export interface FiscalYearClosingTable {
  company_id: string; year: number; result: Num; entry_id: string | null; warnings: JsonDefault<unknown[]>; closed_by: string | null; closed_at: Generated<Date>;
}

export interface DB {
  user_account: UserAccountTable; platform_role_assignment: PlatformRoleAssignmentTable; user_session: UserSessionTable;
  company: CompanyTable; company_membership: CompanyMembershipTable; role: RoleTable; membership_role: MembershipRoleTable;
  invitation: InvitationTable; company_setup: CompanySetupTable; plan: PlanTable; plan_version: PlanVersionTable; subscription: SubscriptionTable;
  subscription_event: SubscriptionEventTable; platform_invoice: PlatformInvoiceTable; platform_payment: PlatformPaymentTable;
  payment_webhook_event: PaymentWebhookEventTable; notification: NotificationTable; support_access_grant: SupportAccessGrantTable;
  audit_log: AuditLogTable; numbering_sequence: NumberingSequenceTable; outbox_event: OutboxEventTable; contact: ContactTable;
  pos_register: PosRegisterTable; pos_session: PosSessionTable; company_formation: CompanyFormationTable; company_formation_step: CompanyFormationStepTable;
  product: ProductTable; sales_document: SalesDocumentTable; sales_document_line: SalesDocumentLineTable; sales_payment: SalesPaymentTable; sales_reminder: SalesReminderTable;
  purchase_document: PurchaseDocumentTable; purchase_document_line: PurchaseDocumentLineTable; purchase_payment: PurchasePaymentTable;
  treasury_account: TreasuryAccountTable; treasury_movement: TreasuryMovementTable;
  ledger_account: LedgerAccountTable; journal: JournalTable; journal_entry: JournalEntryTable; journal_line: JournalLineTable;
  stock_movement: StockMovementTable; warehouse: WarehouseTable; stock_level: StockLevelTable; stock_document: StockDocumentTable; stock_document_line: StockDocumentLineTable;
  employee: EmployeeTable; employee_photo: EmployeePhotoTable; contact_logo: ContactLogoTable; company_logo: CompanyLogoTable; site: SiteTable; appointment: AppointmentTable; appointment_attendee: AppointmentAttendeeTable; evaluation_campaign: EvaluationCampaignTable; evaluation: EvaluationTable; payroll_settings: PayrollSettingsTable; payroll_run: PayrollRunTable; payslip: PayslipTable;
  email_message: EmailMessageTable; password_reset: PasswordResetTable; document_share: DocumentShareTable; fiscal_year_closing: FiscalYearClosingTable; leave_request: LeaveRequestTable;
}
