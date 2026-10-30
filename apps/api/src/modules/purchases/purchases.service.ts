import { Injectable } from '@nestjs/common';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { PaymentMethod, PurchaseDocStatus, PurchaseDocType } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { addDays, computeTotals, LineInput, today } from '../sales/sales.service';

export interface PurchaseInput {
  contactId: string; supplierRef?: string | null; issueDate?: string; dueDate?: string | null; expectedDate?: string | null; notes?: string | null; lines: LineInput[];
}

const PREFIX: Record<PurchaseDocType, string> = { order: 'BC', invoice: 'ACH' };
const LABEL: Record<PurchaseDocType, string> = { order: 'Le bon de commande', invoice: 'La facture fournisseur' };
const OPEN: PurchaseDocStatus[] = ['to_pay', 'partially_paid'];
const remainingOf = (d: { total_ttc: string; paid_amount: string }) => Math.max(0, Number(d.total_ttc) - Number(d.paid_amount));

@Injectable()
export class PurchasesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private async doc(trx: TenantTrx, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Document');
    const d = await trx.selectFrom('purchase_document').selectAll().where('id', '=', id).$if(lock, (q) => q.forUpdate()).executeTakeFirst();
    if (!d) throw notFound('Document');
    return d;
  }

  private async supplier(trx: TenantTrx, contactId: string) {
    if (!isUuid(contactId)) throw badRequest('Fournisseur introuvable.', undefined, 'unknown_contact');
    const c = await trx.selectFrom('contact').selectAll().where('id', '=', contactId).executeTakeFirst();
    if (!c) throw badRequest('Fournisseur introuvable.', undefined, 'unknown_contact');
    if (c.archived_at) throw conflict(`Le contact ${c.code} est archivé.`, 'contact_archived');
    if (c.kind === 'customer') throw badRequest(`${c.name} est enregistré comme client uniquement : modifiez sa fiche pour en faire aussi un fournisseur.`, undefined, 'not_a_supplier');
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
    await trx.deleteFrom('purchase_document_line').where('document_id', '=', documentId).execute();
    await trx.insertInto('purchase_document_line').values(lines.map((l, i) => ({
      company_id: t.companyId, document_id: documentId, position: i + 1, product_id: l.productId ?? null, description: l.description,
      quantity: l.quantity, unit: l.unit ?? null, unit_price: l.unitPrice, discount_pct: l.discountPct ?? 0, vat_rate: l.vatRate,
      total_ht: totals.lines[i].ht, total_vat: totals.lines[i].vat,
    }))).execute();
    return totals;
  }

  /** Refuse d'enregistrer deux fois la même facture d'un fournisseur. */
  private async assertNotDuplicate(trx: TenantTrx, contactId: string, ref: string, exceptId: string) {
    const dup = await trx.selectFrom('purchase_document').select(['number']).where('type', '=', 'invoice').where('status', '!=', 'draft')
      .where('contact_id', '=', contactId).where('id', '!=', exceptId)
      .where((eb) => eb(eb.fn('lower', [eb.fn('trim', ['supplier_ref'])]), '=', ref.trim().toLowerCase())).executeTakeFirst();
    if (dup) throw conflict(`Cette facture fournisseur (réf. ${ref}) est déjà enregistrée sous le numéro ${dup.number}.`, 'duplicate_supplier_invoice');
  }

  async list(t: TenantInfo, f: { type: PurchaseDocType; status?: string; q?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('purchase_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .select(['d.id', 'd.type', 'd.status', 'd.number', 'd.supplier_ref as supplierRef', 'd.issue_date as issueDate', 'd.due_date as dueDate', 'd.expected_date as expectedDate',
          'd.total_ht as totalHt', 'd.total_vat as totalVat', 'd.total_ttc as totalTtc', 'd.paid_amount as paidAmount', 'd.currency', 'c.id as contactId', 'c.name as contactName', 'c.code as contactCode'])
        .where('d.type', '=', f.type).orderBy('d.created_at', 'desc').limit(1000);
      if (f.status) q = q.where('d.status', '=', f.status as PurchaseDocStatus);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('d.number', 'ilike', like), eb('d.supplier_ref', 'ilike', like), eb('c.name', 'ilike', like), eb('c.code', 'ilike', like)]));
      }
      const now = today();
      return (await q.execute()).map((r) => ({
        ...r, totalHt: Number(r.totalHt), totalVat: Number(r.totalVat), totalTtc: Number(r.totalTtc), paidAmount: Number(r.paidAmount),
        remaining: r.type === 'invoice' && r.status !== 'draft' ? Math.max(0, Number(r.totalTtc) - Number(r.paidAmount)) : 0,
        overdue: r.type === 'invoice' && OPEN.includes(r.status) && !!r.dueDate && r.dueDate < now,
      }));
    });
  }

  async get(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id);
      const contact = await trx.selectFrom('contact').select(['id', 'code', 'name', 'tax_id as taxId', 'rccm', 'email', 'phone', 'address', 'city', 'payment_terms_days as paymentTermsDays'])
        .where('id', '=', d.contact_id).executeTakeFirstOrThrow();
      const lines = await trx.selectFrom('purchase_document_line').selectAll().where('document_id', '=', id).orderBy('position').execute();
      const payments = await trx.selectFrom('purchase_payment').select(['id', 'amount', 'paid_on as paidOn', 'method', 'reference', 'created_at as createdAt'])
        .where('document_id', '=', id).orderBy('paid_on').orderBy('created_at').execute();
      const related = await trx.selectFrom('purchase_document').select(['id', 'type', 'number', 'status'])
        .where((eb) => eb.or([eb('id', '=', d.source_order_id ?? id), eb('source_order_id', '=', id)])).where('id', '!=', id).execute();
      const vatBreakdown = Object.values(lines.reduce<Record<string, { rate: number; base: number; vat: number }>>((acc, l) => {
        const k = String(Number(l.vat_rate));
        acc[k] ??= { rate: Number(l.vat_rate), base: 0, vat: 0 };
        acc[k].base += Number(l.total_ht); acc[k].vat += Number(l.total_vat);
        return acc;
      }, {})).sort((a, b) => b.rate - a.rate);
      return {
        id: d.id, type: d.type, status: d.status, number: d.number, supplierRef: d.supplier_ref, issueDate: d.issue_date, dueDate: d.due_date, expectedDate: d.expected_date,
        currency: d.currency, notes: d.notes, validatedAt: d.validated_at, sourceOrderId: d.source_order_id,
        supplier: d.status === 'draft' ? contact : { ...contact, ...(d.supplier as object) }, contact,
        totalHt: Number(d.total_ht), totalVat: Number(d.total_vat), totalTtc: Number(d.total_ttc), paidAmount: Number(d.paid_amount),
        remaining: d.type === 'invoice' && d.status !== 'draft' ? remainingOf(d) : 0, vatBreakdown, related,
        lines: lines.map((l) => ({ id: l.id, productId: l.product_id, description: l.description, quantity: Number(l.quantity), unit: l.unit,
          unitPrice: Number(l.unit_price), discountPct: Number(l.discount_pct), vatRate: Number(l.vat_rate), totalHt: Number(l.total_ht), totalVat: Number(l.total_vat) })),
        payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
      };
    });
  }

  async create(t: TenantInfo, type: PurchaseDocType, input: PurchaseInput) {
    if (input.issueDate && input.issueDate > today()) throw badRequest('La date du document ne peut pas être dans le futur.', undefined, 'future_date');
    const id = await this.db.tenant(t.ctx, async (trx) => {
      await this.supplier(trx, input.contactId);
      const d = await trx.insertInto('purchase_document').values({
        company_id: t.companyId, type, contact_id: input.contactId, issue_date: input.issueDate ?? today(), notes: input.notes ?? null, number: null,
        supplier_ref: type === 'invoice' ? input.supplierRef ?? null : null, due_date: type === 'invoice' ? input.dueDate ?? null : null,
        expected_date: type === 'order' ? input.expectedDate ?? null : null, source_order_id: null, validated_by: null, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      const totals = await this.writeLines(trx, t, d.id, input.lines);
      await trx.updateTable('purchase_document').set({ total_ht: totals.ht, total_vat: totals.vat, total_ttc: totals.ttc }).where('id', '=', d.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `purchase_${type}.created`, entityType: 'purchase_document', entityId: d.id, data: { totalTtc: totals.ttc } });
      return d.id;
    });
    return this.get(t, id);
  }

  async update(t: TenantInfo, id: string, input: Partial<PurchaseInput>) {
    if (input.issueDate && input.issueDate > today()) throw badRequest('La date du document ne peut pas être dans le futur.', undefined, 'future_date');
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict(`${LABEL[d.type]} ${d.number} est validé(e) : il n'est plus modifiable.`, 'document_locked');
      if (input.contactId) await this.supplier(trx, input.contactId);
      const patch: Record<string, unknown> = {};
      if (input.contactId) patch.contact_id = input.contactId;
      if (input.issueDate) patch.issue_date = input.issueDate;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (d.type === 'invoice' && input.supplierRef !== undefined) patch.supplier_ref = input.supplierRef;
      if (d.type === 'invoice' && input.dueDate !== undefined) patch.due_date = input.dueDate;
      if (d.type === 'order' && input.expectedDate !== undefined) patch.expected_date = input.expectedDate;
      if (input.lines) {
        const totals = await this.writeLines(trx, t, id, input.lines);
        Object.assign(patch, { total_ht: totals.ht, total_vat: totals.vat, total_ttc: totals.ttc });
      }
      if (Object.keys(patch).length) await trx.updateTable('purchase_document').set(patch).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `purchase_${d.type}.updated`, entityType: 'purchase_document', entityId: id, data: { fields: Object.keys(patch) } });
    });
    return this.get(t, id);
  }

  async remove(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict('Seul un brouillon peut être supprimé.', 'document_locked');
      await trx.deleteFrom('purchase_document').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `purchase_${d.type}.deleted`, entityType: 'purchase_document', entityId: id, data: { totalTtc: Number(d.total_ttc) } });
      return { ok: true };
    });
  }

  /**
   * Valide le brouillon : numéro interne, fournisseur figé.
   * Commande : datée du jour. Facture : garde la date du fournisseur, exige sa référence et refuse un doublon.
   */
  async validate(t: TenantInfo, id: string) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict('Ce document est déjà validé.', 'already_validated');
      const lines = await trx.selectFrom('purchase_document_line').select('id').where('document_id', '=', id).execute();
      if (!lines.length) throw badRequest('Ajoutez au moins une ligne avant de valider.', undefined, 'no_lines');
      const c = await this.supplier(trx, d.contact_id);
      if (d.type === 'invoice') {
        if (!d.supplier_ref?.trim()) throw badRequest('Indiquez le numéro de la facture du fournisseur avant de la valider.', undefined, 'supplier_ref_required');
        await this.assertNotDuplicate(trx, d.contact_id, d.supplier_ref, id);
      }
      const now = today();
      const issue = d.type === 'order' ? now : d.issue_date;
      const number = await nextNumber(trx, t.companyId, `purchase_${d.type}`, PREFIX[d.type], Number(now.slice(0, 4)));
      const supplier = { code: c.code, name: c.name, taxId: c.tax_id, rccm: c.rccm, address: c.address, city: c.city, email: c.email, phone: c.phone };
      await trx.updateTable('purchase_document').set({
        status: d.type === 'order' ? 'sent' : 'to_pay', number, issue_date: issue, supplier: JSON.stringify(supplier), validated_at: new Date(), validated_by: t.ctx.userId,
        ...(d.type === 'invoice' ? { due_date: d.due_date ?? addDays(issue, c.payment_terms_days) } : {}),
      }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `purchase_${d.type}.validated`, entityType: 'purchase_document', entityId: id, data: { number, supplier: c.name, supplierRef: d.supplier_ref, totalTtc: Number(d.total_ttc) } });
    });
    return this.get(t, id);
  }

  async cancelOrder(t: TenantInfo, id: string) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.type !== 'order' || d.status !== 'sent') throw conflict('Seul un bon de commande envoyé peut être annulé.', 'invalid_state');
      await trx.updateTable('purchase_document').set({ status: 'cancelled' }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'purchase_order.cancelled', entityType: 'purchase_document', entityId: id, data: { number: d.number } });
    });
    return this.get(t, id);
  }

  /** Prépare la facture fournisseur correspondant à un bon de commande envoyé (lignes reprises, à ajuster selon la facture reçue). */
  async convert(t: TenantInfo, id: string) {
    const invoiceId = await this.db.tenant(t.ctx, async (trx) => {
      const o = await this.doc(trx, id, true);
      if (o.type !== 'order' || o.status !== 'sent') throw conflict('Seul un bon de commande envoyé peut être facturé.', 'invalid_state');
      await this.supplier(trx, o.contact_id);
      const inv = await trx.insertInto('purchase_document').values({
        company_id: t.companyId, type: 'invoice', contact_id: o.contact_id, issue_date: today(), notes: o.notes, source_order_id: o.id,
        total_ht: o.total_ht, total_vat: o.total_vat, total_ttc: o.total_ttc, number: null, supplier_ref: null, due_date: null, expected_date: null, validated_by: null, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      const lines = await trx.selectFrom('purchase_document_line').selectAll().where('document_id', '=', o.id).orderBy('position').execute();
      await trx.insertInto('purchase_document_line').values(lines.map(({ id: _id, document_id: _d, ...l }) => ({ ...l, document_id: inv.id }))).execute();
      await trx.updateTable('purchase_document').set({ status: 'invoiced' }).where('id', '=', o.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'purchase_order.invoiced', entityType: 'purchase_document', entityId: o.id, data: { number: o.number, invoiceDraft: inv.id } });
      return inv.id;
    });
    return this.get(t, invoiceId);
  }

  async addPayment(t: TenantInfo, id: string, p: { amount: number; paidOn?: string; method: PaymentMethod; reference?: string | null }) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.type !== 'invoice' || !OPEN.includes(d.status)) throw conflict("Un règlement s'enregistre sur une facture fournisseur validée et non soldée.", 'invalid_state');
      const remaining = remainingOf(d);
      if (p.amount > remaining) throw badRequest(`Le montant dépasse le reste à payer (${remaining.toLocaleString('fr-FR')} FCFA).`, undefined, 'amount_too_high');
      const paidOn = p.paidOn ?? today();
      if (paidOn > today()) throw badRequest('La date du règlement ne peut pas être dans le futur.', undefined, 'future_date');
      await trx.insertInto('purchase_payment').values({ company_id: t.companyId, document_id: id, amount: p.amount, paid_on: paidOn, method: p.method, reference: p.reference ?? null, created_by: t.ctx.userId }).execute();
      const paid = Number(d.paid_amount) + p.amount;
      await trx.updateTable('purchase_document').set({ paid_amount: paid, status: paid >= Number(d.total_ttc) ? 'paid' : 'partially_paid' }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'purchase_invoice.payment_recorded', entityType: 'purchase_document', entityId: id, data: { number: d.number, amount: p.amount, method: p.method } });
    });
    return this.get(t, id);
  }

  /** Dettes fournisseurs : factures non soldées, classées par ancienneté de l'échéance. */
  async payables(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const now = today();
      const rows = await trx.selectFrom('purchase_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .select(['d.id', 'd.number', 'd.supplier_ref', 'd.issue_date', 'd.due_date', 'd.total_ttc', 'd.paid_amount', 'c.id as contactId', 'c.code as contactCode', 'c.name as contactName', 'c.phone'])
        .where('d.type', '=', 'invoice').where('d.status', 'in', OPEN).orderBy('d.due_date').execute();
      const invoices = rows.map((r) => {
        const daysLate = r.due_date ? Math.floor((Date.parse(now) - Date.parse(r.due_date)) / 86400_000) : 0;
        return {
          id: r.id, number: r.number, supplierRef: r.supplier_ref, issueDate: r.issue_date, dueDate: r.due_date, daysLate, remaining: remainingOf(r),
          bucket: daysLate <= 0 ? 'not_due' : daysLate <= 30 ? 'd30' : daysLate <= 60 ? 'd60' : daysLate <= 90 ? 'd90' : 'over90',
          contact: { id: r.contactId, code: r.contactCode, name: r.contactName, phone: r.phone },
        };
      });
      const totals = { not_due: 0, d30: 0, d60: 0, d90: 0, over90: 0 } as Record<string, number>;
      for (const i of invoices) totals[i.bucket] += i.remaining;
      // Échéancier : ce qui arrive à échéance dans les 7 et 30 prochains jours
      const dueWithin = (days: number) => invoices.filter((i) => i.dueDate && i.dueDate >= now && i.dueDate <= addDays(now, days)).reduce((s, i) => s + i.remaining, 0);
      return { invoices, totals, total: invoices.reduce((s, i) => s + i.remaining, 0), dueIn7Days: dueWithin(7), dueIn30Days: dueWithin(30) };
    });
  }

  async summary(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const now = today();
      const monthStart = `${now.slice(0, 7)}-01`;
      const inv = await trx.selectFrom('purchase_document').select(['status', 'issue_date', 'due_date', 'total_ht', 'total_ttc', 'paid_amount'])
        .where('type', '=', 'invoice').where('status', '!=', 'draft').execute();
      const paid = await trx.selectFrom('purchase_payment').select('amount').where('paid_on', '>=', monthStart).execute();
      const orders = await trx.selectFrom('purchase_document').select('id').where('type', '=', 'order').where('status', '=', 'sent').execute();
      const open = inv.filter((i) => OPEN.includes(i.status));
      const overdue = open.filter((i) => i.due_date && i.due_date < now);
      return {
        purchasesMonthHt: inv.filter((i) => i.issue_date >= monthStart).reduce((s, i) => s + Number(i.total_ht), 0),
        paidMonth: paid.reduce((s, p) => s + Number(p.amount), 0),
        payable: open.reduce((s, i) => s + remainingOf(i), 0),
        overdueAmount: overdue.reduce((s, i) => s + remainingOf(i), 0), overdueCount: overdue.length, openOrders: orders.length,
      };
    });
  }

  async exportRows(t: TenantInfo, type: PurchaseDocType) {
    const rows = await this.list(t, { type });
    await this.db.tenant(t.ctx, (trx) => this.audit.tenant(trx, t.ctx, { action: `purchase_${type}.exported`, data: { count: rows.length } }));
    return rows.filter((r) => r.number).map((r) => ({
      numero: r.number, ...(type === 'invoice' ? { ref_fournisseur: r.supplierRef } : {}), date: r.issueDate,
      [type === 'invoice' ? 'echeance' : 'livraison_prevue']: type === 'invoice' ? r.dueDate : r.expectedDate,
      fournisseur_code: r.contactCode, fournisseur: r.contactName, statut: r.status, total_ht: r.totalHt, tva: r.totalVat, total_ttc: r.totalTtc,
      ...(type === 'invoice' ? { regle: r.paidAmount, reste_a_payer: r.remaining } : {}),
    }));
  }
}
