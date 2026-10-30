import type { ColumnType, Generated } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Num = ColumnType<string, number | string, number | string>;
type Json<T = unknown> = ColumnType<T, T | string, T | string>;
type JsonDefault<T = unknown> = ColumnType<T, T | string | undefined, T | string>;

export interface UserAccountTable {
  id: Generated<string>; email: string; password_hash: string; full_name: string; phone: string | null;
  mfa_enabled: Generated<boolean>; totp_secret_enc: string | null; failed_logins: Generated<number>;
  locked_until: TsNullable; last_login_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface PlatformRoleAssignmentTable { user_id: string; role: string; granted_by: string | null; created_at: Generated<Date>; }
export interface UserSessionTable {
  id: Generated<string>; user_id: string; token_hash: string; active_company_id: string | null; mfa_verified: Generated<boolean>;
  ip: string | null; user_agent: string | null; created_at: Generated<Date>; last_seen_at: Generated<Date>; expires_at: Ts; revoked_at: TsNullable;
}
export interface CompanyTable {
  id: string; name: string; legal_form: string | null; rccm: string | null; tax_id: string | null; tax_regime: string | null;
  address: string | null; city: string | null; phone: string | null; email: string | null; country_code: Generated<string>;
  currency: Generated<string>; logo_key: string | null; status: Generated<'active' | 'suspended' | 'closed'>; status_reason: string | null; accounting_locked_until: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface CompanyMembershipTable {
  company_id: string; id: Generated<string>; user_id: string; status: Generated<'active' | 'disabled'>; valid_until: ColumnType<string | null, string | null | undefined, string | null>;
  is_owner: Generated<boolean>; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface RoleTable {
  company_id: string; id: Generated<string>; key: string; name: string; description: string | null; is_system: Generated<boolean>;
  permissions: string[]; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export interface MembershipRoleTable { company_id: string; membership_id: string; role_id: string; }
export interface InvitationTable {
  company_id: string; id: Generated<string>; email: string; role_ids: string[]; token_hash: string; invited_by: string;
  expires_at: Ts; accepted_at: TsNullable; revoked_at: TsNullable; created_at: Generated<Date>;
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
  status: 'succeeded' | 'refunded'; received_at: Generated<Date>;
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
  track_stock: Generated<boolean>; min_stock: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  stock_qty: NumDefault; stock_value: NumDefault; avg_cost: NumDefault;
}
export type SalesDocType = 'quote' | 'invoice' | 'credit_note';
export type SalesDocStatus = 'draft' | 'sent' | 'accepted' | 'refused' | 'invoiced' | 'issued' | 'partially_paid' | 'paid' | 'credited';
type NumDefault = ColumnType<string, number | string | undefined, number | string>;
export interface SalesDocumentTable {
  company_id: string; id: Generated<string>; type: SalesDocType; status: Generated<SalesDocStatus>; number: string | null; contact_id: string;
  customer: JsonDefault<Record<string, unknown>>; issue_date: DateCol; due_date: DateNullable; valid_until: DateNullable; currency: Generated<string>; notes: string | null;
  total_ht: NumDefault; total_vat: NumDefault; total_ttc: NumDefault; paid_amount: NumDefault; credited_amount: NumDefault; refunded_amount: NumDefault; restock: Generated<boolean>; source_quote_id: string | null; source_invoice_id: string | null;
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
  company_id: string; id: Generated<string>; type: PurchaseDocType; status: Generated<PurchaseDocStatus>; number: string | null; contact_id: string;
  supplier: JsonDefault<Record<string, unknown>>; supplier_ref: string | null; issue_date: DateCol; due_date: DateNullable; expected_date: DateNullable;
  currency: Generated<string>; notes: string | null; total_ht: NumDefault; total_vat: NumDefault; total_ttc: NumDefault; paid_amount: NumDefault;
  source_order_id: string | null; validated_at: TsNullable; validated_by: string | null; created_by: string | null; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export type PurchaseDocumentLineTable = SalesDocumentLineTable;
export type PurchasePaymentTable = SalesPaymentTable;

export type TreasuryKind = 'cash' | 'bank' | 'mobile_money';
export interface TreasuryAccountTable {
  company_id: string; id: Generated<string>; kind: TreasuryKind; name: string; bank_name: string | null; account_number: string | null; ledger_code: string;
  opening_balance: NumDefault; opening_date: ColumnType<string, string | undefined, string>; archived_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>;
}
export type MovementSource = 'sales_payment' | 'purchase_payment' | 'sales_refund' | 'expense' | 'income' | 'transfer' | 'cash_count' | 'reversal';
export interface TreasuryMovementTable {
  company_id: string; id: Generated<string>; account_id: string; date: DateCol; direction: 'in' | 'out'; amount: Num; category: string; label: string;
  contact_id: string | null; source_type: MovementSource; source_id: string | null; transfer_id: string | null; reversal_of: string | null; reversed_by: string | null;
  reference: string | null; created_by: string | null; created_at: Generated<Date>;
}

export interface LedgerAccountTable { company_id: string; code: string; name: string; is_system: Generated<boolean>; archived_at: TsNullable; created_at: Generated<Date>; }
export interface JournalTable { company_id: string; code: string; name: string; }
export type EntrySource = 'manual' | 'sales_document' | 'purchase_document' | 'treasury_movement' | 'treasury_opening' | 'stock_opening' | 'stock_variation' | 'reversal';
export interface JournalEntryTable {
  company_id: string; id: Generated<string>; journal_code: string; number: string | null; date: string; label: string; reference: string | null;
  status: Generated<'draft' | 'posted'>; source_type: EntrySource; source_id: string | null; reversal_of: string | null; reversed_by: string | null;
  created_by: string | null; posted_by: string | null; posted_at: TsNullable; created_at: Generated<Date>;
}
export interface JournalLineTable {
  company_id: string; id: Generated<string>; entry_id: string; position: number; account_code: string; contact_id: string | null; label: string; debit: NumDefault; credit: NumDefault;
}

export type StockReason = 'opening' | 'purchase' | 'sale' | 'sale_return' | 'adjustment';
export interface StockMovementTable {
  company_id: string; id: Generated<string>; product_id: string; date: DateCol; direction: 'in' | 'out'; quantity: Num; value: Num;
  qty_after: Num; value_after: Num; reason: StockReason; source_id: string | null; label: string; created_by: string | null; created_at: Generated<Date>;
}

export interface DB {
  user_account: UserAccountTable; platform_role_assignment: PlatformRoleAssignmentTable; user_session: UserSessionTable;
  company: CompanyTable; company_membership: CompanyMembershipTable; role: RoleTable; membership_role: MembershipRoleTable;
  invitation: InvitationTable; plan: PlanTable; plan_version: PlanVersionTable; subscription: SubscriptionTable;
  subscription_event: SubscriptionEventTable; platform_invoice: PlatformInvoiceTable; platform_payment: PlatformPaymentTable;
  payment_webhook_event: PaymentWebhookEventTable; notification: NotificationTable; support_access_grant: SupportAccessGrantTable;
  audit_log: AuditLogTable; numbering_sequence: NumberingSequenceTable; outbox_event: OutboxEventTable; contact: ContactTable;
  product: ProductTable; sales_document: SalesDocumentTable; sales_document_line: SalesDocumentLineTable; sales_payment: SalesPaymentTable; sales_reminder: SalesReminderTable;
  purchase_document: PurchaseDocumentTable; purchase_document_line: PurchaseDocumentLineTable; purchase_payment: PurchasePaymentTable;
  treasury_account: TreasuryAccountTable; treasury_movement: TreasuryMovementTable;
  ledger_account: LedgerAccountTable; journal: JournalTable; journal_entry: JournalEntryTable; journal_line: JournalLineTable;
  stock_movement: StockMovementTable;
}
