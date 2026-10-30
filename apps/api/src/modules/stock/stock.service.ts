import { Injectable } from '@nestjs/common';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { StockReason } from '../../db/schema';
import { AccountingService } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';

/** Valeurs de stock en francs CFA entiers, comme tous les montants ; le coût moyen garde sa précision. */
const franc = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString('fr-FR');

interface Move { productId: string; direction: 'in' | 'out'; quantity: number; value?: number; date: string; reason: StockReason; sourceId?: string | null; label: string }

/**
 * Stock valorisé au coût moyen unitaire pondéré (CMUP) : une entrée recalcule le coût moyen,
 * une sortie part au coût moyen. Le stock ne peut pas devenir négatif (vérifié ici et par la base).
 */
@Injectable()
export class StockService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly accounting: AccountingService) {}

  private async product(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Article');
    const p = await trx.selectFrom('product').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!p) throw notFound('Article');
    return p;
  }

  /** Inscrit un mouvement et met à jour quantité, valeur et coût moyen de l'article (verrouillé pour la transaction). */
  async move(trx: TenantTrx, t: TenantInfo, m: Move) {
    const p = await this.product(trx, m.productId);
    if (!p.track_stock) return null;
    const qty = Number(p.stock_qty), value = Number(p.stock_value), avg = Number(p.avg_cost);
    let moveValue: number;
    if (m.direction === 'out') {
      if (m.quantity > qty) throw conflict(`Stock insuffisant pour « ${p.name} » : ${fmt(qty)} disponible(s), ${fmt(m.quantity)} demandé(s).`, 'insufficient_stock');
      // La dernière unité emporte la valeur restante : pas de reliquat d'arrondi en stock vide.
      moveValue = m.quantity === qty ? value : franc(m.quantity * (qty ? value / qty : avg));
    } else {
      moveValue = franc(m.value ?? m.quantity * (avg || Number(p.purchase_price ?? 0)));
    }
    const qtyAfter = round3(qty + (m.direction === 'in' ? m.quantity : -m.quantity));
    const valueAfter = franc(Math.max(0, value + (m.direction === 'in' ? moveValue : -moveValue)));
    await trx.updateTable('product').set({
      stock_qty: qtyAfter, stock_value: qtyAfter ? valueAfter : 0, avg_cost: qtyAfter ? valueAfter / qtyAfter : avg,
    }).where('id', '=', p.id).execute();
    return trx.insertInto('stock_movement').values({
      company_id: t.companyId, product_id: p.id, date: m.date, direction: m.direction, quantity: m.quantity, value: moveValue,
      qty_after: qtyAfter, value_after: qtyAfter ? valueAfter : 0, reason: m.reason, source_id: m.sourceId ?? null, label: m.label, created_by: t.ctx.userId,
    }).returning(['id', 'value']).executeTakeFirstOrThrow();
  }

  /** Facture de vente : sortie de stock ; avoir avec retour : rentrée au coût moyen. Contrôle global avant tout mouvement. */
  async applySalesDocument(trx: TenantTrx, t: TenantInfo, documentId: string) {
    const d = await trx.selectFrom('sales_document').select(['id', 'type', 'number', 'issue_date', 'restock']).where('id', '=', documentId).executeTakeFirstOrThrow();
    if (d.type === 'quote' || (d.type === 'credit_note' && !d.restock)) return;
    const lines = await trx.selectFrom('sales_document_line as l').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .select(['l.product_id', 'l.quantity', 'p.name', 'p.track_stock', 'p.stock_qty']).where('l.document_id', '=', documentId).where('p.track_stock', '=', true).execute();
    const byProduct = new Map<string, { name: string; qty: number; stock: number }>();
    for (const l of lines) {
      const cur = byProduct.get(l.product_id!) ?? { name: l.name, qty: 0, stock: Number(l.stock_qty) };
      cur.qty = round3(cur.qty + Number(l.quantity));
      byProduct.set(l.product_id!, cur);
    }
    if (d.type === 'invoice') {
      const short = [...byProduct.values()].filter((x) => x.qty > x.stock);
      if (short.length) {
        throw conflict(`Stock insuffisant : ${short.map((x) => `${x.name} (disponible ${fmt(x.stock)}, facturé ${fmt(x.qty)})`).join(' ; ')}. Enregistrez d'abord l'achat ou le stock initial.`, 'insufficient_stock');
      }
    }
    for (const [productId, x] of byProduct) {
      await this.move(trx, t, d.type === 'invoice'
        ? { productId, direction: 'out', quantity: x.qty, date: d.issue_date, reason: 'sale', sourceId: d.id, label: `Vente ${d.number}` }
        : { productId, direction: 'in', quantity: x.qty, date: d.issue_date, reason: 'sale_return', sourceId: d.id, label: `Retour client ${d.number}` });
    }
  }

  /** Facture fournisseur : entrée en stock au prix d'achat net (remise déduite) de chaque ligne. */
  async applyPurchaseInvoice(trx: TenantTrx, t: TenantInfo, documentId: string) {
    const d = await trx.selectFrom('purchase_document').select(['id', 'type', 'number', 'issue_date', 'supplier_ref']).where('id', '=', documentId).executeTakeFirstOrThrow();
    if (d.type !== 'invoice') return;
    const lines = await trx.selectFrom('purchase_document_line as l').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .select(['l.product_id', 'l.quantity', 'l.total_ht']).where('l.document_id', '=', documentId).where('p.track_stock', '=', true).execute();
    for (const l of lines) {
      await this.move(trx, t, { productId: l.product_id!, direction: 'in', quantity: Number(l.quantity), value: Number(l.total_ht), date: d.issue_date, reason: 'purchase',
        sourceId: d.id, label: `Achat ${d.number}${d.supplier_ref ? ` (réf. ${d.supplier_ref})` : ''}` });
    }
  }

  // ------------------------------------------------------------------ consultation
  async overview(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'stock_qty', 'stock_value', 'avg_cost', 'min_stock', 'sale_price', 'purchase_price'])
        .where('track_stock', '=', true).where('archived_at', 'is', null).orderBy('name').execute();
      const last = await trx.selectFrom('stock_movement').select(['product_id', 'date']).orderBy('date', 'desc').execute();
      const items = rows.map((p) => {
        const qty = Number(p.stock_qty), min = p.min_stock === null ? null : Number(p.min_stock);
        return {
          id: p.id, code: p.code, name: p.name, unit: p.unit, quantity: qty, value: Number(p.stock_value), avgCost: round2(Number(p.avg_cost)), minStock: min,
          salePrice: Number(p.sale_price), lastMovement: last.find((m) => m.product_id === p.id)?.date ?? null,
          alert: qty === 0 ? 'out' : min !== null && qty <= min ? 'low' : null,
        };
      });
      return {
        items, totalValue: round2(items.reduce((s, i) => s + i.value, 0)),
        outOfStock: items.filter((i) => i.alert === 'out').length, lowStock: items.filter((i) => i.alert === 'low').length,
      };
    });
  }

  /** Fiche de stock d'un article : tous ses mouvements avec quantité et valeur après chacun. */
  async movements(t: TenantInfo, productId: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(productId)) throw notFound('Article');
      const p = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'stock_qty', 'stock_value', 'avg_cost', 'min_stock', 'track_stock']).where('id', '=', productId).executeTakeFirst();
      if (!p) throw notFound('Article');
      const rows = await trx.selectFrom('stock_movement as m').leftJoin('user_account as u', 'u.id', 'm.created_by')
        .select(['m.id', 'm.date', 'm.direction', 'm.quantity', 'm.value', 'm.qty_after as qtyAfter', 'm.value_after as valueAfter', 'm.reason', 'm.source_id as sourceId', 'm.label', 'u.full_name as by'])
        .where('m.product_id', '=', productId).orderBy('m.date', 'desc').orderBy('m.created_at', 'desc').limit(1000).execute();
      return {
        product: { ...p, stock_qty: Number(p.stock_qty), stock_value: Number(p.stock_value), avg_cost: round2(Number(p.avg_cost)), min_stock: p.min_stock === null ? null : Number(p.min_stock) },
        movements: rows.map((r) => ({ ...r, quantity: Number(r.quantity), value: Number(r.value), qtyAfter: Number(r.qtyAfter), valueAfter: Number(r.valueAfter) })),
      };
    });
  }

  // ------------------------------------------------------------------ saisies
  /** Stock initial d'un article sans mouvement : entrée valorisée, passée en à-nouveaux (D 311 / C 471). */
  async opening(t: TenantInfo, productId: string, input: { quantity: number; unitCost: number; date?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await this.product(trx, productId);
      if (!p.track_stock) throw badRequest("Cet article n'est pas suivi en stock.", undefined, 'not_tracked');
      const any = await trx.selectFrom('stock_movement').select('id').where('product_id', '=', productId).executeTakeFirst();
      if (any) throw conflict("Cet article a déjà des mouvements : corrigez son stock par un inventaire.", 'already_has_movements');
      const date = input.date ?? today();
      const value = franc(input.quantity * input.unitCost);
      const m = await this.move(trx, t, { productId, direction: 'in', quantity: input.quantity, value, date, reason: 'opening', label: 'Stock initial' });
      if (value > 0) {
        const label = `Stock initial — ${p.name}`;
        await this.accounting.postEntry(trx, t, { journal: 'AN', date, label, sourceType: 'stock_opening', sourceId: m!.id, lines: [
          { account: '311', label, debit: value }, { account: '471', label, credit: value }] });
      }
      await this.audit.tenant(trx, t.ctx, { action: 'stock.opening_recorded', entityType: 'product', entityId: productId, data: { name: p.name, quantity: input.quantity, value } });
      return { ok: true };
    });
  }

  /** Inventaire : la quantité comptée devient le stock ; l'écart entre ou sort au coût moyen. */
  async count(t: TenantInfo, productId: string, input: { counted: number; reason: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await this.product(trx, productId);
      if (!p.track_stock) throw badRequest("Cet article n'est pas suivi en stock.", undefined, 'not_tracked');
      const diff = round3(input.counted - Number(p.stock_qty));
      if (diff !== 0) {
        await this.move(trx, t, { productId, direction: diff > 0 ? 'in' : 'out', quantity: Math.abs(diff), date: today(), reason: 'adjustment',
          label: `Inventaire : compté ${fmt(input.counted)}, attendu ${fmt(Number(p.stock_qty))} — ${input.reason}` });
      }
      await this.audit.tenant(trx, t.ctx, { action: 'stock.counted', entityType: 'product', entityId: productId, data: { name: p.name, expected: Number(p.stock_qty), counted: input.counted, reason: input.reason } });
      return { expected: Number(p.stock_qty), counted: input.counted, difference: diff };
    });
  }

  async setSettings(t: TenantInfo, productId: string, input: { minStock?: number | null; trackStock?: boolean }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await this.product(trx, productId);
      const patch: Record<string, unknown> = {};
      if (input.minStock !== undefined) patch.min_stock = input.minStock;
      if (input.trackStock !== undefined && input.trackStock !== p.track_stock) {
        if (input.trackStock && p.kind !== 'good') throw badRequest('Un service ne se stocke pas.', undefined, 'service_not_stockable');
        if (!input.trackStock && Number(p.stock_qty) !== 0) throw conflict(`« ${p.name} » a encore ${fmt(Number(p.stock_qty))} en stock : soldez-le par un inventaire avant d'arrêter le suivi.`, 'stock_not_empty');
        patch.track_stock = input.trackStock;
      }
      if (Object.keys(patch).length) await trx.updateTable('product').set(patch).where('id', '=', productId).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'stock.settings_updated', entityType: 'product', entityId: productId, data: { name: p.name, ...input } });
      return { ok: true };
    });
  }

  /**
   * Variation de stock (inventaire intermittent SYSCOHADA) : aligne le compte 311 sur la valeur du stock à la date.
   * Hausse : D 311 / C 6031 ; baisse : D 6031 / C 311. Corrige le résultat des achats comptés en charges.
   */
  async postVariation(t: TenantInfo, date: string) {
    if (date > today()) throw badRequest('La date ne peut pas être dans le futur.', undefined, 'future_date');
    return this.db.tenant(t.ctx, async (trx) => {
      const moves = await trx.selectFrom('stock_movement').select(['product_id', 'value_after', 'date', 'created_at']).where('date', '<=', date)
        .orderBy('date').orderBy('created_at').execute();
      const lastByProduct = new Map<string, number>();
      for (const m of moves) lastByProduct.set(m.product_id, Number(m.value_after));
      const stockValue = round2([...lastByProduct.values()].reduce((s, v) => s + v, 0));
      const ledger = await trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
        .select((eb) => [eb.fn.sum<string>('l.debit').as('d'), eb.fn.sum<string>('l.credit').as('c')])
        .where('e.status', '=', 'posted').where('e.date', '<=', date).where('l.account_code', 'like', '311%').executeTakeFirst();
      const booked = round2(Number(ledger?.d ?? 0) - Number(ledger?.c ?? 0));
      const diff = round2(stockValue - booked);
      if (!diff) return { stockValue, booked, variation: 0, entry: null };
      const label = `Variation des stocks de marchandises au ${date}`;
      const amount = Math.abs(diff);
      const e = await this.accounting.postEntry(trx, t, { journal: 'OD', date, label, sourceType: 'stock_variation', sourceId: null, lines: diff > 0
        ? [{ account: '311', label, debit: amount }, { account: '6031', label, credit: amount }]
        : [{ account: '6031', label, debit: amount }, { account: '311', label, credit: amount }] });
      await this.audit.tenant(trx, t.ctx, { action: 'stock.variation_posted', entityType: 'journal_entry', entityId: e.id, data: { date, stockValue, booked, variation: diff } });
      return { stockValue, booked, variation: diff, entry: e.number };
    });
  }
}
