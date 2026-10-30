import { Injectable } from '@nestjs/common';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { PaymentMethod, SalesDocType } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

export interface LineInput { productId?: string | null; description: string; quantity: number; unit?: string | null; unitPrice: number; discountPct?: number; vatRate: number }
export interface DocInput { contactId: string; issueDate?: string; dueDate?: string | null; validUntil?: string | null; notes?: string | null; lines: LineInput[] }

const PREFIX: Record<SalesDocType, string> = { quote: 'DEV', invoice: 'FAC' };
const LABEL: Record<SalesDocType, string> = { quote: 'Devis', invoice: 'Facture' };
const QUOTE_VALIDITY_DAYS = 30;

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Montants en francs CFA entiers : chaque ligne est arrondie, puis les lignes sont additionnées. */
export function computeLine(l: Pick<LineInput, 'quantity' | 'unitPrice' | 'discountPct' | 'vatRate'>) {
  const ht = Math.round(l.quantity * l.unitPrice * (1 - (l.discountPct ?? 0) / 100));
  return { ht, vat: Math.round((ht * l.vatRate) / 100) };
}
export function computeTotals(lines: LineInput[]) {
  const totals = lines.map(computeLine);
  const ht = totals.reduce((s, x) => s + x.ht, 0);
  const vat = totals.reduce((s, x) => s + x.vat, 0);
  return { lines: totals, ht, vat, ttc: ht + vat };
}

@Injectable()
export class SalesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

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
          'd.total_ht as totalHt', 'd.total_vat as totalVat', 'd.total_ttc as totalTtc', 'd.paid_amount as paidAmount', 'd.currency', 'c.id as contactId', 'c.name as contactName', 'c.code as contactCode'])
        .where('d.type', '=', f.type).orderBy('d.created_at', 'desc').limit(1000);
      if (f.status) q = q.where('d.status', '=', f.status as any);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('d.number', 'ilike', like), eb('c.name', 'ilike', like), eb('c.code', 'ilike', like)]));
      }
      const rows = await q.execute();
      const now = today();
      return rows.map((r) => ({
        ...r, totalHt: Number(r.totalHt), totalVat: Number(r.totalVat), totalTtc: Number(r.totalTtc), paidAmount: Number(r.paidAmount),
        overdue: r.type === 'invoice' && ['issued', 'partially_paid'].includes(r.status) && !!r.dueDate && r.dueDate < now,
      }));
    });
  }

  async get(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id);
      const contact = await trx.selectFrom('contact').select(['id', 'code', 'name', 'tax_id as taxId', 'rccm', 'email', 'phone', 'address', 'city', 'payment_terms_days as paymentTermsDays'])
        .where('id', '=', d.contact_id).executeTakeFirstOrThrow();
      const lines = await trx.selectFrom('sales_document_line').selectAll().where('document_id', '=', id).orderBy('position').execute();
      const payments = await trx.selectFrom('sales_payment').select(['id', 'amount', 'paid_on as paidOn', 'method', 'reference', 'created_at as createdAt'])
        .where('document_id', '=', id).orderBy('paid_on').orderBy('created_at').execute();
      const related = await trx.selectFrom('sales_document').select(['id', 'type', 'number', 'status'])
        .where((eb) => eb.or([eb('id', '=', d.source_quote_id ?? id), eb('source_quote_id', '=', id)])).where('id', '!=', id).execute();
      const vatBreakdown = Object.values(lines.reduce<Record<string, { rate: number; base: number; vat: number }>>((acc, l) => {
        const k = String(Number(l.vat_rate));
        acc[k] ??= { rate: Number(l.vat_rate), base: 0, vat: 0 };
        acc[k].base += Number(l.total_ht); acc[k].vat += Number(l.total_vat);
        return acc;
      }, {})).sort((a, b) => b.rate - a.rate);
      return {
        id: d.id, type: d.type, status: d.status, number: d.number, issueDate: d.issue_date, dueDate: d.due_date, validUntil: d.valid_until,
        currency: d.currency, notes: d.notes, validatedAt: d.validated_at, sourceQuoteId: d.source_quote_id,
        customer: d.status === 'draft' ? contact : { ...contact, ...(d.customer as object) }, contact,
        totalHt: Number(d.total_ht), totalVat: Number(d.total_vat), totalTtc: Number(d.total_ttc), paidAmount: Number(d.paid_amount),
        remaining: Number(d.total_ttc) - Number(d.paid_amount), vatBreakdown, related,
        lines: lines.map((l) => ({ id: l.id, productId: l.product_id, description: l.description, quantity: Number(l.quantity), unit: l.unit,
          unitPrice: Number(l.unit_price), discountPct: Number(l.discount_pct), vatRate: Number(l.vat_rate), totalHt: Number(l.total_ht), totalVat: Number(l.total_vat) })),
        payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
      };
    });
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
      if (input.contactId) await this.customer(trx, input.contactId);
      const patch: Record<string, unknown> = {};
      if (input.contactId) patch.contact_id = input.contactId;
      if (input.issueDate) patch.issue_date = input.issueDate;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (d.type === 'invoice' && input.dueDate !== undefined) patch.due_date = input.dueDate;
      if (d.type === 'quote' && input.validUntil !== undefined) patch.valid_until = input.validUntil;
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
      const c = await this.customer(trx, d.contact_id);
      const issue = today();
      const number = await nextNumber(trx, t.companyId, d.type, PREFIX[d.type], Number(issue.slice(0, 4)));
      const customer = { code: c.code, name: c.name, taxId: c.tax_id, rccm: c.rccm, address: c.address, city: c.city, email: c.email, phone: c.phone };
      const dates = d.type === 'invoice'
        ? { due_date: d.due_date && d.due_date >= issue ? d.due_date : addDays(issue, c.payment_terms_days) }
        : { valid_until: d.valid_until && d.valid_until >= issue ? d.valid_until : addDays(issue, QUOTE_VALIDITY_DAYS) };
      await trx.updateTable('sales_document').set({
        status: d.type === 'invoice' ? 'issued' : 'sent', number, issue_date: issue, customer: JSON.stringify(customer), validated_at: new Date(), validated_by: t.ctx.userId, ...dates,
      }).where('id', '=', id).execute();
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

  async addPayment(t: TenantInfo, id: string, p: { amount: number; paidOn?: string; method: PaymentMethod; reference?: string | null }) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.type !== 'invoice' || !['issued', 'partially_paid'].includes(d.status)) throw conflict("Un encaissement s'enregistre sur une facture émise et non soldée.", 'invalid_state');
      const remaining = Number(d.total_ttc) - Number(d.paid_amount);
      if (p.amount > remaining) throw badRequest(`Le montant dépasse le reste à payer (${remaining.toLocaleString('fr-FR')} FCFA).`, undefined, 'amount_too_high');
      const paidOn = p.paidOn ?? today();
      if (paidOn > today()) throw badRequest("La date d'encaissement ne peut pas être dans le futur.", undefined, 'future_date');
      await trx.insertInto('sales_payment').values({ company_id: t.companyId, document_id: id, amount: p.amount, paid_on: paidOn, method: p.method, reference: p.reference ?? null, created_by: t.ctx.userId }).execute();
      const paid = Number(d.paid_amount) + p.amount;
      await trx.updateTable('sales_document').set({ paid_amount: paid, status: paid >= Number(d.total_ttc) ? 'paid' : 'partially_paid' }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'invoice.payment_recorded', entityType: 'sales_document', entityId: id, data: { number: d.number, amount: p.amount, method: p.method } });
    });
    return this.get(t, id);
  }

  /** Indicateurs du tableau de bord : chiffre d'affaires, encaissements et créances. */
  async summary(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const now = today();
      const monthStart = `${now.slice(0, 7)}-01`;
      const inv = await trx.selectFrom('sales_document').select(['status', 'issue_date', 'due_date', 'total_ht', 'total_ttc', 'paid_amount'])
        .where('type', '=', 'invoice').where('status', '!=', 'draft').execute();
      const pay = await trx.selectFrom('sales_payment').select('amount').where('paid_on', '>=', monthStart).execute();
      const quotes = await trx.selectFrom('sales_document').select((eb) => eb.fn.countAll<string>().as('c')).where('type', '=', 'quote').where('status', 'in', ['sent', 'accepted']).executeTakeFirstOrThrow();
      const open = inv.filter((i) => i.status === 'issued' || i.status === 'partially_paid');
      const overdue = open.filter((i) => i.due_date && i.due_date < now);
      const due = (rows: typeof inv) => rows.reduce((s, i) => s + Number(i.total_ttc) - Number(i.paid_amount), 0);
      return {
        revenueMonthHt: inv.filter((i) => i.issue_date >= monthStart).reduce((s, i) => s + Number(i.total_ht), 0),
        collectedMonth: pay.reduce((s, p) => s + Number(p.amount), 0), outstanding: due(open), overdueAmount: due(overdue), overdueCount: overdue.length, openQuotes: Number(quotes.c),
      };
    });
  }

  async exportRows(t: TenantInfo, type: SalesDocType) {
    const rows = await this.list(t, { type });
    await this.db.tenant(t.ctx, (trx) => this.audit.tenant(trx, t.ctx, { action: `${type}.exported`, data: { count: rows.length } }));
    return rows.filter((r) => r.number).map((r) => ({
      numero: r.number, date: r.issueDate, echeance: r.type === 'invoice' ? r.dueDate : r.validUntil, client_code: r.contactCode, client: r.contactName,
      statut: r.status, total_ht: r.totalHt, tva: r.totalVat, total_ttc: r.totalTtc, ...(r.type === 'invoice' ? { encaisse: r.paidAmount, reste_a_payer: r.totalTtc - r.paidAmount } : {}),
    }));
  }
}
