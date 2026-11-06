import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { inScope, siteScope } from '../../common/sites';
import { balance } from '../sales/sales.service';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';

const DAY = 86_400_000;
const round = (n: number) => Math.round(n);
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * DAY).toISOString().slice(0, 10);
const span = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
const today = () => new Date().toISOString().slice(0, 10);
const monthEnd = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** Totaux d'une période ; le résultat est un résultat de gestion, avant impôt sur les bénéfices. */
export interface Totals {
  salesTtc: number; salesHt: number; invoices: number; cogs: number; grossMargin: number;
  expenses: number; otherIncome: number; result: number;
}

/**
 * Rapport de gestion d'une période, calculé sur les opérations elles-mêmes (il ne dépend pas du module Comptabilité) :
 * - chiffre d'affaires : factures émises moins avoirs, à leur date d'émission ;
 * - coût des marchandises vendues : sorties de stock des factures (au coût moyen), moins retours et annulations ;
 * - dépenses : dépenses de trésorerie (hors retraits de l'exploitant), achats facturés hors marchandises stockées,
 *   pertes et consommations de stock, écarts d'inventaire et de caisse, charges de personnel des paies validées ;
 * - résultat = marge brute − dépenses + autres recettes.
 * Les achats de marchandises stockées n'y figurent qu'au moment de leur vente (par le coût des marchandises vendues).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  async build(t: TenantInfo, from: string, to: string) {
    const days = span(from, to);
    const previous = { from: shift(from, -days), to: shift(from, -1) };
    // Charges de personnel : paies de toute l'entreprise, visibles seulement avec la permission « voir les salaires ».
    const payroll = t.permissions.has('payroll.salaries') && t.entitlements.modules.includes('payroll') && !siteScope(t);
    return this.db.tenant(t.ctx, async (trx) => {
      const cur = await this.period(trx, t, from, to, payroll);
      const prev = await this.period(trx, t, previous.from, previous.to, payroll);
      return {
        from, to, previous, payrollIncluded: payroll,
        totals: cur.totals, previousTotals: prev.totals,
        expensesByCategory: cur.expenses, previousExpensesByCategory: prev.expenses,
        trend: await this.trend(trx, t, from, to),
        collections: await this.collections(trx, t, from, to),
        topProducts: await this.topProducts(trx, t, from, to),
      };
    });
  }

  /**
   * Rapport des stocks : valeur au début et à la fin (somme des mouvements au coût moyen), entrées et sorties par nature,
   * rotation et couverture, puis le détail par article. Les transferts entre entrepôts du périmètre s'annulent.
   */
  async stock(t: TenantInfo, from: string, to: string) {
    const days = span(from, to);
    return this.db.tenant(t.ctx, async (trx) => {
      const moves = await inScope(trx.selectFrom('stock_movement as m')
        .innerJoin('warehouse as w', (j) => j.onRef('w.id', '=', 'm.warehouse_id').onRef('w.company_id', '=', 'm.company_id'))
        .leftJoin('stock_document as d', (j) => j.onRef('d.id', '=', 'm.document_id').onRef('d.company_id', '=', 'm.company_id'))
        .where('m.date', '<=', to)
        .select(['m.product_id', 'm.date', 'm.direction', 'm.quantity', 'm.value', 'm.reason', 'd.reason as doc_reason']), t, 'w.site_id').execute();
      const products = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'min_stock', 'avg_cost']).where('track_stock', '=', true).execute();
      const per = new Map(products.map((p) => [p.id, { ...p, qtyStart: 0, valueStart: 0, qtyIn: 0, qtyOut: 0, sold: 0, qtyEnd: 0, valueEnd: 0 }]));
      const flows = new Map<string, { in: number; out: number }>();
      const daily = new Map<string, number>();
      let valueStart = 0;
      for (const m of moves) {
        const p = per.get(m.product_id);
        if (!p) continue;
        const sign = m.direction === 'in' ? 1 : -1, qty = Number(m.quantity), value = Number(m.value);
        p.qtyEnd += sign * qty; p.valueEnd += sign * value;
        if (m.date < from) { p.qtyStart += sign * qty; p.valueStart += sign * value; valueStart += sign * value; continue; }
        daily.set(m.date, (daily.get(m.date) ?? 0) + sign * value);
        if (m.reason === 'transfer') continue;
        if (sign > 0) p.qtyIn += qty; else p.qtyOut += qty;
        if (m.reason === 'sale') p.sold += qty;
        if (m.reason === 'sale_return') p.sold -= qty;
        // Nature du flux : bons de sortie détaillés par motif (perte, consommation…), le reste par origine.
        const key = m.reason === 'issue' || m.reason === 'receipt' ? `${m.reason}:${m.doc_reason ?? 'other'}` : m.reason;
        const f = flows.get(key) ?? { in: 0, out: 0 };
        if (sign > 0) f.in += value; else f.out += value;
        flows.set(key, f);
      }
      // Valeur jour par jour (par mois au-delà de deux mois), pour la courbe.
      const unit = days > 62 ? 'month' : 'day';
      const points: { key: string; value: number }[] = [];
      let running = valueStart;
      for (let d = from; d <= to; d = shift(d, 1)) {
        running += daily.get(d) ?? 0;
        const key = unit === 'day' ? d : d.slice(0, 7);
        if (points.length && points[points.length - 1].key === key) points[points.length - 1].value = round(running);
        else points.push({ key, value: round(running) });
      }
      const rows = [...per.values()].filter((p) => p.qtyStart || p.qtyIn || p.qtyOut || p.qtyEnd).map((p) => {
        const dailySales = p.sold / days;
        return {
          code: p.code, name: p.name, unit: p.unit, qtyStart: p.qtyStart, qtyIn: p.qtyIn, qtyOut: p.qtyOut, qtyEnd: p.qtyEnd, sold: p.sold,
          valueEnd: round(p.valueEnd), minStock: p.min_stock === null ? null : Number(p.min_stock),
          coverDays: dailySales > 0 ? Math.round(p.qtyEnd / dailySales) : null,
          status: p.qtyEnd <= 0 ? 'out' : p.min_stock !== null && p.qtyEnd <= Number(p.min_stock) ? 'low' : p.sold <= 0 ? 'dormant' : 'ok',
        };
      }).sort((a, b) => b.valueEnd - a.valueEnd);
      const valueEnd = rows.reduce((s, r) => s + r.valueEnd, 0);
      const cogs = (flows.get('sale')?.out ?? 0) - (flows.get('sale_return')?.in ?? 0);
      const average = (valueStart + valueEnd) / 2;
      return {
        from, to, unit,
        totals: {
          valueStart: round(valueStart), valueEnd: round(valueEnd), cogs: round(cogs),
          valueIn: round([...flows.values()].reduce((s, f) => s + f.in, 0)), valueOut: round([...flows.values()].reduce((s, f) => s + f.out, 0)),
          // Rotation : coût des ventes / stock moyen ; couverture : jours de ventes que le stock final permet de servir.
          turnover: average > 0 ? Math.round((cogs / average) * 100) / 100 : null,
          coverDays: cogs > 0 ? Math.round(valueEnd / (cogs / days)) : null,
          out: rows.filter((r) => r.status === 'out').length, low: rows.filter((r) => r.status === 'low').length, dormant: rows.filter((r) => r.status === 'dormant').length,
        },
        flows: [...flows].map(([key, f]) => ({ key, in: round(f.in), out: round(f.out) })).filter((f) => f.in || f.out),
        trend: points, products: rows,
      };
    });
  }

  /** Rapport clients : ventes de la période par client, encaissements, encours, retards et délai moyen de paiement. */
  async customers(t: TenantInfo, from: string, to: string) {
    const days = span(from, to);
    const previous = { from: shift(from, -days), to: shift(from, -1) };
    const now = today();
    return this.db.tenant(t.ctx, async (trx) => {
      const sign = sql<number>`case when d.type = 'credit_note' then -1 else 1 end`;
      const sales = await inScope(trx.selectFrom('sales_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .where('d.type', 'in', ['invoice', 'credit_note']).where('d.status', 'not in', ['draft', 'cancelled']).where('d.issue_date', '>=', previous.from).where('d.issue_date', '<=', to)
        .select(['c.id', 'c.code', 'c.name', sql<boolean>`d.issue_date >= ${from}`.as('current'), sql<string>`sum(${sign} * d.total_ht)`.as('ht'),
          sql<string>`count(*) filter (where d.type = 'invoice')`.as('n'), sql<string>`max(d.issue_date)`.as('last')])
        .groupBy(['c.id', 'c.code', 'c.name', 'current']), t, 'd.site_id').execute();
      const firstEver = new Map((await inScope(trx.selectFrom('sales_document as d').where('d.type', '=', 'invoice').where('d.status', 'not in', ['draft', 'cancelled'])
        .select(['d.contact_id', sql<string>`min(d.issue_date)`.as('first')]).groupBy('d.contact_id'), t, 'd.site_id').execute()).map((r) => [r.contact_id, r.first]));
      const paid = await inScope(trx.selectFrom('sales_payment as p').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'p.document_id').onRef('d.company_id', '=', 'p.company_id'))
        .where('p.paid_on', '>=', from).where('p.paid_on', '<=', to).select(['d.contact_id', sql<string>`sum(p.amount)`.as('amount')]).groupBy('d.contact_id'), t, 'd.site_id').execute();
      // Encours à ce jour : factures émises non soldées.
      const open = await inScope(trx.selectFrom('sales_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .where('d.type', '=', 'invoice').where('d.status', 'in', ['issued', 'partially_paid'])
        .select(['c.id', 'c.code', 'c.name', 'd.due_date', 'd.total_ttc', 'd.paid_amount', 'd.credited_amount', 'd.refunded_amount']), t, 'd.site_id').execute();
      // Délai de paiement : factures soldées dans la période, de l'émission au dernier encaissement.
      const delay = await inScope(trx.selectFrom('sales_document as d')
        .innerJoin(trx.selectFrom('sales_payment').select(['document_id', sql<string>`max(paid_on)`.as('last')]).groupBy('document_id').as('lp'), 'lp.document_id', 'd.id')
        .where('d.type', '=', 'invoice').where('d.status', '=', 'paid').where('lp.last', '>=', from).where('lp.last', '<=', to)
        .select([sql<string>`avg(lp.last::date - d.issue_date)`.as('days'), sql<string>`count(*)`.as('n')]), t, 'd.site_id').executeTakeFirst();

      const per = new Map<string, any>();
      const row = (id: string, code: string, name: string) => per.get(id) ?? per.set(id, { id, code, name, salesHt: 0, previousHt: 0, invoices: 0, collected: 0, due: 0, overdue: 0, last: null as string | null, isNew: false }).get(id);
      for (const s of sales) {
        const r = row(s.id, s.code, s.name);
        if (s.current) { r.salesHt += Number(s.ht); r.invoices += Number(s.n); r.last = s.last; } else r.previousHt += Number(s.ht);
      }
      const aging = { notDue: 0, d30: 0, d60: 0, d90: 0, more: 0 };
      for (const o of open) {
        const r = row(o.id, o.code, o.name), rest = balance(o).remaining;
        const late = o.due_date && o.due_date < now ? Math.floor((Date.parse(now) - Date.parse(o.due_date)) / DAY) : 0;
        r.due += rest; if (late > 0) r.overdue += rest;
        aging[late <= 0 ? 'notDue' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'more'] += rest;
      }
      for (const p of paid) if (per.has(p.contact_id)) per.get(p.contact_id).collected += Number(p.amount);
      for (const r of per.values()) r.isNew = !!firstEver.get(r.id) && firstEver.get(r.id)! >= from && firstEver.get(r.id)! <= to;
      const rows = [...per.values()].filter((r) => r.salesHt || r.previousHt || r.due || r.collected)
        .map((r) => ({ ...r, salesHt: round(r.salesHt), previousHt: round(r.previousHt), collected: round(r.collected), due: round(r.due), overdue: round(r.overdue) }))
        .sort((a, b) => b.salesHt - a.salesHt || b.due - a.due);
      const active = rows.filter((r) => r.invoices > 0);
      const salesHt = rows.reduce((s, r) => s + r.salesHt, 0);
      const invoices = rows.reduce((s, r) => s + r.invoices, 0);
      return {
        from, to, previous,
        totals: {
          salesHt, previousHt: rows.reduce((s, r) => s + r.previousHt, 0), active: active.length, newCustomers: rows.filter((r) => r.isNew).length,
          averageBasket: invoices ? round(salesHt / invoices) : 0, invoices, collected: rows.reduce((s, r) => s + r.collected, 0),
          due: rows.reduce((s, r) => s + r.due, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0),
          paymentDays: delay && Number(delay.n) ? Math.round(Number(delay.days)) : null,
          topShare: salesHt > 0 ? Math.round(((active[0]?.salesHt ?? 0) / salesHt) * 100) : null,
        },
        aging: Object.entries(aging).map(([key, amount]) => ({ key, amount: round(amount) })),
        customers: rows,
      };
    });
  }

  /** Rapport fournisseurs : achats facturés de la période, règlements, dettes à ce jour et échéancier. */
  async suppliers(t: TenantInfo, from: string, to: string) {
    const days = span(from, to);
    const previous = { from: shift(from, -days), to: shift(from, -1) };
    const now = today();
    return this.db.tenant(t.ctx, async (trx) => {
      const bought = await inScope(trx.selectFrom('purchase_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .where('d.type', '=', 'invoice').where('d.status', 'not in', ['draft', 'cancelled']).where('d.issue_date', '>=', previous.from).where('d.issue_date', '<=', to)
        .select(['c.id', 'c.code', 'c.name', sql<boolean>`d.issue_date >= ${from}`.as('current'), sql<string>`sum(d.total_ht)`.as('ht'), sql<string>`count(*)`.as('n'), sql<string>`max(d.issue_date)`.as('last')])
        .groupBy(['c.id', 'c.code', 'c.name', 'current']), t, 'd.site_id').execute();
      const paid = await inScope(trx.selectFrom('purchase_payment as p').innerJoin('purchase_document as d', (j) => j.onRef('d.id', '=', 'p.document_id').onRef('d.company_id', '=', 'p.company_id'))
        .where('p.paid_on', '>=', from).where('p.paid_on', '<=', to).select(['d.contact_id', sql<string>`sum(p.amount)`.as('amount')]).groupBy('d.contact_id'), t, 'd.site_id').execute();
      const open = await inScope(trx.selectFrom('purchase_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .where('d.type', '=', 'invoice').where('d.status', 'in', ['to_pay', 'partially_paid'])
        .select(['c.id', 'c.code', 'c.name', 'd.due_date', 'd.total_ttc', 'd.paid_amount']), t, 'd.site_id').execute();

      const per = new Map<string, any>();
      const row = (id: string, code: string, name: string) => per.get(id) ?? per.set(id, { id, code, name, purchasesHt: 0, previousHt: 0, invoices: 0, paid: 0, due: 0, overdue: 0, dueSoon: 0, last: null as string | null }).get(id);
      for (const b of bought) {
        const r = row(b.id, b.code, b.name);
        if (b.current) { r.purchasesHt += Number(b.ht); r.invoices += Number(b.n); r.last = b.last; } else r.previousHt += Number(b.ht);
      }
      // Échéancier : en retard, puis à payer dans 7, 30 jours, et plus tard.
      const schedule = { overdue: 0, week: 0, month: 0, later: 0 };
      for (const o of open) {
        const r = row(o.id, o.code, o.name), rest = Math.max(0, Number(o.total_ttc) - Number(o.paid_amount));
        const inDays = o.due_date ? Math.floor((Date.parse(o.due_date) - Date.parse(now)) / DAY) : 0;
        r.due += rest;
        if (inDays < 0) { r.overdue += rest; schedule.overdue += rest; }
        else if (inDays <= 7) { r.dueSoon += rest; schedule.week += rest; }
        else if (inDays <= 30) schedule.month += rest;
        else schedule.later += rest;
      }
      for (const p of paid) if (per.has(p.contact_id)) per.get(p.contact_id).paid += Number(p.amount);
      const rows = [...per.values()].filter((r) => r.purchasesHt || r.previousHt || r.due || r.paid)
        .map((r) => ({ ...r, purchasesHt: round(r.purchasesHt), previousHt: round(r.previousHt), paid: round(r.paid), due: round(r.due), overdue: round(r.overdue), dueSoon: round(r.dueSoon) }))
        .sort((a, b) => b.purchasesHt - a.purchasesHt || b.due - a.due);
      const purchasesHt = rows.reduce((s, r) => s + r.purchasesHt, 0);
      return {
        from, to, previous,
        totals: {
          purchasesHt, previousHt: rows.reduce((s, r) => s + r.previousHt, 0), active: rows.filter((r) => r.invoices > 0).length,
          invoices: rows.reduce((s, r) => s + r.invoices, 0), paid: rows.reduce((s, r) => s + r.paid, 0),
          due: rows.reduce((s, r) => s + r.due, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0), dueSoon: rows.reduce((s, r) => s + r.dueSoon, 0),
          topShare: purchasesHt > 0 ? Math.round(((rows[0]?.purchasesHt ?? 0) / purchasesHt) * 100) : null,
        },
        schedule: Object.entries(schedule).map(([key, amount]) => ({ key, amount: round(amount) })),
        suppliers: rows,
      };
    });
  }

  private async period(trx: TenantTrx, t: TenantInfo, from: string, to: string, payroll: boolean) {
    const sales = await inScope(trx.selectFrom('sales_document').where('type', 'in', ['invoice', 'credit_note']).where('status', 'not in', ['draft', 'cancelled'])
      .where('issue_date', '>=', from).where('issue_date', '<=', to)
      .select([sql<string>`coalesce(sum(case when type = 'invoice' then total_ttc else -total_ttc end), 0)`.as('ttc'),
        sql<string>`coalesce(sum(case when type = 'invoice' then total_ht else -total_ht end), 0)`.as('ht'),
        sql<string>`count(*) filter (where type = 'invoice')`.as('n')]), t, 'site_id').executeTakeFirstOrThrow();

    // Coût des marchandises vendues : mouvements de stock provoqués par une facture ou un avoir de vente.
    const cogs = await inScope(trx.selectFrom('stock_movement as m')
      .innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'm.source_id').onRef('d.company_id', '=', 'm.company_id'))
      .where('m.date', '>=', from).where('m.date', '<=', to)
      .select(sql<string>`coalesce(sum(case when m.direction = 'out' then m.value else -m.value end), 0)`.as('v')), t, 'd.site_id').executeTakeFirstOrThrow();

    const expenses = new Map<string, number>();
    const add = (key: string, v: number) => { if (Math.round(v)) expenses.set(key, (expenses.get(key) ?? 0) + v); };

    // Dépenses et recettes saisies en trésorerie (contre-passations exclues des deux côtés).
    const moves = await inScope(trx.selectFrom('treasury_movement as m')
      .innerJoin('treasury_account as a', (j) => j.onRef('a.id', '=', 'm.account_id').onRef('a.company_id', '=', 'm.company_id'))
      .where('m.date', '>=', from).where('m.date', '<=', to).where('m.reversed_by', 'is', null).where('m.reversal_of', 'is', null)
      .where('m.source_type', 'in', ['expense', 'income', 'cash_count'])
      .select(['m.source_type', 'm.category', sql<string>`sum(case when m.direction = 'out' then m.amount else -m.amount end)`.as('out')])
      .groupBy(['m.source_type', 'm.category']), t, 'a.site_id').execute();
    let otherIncome = 0;
    for (const m of moves) {
      const out = Number(m.out);
      if (m.source_type === 'expense' && m.category !== 'owner_withdrawal') add(m.category, out);
      else if (m.source_type === 'income' && m.category === 'other_income') otherIncome -= out;
      else if (m.source_type === 'cash_count') add('cash_difference', out);
    }

    // Achats facturés qui ne sont pas des marchandises stockées (services, fournitures, saisie libre).
    const bought = await inScope(trx.selectFrom('purchase_document_line as l')
      .innerJoin('purchase_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
      .leftJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .where('d.type', '=', 'invoice').where('d.status', 'not in', ['draft', 'cancelled']).where('d.issue_date', '>=', from).where('d.issue_date', '<=', to)
      .where((eb) => eb.or([eb('p.id', 'is', null), eb('p.track_stock', '=', false)]))
      .select(sql<string>`coalesce(sum(l.total_ht), 0)`.as('ht')), t, 'd.site_id').executeTakeFirstOrThrow();
    add('purchases', Number(bought.ht));

    // Stock sorti sans vente (bons de sortie) et écarts d'inventaire, au coût moyen.
    const stock = await inScope(trx.selectFrom('stock_movement as m')
      .innerJoin('warehouse as w', (j) => j.onRef('w.id', '=', 'm.warehouse_id').onRef('w.company_id', '=', 'm.company_id'))
      .where('m.date', '>=', from).where('m.date', '<=', to).where('m.reason', 'in', ['issue', 'adjustment'])
      .select(['m.reason', sql<string>`sum(case when m.direction = 'out' then m.value else -m.value end)`.as('out')]).groupBy('m.reason'), t, 'w.site_id').execute();
    for (const s of stock) add(s.reason === 'issue' ? 'stock_issues' : 'inventory', Number(s.out));

    if (payroll) {
      // Paies validées dont le mois se termine dans la période.
      const runs = await trx.selectFrom('payslip as s').innerJoin('payroll_run as r', (j) => j.onRef('r.id', '=', 's.run_id').onRef('r.company_id', '=', 's.company_id'))
        .where('r.status', '=', 'validated').select(['r.period', sql<string>`sum(s.employer_cost)`.as('cost')]).groupBy('r.period').execute();
      for (const r of runs) if (monthEnd(r.period) >= from && monthEnd(r.period) <= to) add('payroll', Number(r.cost));
    }

    const salesHt = Number(sales.ht), cogsValue = Number(cogs.v);
    const totalExpenses = [...expenses.values()].reduce((a, b) => a + b, 0);
    const grossMargin = salesHt - cogsValue;
    const totals: Totals = {
      salesTtc: round(Number(sales.ttc)), salesHt: round(salesHt), invoices: Number(sales.n), cogs: round(cogsValue), grossMargin: round(grossMargin),
      expenses: round(totalExpenses), otherIncome: round(otherIncome), result: round(grossMargin - totalExpenses + otherIncome),
    };
    return { totals, expenses: [...expenses].map(([key, amount]) => ({ key, amount: round(amount) })).filter((e) => e.amount !== 0).sort((a, b) => b.amount - a.amount) };
  }

  /** Ventes TTC (avoirs déduits) par jour, ou par mois au-delà de deux mois. */
  private async trend(trx: TenantTrx, t: TenantInfo, from: string, to: string) {
    const unit = span(from, to) > 62 ? 'month' : 'day';
    const key = unit === 'day' ? sql<string>`to_char(issue_date, 'YYYY-MM-DD')` : sql<string>`to_char(issue_date, 'YYYY-MM')`;
    const rows = await inScope(trx.selectFrom('sales_document').where('type', 'in', ['invoice', 'credit_note']).where('status', 'not in', ['draft', 'cancelled'])
      .where('issue_date', '>=', from).where('issue_date', '<=', to)
      .select([key.as('k'), sql<string>`sum(case when type = 'invoice' then total_ttc else -total_ttc end)`.as('ttc')]).groupBy('k'), t, 'site_id').execute();
    const by = new Map(rows.map((r) => [r.k, round(Number(r.ttc))]));
    const keys: string[] = [];
    if (unit === 'day') for (let d = from; d <= to; d = shift(d, 1)) keys.push(d);
    else for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shift(`${m}-28`, 7).slice(0, 7)) keys.push(m);
    return { unit, points: keys.map((k) => ({ key: k, salesTtc: by.get(k) ?? 0 })) };
  }

  /** Encaissements clients de la période par mode de paiement. */
  private async collections(trx: TenantTrx, t: TenantInfo, from: string, to: string) {
    const rows = await inScope(trx.selectFrom('sales_payment as p').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'p.document_id').onRef('d.company_id', '=', 'p.company_id'))
      .where('p.paid_on', '>=', from).where('p.paid_on', '<=', to)
      .select(['p.method', sql<string>`sum(p.amount)`.as('amount')]).groupBy('p.method'), t, 'd.site_id').execute();
    return rows.map((r) => ({ method: r.method, amount: round(Number(r.amount)) })).filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
  }

  /** Articles les plus vendus (hors taxes, avoirs déduits), avec leur marge quand le coût est connu. */
  private async topProducts(trx: TenantTrx, t: TenantInfo, from: string, to: string) {
    const sign = sql<number>`case when d.type = 'credit_note' then -1 else 1 end`;
    const rows = await inScope(trx.selectFrom('sales_document_line as l')
      .innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
      .innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .where('d.type', 'in', ['invoice', 'credit_note']).where('d.status', 'not in', ['draft', 'cancelled']).where('d.issue_date', '>=', from).where('d.issue_date', '<=', to)
      .select(['p.id', 'p.name', 'p.unit', sql<string>`sum(${sign} * l.total_ht)`.as('ht'), sql<string>`sum(${sign} * l.quantity)`.as('qty')])
      .groupBy(['p.id', 'p.name', 'p.unit']).orderBy('ht', 'desc').limit(8), t, 'd.site_id').execute();
    return rows.map((r) => ({ name: r.name, unit: r.unit, salesHt: round(Number(r.ht)), quantity: Number(r.qty) })).filter((r) => r.salesHt > 0);
  }
}
