import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AccountingService } from '../accounting/accounting.service';

const today = () => new Date().toISOString().slice(0, 10);
const round = (n: number) => Math.round(n);

/** Les N derniers mois, du plus ancien au mois en cours : « 2026-10 ». */
export function lastMonths(n: number, now = today()) {
  const y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7)) - 1;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}
const monthEnd = (p: string) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);

export interface Alert { kind: string; severity: 'critical' | 'warning' | 'info'; label: string; count: number; amount?: number; href: string }

/**
 * Tableau de bord : séries mensuelles, palmarès et alertes. Chaque section n'est calculée que si
 * l'utilisateur a la permission de la voir et que la formule inclut le module correspondant.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly db: DatabaseService, private readonly accounting: AccountingService) {}

  async build(t: TenantInfo, months: number) {
    const can = (perm: string, module?: string) => t.permissions.has(perm) && (!module || t.entitlements.modules.includes(module));
    const periods = lastMonths(months);
    const from = `${periods[0]}-01`;
    return this.db.tenant(t.ctx, async (trx) => {
      const sales = can('sales.read', 'sales');
      const purchases = can('purchases.read', 'purchases');
      const cash = can('cash.read', 'cash');
      const monthly = periods.map((p) => ({ month: p, revenueHt: 0, purchasesHt: 0, collected: 0, cashEnd: null as number | null }));
      const at = (p: string) => monthly.find((m) => m.month === p)!;

      if (sales) {
        // Chiffre d'affaires net : factures émises moins avoirs, au mois d'émission.
        const docs = await trx.selectFrom('sales_document').select([sql<string>`to_char(issue_date, 'YYYY-MM')`.as('m'), 'type', (eb) => eb.fn.sum<string>('total_ht').as('ht')])
          .where('type', 'in', ['invoice', 'credit_note']).where('status', '!=', 'draft').where('issue_date', '>=', from).groupBy(['m', 'type']).execute();
        for (const d of docs) if (at(d.m)) at(d.m).revenueHt += (d.type === 'credit_note' ? -1 : 1) * Number(d.ht);
        const pays = await trx.selectFrom('sales_payment').select([sql<string>`to_char(paid_on, 'YYYY-MM')`.as('m'), (eb) => eb.fn.sum<string>('amount').as('a')])
          .where('paid_on', '>=', from).groupBy('m').execute();
        for (const p of pays) if (at(p.m)) at(p.m).collected += Number(p.a);
      }
      if (purchases) {
        const bills = await trx.selectFrom('purchase_document').select([sql<string>`to_char(issue_date, 'YYYY-MM')`.as('m'), (eb) => eb.fn.sum<string>('total_ht').as('ht')])
          .where('type', '=', 'invoice').where('status', '!=', 'draft').where('issue_date', '>=', from).groupBy('m').execute();
        for (const b of bills) if (at(b.m)) at(b.m).purchasesHt += Number(b.ht);
      }
      if (cash) {
        // Solde de trésorerie en fin de mois : soldes d'ouverture + mouvements jusqu'à cette date.
        const accounts = await trx.selectFrom('treasury_account').select(['opening_balance', 'opening_date']).execute();
        const moves = await trx.selectFrom('treasury_movement').select(['date', 'direction', 'amount']).execute();
        for (const m of monthly) {
          const end = monthEnd(m.month);
          if (end < from) continue;
          m.cashEnd = round(accounts.filter((a) => a.opening_date <= end).reduce((s, a) => s + Number(a.opening_balance), 0)
            + moves.filter((x) => x.date <= end).reduce((s, x) => s + (x.direction === 'in' ? 1 : -1) * Number(x.amount), 0));
        }
      }

      // Palmarès de la période : clients et articles (hors taxes, avoirs déduits)
      let topCustomers: { name: string; amount: number }[] = [];
      let topProducts: { name: string; amount: number; quantity: number; unit: string | null }[] = [];
      if (sales) {
        const sign = sql<number>`case when d.type = 'credit_note' then -1 else 1 end`;
        topCustomers = (await trx.selectFrom('sales_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
          .select(['c.name', sql<string>`sum(${sign} * d.total_ht)`.as('amount')])
          .where('d.type', 'in', ['invoice', 'credit_note']).where('d.status', '!=', 'draft').where('d.issue_date', '>=', from)
          .groupBy('c.name').orderBy('amount', 'desc').limit(5).execute()).map((r) => ({ name: r.name, amount: round(Number(r.amount)) })).filter((r) => r.amount > 0);
        topProducts = (await trx.selectFrom('sales_document_line as l')
          .innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
          .innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
          .select(['p.name', 'p.unit', sql<string>`sum(${sign} * l.total_ht)`.as('amount'), sql<string>`sum(${sign} * l.quantity)`.as('quantity')])
          .where('d.type', 'in', ['invoice', 'credit_note']).where('d.status', '!=', 'draft').where('d.issue_date', '>=', from)
          .groupBy(['p.name', 'p.unit']).orderBy('amount', 'desc').limit(5).execute())
          .map((r) => ({ name: r.name, unit: r.unit, amount: round(Number(r.amount)), quantity: Number(r.quantity) })).filter((r) => r.amount > 0);
      }

      return {
        months: periods, monthly, topCustomers, topProducts, alerts: await this.alerts(trx, t, can),
        sections: { sales, purchases, cash },
      };
    });
  }

  /** Ce qui demande une action, regroupé, du plus urgent au moins urgent. */
  private async alerts(trx: TenantTrx, t: TenantInfo, can: (perm: string, module?: string) => boolean): Promise<Alert[]> {
    const now = today();
    const out: Alert[] = [];
    const sumDue = (rows: { total_ttc: string; paid_amount: string; credited_amount?: string }[]) =>
      round(rows.reduce((s, r) => s + Number(r.total_ttc) - Number(r.paid_amount) - Number(r.credited_amount ?? 0), 0));

    if (can('sales.read', 'sales')) {
      const late = await trx.selectFrom('sales_document').select(['total_ttc', 'paid_amount', 'credited_amount'])
        .where('type', '=', 'invoice').where('status', 'in', ['issued', 'partially_paid']).where('due_date', '<', now).execute();
      if (late.length) out.push({ kind: 'overdue_invoices', severity: 'critical', label: 'Factures clients en retard', count: late.length, amount: sumDue(late), href: '/app/ventes/relances' });
      const drafts = await trx.selectFrom('sales_document').select('id').where('status', '=', 'draft').where('created_at', '<', new Date(Date.now() - 7 * 86400_000)).execute();
      if (drafts.length) out.push({ kind: 'old_drafts', severity: 'info', label: 'Brouillons de vente de plus de 7 jours', count: drafts.length, href: '/app/ventes/factures' });
    }
    if (can('purchases.read', 'purchases')) {
      const soon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
      const due = await trx.selectFrom('purchase_document').select(['total_ttc', 'paid_amount', 'due_date'])
        .where('type', '=', 'invoice').where('status', 'in', ['to_pay', 'partially_paid']).where('due_date', '<=', soon).execute();
      const overdue = due.filter((d) => d.due_date! < now), upcoming = due.filter((d) => d.due_date! >= now);
      if (overdue.length) out.push({ kind: 'overdue_bills', severity: 'critical', label: 'Factures fournisseurs échues', count: overdue.length, amount: sumDue(overdue), href: '/app/achats/echeancier' });
      if (upcoming.length) out.push({ kind: 'upcoming_bills', severity: 'warning', label: 'Factures fournisseurs à payer sous 7 jours', count: upcoming.length, amount: sumDue(upcoming), href: '/app/achats/echeancier' });
    }
    if (can('products.read')) {
      const stock = await trx.selectFrom('product').select(['stock_qty', 'min_stock']).where('track_stock', '=', true).where('archived_at', 'is', null).execute();
      const out0 = stock.filter((p) => Number(p.stock_qty) === 0).length;
      const low = stock.filter((p) => Number(p.stock_qty) > 0 && p.min_stock !== null && Number(p.stock_qty) <= Number(p.min_stock)).length;
      if (out0) out.push({ kind: 'out_of_stock', severity: 'warning', label: 'Articles en rupture de stock', count: out0, href: '/app/stocks' });
      if (low) out.push({ kind: 'low_stock', severity: 'warning', label: "Articles sous le seuil d'alerte", count: low, href: '/app/stocks' });
    }
    if (can('leave.validate', 'hr')) {
      const pending = await trx.selectFrom('leave_request').select('id').where('status', '=', 'pending').execute();
      if (pending.length) out.push({ kind: 'pending_leave', severity: 'info', label: 'Demandes de congé à traiter', count: pending.length, href: '/app/conges' });
    }
    if (can('accounting.read', 'accounting')) {
      const pending = (await this.accounting.pending(trx)).length;
      if (pending) out.push({ kind: 'pending_accounting', severity: 'warning', label: 'Opérations non comptabilisées', count: pending, href: '/app/comptabilite' });
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }
}
