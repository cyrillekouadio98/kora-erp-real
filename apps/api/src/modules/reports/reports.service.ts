import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { inScope, siteScope } from '../../common/sites';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';

const DAY = 86_400_000;
const round = (n: number) => Math.round(n);
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * DAY).toISOString().slice(0, 10);
const span = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
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
