import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { assertSiteAccess, inScope, workingSite } from '../../common/sites';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { PaymentMethod } from '../../db/schema';
import { AccountingService } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';
import { logoDataUrl } from '../companies/company-logo';
import { computeTotals, LineInput, today } from '../sales/sales.service';
import { StockService } from '../stock/stock.service';
import { TreasuryService } from '../treasury/treasury.service';

export type PosMethod = Extract<PaymentMethod, 'cash' | 'mobile_money' | 'card'>;
export interface RegisterInput { name: string; siteId?: string | null; warehouseId?: string | null; cashAccountId?: string | null }
export interface SaleInput { contactId?: string | null; lines: LineInput[]; payments: { method: PosMethod; amount: number; reference?: string | null }[] }

const WALK_IN = 'Client comptoir';
const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

/**
 * Point de vente : caisses, sessions (ouverture avec fond de caisse, clôture avec comptage) et tickets.
 * Un ticket est une facture de vente soldée sur-le-champ, rattachée à la session : stock, écriture
 * comptable et encaissements suivent le même chemin qu'une facture saisie dans Ventes.
 */
@Injectable()
export class PosService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly stock: StockService,
    private readonly accounting: AccountingService, private readonly treasury: TreasuryService) {}

  // ------------------------------------------------------------------ caisses
  private async register(trx: TenantTrx, t: TenantInfo, id: string) {
    if (!isUuid(id)) throw notFound('Caisse');
    const r = await trx.selectFrom('pos_register').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw notFound('Caisse');
    assertSiteAccess(t, r.site_id);
    return r;
  }

  /** Contact « Client comptoir » des ventes anonymes, créé à la première caisse. */
  private async walkInCustomer(trx: TenantTrx, t: TenantInfo) {
    const c = await trx.selectFrom('contact').select('id').where('name', '=', WALK_IN).where('kind', 'in', ['customer', 'both']).where('archived_at', 'is', null).orderBy('created_at').executeTakeFirst();
    if (c) return c.id;
    let code: string;
    for (;;) {
      code = await nextNumber(trx, t.companyId, 'contact_customer', 'CLI');
      if (!(await trx.selectFrom('contact').select('id').where('code', '=', code).executeTakeFirst())) break;
    }
    const row = await trx.insertInto('contact').values({
      company_id: t.companyId, code, kind: 'customer', legal_type: 'individual', name: WALK_IN, tax_id: null, rccm: null, email: null, phone: null, address: null, city: null,
      notes: 'Ventes au comptoir sans client identifié (point de vente).', archived_at: null, created_by: t.ctx.userId,
    }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  /** Compte de caisse de la caisse : celui choisi, sinon la première caisse active du site (de l'entreprise à défaut). */
  private async cashAccount(trx: TenantTrx, id: string | null | undefined, siteId: string) {
    if (id) {
      if (!isUuid(id)) throw badRequest('Compte de caisse introuvable.', undefined, 'unknown_account');
      const a = await trx.selectFrom('treasury_account').selectAll().where('id', '=', id).executeTakeFirst();
      if (!a) throw badRequest('Compte de caisse introuvable.', undefined, 'unknown_account');
      if (a.kind !== 'cash') throw badRequest('Les espèces d’une caisse vont sur un compte de caisse (pas une banque ni un mobile money).', undefined, 'not_cash');
      if (a.archived_at) throw conflict(`Le compte « ${a.name} » est archivé.`, 'account_archived');
      return a;
    }
    const a = await trx.selectFrom('treasury_account').selectAll().where('kind', '=', 'cash').where('archived_at', 'is', null)
      .orderBy(sql`site_id = ${siteId}`, 'desc').orderBy('created_at').executeTakeFirst();
    if (!a) throw badRequest('Aucun compte de caisse actif : créez-en un dans Trésorerie.', undefined, 'no_account');
    return a;
  }

  async registers(t: TenantInfo, includeArchived = false) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await inScope(trx.selectFrom('pos_register as r')
        .innerJoin('site as s', (j) => j.onRef('s.id', '=', 'r.site_id').onRef('s.company_id', '=', 'r.company_id'))
        .innerJoin('warehouse as w', (j) => j.onRef('w.id', '=', 'r.warehouse_id').onRef('w.company_id', '=', 'r.company_id'))
        .innerJoin('treasury_account as a', (j) => j.onRef('a.id', '=', 'r.cash_account_id').onRef('a.company_id', '=', 'r.company_id'))
        .select(['r.id', 'r.name', 'r.site_id as siteId', 's.name as siteName', 'r.warehouse_id as warehouseId', 'w.name as warehouseName',
          'r.cash_account_id as cashAccountId', 'a.name as cashAccountName', 'r.archived_at as archivedAt'])
        .$if(!includeArchived, (q) => q.where('r.archived_at', 'is', null)), t, 'r.site_id').orderBy('r.name').execute();
      const open = await this.sessionRows(trx, t).where('x.status', '=', 'open').execute();
      return rows.map((r) => ({ ...r, session: this.sessionOut(open.find((o) => o.registerId === r.id)) ?? null }));
    });
  }

  async createRegister(t: TenantInfo, input: RegisterInput) {
    return this.db.tenant(t.ctx, async (trx) => {
      const siteId = input.siteId ?? workingSite(t) ?? (await trx.selectFrom('site').select('id').where('is_default', '=', true).executeTakeFirstOrThrow()).id;
      assertSiteAccess(t, siteId);
      const w = await this.stock.warehouseFor(trx, t, input.warehouseId ?? null, siteId);
      if (w.site_id !== siteId) throw badRequest('Cet entrepôt appartient à un autre site que la caisse.', undefined, 'warehouse_other_site');
      const a = await this.cashAccount(trx, input.cashAccountId, siteId);
      if (await trx.selectFrom('pos_register').select('id').where('name', '=', input.name).executeTakeFirst()) throw conflict(`Une caisse s’appelle déjà « ${input.name} ».`, 'register_exists');
      const r = await trx.insertInto('pos_register').values({
        company_id: t.companyId, site_id: siteId, name: input.name, warehouse_id: w.id, cash_account_id: a.id, customer_id: await this.walkInCustomer(trx, t),
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'pos.register_created', entityType: 'pos_register', entityId: r.id, data: { name: input.name, warehouse: w.name, cashAccount: a.name } });
      return { id: r.id };
    });
  }

  async updateRegister(t: TenantInfo, id: string, input: Partial<RegisterInput> & { archived?: boolean }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const r = await this.register(trx, t, id);
      const patch: Record<string, unknown> = {};
      if (input.name && input.name !== r.name) {
        if (await trx.selectFrom('pos_register').select('id').where('name', '=', input.name).where('id', '!=', id).executeTakeFirst()) throw conflict(`Une caisse s’appelle déjà « ${input.name} ».`, 'register_exists');
        patch.name = input.name;
      }
      if (input.warehouseId) {
        const w = await this.stock.warehouseFor(trx, t, input.warehouseId, r.site_id);
        if (w.site_id !== r.site_id) throw badRequest('Cet entrepôt appartient à un autre site que la caisse.', undefined, 'warehouse_other_site');
        patch.warehouse_id = w.id;
      }
      if (input.cashAccountId) patch.cash_account_id = (await this.cashAccount(trx, input.cashAccountId, r.site_id)).id;
      if (input.archived !== undefined) {
        if (input.archived && await trx.selectFrom('pos_session').select('id').where('register_id', '=', id).where('status', '=', 'open').executeTakeFirst()) {
          throw conflict('Une session est ouverte sur cette caisse : clôturez-la avant de l’archiver.', 'session_open');
        }
        patch.archived_at = input.archived ? new Date() : null;
      }
      if (Object.keys(patch).length) {
        await trx.updateTable('pos_register').set(patch).where('id', '=', id).execute();
        await this.audit.tenant(trx, t.ctx, { action: 'pos.register_updated', entityType: 'pos_register', entityId: id, data: { name: r.name, fields: Object.keys(patch) } });
      }
      return { id };
    });
  }

  // ------------------------------------------------------------------ sessions
  private sessionRows(trx: TenantTrx, t: TenantInfo) {
    return inScope(trx.selectFrom('pos_session as x')
      .innerJoin('pos_register as r', (j) => j.onRef('r.id', '=', 'x.register_id').onRef('r.company_id', '=', 'x.company_id'))
      .innerJoin('user_account as u', 'u.id', 'x.opened_by')
      .leftJoin('user_account as cu', 'cu.id', 'x.closed_by')
      .select(['x.id', 'x.number', 'x.status', 'x.register_id as registerId', 'r.name as registerName', 'x.site_id as siteId', 'x.opening_float as openingFloat',
        'x.opened_by as openedById', 'u.full_name as openedBy', 'x.opened_at as openedAt', 'x.expected_cash as expectedCash', 'x.counted_cash as countedCash',
        'x.difference', 'x.closing_note as closingNote', 'cu.full_name as closedBy', 'x.closed_at as closedAt',
        (eb) => eb.selectFrom('sales_document as d').select(eb.fn.countAll<string>().as('c')).whereRef('d.pos_session_id', '=', 'x.id').whereRef('d.company_id', '=', 'x.company_id').as('tickets'),
        (eb) => eb.selectFrom('sales_document as d').select(sql<string>`coalesce(sum(d.total_ttc), 0)`.as('s')).whereRef('d.pos_session_id', '=', 'x.id').whereRef('d.company_id', '=', 'x.company_id').as('total')]), t, 'x.site_id');
  }

  private sessionOut<T extends { openingFloat: string; expectedCash: string | null; countedCash: string | null; difference: string | null; tickets: string | null; total: string | null }>(s?: T) {
    if (!s) return undefined;
    return { ...s, openingFloat: n(s.openingFloat), expectedCash: s.expectedCash == null ? null : n(s.expectedCash), countedCash: s.countedCash == null ? null : n(s.countedCash),
      difference: s.difference == null ? null : n(s.difference), tickets: n(s.tickets), total: n(s.total) };
  }

  async sessions(t: TenantInfo, f: { registerId?: string; status?: 'open' | 'closed' }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = this.sessionRows(trx, t).orderBy('x.opened_at', 'desc').limit(500);
      if (f.registerId) q = q.where('x.register_id', '=', f.registerId);
      if (f.status) q = q.where('x.status', '=', f.status);
      return (await q.execute()).map((s) => this.sessionOut(s)!);
    });
  }

  async openSession(t: TenantInfo, registerId: string, input: { openingFloat: number }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const r = await this.register(trx, t, registerId);
      if (r.archived_at) throw conflict(`La caisse « ${r.name} » est archivée.`, 'register_archived');
      const open = await trx.selectFrom('pos_session as x').innerJoin('user_account as u', 'u.id', 'x.opened_by').select(['x.number', 'u.full_name'])
        .where('x.register_id', '=', registerId).where('x.status', '=', 'open').executeTakeFirst();
      if (open) throw conflict(`La caisse « ${r.name} » est déjà ouverte (session ${open.number}, ${open.full_name}).`, 'session_open');
      const number = await nextNumber(trx, t.companyId, 'pos_session', 'SES', Number(today().slice(0, 4)));
      const s = await trx.insertInto('pos_session').values({
        company_id: t.companyId, site_id: r.site_id, register_id: r.id, number, opening_float: input.openingFloat, opened_by: t.ctx.userId,
        expected_cash: null, counted_cash: null, difference: null, closing_note: null, closed_by: null, closed_at: null,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'pos.session_opened', entityType: 'pos_session', entityId: s.id, data: { number, register: r.name, openingFloat: input.openingFloat } });
      return { id: s.id, number };
    });
  }

  /** Espèces attendues dans le tiroir : fond de caisse + espèces encaissées (rendu déduit) par les tickets de la session. */
  private async expectedCash(trx: TenantTrx, sessionId: string, openingFloat: number) {
    const r = await trx.selectFrom('sales_payment as p').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'p.document_id').onRef('d.company_id', '=', 'p.company_id'))
      .select(sql<string>`coalesce(sum(p.amount), 0)`.as('s')).where('d.pos_session_id', '=', sessionId).where('p.method', '=', 'cash').executeTakeFirstOrThrow();
    return openingFloat + n(r.s);
  }

  private async session(trx: TenantTrx, t: TenantInfo, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Session de caisse');
    const s = await trx.selectFrom('pos_session').selectAll().where('id', '=', id).$if(lock, (q) => q.forUpdate()).executeTakeFirst();
    if (!s) throw notFound('Session de caisse');
    assertSiteAccess(t, s.site_id);
    return s;
  }

  /** Clôture : le caissier compte son tiroir ; l'écart avec les espèces attendues est inscrit sur le compte de caisse. */
  async closeSession(t: TenantInfo, id: string, input: { countedCash: number; note?: string | null }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const s = await this.session(trx, t, id, true);
      if (s.status !== 'open') throw conflict(`La session ${s.number} est déjà clôturée.`, 'session_closed');
      if (s.opened_by !== t.ctx.userId && !t.permissions.has('pos.validate')) throw forbidden('Seul le caissier qui a ouvert la session, ou un responsable, peut la clôturer.');
      const r = await trx.selectFrom('pos_register').selectAll().where('id', '=', s.register_id).executeTakeFirstOrThrow();
      const expected = await this.expectedCash(trx, id, n(s.opening_float));
      const difference = Math.round((input.countedCash - expected) * 100) / 100;
      if (difference !== 0) {
        await this.treasury.record(trx, t, {
          accountId: r.cash_account_id, date: today(), direction: difference > 0 ? 'in' : 'out', amount: Math.abs(difference), category: 'cash_difference', sourceType: 'cash_count', sourceId: id,
          label: `Écart de caisse ${s.number} — ${r.name} (compté ${input.countedCash.toLocaleString('fr-FR')}, attendu ${expected.toLocaleString('fr-FR')})${input.note ? ` — ${input.note}` : ''}`,
        });
      }
      await trx.updateTable('pos_session').set({ status: 'closed', expected_cash: expected, counted_cash: input.countedCash, difference, closing_note: input.note ?? null, closed_by: t.ctx.userId, closed_at: new Date() })
        .where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'pos.session_closed', entityType: 'pos_session', entityId: id, data: { number: s.number, register: r.name, expected, counted: input.countedCash, difference } });
      return { id, expectedCash: expected, countedCash: input.countedCash, difference };
    });
  }

  /** Rapport de clôture (Z) : chiffre d'affaires, TVA par taux, encaissements par mode, espèces et écart. */
  async sessionReport(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      await this.session(trx, t, id);
      const s = this.sessionOut(await this.sessionRows(trx, t).where('x.id', '=', id).executeTakeFirstOrThrow())!;
      const tickets = await trx.selectFrom('sales_document').select(['id', 'number', 'status', 'validated_at as at', 'total_ht as totalHt', 'total_vat as totalVat', 'total_ttc as totalTtc', 'credited_amount as creditedAmount'])
        .where('pos_session_id', '=', id).orderBy('validated_at').execute();
      const byMethod = await trx.selectFrom('sales_payment as p').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'p.document_id').onRef('d.company_id', '=', 'p.company_id'))
        .select(['p.method', sql<string>`sum(p.amount)`.as('amount'), sql<string>`count(*)`.as('count')]).where('d.pos_session_id', '=', id).groupBy('p.method').execute();
      const byVat = await trx.selectFrom('sales_document_line as l').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
        .select(['l.vat_rate as rate', sql<string>`sum(l.total_ht)`.as('ht'), sql<string>`sum(l.total_vat)`.as('vat')]).where('d.pos_session_id', '=', id).groupBy('l.vat_rate').orderBy('l.vat_rate', 'desc').execute();
      const top = await trx.selectFrom('sales_document_line as l').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
        .select(['l.description', sql<string>`sum(l.quantity)`.as('qty'), sql<string>`sum(l.total_ht + l.total_vat)`.as('ttc')]).where('d.pos_session_id', '=', id)
        .groupBy('l.description').orderBy(sql`sum(l.total_ht + l.total_vat)`, 'desc').limit(10).execute();
      const expected = s.status === 'open' ? await this.expectedCash(trx, id, s.openingFloat) : s.expectedCash;
      const sum = (k: 'totalHt' | 'totalVat' | 'totalTtc') => tickets.reduce((a, x) => a + n(x[k]), 0);
      return {
        session: { ...s, expectedCash: expected }, company: await this.header(trx, t),
        totals: { tickets: tickets.length, ht: sum('totalHt'), vat: sum('totalVat'), ttc: sum('totalTtc'), average: tickets.length ? Math.round(sum('totalTtc') / tickets.length) : 0,
          credited: tickets.reduce((a, x) => a + n(x.creditedAmount), 0) },
        byMethod: byMethod.map((m) => ({ method: m.method, amount: n(m.amount), count: n(m.count) })),
        byVat: byVat.map((v) => ({ rate: n(v.rate), ht: n(v.ht), vat: n(v.vat) })),
        top: top.map((x) => ({ description: x.description, quantity: n(x.qty), ttc: n(x.ttc) })),
        tickets: tickets.map((x) => ({ ...x, totalHt: n(x.totalHt), totalVat: n(x.totalVat), totalTtc: n(x.totalTtc), creditedAmount: n(x.creditedAmount) })),
      };
    });
  }

  // ------------------------------------------------------------------ vente
  /**
   * Encaisse un ticket : facture numérotée TK-AAAA-00001, soldée immédiatement. Les espèces reçues au-delà
   * du total sont rendues au client (seules les espèces se rendent) ; mobile money et carte vont sur leurs comptes.
   */
  async sell(t: TenantInfo, sessionId: string, input: SaleInput) {
    const id = await this.db.tenant(t.ctx, async (trx) => {
      const s = await this.session(trx, t, sessionId);
      if (s.status !== 'open') throw conflict(`La session ${s.number} est clôturée : ouvrez une nouvelle session pour vendre.`, 'session_closed');
      const r = await trx.selectFrom('pos_register').selectAll().where('id', '=', s.register_id).executeTakeFirstOrThrow();
      const contactId = input.contactId ?? r.customer_id;
      if (!isUuid(contactId)) throw badRequest('Client introuvable.', undefined, 'unknown_contact');
      const c = await trx.selectFrom('contact').selectAll().where('id', '=', contactId).executeTakeFirst();
      if (!c || c.archived_at || c.kind === 'supplier') throw badRequest('Client introuvable ou archivé.', undefined, 'unknown_contact');

      const productIds = [...new Set(input.lines.map((l) => l.productId).filter((x): x is string => !!x))];
      if (productIds.length) {
        const found = await trx.selectFrom('product').select(['id', 'archived_at']).where('id', 'in', productIds).execute();
        if (found.length !== productIds.length) throw badRequest('Un ou plusieurs articles sont introuvables.', undefined, 'unknown_product');
      }
      const totals = computeTotals(input.lines);
      const cash = input.payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0);
      const other = input.payments.filter((p) => p.method !== 'cash').reduce((a, p) => a + p.amount, 0);
      if (other > totals.ttc) throw badRequest('Le mobile money et la carte ne peuvent pas dépasser le total : seule la monnaie en espèces se rend.', undefined, 'overpaid_non_cash');
      if (cash + other < totals.ttc) throw badRequest(`Montant reçu insuffisant : il manque ${(totals.ttc - cash - other).toLocaleString('fr-FR')} FCFA.`, undefined, 'underpaid');
      const change = cash + other - totals.ttc;

      const issue = today();
      const number = await nextNumber(trx, t.companyId, 'pos_ticket', 'TK', Number(issue.slice(0, 4)));
      const customer = { code: c.code, name: c.name, taxId: c.tax_id, rccm: c.rccm, address: c.address, city: c.city, email: c.email, phone: c.phone };
      const d = await trx.insertInto('sales_document').values({
        company_id: t.companyId, type: 'invoice', contact_id: contactId, issue_date: issue, due_date: issue, valid_until: null, notes: null, number: null,
        source_quote_id: null, validated_by: null, created_by: t.ctx.userId, site_id: r.site_id, warehouse_id: r.warehouse_id, pos_session_id: s.id, cash_tendered: cash || null,
        total_ht: totals.ht, total_vat: totals.vat, total_ttc: totals.ttc,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('sales_document_line').values(input.lines.map((l, i) => ({
        company_id: t.companyId, document_id: d.id, position: i + 1, product_id: l.productId ?? null, description: l.description, quantity: l.quantity, unit: l.unit ?? null,
        unit_price: l.unitPrice, discount_pct: l.discountPct ?? 0, vat_rate: l.vatRate, total_ht: totals.lines[i].ht, total_vat: totals.lines[i].vat,
      }))).execute();
      await trx.updateTable('sales_document').set({ status: 'issued', number, customer: JSON.stringify(customer), validated_at: new Date(), validated_by: t.ctx.userId }).where('id', '=', d.id).execute();
      await this.stock.applySalesDocument(trx, t, d.id);
      await this.accounting.postSalesDocument(trx, t, d.id);

      // Encaissements : espèces gardées (reçu − rendu) sur la caisse, le reste sur le compte du mode de paiement.
      const legs: { method: PosMethod; amount: number; reference?: string | null }[] = [];
      if (cash - change > 0) legs.push({ method: 'cash', amount: cash - change });
      for (const p of input.payments) if (p.method !== 'cash' && p.amount > 0) legs.push(p);
      for (const p of legs) {
        const account = p.method === 'cash' ? { id: r.cash_account_id } : await this.treasury.resolveAccount(trx, null, p.method, r.site_id);
        const pay = await trx.insertInto('sales_payment').values({ company_id: t.companyId, document_id: d.id, amount: p.amount, paid_on: issue, method: p.method, reference: p.reference ?? null, created_by: t.ctx.userId })
          .returning('id').executeTakeFirstOrThrow();
        await this.treasury.record(trx, t, { accountId: account.id, date: issue, direction: 'in', amount: p.amount, category: 'customer_payment', label: `Ticket ${number} — ${r.name}`,
          contactId, sourceType: 'sales_payment', sourceId: pay.id, reference: p.reference ?? null });
      }
      await trx.updateTable('sales_document').set({ paid_amount: totals.ttc, status: 'paid' }).where('id', '=', d.id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'pos.ticket_sold', entityType: 'sales_document', entityId: d.id, data: { number, session: s.number, totalTtc: totals.ttc, change } });
      return d.id;
    });
    return this.ticket(t, id);
  }

  private async header(trx: TenantTrx, t: TenantInfo) {
    const c = await trx.selectFrom('company').select(['name', 'address', 'city', 'phone', 'tax_id as taxId', 'rccm']).where('id', '=', t.companyId).executeTakeFirstOrThrow();
    return { ...c, logo: await logoDataUrl(trx) };
  }

  /** Ticket complet, pour l'affichage et la réimpression. */
  async ticket(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(id)) throw notFound('Ticket');
      const d = await trx.selectFrom('sales_document as d')
        .innerJoin('pos_session as x', (j) => j.onRef('x.id', '=', 'd.pos_session_id').onRef('x.company_id', '=', 'd.company_id'))
        .innerJoin('pos_register as r', (j) => j.onRef('r.id', '=', 'x.register_id').onRef('r.company_id', '=', 'x.company_id'))
        .innerJoin('site as s', (j) => j.onRef('s.id', '=', 'd.site_id').onRef('s.company_id', '=', 'd.company_id'))
        .leftJoin('user_account as u', 'u.id', 'd.validated_by')
        .select(['d.id', 'd.number', 'd.status', 'd.issue_date as issueDate', 'd.validated_at as at', 'd.total_ht as totalHt', 'd.total_vat as totalVat', 'd.total_ttc as totalTtc',
          'd.cash_tendered as cashTendered', 'd.credited_amount as creditedAmount', 'd.customer', 'd.contact_id as contactId', 'r.customer_id as walkInId',
          'x.number as sessionNumber', 'x.id as sessionId', 'r.name as registerName', 's.name as siteName', 's.address as siteAddress', 's.phone as sitePhone', 'u.full_name as cashier'])
        .where('d.id', '=', id).executeTakeFirst();
      if (!d) throw notFound('Ticket');
      const lines = await trx.selectFrom('sales_document_line').select(['description', 'quantity', 'unit', 'unit_price as unitPrice', 'discount_pct as discountPct', 'vat_rate as vatRate', 'total_ht as totalHt', 'total_vat as totalVat'])
        .where('document_id', '=', id).orderBy('position').execute();
      const payments = await trx.selectFrom('sales_payment').select(['method', 'amount', 'reference']).where('document_id', '=', id).orderBy('created_at').execute();
      const out = lines.map((l) => ({ ...l, quantity: n(l.quantity), unitPrice: n(l.unitPrice), discountPct: n(l.discountPct), vatRate: n(l.vatRate), totalHt: n(l.totalHt), totalVat: n(l.totalVat) }));
      const vat = new Map<number, { rate: number; ht: number; vat: number }>();
      for (const l of out) { const v = vat.get(l.vatRate) ?? { rate: l.vatRate, ht: 0, vat: 0 }; v.ht += l.totalHt; v.vat += l.totalVat; vat.set(l.vatRate, v); }
      const pays = payments.map((p) => ({ ...p, amount: n(p.amount) }));
      const cashKept = pays.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0);
      const tendered = d.cashTendered == null ? null : n(d.cashTendered);
      return {
        ...d, totalHt: n(d.totalHt), totalVat: n(d.totalVat), totalTtc: n(d.totalTtc), creditedAmount: n(d.creditedAmount), cashTendered: tendered,
        change: tendered == null ? 0 : Math.max(0, tendered - cashKept), walkIn: d.contactId === d.walkInId,
        lines: out, vat: [...vat.values()].sort((a, b) => b.rate - a.rate), payments: pays, company: await this.header(trx, t),
      };
    });
  }

  async tickets(t: TenantInfo, f: { sessionId?: string; q?: string; date?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = inScope(trx.selectFrom('sales_document as d')
        .innerJoin('pos_session as x', (j) => j.onRef('x.id', '=', 'd.pos_session_id').onRef('x.company_id', '=', 'd.company_id'))
        .innerJoin('pos_register as r', (j) => j.onRef('r.id', '=', 'x.register_id').onRef('r.company_id', '=', 'x.company_id'))
        .innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .leftJoin('user_account as u', 'u.id', 'd.validated_by')
        .select(['d.id', 'd.number', 'd.status', 'd.validated_at as at', 'd.total_ttc as totalTtc', 'd.credited_amount as creditedAmount', 'x.number as sessionNumber', 'r.name as registerName',
          'c.name as customer', 'u.full_name as cashier',
          (eb) => eb.selectFrom('sales_document_line as l').select(eb.fn.countAll<string>().as('k')).whereRef('l.document_id', '=', 'd.id').whereRef('l.company_id', '=', 'd.company_id').as('items'),
          (eb) => eb.selectFrom('sales_payment as p').select(sql<string>`string_agg(DISTINCT p.method, ',')`.as('m')).whereRef('p.document_id', '=', 'd.id').whereRef('p.company_id', '=', 'd.company_id').as('methods')])
        .where('d.pos_session_id', 'is not', null), t, 'd.site_id').orderBy('d.validated_at', 'desc').limit(500);
      if (f.sessionId) q = q.where('d.pos_session_id', '=', f.sessionId);
      if (f.date) q = q.where('d.issue_date', '=', f.date);
      if (f.q) { const like = `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`; q = q.where((eb) => eb.or([eb('d.number', 'ilike', like), eb('c.name', 'ilike', like)])); }
      return (await q.execute()).map((x) => ({ ...x, totalTtc: n(x.totalTtc), creditedAmount: n(x.creditedAmount), items: n(x.items), methods: x.methods ? x.methods.split(',') : [] }));
    });
  }

  /** Catalogue de la caisse : articles actifs avec code-barres, prix TTC et stock de l'entrepôt de la caisse. */
  async catalog(t: TenantInfo, registerId: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const r = await this.register(trx, t, registerId);
      const rows = await trx.selectFrom('product as p')
        .leftJoin('stock_level as sl', (j) => j.onRef('sl.product_id', '=', 'p.id').onRef('sl.company_id', '=', 'p.company_id').on('sl.warehouse_id', '=', r.warehouse_id))
        .select(['p.id', 'p.code', 'p.barcode', 'p.name', 'p.kind', 'p.unit', 'p.sale_price as salePrice', 'p.vat_rate as vatRate', 'p.track_stock as trackStock', 'sl.quantity as stock'])
        .where('p.archived_at', 'is', null).orderBy('p.name').limit(5000).execute();
      return rows.map((p) => ({ ...p, salePrice: n(p.salePrice), vatRate: n(p.vatRate), stock: p.trackStock ? n(p.stock) : null }));
    });
  }
}
