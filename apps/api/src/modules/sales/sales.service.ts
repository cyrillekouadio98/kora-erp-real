import { Injectable } from '@nestjs/common';
import { config } from '../../config';
import { randomToken, safeEqual, sha256 } from '../../common/crypto';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, setTenantContext, TenantTrx } from '../../db/database.service';
import type { PaymentMethod, ReminderChannel, SalesDocStatus, SalesDocType } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { AccountingService } from '../accounting/accounting.service';
import { MailService } from '../mail/mail.service';
import { StockService } from '../stock/stock.service';
import { TreasuryService } from '../treasury/treasury.service';

export interface LineInput { productId?: string | null; description: string; quantity: number; unit?: string | null; unitPrice: number; discountPct?: number; vatRate: number }
export interface DocInput { contactId: string; issueDate?: string; dueDate?: string | null; validUntil?: string | null; notes?: string | null; restock?: boolean; lines: LineInput[] }

const PREFIX: Record<SalesDocType, string> = { quote: 'DEV', invoice: 'FAC', credit_note: 'AV' };
const LABEL: Record<SalesDocType, string> = { quote: 'Devis', invoice: 'Facture', credit_note: 'Avoir' };
const OPEN_INVOICE: SalesDocStatus[] = ['issued', 'partially_paid'];
const QUOTE_VALIDITY_DAYS = 30;

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Montants en francs CFA entiers : chaque ligne est arrondie, puis les lignes sont additionnées. */
export function computeLine(l: Pick<LineInput, 'quantity' | 'unitPrice' | 'discountPct' | 'vatRate'>) {
  const ht = Math.round(l.quantity * l.unitPrice * (1 - (l.discountPct ?? 0) / 100));
  return { ht, vat: Math.round((ht * l.vatRate) / 100) };
}
/** Statut d'une facture émise d'après ce qui a été encaissé et crédité par avoir. */
export function invoiceStatus(total: number, paid: number, credited: number): SalesDocStatus {
  if (credited >= total) return 'credited';
  if (paid + credited >= total) return 'paid';
  return paid > 0 || credited > 0 ? 'partially_paid' : 'issued';
}
/** Reste à payer et trop-perçu (le client a payé plus que ce qui reste dû après avoir). */
export const balance = (d: { total_ttc: string; paid_amount: string; credited_amount: string; refunded_amount?: string }) => {
  const due = Number(d.total_ttc) - Number(d.paid_amount) - Number(d.credited_amount) + Number(d.refunded_amount ?? 0);
  return { remaining: Math.max(0, due), refundDue: Math.max(0, -due) };
};

export function computeTotals(lines: LineInput[]) {
  const totals = lines.map(computeLine);
  const ht = totals.reduce((s, x) => s + x.ht, 0);
  const vat = totals.reduce((s, x) => s + x.vat, 0);
  return { lines: totals, ht, vat, ttc: ht + vat };
}

@Injectable()
export class SalesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly treasury: TreasuryService, private readonly accounting: AccountingService, private readonly stock: StockService, private readonly mail: MailService) {}

  private async doc(trx: TenantTrx, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Document');
    const d = await trx.selectFrom('sales_document').selectAll().where('id', '=', id).$if(lock, (q) => q.forUpdate()).executeTakeFirst();
    if (!d) throw notFound('Document');
    return d;
  }

  private async customer(trx: TenantTrx, contactId: string) {
    if (!isUuid(contactId)) throw badRequest('Client introuvable.', undefined, 'unknown_contact');
    const c = await trx.selectFrom('contact').selectAll().where('id', '=', contactId).executeTakeFirst();
    if (!c) throw badRequest('Client introuvable.', undefined, 'unknown_contact');
    if (c.archived_at) throw conflict(`Le contact ${c.code} est archivé.`, 'contact_archived');
    if (c.kind === 'supplier') throw badRequest(`${c.name} est enregistré comme fournisseur uniquement : modifiez sa fiche pour en faire aussi un client.`, undefined, 'not_a_customer');
    return c;
  }

  private async writeLines(trx: TenantTrx, t: TenantInfo, documentId: string, lines: LineInput[]) {
    const productIds = [...new Set(lines.map((l) => l.productId).filter((x): x is string => !!x))];
    if (productIds.length) {
      if (!productIds.every(isUuid)) throw badRequest('Article introuvable.', undefined, 'unknown_product');
      const found = await trx.selectFrom('product').select('id').where('id', 'in', productIds).execute();
      if (found.length !== productIds.length) throw badRequest('Un ou plusieurs articles sont introuvables.', undefined, 'unknown_product');
    }
    const totals = computeTotals(lines);
    await trx.deleteFrom('sales_document_line').where('document_id', '=', documentId).execute();
    await trx.insertInto('sales_document_line').values(lines.map((l, i) => ({
      company_id: t.companyId, document_id: documentId, position: i + 1, product_id: l.productId ?? null, description: l.description,
      quantity: l.quantity, unit: l.unit ?? null, unit_price: l.unitPrice, discount_pct: l.discountPct ?? 0, vat_rate: l.vatRate,
      total_ht: totals.lines[i].ht, total_vat: totals.lines[i].vat,
    }))).execute();
    return totals;
  }

  async list(t: TenantInfo, f: { type: SalesDocType; status?: string; q?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('sales_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .select(['d.id', 'd.type', 'd.status', 'd.number', 'd.issue_date as issueDate', 'd.due_date as dueDate', 'd.valid_until as validUntil',
          'd.total_ht as totalHt', 'd.total_vat as totalVat', 'd.total_ttc as totalTtc', 'd.paid_amount as paidAmount', 'd.credited_amount as creditedAmount', 'd.refunded_amount as refundedAmount', 'd.currency',
          'c.id as contactId', 'c.name as contactName', 'c.code as contactCode'])
        .where('d.type', '=', f.type).orderBy('d.created_at', 'desc').limit(1000);
      if (f.status) q = q.where('d.status', '=', f.status as any);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('d.number', 'ilike', like), eb('c.name', 'ilike', like), eb('c.code', 'ilike', like)]));
      }
      const rows = await q.execute();
      const now = today();
      return rows.map((r) => ({
        ...r, totalHt: Number(r.totalHt), totalVat: Number(r.totalVat), totalTtc: Number(r.totalTtc), paidAmount: Number(r.paidAmount), creditedAmount: Number(r.creditedAmount),
        remaining: r.type === 'invoice' && r.status !== 'draft' ? balance({ total_ttc: r.totalTtc, paid_amount: r.paidAmount, credited_amount: r.creditedAmount, refunded_amount: r.refundedAmount }).remaining : 0,
        overdue: r.type === 'invoice' && OPEN_INVOICE.includes(r.status) && !!r.dueDate && r.dueDate < now,
      }));
    });
  }

  async get(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, (trx) => this.view(trx, id));
  }

  /** Lecture complète d'un document dans une transaction déjà ouverte (espace entreprise ou lien de consultation). */
  async view(trx: TenantTrx, id: string) {
    const d = await this.doc(trx, id);
    const contact = await trx.selectFrom('contact').select(['id', 'code', 'name', 'tax_id as taxId', 'rccm', 'email', 'phone', 'address', 'city', 'payment_terms_days as paymentTermsDays'])
      .where('id', '=', d.contact_id).executeTakeFirstOrThrow();
    const lines = await trx.selectFrom('sales_document_line').selectAll().where('document_id', '=', id).orderBy('position').execute();
    const payments = await trx.selectFrom('sales_payment as p')
      .leftJoin('treasury_movement as m', (j) => j.onRef('m.source_id', '=', 'p.id').onRef('m.company_id', '=', 'p.company_id'))
      .leftJoin('treasury_account as a', (j) => j.onRef('a.id', '=', 'm.account_id').onRef('a.company_id', '=', 'm.company_id'))
      .select(['p.id', 'p.amount', 'p.paid_on as paidOn', 'p.method', 'p.reference', 'p.created_at as createdAt', 'a.name as accountName'])
      .where('p.document_id', '=', id).orderBy('p.paid_on').orderBy('p.created_at').execute();
    const refunds = await trx.selectFrom('treasury_movement as m')
      .innerJoin('treasury_account as a', (j) => j.onRef('a.id', '=', 'm.account_id').onRef('a.company_id', '=', 'm.company_id'))
      .select(['m.id', 'm.amount', 'm.date', 'm.reference', 'a.name as accountName']).where('m.source_type', '=', 'sales_refund').where('m.source_id', '=', id).orderBy('m.date').execute();
    const source = d.source_quote_id ?? d.source_invoice_id ?? id;
    const related = await trx.selectFrom('sales_document').select(['id', 'type', 'number', 'status', 'total_ttc as totalTtc'])
      .where((eb) => eb.or([eb('id', '=', source), eb('source_quote_id', '=', id), eb('source_invoice_id', '=', id)])).where('id', '!=', id).orderBy('created_at').execute();
    const reminders = await trx.selectFrom('sales_reminder as r').leftJoin('user_account as u', 'u.id', 'r.created_by')
      .select(['r.id', 'r.channel', 'r.note', 'r.promised_on as promisedOn', 'r.created_at as createdAt', 'u.full_name as by'])
      .where('r.document_id', '=', id).orderBy('r.created_at', 'desc').execute();
    const vatBreakdown = Object.values(lines.reduce<Record<string, { rate: number; base: number; vat: number }>>((acc, l) => {
      const k = String(Number(l.vat_rate));
      acc[k] ??= { rate: Number(l.vat_rate), base: 0, vat: 0 };
      acc[k].base += Number(l.total_ht); acc[k].vat += Number(l.total_vat);
      return acc;
    }, {})).sort((a, b) => b.rate - a.rate);
    return {
      id: d.id, type: d.type, status: d.status, number: d.number, issueDate: d.issue_date, dueDate: d.due_date, validUntil: d.valid_until,
      currency: d.currency, notes: d.notes, restock: d.restock, validatedAt: d.validated_at, sourceQuoteId: d.source_quote_id,
      customer: d.status === 'draft' ? contact : { ...contact, ...(d.customer as object) }, contact,
      totalHt: Number(d.total_ht), totalVat: Number(d.total_vat), totalTtc: Number(d.total_ttc), paidAmount: Number(d.paid_amount), creditedAmount: Number(d.credited_amount), refundedAmount: Number(d.refunded_amount),
      refunds: refunds.map((r) => ({ ...r, amount: Number(r.amount) })),
      ...(d.type === 'invoice' ? balance(d) : { remaining: 0, refundDue: 0 }), sourceInvoiceId: d.source_invoice_id, vatBreakdown, reminders,
      related: related.map((r) => ({ ...r, totalTtc: Number(r.totalTtc) })),
      lines: lines.map((l) => ({ id: l.id, productId: l.product_id, description: l.description, quantity: Number(l.quantity), unit: l.unit,
        unitPrice: Number(l.unit_price), discountPct: Number(l.discount_pct), vatRate: Number(l.vat_rate), totalHt: Number(l.total_ht), totalVat: Number(l.total_vat) })),
      payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    };
  }

  async create(t: TenantInfo, type: SalesDocType, input: DocInput) {
    const id = await this.db.tenant(t.ctx, async (trx) => {
      await this.customer(trx, input.contactId);
      const d = await trx.insertInto('sales_document').values({
        company_id: t.companyId, type, contact_id: input.contactId, issue_date: input.issueDate ?? today(), due_date: type === 'invoice' ? input.dueDate ?? null : null,
        valid_until: type === 'quote' ? input.validUntil ?? null : null, notes: input.notes ?? null, number: null, source_quote_id: null, validated_by: null, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      const totals = await this.writeLines(trx, t, d.id, input.lines);
      await trx.updateTable('sales_document').set({ total_ht: totals.ht, total_vat: totals.vat, total_ttc: totals.ttc }).where('id', '=', d.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `${type}.created`, entityType: 'sales_document', entityId: d.id, data: { totalTtc: totals.ttc } });
      return d.id;
    });
    return this.get(t, id);
  }

  async update(t: TenantInfo, id: string, input: Partial<DocInput>) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict(`${LABEL[d.type]} ${d.number} est validé(e) : il n'est plus modifiable.`, 'document_locked');
      if (d.type === 'credit_note' && input.contactId && input.contactId !== d.contact_id) throw badRequest("Le client d'un avoir est celui de la facture d'origine.", undefined, 'credit_note_contact');
      if (input.contactId) await this.customer(trx, input.contactId);
      const patch: Record<string, unknown> = {};
      if (input.contactId) patch.contact_id = input.contactId;
      if (input.issueDate) patch.issue_date = input.issueDate;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (d.type === 'invoice' && input.dueDate !== undefined) patch.due_date = input.dueDate;
      if (d.type === 'quote' && input.validUntil !== undefined) patch.valid_until = input.validUntil;
      if (d.type === 'credit_note' && input.restock !== undefined) patch.restock = input.restock;
      if (input.lines) {
        const totals = await this.writeLines(trx, t, id, input.lines);
        Object.assign(patch, { total_ht: totals.ht, total_vat: totals.vat, total_ttc: totals.ttc });
      }
      if (Object.keys(patch).length) await trx.updateTable('sales_document').set(patch).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `${d.type}.updated`, entityType: 'sales_document', entityId: id, data: { fields: Object.keys(patch) } });
    });
    return this.get(t, id);
  }

  async remove(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict('Seul un brouillon peut être supprimé. Une facture émise se corrige par un avoir.', 'document_locked');
      await trx.deleteFrom('sales_document').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `${d.type}.deleted`, entityType: 'sales_document', entityId: id, data: { totalTtc: Number(d.total_ttc) } });
      return { ok: true };
    });
  }

  /** Valide le brouillon : numéro définitif, date du jour, coordonnées du client figées, échéance calculée. */
  async validate(t: TenantInfo, id: string) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict('Ce document est déjà validé.', 'already_validated');
      const lines = await trx.selectFrom('sales_document_line').select('id').where('document_id', '=', id).execute();
      if (!lines.length) throw badRequest('Ajoutez au moins une ligne avant de valider.', undefined, 'no_lines');
      const c = d.type === 'credit_note'
        ? await trx.selectFrom('contact').selectAll().where('id', '=', d.contact_id).executeTakeFirstOrThrow()
        : await this.customer(trx, d.contact_id);
      if (d.type === 'credit_note') await this.applyCreditNote(trx, d);
      const issue = today();
      const number = await nextNumber(trx, t.companyId, d.type, PREFIX[d.type], Number(issue.slice(0, 4)));
      const customer = { code: c.code, name: c.name, taxId: c.tax_id, rccm: c.rccm, address: c.address, city: c.city, email: c.email, phone: c.phone };
      const dates = d.type === 'invoice' ? { due_date: d.due_date && d.due_date >= issue ? d.due_date : addDays(issue, c.payment_terms_days) }
        : d.type === 'quote' ? { valid_until: d.valid_until && d.valid_until >= issue ? d.valid_until : addDays(issue, QUOTE_VALIDITY_DAYS) } : {};
      await trx.updateTable('sales_document').set({
        status: d.type === 'quote' ? 'sent' : 'issued', number, issue_date: issue, customer: JSON.stringify(customer), validated_at: new Date(), validated_by: t.ctx.userId, ...dates,
      }).where('id', '=', id).execute();
      await this.stock.applySalesDocument(trx, t, id);
      await this.accounting.postSalesDocument(trx, t, id);
      await this.audit.tenant(trx, t.ctx, { action: `${d.type}.validated`, entityType: 'sales_document', entityId: id, data: { number, customer: c.name, totalTtc: Number(d.total_ttc) } });
    });
    return this.get(t, id);
  }

  async decideQuote(t: TenantInfo, id: string, accepted: boolean) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.type !== 'quote' || d.status !== 'sent') throw conflict("Seul un devis envoyé peut être accepté ou refusé.", 'invalid_state');
      await trx.updateTable('sales_document').set({ status: accepted ? 'accepted' : 'refused' }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: accepted ? 'quote.accepted' : 'quote.refused', entityType: 'sales_document', entityId: id, data: { number: d.number } });
    });
    return this.get(t, id);
  }

  /** Transforme un devis envoyé ou accepté en brouillon de facture reprenant ses lignes. */
  async convert(t: TenantInfo, id: string) {
    const invoiceId = await this.db.tenant(t.ctx, async (trx) => {
      const q = await this.doc(trx, id, true);
      if (q.type !== 'quote' || !['sent', 'accepted'].includes(q.status)) throw conflict('Seul un devis envoyé ou accepté peut être facturé.', 'invalid_state');
      await this.customer(trx, q.contact_id);
      const inv = await trx.insertInto('sales_document').values({
        company_id: t.companyId, type: 'invoice', contact_id: q.contact_id, issue_date: today(), notes: q.notes, source_quote_id: q.id,
        total_ht: q.total_ht, total_vat: q.total_vat, total_ttc: q.total_ttc, number: null, due_date: null, valid_until: null, validated_by: null, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      const lines = await trx.selectFrom('sales_document_line').selectAll().where('document_id', '=', q.id).orderBy('position').execute();
      await trx.insertInto('sales_document_line').values(lines.map(({ id: _id, document_id: _d, ...l }) => ({ ...l, document_id: inv.id }))).execute();
      await trx.updateTable('sales_document').set({ status: 'invoiced' }).where('id', '=', q.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'quote.invoiced', entityType: 'sales_document', entityId: q.id, data: { number: q.number, invoiceDraft: inv.id } });
      return inv.id;
    });
    return this.get(t, invoiceId);
  }

  async addPayment(t: TenantInfo, id: string, p: { amount: number; paidOn?: string; method: PaymentMethod; reference?: string | null; accountId?: string | null }) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.type !== 'invoice' || !OPEN_INVOICE.includes(d.status)) throw conflict("Un encaissement s'enregistre sur une facture émise et non soldée.", 'invalid_state');
      const { remaining } = balance(d);
      if (p.amount > remaining) throw badRequest(`Le montant dépasse le reste à payer (${remaining.toLocaleString('fr-FR')} FCFA).`, undefined, 'amount_too_high');
      const paidOn = p.paidOn ?? today();
      if (paidOn > today()) throw badRequest("La date d'encaissement ne peut pas être dans le futur.", undefined, 'future_date');
      const account = await this.treasury.resolveAccount(trx, p.accountId, p.method);
      const pay = await trx.insertInto('sales_payment').values({ company_id: t.companyId, document_id: id, amount: p.amount, paid_on: paidOn, method: p.method, reference: p.reference ?? null, created_by: t.ctx.userId })
        .returning('id').executeTakeFirstOrThrow();
      await this.treasury.record(trx, t, { accountId: account.id, date: paidOn, direction: 'in', amount: p.amount, category: 'customer_payment', label: `Encaissement ${d.number}`,
        contactId: d.contact_id, sourceType: 'sales_payment', sourceId: pay.id, reference: p.reference });
      const paid = Number(d.paid_amount) + p.amount;
      await trx.updateTable('sales_document').set({ paid_amount: paid, status: invoiceStatus(Number(d.total_ttc), paid, Number(d.credited_amount)) }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'invoice.payment_recorded', entityType: 'sales_document', entityId: id, data: { number: d.number, amount: p.amount, method: p.method } });
    });
    return this.get(t, id);
  }

  /** Rembourse au client tout ou partie du trop-perçu d'une facture (après avoir). */
  async refund(t: TenantInfo, id: string, r: { amount: number; method: PaymentMethod; accountId?: string | null; paidOn?: string; reference?: string | null }) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.type !== 'invoice' || d.status === 'draft') throw conflict('Un remboursement se rattache à une facture émise.', 'invalid_state');
      const { refundDue } = balance(d);
      if (refundDue <= 0) throw conflict(`La facture ${d.number} n'a pas de trop-perçu à rembourser.`, 'nothing_to_refund');
      if (r.amount > refundDue) throw badRequest(`Le remboursement dépasse le trop-perçu (${refundDue.toLocaleString('fr-FR')} FCFA).`, undefined, 'amount_too_high');
      const account = await this.treasury.resolveAccount(trx, r.accountId, r.method);
      await this.treasury.record(trx, t, { accountId: account.id, date: r.paidOn ?? today(), direction: 'out', amount: r.amount, category: 'customer_refund',
        label: `Remboursement du trop-perçu ${d.number}`, contactId: d.contact_id, sourceType: 'sales_refund', sourceId: d.id, reference: r.reference });
      await trx.updateTable('sales_document').set({ refunded_amount: Number(d.refunded_amount) + r.amount }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'invoice.refund_recorded', entityType: 'sales_document', entityId: id, data: { number: d.number, amount: r.amount, account: account.name } });
    });
    return this.get(t, id);
  }

  /** L'avoir validé diminue le reste à payer de sa facture ; il ne peut pas dépasser ce qui n'a pas encore été crédité. */
  private async applyCreditNote(trx: TenantTrx, cn: { source_invoice_id: string | null; total_ttc: string }) {
    const inv = await this.doc(trx, cn.source_invoice_id!, true);
    const creditable = Number(inv.total_ttc) - Number(inv.credited_amount);
    if (Number(cn.total_ttc) > creditable) {
      throw badRequest(`L'avoir (${Number(cn.total_ttc).toLocaleString('fr-FR')} FCFA) dépasse le montant encore créditable de la facture ${inv.number} (${creditable.toLocaleString('fr-FR')} FCFA).`, undefined, 'credit_too_high');
    }
    const credited = Number(inv.credited_amount) + Number(cn.total_ttc);
    await trx.updateTable('sales_document').set({ credited_amount: credited, status: invoiceStatus(Number(inv.total_ttc), Number(inv.paid_amount), credited) }).where('id', '=', inv.id).execute();
  }

  /** Prépare un avoir reprenant les lignes de la facture (à réduire pour un avoir partiel). */
  async createCreditNote(t: TenantInfo, invoiceId: string) {
    const id = await this.db.tenant(t.ctx, async (trx) => {
      const inv = await this.doc(trx, invoiceId, true);
      if (inv.type !== 'invoice' || inv.status === 'draft') throw conflict("Un avoir s'établit sur une facture émise. Un brouillon se modifie ou se supprime.", 'invalid_state');
      if (Number(inv.credited_amount) >= Number(inv.total_ttc)) throw conflict(`La facture ${inv.number} est déjà entièrement annulée par avoir.`, 'already_credited');
      const pending = await trx.selectFrom('sales_document').select('id').where('source_invoice_id', '=', inv.id).where('status', '=', 'draft').executeTakeFirst();
      if (pending) return pending.id;
      const cn = await trx.insertInto('sales_document').values({
        company_id: t.companyId, type: 'credit_note', contact_id: inv.contact_id, issue_date: today(), source_invoice_id: inv.id, notes: `Avoir sur la facture ${inv.number}`,
        total_ht: inv.total_ht, total_vat: inv.total_vat, total_ttc: inv.total_ttc, number: null, due_date: null, valid_until: null, source_quote_id: null, validated_by: null, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      const lines = await trx.selectFrom('sales_document_line').selectAll().where('document_id', '=', inv.id).orderBy('position').execute();
      await trx.insertInto('sales_document_line').values(lines.map(({ id: _id, document_id: _d, ...l }) => ({ ...l, document_id: cn.id }))).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'credit_note.created', entityType: 'sales_document', entityId: cn.id, data: { invoice: inv.number } });
      return cn.id;
    });
    return this.get(t, id);
  }

  // ------------------------------------------------------------------ envoi par e-mail et lien de consultation
  /** Lien de consultation sans compte, valable 90 jours : seul son empreinte est conservée. */
  private async shareLink(trx: TenantTrx, t: TenantInfo, documentId: string) {
    const secret = randomToken(24);
    const share = await trx.insertInto('document_share').values({
      company_id: t.companyId, document_id: documentId, token_hash: sha256(secret), expires_at: new Date(Date.now() + 90 * 86400_000), created_by: t.ctx.userId, last_viewed_at: null,
    }).returning('id').executeTakeFirstOrThrow();
    return `${config.webUrl}/document?token=${encodeURIComponent(`${t.companyId}.${share.id}.${secret}`)}`;
  }

  private async sender(trx: TenantTrx, t: TenantInfo) {
    const company = await trx.selectFrom('company').select(['name', 'email']).where('id', '=', t.companyId).executeTakeFirstOrThrow();
    const user = await trx.selectFrom('user_account').select(['full_name', 'email']).where('id', '=', t.ctx.userId).executeTakeFirstOrThrow();
    return { company, user, replyTo: company.email ?? user.email };
  }

  /** Envoie un devis, une facture ou un avoir au client, avec un lien vers sa version consultable et imprimable. */
  async send(t: TenantInfo, id: string, input: { to?: string | null; message?: string | null }) {
    const sent = await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id);
      if (d.status === 'draft') throw conflict("Un brouillon ne s'envoie pas : validez-le d'abord.", 'document_draft');
      const contact = await trx.selectFrom('contact').select(['name', 'email']).where('id', '=', d.contact_id).executeTakeFirstOrThrow();
      const to = input.to ?? contact.email;
      if (!to) throw badRequest(`Aucune adresse e-mail pour ${contact.name} : indiquez-en une ou complétez sa fiche.`, undefined, 'no_email');
      const { company, user, replyTo } = await this.sender(trx, t);
      const url = await this.shareLink(trx, t, id);
      const amount = `${Number(d.total_ttc).toLocaleString('fr-FR')} FCFA TTC`;
      const fr = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '');
      const intro = {
        quote: `Veuillez trouver notre devis ${d.number} d'un montant de ${amount}, valable jusqu'au ${fr(d.valid_until)}.`,
        invoice: `Veuillez trouver notre facture ${d.number} d'un montant de ${amount}${d.due_date ? `, à régler au plus tard le ${fr(d.due_date)}` : ''}.`,
        credit_note: `Veuillez trouver notre avoir ${d.number} d'un montant de ${amount}.`,
      }[d.type];
      await this.mail.enqueue(trx, {
        companyId: t.companyId, to, kind: 'sales_document', entityId: id, fromName: company.name, replyTo, createdBy: t.ctx.userId,
        subject: `${LABEL[d.type]} ${d.number} — ${company.name}`,
        paragraphs: [`Bonjour ${contact.name},`, intro, ...(input.message ? [input.message] : []), `Cordialement,\n${user.full_name}\n${company.name}`],
        action: { label: `Consulter ${d.type === 'invoice' ? 'la facture' : d.type === 'quote' ? 'le devis' : "l'avoir"}`, url },
      });
      await this.audit.tenant(trx, t.ctx, { action: 'sales_document.sent', entityType: 'sales_document', entityId: id, data: { number: d.number, to } });
      return { to, url };
    });
    return { ...(await this.get(t, id)), sentTo: sent.to };
  }

  /** Page de consultation d'un document par son destinataire (lien reçu par e-mail). */
  async publicView(token: string) {
    const [companyId, shareId, secret] = (token ?? '').split('.');
    if (!isUuid(companyId) || !isUuid(shareId) || !secret) throw notFound('Document');
    return this.db.identity(async (trx) => {
      const tt = await setTenantContext(trx, companyId, '00000000-0000-0000-0000-000000000000');
      const share = await tt.selectFrom('document_share').selectAll().where('id', '=', shareId).executeTakeFirst();
      if (!share || !safeEqual(share.token_hash, sha256(secret)) || new Date(share.expires_at) < new Date()) throw notFound('Document');
      await tt.updateTable('document_share').set({ views: share.views + 1, last_viewed_at: new Date() }).where('id', '=', shareId).execute();
      const company = await tt.selectFrom('company').select(['name', 'address', 'city', 'phone', 'email', 'rccm', 'tax_id as taxId', 'tax_regime as taxRegime'])
        .where('id', '=', companyId).executeTakeFirstOrThrow();
      const v = await this.view(tt, share.document_id);
      // Seul ce qui figure sur le document imprimé est montré : ni relances, ni historique interne.
      return {
        company, type: v.type, number: v.number, status: v.status, issueDate: v.issueDate, dueDate: v.dueDate, validUntil: v.validUntil, customer: v.customer, notes: v.notes,
        lines: v.lines, vatBreakdown: v.vatBreakdown, totalHt: v.totalHt, totalVat: v.totalVat, totalTtc: v.totalTtc, paidAmount: v.paidAmount,
        creditedAmount: v.creditedAmount, remaining: v.remaining,
      };
    });
  }

  async addReminder(t: TenantInfo, id: string, r: { channel: ReminderChannel; note?: string | null; promisedOn?: string | null; sendEmail?: boolean; message?: string | null; to?: string | null }) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id);
      if (d.type !== 'invoice' || !OPEN_INVOICE.includes(d.status)) throw conflict('Seule une facture émise et non soldée peut être relancée.', 'invalid_state');
      if (r.promisedOn && r.promisedOn < today()) throw badRequest('La date de paiement promise ne peut pas être passée.', undefined, 'past_date');
      if (r.sendEmail) {
        // Relance envoyée par Kora : le message préparé part avec un lien vers la facture.
        const contact = await trx.selectFrom('contact').select(['name', 'email']).where('id', '=', d.contact_id).executeTakeFirstOrThrow();
        const to = r.to ?? contact.email;
        if (!to) throw badRequest(`Aucune adresse e-mail pour ${contact.name} : indiquez-en une ou complétez sa fiche.`, undefined, 'no_email');
        if (!r.message?.trim()) throw badRequest('Le message de relance est vide.', undefined, 'empty_message');
        const { company, replyTo } = await this.sender(trx, t);
        await this.mail.enqueue(trx, {
          companyId: t.companyId, to, kind: 'reminder', entityId: id, fromName: company.name, replyTo, createdBy: t.ctx.userId,
          subject: `Relance — facture ${d.number} — ${company.name}`, paragraphs: r.message.split(/\n{2,}/), action: { label: 'Consulter la facture', url: await this.shareLink(trx, t, id) },
        });
        r = { ...r, channel: 'email', note: [r.note, `E-mail envoyé à ${to}`].filter(Boolean).join(' — ') };
      }
      await trx.insertInto('sales_reminder').values({ company_id: t.companyId, document_id: id, channel: r.channel, note: r.note ?? null, promised_on: r.promisedOn ?? null, created_by: t.ctx.userId }).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'invoice.reminder_recorded', entityType: 'sales_document', entityId: id, data: { number: d.number, channel: r.channel } });
    });
    return this.get(t, id);
  }

  /** Créances clients : factures non soldées, ancienneté du retard et dernière relance. */
  async receivables(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const now = today();
      const rows = await trx.selectFrom('sales_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .select((eb) => ['d.id', 'd.number', 'd.issue_date', 'd.due_date', 'd.total_ttc', 'd.paid_amount', 'd.credited_amount', 'd.refunded_amount', 'c.id as contactId', 'c.code as contactCode', 'c.name as contactName', 'c.phone', 'c.email',
          eb.selectFrom('sales_reminder as r').whereRef('r.document_id', '=', 'd.id').select(eb.fn.countAll<string>().as('n')).as('reminderCount'),
          eb.selectFrom('sales_reminder as r').whereRef('r.document_id', '=', 'd.id').select((e) => e.fn.max('r.created_at').as('m')).as('lastReminderAt'),
          eb.selectFrom('sales_reminder as r').whereRef('r.document_id', '=', 'd.id').where('r.promised_on', 'is not', null).orderBy('r.created_at', 'desc').limit(1).select('r.promised_on').as('promisedOn')])
        .where('d.type', '=', 'invoice').where('d.status', 'in', OPEN_INVOICE).orderBy('d.due_date').execute();
      const invoices = rows.map((r) => {
        const daysLate = r.due_date ? Math.floor((Date.parse(now) - Date.parse(r.due_date)) / 86400_000) : 0;
        return {
          id: r.id, number: r.number, issueDate: r.issue_date, dueDate: r.due_date, daysLate, remaining: balance(r).remaining,
          bucket: daysLate <= 0 ? 'not_due' : daysLate <= 30 ? 'd30' : daysLate <= 60 ? 'd60' : daysLate <= 90 ? 'd90' : 'over90',
          contact: { id: r.contactId, code: r.contactCode, name: r.contactName, phone: r.phone, email: r.email },
          reminderCount: Number(r.reminderCount), lastReminderAt: r.lastReminderAt, promisedOn: r.promisedOn,
        };
      });
      const totals = { not_due: 0, d30: 0, d60: 0, d90: 0, over90: 0 } as Record<string, number>;
      for (const i of invoices) totals[i.bucket] += i.remaining;
      return { invoices, totals, total: invoices.reduce((s, i) => s + i.remaining, 0) };
    });
  }

  /** Indicateurs du tableau de bord : chiffre d'affaires, encaissements et créances. */
  async summary(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const now = today();
      const monthStart = `${now.slice(0, 7)}-01`;
      const inv = await trx.selectFrom('sales_document').select(['status', 'issue_date', 'due_date', 'total_ht', 'total_ttc', 'paid_amount', 'credited_amount', 'refunded_amount'])
        .where('type', '=', 'invoice').where('status', '!=', 'draft').execute();
      const credits = await trx.selectFrom('sales_document').select('total_ht').where('type', '=', 'credit_note').where('status', '=', 'issued').where('issue_date', '>=', monthStart).execute();
      const pay = await trx.selectFrom('sales_payment').select('amount').where('paid_on', '>=', monthStart).execute();
      const quotes = await trx.selectFrom('sales_document').select((eb) => eb.fn.countAll<string>().as('c')).where('type', '=', 'quote').where('status', 'in', ['sent', 'accepted']).executeTakeFirstOrThrow();
      const open = inv.filter((i) => OPEN_INVOICE.includes(i.status));
      const overdue = open.filter((i) => i.due_date && i.due_date < now);
      const due = (rows: typeof inv) => rows.reduce((s, i) => s + balance(i).remaining, 0);
      return {
        // Chiffre d'affaires net : factures émises dans le mois moins avoirs émis dans le mois.
        revenueMonthHt: inv.filter((i) => i.issue_date >= monthStart).reduce((s, i) => s + Number(i.total_ht), 0) - credits.reduce((s, c) => s + Number(c.total_ht), 0),
        collectedMonth: pay.reduce((s, p) => s + Number(p.amount), 0), outstanding: due(open), overdueAmount: due(overdue), overdueCount: overdue.length, openQuotes: Number(quotes.c),
      };
    });
  }

  async exportRows(t: TenantInfo, type: SalesDocType) {
    const rows = await this.list(t, { type });
    await this.db.tenant(t.ctx, (trx) => this.audit.tenant(trx, t.ctx, { action: `${type}.exported`, data: { count: rows.length } }));
    return rows.filter((r) => r.number).map((r) => ({
      numero: r.number, date: r.issueDate, ...(r.type === 'credit_note' ? {} : { echeance: r.type === 'invoice' ? r.dueDate : r.validUntil }), client_code: r.contactCode, client: r.contactName,
      statut: r.status, total_ht: r.totalHt, tva: r.totalVat, total_ttc: r.totalTtc,
      ...(r.type === 'invoice' ? { encaisse: r.paidAmount, avoirs: r.creditedAmount, reste_a_payer: r.remaining } : {}),
    }));
  }
}
