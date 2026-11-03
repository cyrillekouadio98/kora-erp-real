import { Injectable } from '@nestjs/common';
import { assertSiteAccess, inScope, NONE, siteScope, workingSite } from '../../common/sites';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { StockDocType, StockReason } from '../../db/schema';
import { AccountingService } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';
import { TreasuryService } from '../treasury/treasury.service';

/** Valeurs de stock en francs CFA entiers, comme tous les montants ; le coût moyen garde sa précision. */
const franc = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString('fr-FR');
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

export const RECEIPT_REASONS = { cash_purchase: 'Achat comptant', production: 'Production / fabrication', return: 'Retour hors facture', gift: 'Don reçu', found: 'Marchandise retrouvée', other: 'Autre entrée' } as const;
export const ISSUE_REASONS = { consumption: 'Consommation interne', loss: 'Casse / perte', theft: 'Vol', expired: 'Produit périmé', gift: 'Don', sample: 'Échantillon gratuit', other: 'Autre sortie' } as const;
const PREFIX: Record<StockDocType, string> = { receipt: 'BE', issue: 'BS', transfer: 'BT', inventory: 'INV' };
const TITLE: Record<StockDocType, string> = { receipt: "Bon d'entrée", issue: 'Bon de sortie', transfer: 'Bon de transfert', inventory: 'Inventaire' };

interface Move {
  productId: string; warehouseId?: string | null; direction: 'in' | 'out'; quantity: number; value?: number; date: string;
  reason: StockReason; sourceId?: string | null; documentId?: string | null; label: string;
}
export interface StockLineInput { productId: string; quantity?: number | null; unitCost?: number | null; note?: string | null }
export interface StockDocInput {
  type: StockDocType; warehouseId?: string | null; destWarehouseId?: string | null; reason?: string; date?: string; contactId?: string | null;
  treasuryAccountId?: string | null; reference?: string | null; notes?: string | null; lines?: StockLineInput[];
}

/**
 * Stock valorisé au coût moyen unitaire pondéré (CMUP), par article, tous entrepôts confondus : une entrée
 * recalcule le coût moyen, une sortie part au coût moyen, un transfert déplace des quantités sans toucher à la valeur.
 * Les quantités sont tenues par entrepôt ; aucune ne peut devenir négative (vérifié ici et par la base).
 */
@Injectable()
export class StockService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly accounting: AccountingService, private readonly treasury: TreasuryService) {}

  private async product(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Article');
    const p = await trx.selectFrom('product').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!p) throw notFound('Article');
    return p;
  }

  // ------------------------------------------------------------------ entrepôts
  /** Entrepôt par défaut, créé à la première opération d'une nouvelle entreprise. */
  async defaultWarehouse(trx: TenantTrx, t: TenantInfo) {
    const w = await trx.selectFrom('warehouse').selectAll().where('is_default', '=', true).executeTakeFirst();
    if (w) return w;
    await trx.insertInto('warehouse').values({ company_id: t.companyId, code: 'DP', name: 'Dépôt principal', is_default: true })
      .onConflict((oc) => oc.doNothing()).execute();
    return trx.selectFrom('warehouse').selectAll().where('is_default', '=', true).executeTakeFirstOrThrow();
  }

  /** Entrepôt d'un site : son entrepôt principal (créé au besoin) ; sans site, l'entrepôt par défaut de l'entreprise. */
  async siteWarehouse(trx: TenantTrx, t: TenantInfo, siteId: string | null) {
    if (!siteId) return this.defaultWarehouse(trx, t);
    const pick = () => trx.selectFrom('warehouse').selectAll().where('site_id', '=', siteId).where('archived_at', 'is', null).orderBy('is_default', 'desc').orderBy('code').limit(1).executeTakeFirst();
    const w = await pick();
    if (w) return w;
    const site = await trx.selectFrom('site').select(['code', 'name']).where('id', '=', siteId).executeTakeFirstOrThrow();
    await trx.insertInto('warehouse').values({ company_id: t.companyId, site_id: siteId, code: `${site.code.replace(/[^A-Z0-9-]/g, '').slice(0, 8) || 'SITE'}-DP`, name: `Dépôt ${site.name}` }).onConflict((oc) => oc.doNothing()).execute();
    return (await pick()) ?? this.defaultWarehouse(trx, t);
  }

  /** Entrepôt indiqué (actif), ou entrepôt du site (le site de l'opération, sinon le site choisi). */
  async warehouseFor(trx: TenantTrx, t: TenantInfo, id?: string | null, siteId?: string | null) {
    if (!id) return this.siteWarehouse(trx, t, siteId ?? workingSite(t));
    if (!isUuid(id)) throw badRequest('Entrepôt introuvable.', undefined, 'unknown_warehouse');
    const w = await trx.selectFrom('warehouse').selectAll().where('id', '=', id).executeTakeFirst();
    if (!w) throw badRequest('Entrepôt introuvable.', undefined, 'unknown_warehouse');
    if (w.archived_at) throw conflict(`L'entrepôt « ${w.name} » est archivé.`, 'warehouse_archived');
    return w;
  }

  private async level(trx: TenantTrx, productId: string, warehouseId: string) {
    const l = await trx.selectFrom('stock_level').select('quantity').where('product_id', '=', productId).where('warehouse_id', '=', warehouseId).executeTakeFirst();
    return Number(l?.quantity ?? 0);
  }

  private async setLevel(trx: TenantTrx, t: TenantInfo, productId: string, warehouseId: string, quantity: number) {
    await trx.insertInto('stock_level').values({ company_id: t.companyId, product_id: productId, warehouse_id: warehouseId, quantity })
      .onConflict((oc) => oc.columns(['company_id', 'product_id', 'warehouse_id']).doUpdateSet({ quantity })).execute();
  }

  // ------------------------------------------------------------------ mouvements
  /**
   * Inscrit un mouvement et met à jour quantité, valeur et coût moyen de l'article et la quantité de l'entrepôt.
   * L'article est verrouillé pour la transaction : deux sorties simultanées ne peuvent pas vider deux fois le stock.
   */
  async move(trx: TenantTrx, t: TenantInfo, m: Move) {
    const p = await this.product(trx, m.productId);
    if (!p.track_stock) return null;
    const w = await this.warehouseFor(trx, t, m.warehouseId);
    const qty = Number(p.stock_qty), value = Number(p.stock_value), avg = Number(p.avg_cost);
    const whQty = await this.level(trx, p.id, w.id);
    let moveValue: number;
    if (m.direction === 'out') {
      if (m.quantity > whQty) throw conflict(`Stock insuffisant pour « ${p.name} » dans « ${w.name} » : ${fmt(whQty)} disponible(s), ${fmt(m.quantity)} demandé(s).`, 'insufficient_stock');
      // La dernière unité emporte la valeur restante : pas de reliquat d'arrondi en stock vide.
      moveValue = m.quantity === qty ? value : m.value !== undefined ? Math.min(franc(m.value), value) : franc(m.quantity * (qty ? value / qty : avg));
    } else {
      moveValue = franc(m.value ?? m.quantity * (avg || Number(p.purchase_price ?? 0)));
    }
    const sign = m.direction === 'in' ? 1 : -1;
    const qtyAfter = round3(qty + sign * m.quantity);
    const valueAfter = qtyAfter ? franc(Math.max(0, value + sign * moveValue)) : 0;
    const whAfter = round3(whQty + sign * m.quantity);
    await trx.updateTable('product').set({ stock_qty: qtyAfter, stock_value: valueAfter, avg_cost: qtyAfter ? valueAfter / qtyAfter : avg }).where('id', '=', p.id).execute();
    await this.setLevel(trx, t, p.id, w.id, whAfter);
    return trx.insertInto('stock_movement').values({
      company_id: t.companyId, product_id: p.id, warehouse_id: w.id, date: m.date, direction: m.direction, quantity: m.quantity, value: moveValue,
      qty_after: qtyAfter, value_after: valueAfter, wh_qty_after: whAfter, reason: m.reason, source_id: m.sourceId ?? null, document_id: m.documentId ?? null,
      label: m.label, created_by: t.ctx.userId,
    }).returning(['id', 'value']).executeTakeFirstOrThrow();
  }

  /** Transfert : sortie d'un entrepôt, entrée dans l'autre, au coût moyen ; quantité et valeur totales inchangées. */
  private async transferLine(trx: TenantTrx, t: TenantInfo, m: { productId: string; fromId: string; toId: string; quantity: number; date: string; documentId: string; label: string }) {
    const p = await this.product(trx, m.productId);
    const from = await this.level(trx, p.id, m.fromId);
    if (m.quantity > from) throw conflict(`Stock insuffisant pour « ${p.name} » dans l'entrepôt de départ : ${fmt(from)} disponible(s).`, 'insufficient_stock');
    const to = await this.level(trx, p.id, m.toId);
    const qty = Number(p.stock_qty), value = Number(p.stock_value);
    const moveValue = m.quantity === qty ? value : franc(m.quantity * (qty ? value / qty : Number(p.avg_cost)));
    const legs = [
      { warehouseId: m.fromId, direction: 'out' as const, after: round3(from - m.quantity) },
      { warehouseId: m.toId, direction: 'in' as const, after: round3(to + m.quantity) },
    ];
    for (const leg of legs) {
      await this.setLevel(trx, t, p.id, leg.warehouseId, leg.after);
      await trx.insertInto('stock_movement').values({
        company_id: t.companyId, product_id: p.id, warehouse_id: leg.warehouseId, date: m.date, direction: leg.direction, quantity: m.quantity, value: moveValue,
        qty_after: qty, value_after: value, wh_qty_after: leg.after, reason: 'transfer', source_id: null, document_id: m.documentId, label: m.label, created_by: t.ctx.userId,
      }).execute();
    }
    return moveValue;
  }

  /** Quantité demandée par article, contrôlée contre l'entrepôt avant tout mouvement : un seul message pour toutes les ruptures. */
  private async assertAvailable(trx: TenantTrx, warehouseId: string, wanted: Map<string, { name: string; qty: number }>, hint: string) {
    const short: string[] = [];
    for (const [productId, x] of wanted) {
      const have = await this.level(trx, productId, warehouseId);
      if (x.qty > have) short.push(`${x.name} (disponible ${fmt(have)}, demandé ${fmt(x.qty)})`);
    }
    if (short.length) throw conflict(`Stock insuffisant : ${short.join(' ; ')}.${hint}`, 'insufficient_stock');
  }

  /** Facture de vente : sortie de l'entrepôt choisi ; avoir avec retour : rentrée au coût moyen. Contrôle global avant tout mouvement. */
  async applySalesDocument(trx: TenantTrx, t: TenantInfo, documentId: string) {
    const d = await trx.selectFrom('sales_document').select(['id', 'type', 'number', 'issue_date', 'restock', 'warehouse_id', 'source_invoice_id', 'site_id']).where('id', '=', documentId).executeTakeFirstOrThrow();
    if (d.type === 'quote' || d.type === 'order' || (d.type === 'credit_note' && !d.restock)) return;
    let warehouseId = d.warehouse_id;
    if (!warehouseId && d.type === 'credit_note' && d.source_invoice_id) {
      warehouseId = (await trx.selectFrom('sales_document').select('warehouse_id').where('id', '=', d.source_invoice_id).executeTakeFirst())?.warehouse_id ?? null;
    }
    const w = await this.warehouseFor(trx, t, warehouseId, d.site_id);
    const lines = await trx.selectFrom('sales_document_line as l').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .select(['l.product_id', 'l.quantity', 'p.name']).where('l.document_id', '=', documentId).where('p.track_stock', '=', true).execute();
    const byProduct = new Map<string, { name: string; qty: number }>();
    for (const l of lines) {
      const cur = byProduct.get(l.product_id!) ?? { name: l.name, qty: 0 };
      cur.qty = round3(cur.qty + Number(l.quantity));
      byProduct.set(l.product_id!, cur);
    }
    if (d.type === 'invoice') await this.assertAvailable(trx, w.id, byProduct, ` Enregistrez d'abord l'achat, le stock initial ou un transfert vers « ${w.name} ».`);
    for (const [productId, x] of byProduct) {
      await this.move(trx, t, d.type === 'invoice'
        ? { productId, warehouseId: w.id, direction: 'out', quantity: x.qty, date: d.issue_date, reason: 'sale', sourceId: d.id, label: `Vente ${d.number}` }
        : { productId, warehouseId: w.id, direction: 'in', quantity: x.qty, date: d.issue_date, reason: 'sale_return', sourceId: d.id, label: `Retour client ${d.number}` });
    }
  }

  /** Facture fournisseur : entrée dans l'entrepôt choisi au prix d'achat net (remise déduite) de chaque ligne. */
  async applyPurchaseInvoice(trx: TenantTrx, t: TenantInfo, documentId: string) {
    const d = await trx.selectFrom('purchase_document').select(['id', 'type', 'number', 'issue_date', 'supplier_ref', 'warehouse_id', 'site_id']).where('id', '=', documentId).executeTakeFirstOrThrow();
    if (d.type !== 'invoice') return;
    const w = await this.warehouseFor(trx, t, d.warehouse_id, d.site_id);
    const lines = await trx.selectFrom('purchase_document_line as l').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .select(['l.product_id', 'l.quantity', 'l.total_ht']).where('l.document_id', '=', documentId).where('p.track_stock', '=', true).execute();
    for (const l of lines) {
      await this.move(trx, t, { productId: l.product_id!, warehouseId: w.id, direction: 'in', quantity: Number(l.quantity), value: Number(l.total_ht), date: d.issue_date, reason: 'purchase',
        sourceId: d.id, label: `Achat ${d.number}${d.supplier_ref ? ` (réf. ${d.supplier_ref})` : ''}` });
    }
  }

  /**
   * Facture remise en brouillon : chaque mouvement qu'elle a provoqué est annulé à la même valeur
   * (la marchandise vendue rentre, la marchandise achetée ressort si elle est encore en stock).
   */
  async revertSource(trx: TenantTrx, t: TenantInfo, sourceId: string, label: string) {
    const moves = await trx.selectFrom('stock_movement as m').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'm.product_id').onRef('p.company_id', '=', 'm.company_id'))
      .select(['m.product_id', 'm.warehouse_id', 'm.direction', 'm.quantity', 'm.value', 'p.name']).where('m.source_id', '=', sourceId).execute();
    const net = new Map<string, { productId: string; warehouseId: string; name: string; qty: number; value: number }>();
    for (const m of moves) {
      const key = `${m.product_id}|${m.warehouse_id}`;
      const cur = net.get(key) ?? { productId: m.product_id, warehouseId: m.warehouse_id, name: m.name, qty: 0, value: 0 };
      const sign = m.direction === 'in' ? 1 : -1;
      cur.qty = round3(cur.qty + sign * Number(m.quantity));
      cur.value = franc(cur.value + sign * Number(m.value));
      net.set(key, cur);
    }
    const back = [...net.values()].filter((x) => x.qty !== 0);
    for (const w of new Set(back.filter((x) => x.qty > 0).map((x) => x.warehouseId))) {
      const wanted = new Map(back.filter((x) => x.qty > 0 && x.warehouseId === w).map((x) => [x.productId, { name: x.name, qty: x.qty }]));
      await this.assertAvailable(trx, w, wanted, ' La marchandise de cette facture est déjà sortie du stock : elle ne peut plus être remise en brouillon.');
    }
    for (const x of back) {
      await this.move(trx, t, { productId: x.productId, warehouseId: x.warehouseId, direction: x.qty > 0 ? 'out' : 'in', quantity: Math.abs(x.qty), value: Math.abs(x.value), date: today(), reason: 'cancellation', sourceId, label });
    }
  }

  // ------------------------------------------------------------------ consultation
  /** Quantités engagées par article et entrepôt : commandes clients confirmées (réservé) ou commandes fournisseurs envoyées (à recevoir). */
  private async committed(trx: TenantTrx, side: 'sales' | 'purchase', defaultId: string) {
    const rows = side === 'sales'
      ? await trx.selectFrom('sales_document_line as l').innerJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
        .select(['l.product_id', 'd.warehouse_id', 'd.site_id', (eb) => eb.fn.sum<string>('l.quantity').as('qty')])
        .where('d.type', '=', 'order').where('d.status', '=', 'confirmed').where('l.product_id', 'is not', null).groupBy(['l.product_id', 'd.warehouse_id', 'd.site_id']).execute()
      : await trx.selectFrom('purchase_document_line as l').innerJoin('purchase_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
        .select(['l.product_id', 'd.warehouse_id', 'd.site_id', (eb) => eb.fn.sum<string>('l.quantity').as('qty')])
        .where('d.type', '=', 'order').where('d.status', '=', 'sent').where('l.product_id', 'is not', null).groupBy(['l.product_id', 'd.warehouse_id', 'd.site_id']).execute();
    // Commande sans entrepôt : l'entrepôt principal de son site.
    const main = new Map<string, string>();
    for (const w of await trx.selectFrom('warehouse').select(['id', 'site_id']).where('archived_at', 'is', null).orderBy('is_default', 'desc').orderBy('code').execute()) {
      if (!main.has(w.site_id)) main.set(w.site_id, w.id);
    }
    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const byWh = out.get(r.product_id!) ?? new Map<string, number>();
      const wh = r.warehouse_id ?? main.get(r.site_id) ?? defaultId;
      byWh.set(wh, round3((byWh.get(wh) ?? 0) + Number(r.qty)));
      out.set(r.product_id!, byWh);
    }
    return out;
  }

  /**
   * Vue d'ensemble : pour chaque article, stock physique, réservé (commandes clients confirmées), disponible,
   * à recevoir (commandes fournisseurs envoyées) et prévisionnel. Filtrable par entrepôt.
   */
  async overview(t: TenantInfo, warehouseId?: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const def = await this.defaultWarehouse(trx, t);
      const warehouses = await inScope(trx.selectFrom('warehouse').select(['id', 'code', 'name', 'is_default as isDefault', 'site_id as siteId']).where('archived_at', 'is', null), t, 'site_id')
        .orderBy('is_default', 'desc').orderBy('code').execute();
      if (warehouseId && !warehouses.some((w) => w.id === warehouseId)) {
        // Entrepôt d'un autre site demandé nommément (bon de transfert) : permis sans limite de site.
        const other = !t.allowedSiteIds && isUuid(warehouseId)
          ? await trx.selectFrom('warehouse').select(['id', 'code', 'name', 'is_default as isDefault', 'site_id as siteId']).where('id', '=', warehouseId).where('archived_at', 'is', null).executeTakeFirst() : null;
        if (!other) throw notFound('Entrepôt');
        warehouses.push(other);
      }
      // Entrepôts comptés : celui demandé, sinon ceux du site affiché ; null = toute l'entreprise.
      const whSet = warehouseId ? [warehouseId] : siteScope(t) ? warehouses.map((w) => w.id) : null;
      const inSet = (id: string) => !whSet || whSet.includes(id);
      const rows = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'stock_qty', 'stock_value', 'avg_cost', 'min_stock', 'sale_price', 'purchase_price', 'vat_rate'])
        .where('track_stock', '=', true).where('archived_at', 'is', null).orderBy('name').execute();
      const levels = await trx.selectFrom('stock_level').select(['product_id', 'warehouse_id', 'quantity']).where('quantity', '>', '0').execute();
      const last = await trx.selectFrom('stock_movement').select(['product_id', (eb) => eb.fn.max('date').as('date')])
        .$if(!!whSet, (q) => q.where('warehouse_id', 'in', whSet!.length ? whSet! : [def.id])).groupBy('product_id').execute();
      const reserved = await this.committed(trx, 'sales', def.id);
      const incoming = await this.committed(trx, 'purchase', def.id);
      const pick = (m: Map<string, number> | undefined) => (m ? [...m.entries()].filter(([w]) => inSet(w)).reduce((s, [, v]) => s + v, 0) : 0);

      const items = rows.map((p) => {
        const total = Number(p.stock_qty), avg = Number(p.avg_cost), min = num(p.min_stock);
        const byWarehouse = levels.filter((l) => l.product_id === p.id && inSet(l.warehouse_id)).map((l) => ({ warehouseId: l.warehouse_id, quantity: Number(l.quantity) }));
        const quantity = whSet ? round3(byWarehouse.reduce((s, l) => s + l.quantity, 0)) : total;
        const value = whSet ? (quantity === total ? Number(p.stock_value) : franc(quantity * avg)) : Number(p.stock_value);
        const res = round3(pick(reserved.get(p.id))), inc = round3(pick(incoming.get(p.id)));
        const available = round3(quantity - res), forecast = round3(available + inc);
        const toOrder = min !== null && forecast <= min;
        return {
          id: p.id, code: p.code, name: p.name, unit: p.unit, quantity, reserved: res, available, incoming: inc, forecast, value, avgCost: round2(avg), minStock: min,
          salePrice: Number(p.sale_price), purchasePrice: num(p.purchase_price), vatRate: Number(p.vat_rate), byWarehouse,
          lastMovement: last.find((m) => m.product_id === p.id)?.date ?? null,
          alert: quantity === 0 ? 'out' : min !== null && quantity <= min ? 'low' : null,
          toOrder, suggested: toOrder ? Math.max(1, Math.ceil(min! * 2 - forecast)) : 0,
        };
      });

      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const flows = await trx.selectFrom('stock_movement').select(['direction', (eb) => eb.fn.sum<string>('value').as('v')])
        .where('date', '>=', since).where('reason', '!=', 'transfer').$if(!!whSet, (q) => q.where('warehouse_id', 'in', whSet!.length ? whSet! : [def.id])).groupBy('direction').execute();
      const drafts = await inScope(trx.selectFrom('stock_document').select((eb) => eb.fn.countAll<string>().as('n')).where('status', '=', 'draft'), t, 'site_id').executeTakeFirst();
      return {
        warehouses, items, totalValue: round2(items.reduce((s, i) => s + i.value, 0)),
        outOfStock: items.filter((i) => i.alert === 'out').length, lowStock: items.filter((i) => i.alert === 'low').length, toOrder: items.filter((i) => i.toOrder).length,
        reservedValue: franc(items.reduce((s, i) => s + i.reserved * i.avgCost, 0)),
        in30: Number(flows.find((f) => f.direction === 'in')?.v ?? 0), out30: Number(flows.find((f) => f.direction === 'out')?.v ?? 0),
        draftDocuments: Number(drafts?.n ?? 0),
      };
    });
  }

  /** Fiche de stock d'un article : tous ses mouvements avec quantité et valeur après chacun, et sa répartition par entrepôt. */
  async movements(t: TenantInfo, productId: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(productId)) throw notFound('Article');
      const p = await trx.selectFrom('product').select(['id', 'code', 'name', 'unit', 'stock_qty', 'stock_value', 'avg_cost', 'min_stock', 'track_stock']).where('id', '=', productId).executeTakeFirst();
      if (!p) throw notFound('Article');
      const rows = await this.movementQuery(trx, t).where('m.product_id', '=', productId).orderBy('m.date', 'desc').orderBy('m.created_at', 'desc').limit(1000).execute();
      const levels = await inScope(trx.selectFrom('stock_level as l').innerJoin('warehouse as w', (j) => j.onRef('w.id', '=', 'l.warehouse_id').onRef('w.company_id', '=', 'l.company_id'))
        .select(['w.id', 'w.code', 'w.name', 'l.quantity']).where('l.product_id', '=', productId).where('l.quantity', '>', '0'), t, 'w.site_id').orderBy('w.code').execute();
      return {
        product: { ...p, stock_qty: Number(p.stock_qty), stock_value: Number(p.stock_value), avg_cost: round2(Number(p.avg_cost)), min_stock: num(p.min_stock) },
        byWarehouse: levels.map((l) => ({ ...l, quantity: Number(l.quantity) })),
        movements: rows.map(movementRow),
      };
    });
  }

  private movementQuery(trx: TenantTrx, t: TenantInfo) {
    return inScope(trx.selectFrom('stock_movement as m')
      .innerJoin('product as p', (j) => j.onRef('p.id', '=', 'm.product_id').onRef('p.company_id', '=', 'm.company_id'))
      .innerJoin('warehouse as w', (j) => j.onRef('w.id', '=', 'm.warehouse_id').onRef('w.company_id', '=', 'm.company_id'))
      .leftJoin('stock_document as d', (j) => j.onRef('d.id', '=', 'm.document_id').onRef('d.company_id', '=', 'm.company_id'))
      .leftJoin('user_account as u', 'u.id', 'm.created_by')
      .select(['m.id', 'm.date', 'm.direction', 'm.quantity', 'm.value', 'm.qty_after as qtyAfter', 'm.value_after as valueAfter', 'm.wh_qty_after as whQtyAfter',
        'm.reason', 'm.source_id as sourceId', 'm.document_id as documentId', 'd.number as documentNumber', 'm.label', 'u.full_name as by',
        'p.id as productId', 'p.code as productCode', 'p.name as productName', 'p.unit', 'w.code as warehouseCode', 'w.name as warehouseName']), t, 'w.site_id');
  }

  /** Journal des mouvements de stock, tous articles, filtrable par période, entrepôt, nature et article. */
  async journal(t: TenantInfo, f: { from?: string; to?: string; warehouseId?: string; reason?: StockReason; productId?: string; q?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = this.movementQuery(trx, t).orderBy('m.date', 'desc').orderBy('m.created_at', 'desc').limit(2000);
      if (f.from) q = q.where('m.date', '>=', f.from);
      if (f.to) q = q.where('m.date', '<=', f.to);
      if (f.warehouseId) q = q.where('m.warehouse_id', '=', f.warehouseId);
      if (f.reason) q = q.where('m.reason', '=', f.reason);
      if (f.productId) q = q.where('m.product_id', '=', f.productId);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('p.name', 'ilike', like), eb('p.code', 'ilike', like), eb('m.label', 'ilike', like)]));
      }
      const movements = (await q.execute()).map(movementRow);
      // Un transfert n'est ni une entrée ni une sortie pour l'entreprise (sauf si l'on regarde un seul entrepôt).
      const flows = f.warehouseId ? movements : movements.filter((m) => m.reason !== 'transfer');
      return {
        movements,
        totalIn: flows.filter((m) => m.direction === 'in').reduce((s, m) => s + m.value, 0),
        totalOut: flows.filter((m) => m.direction === 'out').reduce((s, m) => s + m.value, 0),
      };
    });
  }

  /** Valeur du stock à une date : dernière valeur connue de chaque article à cette date. */
  async valueAt(trx: TenantTrx, date: string) {
    const moves = await trx.selectFrom('stock_movement').select(['product_id', 'value_after']).where('date', '<=', date).orderBy('date').orderBy('created_at').execute();
    const lastByProduct = new Map<string, number>();
    for (const m of moves) lastByProduct.set(m.product_id, Number(m.value_after));
    return round2([...lastByProduct.values()].reduce((s, v) => s + v, 0));
  }

  /** Solde du compte de stock 311 (écritures validées) à une date. */
  private async ledgerStock(trx: TenantTrx, date: string) {
    const ledger = await trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
      .select((eb) => [eb.fn.sum<string>('l.debit').as('d'), eb.fn.sum<string>('l.credit').as('c')])
      .where('e.status', '=', 'posted').where('e.date', '<=', date).where('l.account_code', 'like', '311%').executeTakeFirst();
    return round2(Number(ledger?.d ?? 0) - Number(ledger?.c ?? 0));
  }

  /**
   * Valorisation du stock à une date, au CMUP : quantité, coût moyen et valeur de chaque article, total par entrepôt,
   * et rapprochement avec le compte 311 de la comptabilité.
   */
  async valuation(t: TenantInfo, date: string, warehouseId?: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      await this.defaultWarehouse(trx, t);
      const moves = await trx.selectFrom('stock_movement').select(['product_id', 'warehouse_id', 'qty_after', 'value_after', 'wh_qty_after'])
        .where('date', '<=', date).orderBy('date').orderBy('created_at').execute();
      const byProduct = new Map<string, { qty: number; value: number; wh: Map<string, number> }>();
      for (const m of moves) {
        const cur = byProduct.get(m.product_id) ?? { qty: 0, value: 0, wh: new Map<string, number>() };
        cur.qty = Number(m.qty_after); cur.value = Number(m.value_after); cur.wh.set(m.warehouse_id, Number(m.wh_qty_after));
        byProduct.set(m.product_id, cur);
      }
      const warehouses = await inScope(trx.selectFrom('warehouse').select(['id', 'code', 'name', 'archived_at']), t, 'site_id').orderBy('is_default', 'desc').orderBy('code').execute();
      // Entrepôts comptés : celui demandé, sinon ceux du site affiché ; null = toute l'entreprise.
      const whSet = warehouseId ? [warehouseId] : siteScope(t) ? warehouses.map((w) => w.id) : null;
      const products = byProduct.size
        ? await trx.selectFrom('product').select(['id', 'code', 'name', 'unit']).where('id', 'in', [...byProduct.keys()]).orderBy('name').execute() : [];
      const whValue = new Map<string, number>();
      const items = products.map((p) => {
        const s = byProduct.get(p.id)!;
        const avg = s.qty ? s.value / s.qty : 0;
        for (const [wh, q] of s.wh) whValue.set(wh, (whValue.get(wh) ?? 0) + (q === s.qty ? s.value : q * avg));
        const quantity = whSet ? round3(whSet.reduce((sum, w) => sum + (s.wh.get(w) ?? 0), 0)) : s.qty;
        return { id: p.id, code: p.code, name: p.name, unit: p.unit, quantity, avgCost: round2(avg), value: whSet ? (quantity === s.qty ? s.value : franc(quantity * avg)) : s.value };
      }).filter((i) => i.quantity > 0);
      const stockValue = await this.valueAt(trx, date);
      const ledger = await this.ledgerStock(trx, date);
      return {
        date, items, total: franc(items.reduce((s, i) => s + i.value, 0)),
        byWarehouse: warehouses.filter((w) => whValue.get(w.id) || !w.archived_at).map((w) => ({ id: w.id, code: w.code, name: w.name, value: franc(whValue.get(w.id) ?? 0) })),
        stockValue, ledger, gap: round2(stockValue - ledger),
      };
    });
  }

  // ------------------------------------------------------------------ saisies directes sur un article
  /** Stock initial d'un article sans mouvement : entrée valorisée, passée en à-nouveaux (D 311 / C 471). */
  async opening(t: TenantInfo, productId: string, input: { quantity: number; unitCost: number; date?: string; warehouseId?: string | null }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await this.product(trx, productId);
      if (!p.track_stock) throw badRequest("Cet article n'est pas suivi en stock.", undefined, 'not_tracked');
      const any = await trx.selectFrom('stock_movement').select('id').where('product_id', '=', productId).executeTakeFirst();
      if (any) throw conflict("Cet article a déjà des mouvements : corrigez son stock par un inventaire.", 'already_has_movements');
      const date = input.date ?? today();
      const value = franc(input.quantity * input.unitCost);
      const m = await this.move(trx, t, { productId, warehouseId: input.warehouseId, direction: 'in', quantity: input.quantity, value, date, reason: 'opening', label: 'Stock initial' });
      if (value > 0) {
        const label = `Stock initial — ${p.name}`;
        await this.accounting.postEntry(trx, t, { journal: 'AN', date, label, sourceType: 'stock_opening', sourceId: m!.id, lines: [
          { account: '311000', label, debit: value }, { account: '471000', label, credit: value }] });
      }
      await this.audit.tenant(trx, t.ctx, { action: 'stock.opening_recorded', entityType: 'product', entityId: productId, data: { name: p.name, quantity: input.quantity, value } });
      return { ok: true };
    });
  }

  /** Inventaire rapide d'un article dans un entrepôt : la quantité comptée devient le stock ; l'écart entre ou sort au coût moyen. */
  async count(t: TenantInfo, productId: string, input: { counted: number; reason: string; warehouseId?: string | null }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const p = await this.product(trx, productId);
      if (!p.track_stock) throw badRequest("Cet article n'est pas suivi en stock.", undefined, 'not_tracked');
      const w = await this.warehouseFor(trx, t, input.warehouseId);
      const expected = await this.level(trx, productId, w.id);
      const diff = round3(input.counted - expected);
      if (diff !== 0) {
        await this.move(trx, t, { productId, warehouseId: w.id, direction: diff > 0 ? 'in' : 'out', quantity: Math.abs(diff), date: today(), reason: 'adjustment',
          label: `Inventaire : compté ${fmt(input.counted)}, attendu ${fmt(expected)} — ${input.reason}` });
      }
      await this.audit.tenant(trx, t.ctx, { action: 'stock.counted', entityType: 'product', entityId: productId, data: { name: p.name, warehouse: w.code, expected, counted: input.counted, reason: input.reason } });
      return { expected, counted: input.counted, difference: diff };
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
      const stockValue = await this.valueAt(trx, date);
      const booked = await this.ledgerStock(trx, date);
      const diff = round2(stockValue - booked);
      if (!diff) return { stockValue, booked, variation: 0, entry: null };
      const label = `Variation des stocks de marchandises au ${date}`;
      const amount = Math.abs(diff);
      const e = await this.accounting.postEntry(trx, t, { journal: 'OD', date, label, sourceType: 'stock_variation', sourceId: null, lines: diff > 0
        ? [{ account: '311000', label, debit: amount }, { account: '603100', label, credit: amount }]
        : [{ account: '603100', label, debit: amount }, { account: '311000', label, credit: amount }] });
      await this.audit.tenant(trx, t.ctx, { action: 'stock.variation_posted', entityType: 'journal_entry', entityId: e.id, data: { date, stockValue, booked, variation: diff } });
      return { stockValue, booked, variation: diff, entry: e.number };
    });
  }

  // ------------------------------------------------------------------ entrepôts (paramétrage)
  async warehouses(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      await this.defaultWarehouse(trx, t);
      const rows = await trx.selectFrom('warehouse as w').innerJoin('site as s', (j) => j.onRef('s.id', '=', 'w.site_id').onRef('s.company_id', '=', 'w.company_id'))
        .selectAll('w').select(['s.name as site_name', 's.code as site_code']).orderBy('w.archived_at', 'desc').orderBy('w.is_default', 'desc').orderBy('w.code').execute();
      const stock = await trx.selectFrom('stock_level as l').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
        .select(['l.warehouse_id', 'l.quantity', 'p.stock_qty', 'p.stock_value', 'p.avg_cost']).where('l.quantity', '>', '0').execute();
      return rows.map((w) => {
        const mine = stock.filter((s) => s.warehouse_id === w.id);
        return {
          id: w.id, code: w.code, name: w.name, address: w.address, isDefault: w.is_default, archived: !!w.archived_at, products: mine.length,
          siteId: w.site_id, siteName: w.site_name, siteCode: w.site_code,
          value: franc(mine.reduce((s, l) => s + (Number(l.quantity) === Number(l.stock_qty) ? Number(l.stock_value) : Number(l.quantity) * Number(l.avg_cost)), 0)),
        };
      });
    });
  }

  async createWarehouse(t: TenantInfo, input: { code: string; name: string; address?: string | null; siteId?: string | null }) {
    const siteId = input.siteId ?? workingSite(t);
    assertSiteAccess(t, siteId);
    return this.db.tenant(t.ctx, async (trx) => {
      await this.defaultWarehouse(trx, t);
      const code = input.code.toUpperCase();
      if (await trx.selectFrom('warehouse').select('id').where('code', '=', code).executeTakeFirst()) throw conflict(`Le code ${code} est déjà utilisé.`, 'duplicate_code');
      const w = await trx.insertInto('warehouse').values({ company_id: t.companyId, code, name: input.name, address: input.address ?? null, ...(siteId ? { site_id: siteId } : {}) }).returning(['id']).executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'warehouse.created', entityType: 'warehouse', entityId: w.id, data: { code, name: input.name } });
      return w;
    });
  }

  async updateWarehouse(t: TenantInfo, id: string, input: { name?: string; address?: string | null; isDefault?: boolean; archived?: boolean; siteId?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(id)) throw notFound('Entrepôt');
      const w = await trx.selectFrom('warehouse').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!w) throw notFound('Entrepôt');
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.address !== undefined) patch.address = input.address;
      if (input.siteId && input.siteId !== w.site_id) {
        // Rattacher l'entrepôt à un autre site : les documents déjà passés gardent leur site.
        assertSiteAccess(t, w.site_id); assertSiteAccess(t, input.siteId);
        if (!(await trx.selectFrom('site').select('id').where('id', '=', input.siteId).where('archived_at', 'is', null).executeTakeFirst())) throw badRequest('Site introuvable ou archivé.', undefined, 'unknown_site');
        patch.site_id = input.siteId;
      }
      if (input.archived !== undefined && input.archived !== !!w.archived_at) {
        if (input.archived) {
          if (w.is_default || input.isDefault) throw conflict("L'entrepôt par défaut ne peut pas être archivé : choisissez d'abord un autre entrepôt par défaut.", 'default_warehouse');
          const left = await trx.selectFrom('stock_level').select('product_id').where('warehouse_id', '=', id).where('quantity', '>', '0').executeTakeFirst();
          if (left) throw conflict(`L'entrepôt « ${w.name} » contient encore de la marchandise : transférez-la avant de l'archiver.`, 'warehouse_not_empty');
          const drafts = await trx.selectFrom('stock_document').select('id').where('status', '=', 'draft')
            .where((eb) => eb.or([eb('warehouse_id', '=', id), eb('dest_warehouse_id', '=', id)])).executeTakeFirst();
          if (drafts) throw conflict(`Des bons en brouillon utilisent « ${w.name} » : validez-les ou supprimez-les d'abord.`, 'warehouse_in_use');
        }
        patch.archived_at = input.archived ? new Date() : null;
      }
      if (input.isDefault && !w.is_default) {
        if (w.archived_at && input.archived !== false) throw conflict('Un entrepôt archivé ne peut pas être celui par défaut.', 'warehouse_archived');
        await trx.updateTable('warehouse').set({ is_default: false }).where('is_default', '=', true).execute();
        patch.is_default = true;
      }
      if (Object.keys(patch).length) await trx.updateTable('warehouse').set(patch).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'warehouse.updated', entityType: 'warehouse', entityId: id, data: { code: w.code, ...input } });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ bons de stock
  private async doc(trx: TenantTrx, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Bon de stock');
    const d = await trx.selectFrom('stock_document').selectAll().where('id', '=', id).$if(lock, (q) => q.forUpdate()).executeTakeFirst();
    if (!d) throw notFound('Bon de stock');
    return d;
  }

  async listDocuments(t: TenantInfo, f: { types: StockDocType[]; status?: 'draft' | 'done' }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('stock_document as d')
        .innerJoin('warehouse as w', (j) => j.onRef('w.id', '=', 'd.warehouse_id').onRef('w.company_id', '=', 'd.company_id'))
        .leftJoin('warehouse as w2', (j) => j.onRef('w2.id', '=', 'd.dest_warehouse_id').onRef('w2.company_id', '=', 'd.company_id'))
        .leftJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .select(['d.id', 'd.type', 'd.status', 'd.number', 'd.date', 'd.reason', 'd.reference', 'd.total_value as totalValue', 'w.name as warehouse', 'w2.name as destWarehouse', 'c.name as contactName',
          (eb) => eb.selectFrom('stock_document_line as l').select((e) => e.fn.countAll<string>().as('n')).whereRef('l.document_id', '=', 'd.id').as('lines'),
          (eb) => eb.selectFrom('stock_document_line as l').select((e) => e.fn.countAll<string>().as('n')).whereRef('l.document_id', '=', 'd.id').where('l.quantity', 'is not', null).as('counted')])
        .select(['d.site_id as siteId', 'w.site_id as fromSiteId', 'w2.site_id as toSiteId'])
        .where('d.type', 'in', f.types).orderBy('d.created_at', 'desc').limit(1000);
      if (f.status) q = q.where('d.status', '=', f.status);
      // Un site voit ses bons et les transferts qu'il reçoit.
      const scope = siteScope(t);
      if (scope) q = q.where((eb) => eb.or([eb('d.site_id', 'in', scope.length ? scope : [NONE]), eb('w2.site_id', 'in', scope.length ? scope : [NONE])]));
      return (await q.execute()).map((r) => ({ ...r, totalValue: Number(r.totalValue), lines: Number(r.lines), counted: Number(r.counted) }));
    });
  }

  async getDocument(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id);
      const lines = await trx.selectFrom('stock_document_line as l').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
        .select(['l.id', 'l.product_id as productId', 'p.code', 'p.name', 'p.unit', 'p.avg_cost', 'l.quantity', 'l.expected', 'l.unit_cost as unitCost', 'l.value', 'l.note'])
        .where('l.document_id', '=', id).orderBy('l.position').execute();
      // Brouillon : stock théorique du moment ; bon validé : valeurs figées à la validation.
      const live = d.status === 'draft' && lines.length
        ? await trx.selectFrom('stock_level').select(['product_id', 'quantity']).where('warehouse_id', '=', d.warehouse_id).where('product_id', 'in', lines.map((l) => l.productId)).execute() : [];
      const ware = await trx.selectFrom('warehouse').select(['id', 'code', 'name']).where('id', 'in', [d.warehouse_id, ...(d.dest_warehouse_id ? [d.dest_warehouse_id] : [])]).execute();
      const contact = d.contact_id ? await trx.selectFrom('contact').select(['id', 'code', 'name']).where('id', '=', d.contact_id).executeTakeFirst() : null;
      const account = d.treasury_account_id ? await trx.selectFrom('treasury_account').select(['id', 'name', 'kind']).where('id', '=', d.treasury_account_id).executeTakeFirst() : null;
      const by = d.validated_by ? await trx.selectFrom('user_account').select('full_name').where('id', '=', d.validated_by).executeTakeFirst() : null;
      return {
        id: d.id, type: d.type, title: TITLE[d.type], status: d.status, number: d.number, date: d.date, reason: d.reason, reference: d.reference, notes: d.notes,
        warehouse: ware.find((w) => w.id === d.warehouse_id)!, destWarehouse: ware.find((w) => w.id === d.dest_warehouse_id) ?? null,
        contact: contact ?? null, treasuryAccount: account ?? null, treasuryMovementId: d.treasury_movement_id,
        totalValue: Number(d.total_value), validatedAt: d.validated_at, validatedBy: by?.full_name ?? null,
        lines: lines.map((l) => ({
          id: l.id, productId: l.productId, code: l.code, name: l.name, unit: l.unit, quantity: num(l.quantity), unitCost: num(l.unitCost), value: num(l.value), note: l.note,
          expected: d.status === 'draft' ? Number(live.find((x) => x.product_id === l.productId)?.quantity ?? 0) : num(l.expected),
          avgCost: round2(Number(l.avg_cost)),
        })),
      };
    });
  }

  /** Contrôle l'en-tête d'un bon (entrepôts, motif, achat comptant) ; renvoie les colonnes à écrire. */
  private async header(trx: TenantTrx, t: TenantInfo, type: StockDocType, input: Omit<StockDocInput, 'type' | 'lines'>) {
    const w = await this.warehouseFor(trx, t, input.warehouseId);
    let dest: string | null = null;
    if (type === 'transfer') {
      if (!input.destWarehouseId) throw badRequest("Choisissez l'entrepôt d'arrivée.", undefined, 'dest_required');
      const d = await this.warehouseFor(trx, t, input.destWarehouseId);
      if (d.id === w.id) throw badRequest("L'entrepôt d'arrivée doit être différent de l'entrepôt de départ.", undefined, 'same_warehouse');
      dest = d.id;
    }
    const reasons: Record<string, string> | null = type === 'receipt' ? RECEIPT_REASONS : type === 'issue' ? ISSUE_REASONS : null;
    if (reasons && (!input.reason || !(input.reason in reasons))) throw badRequest('Indiquez le motif du bon.', undefined, 'reason_required');
    const reason = reasons ? input.reason! : type;
    if (input.contactId && (!isUuid(input.contactId) || !(await trx.selectFrom('contact').select('id').where('id', '=', input.contactId).executeTakeFirst()))) {
      throw badRequest('Contact introuvable.', undefined, 'unknown_contact');
    }
    let account: string | null = null;
    if (reason === 'cash_purchase') {
      if (!input.treasuryAccountId) throw badRequest("Choisissez la caisse, la banque ou le compte mobile money qui a payé l'achat.", undefined, 'treasury_account_required');
      if (!isUuid(input.treasuryAccountId) || !(await trx.selectFrom('treasury_account').select('id').where('id', '=', input.treasuryAccountId).executeTakeFirst())) {
        throw badRequest('Compte de trésorerie introuvable.', undefined, 'unknown_account');
      }
      account = input.treasuryAccountId;
    }
    if (input.date && input.date > today()) throw badRequest('La date ne peut pas être dans le futur.', undefined, 'future_date');
    assertSiteAccess(t, w.site_id);
    return {
      site_id: w.site_id, warehouse_id: w.id, dest_warehouse_id: dest, reason, contact_id: input.contactId ?? null, treasury_account_id: account,
      ...(input.date ? { date: input.date } : {}), ...(input.reference !== undefined ? { reference: input.reference } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
  }

  private async writeLines(trx: TenantTrx, t: TenantInfo, type: StockDocType, documentId: string, lines: StockLineInput[]) {
    const ids = lines.map((l) => l.productId);
    if (new Set(ids).size !== ids.length) throw badRequest('Un même article apparaît deux fois : regroupez les quantités sur une seule ligne.', undefined, 'duplicate_product');
    if (ids.length) {
      if (!ids.every(isUuid)) throw badRequest('Article introuvable.', undefined, 'unknown_product');
      const found = await trx.selectFrom('product').select(['id', 'name', 'track_stock']).where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw badRequest('Un ou plusieurs articles sont introuvables.', undefined, 'unknown_product');
      const untracked = found.find((p) => !p.track_stock);
      if (untracked) throw badRequest(`« ${untracked.name} » n'est pas suivi en stock.`, undefined, 'not_tracked');
    }
    await trx.deleteFrom('stock_document_line').where('document_id', '=', documentId).execute();
    if (!lines.length) return;
    await trx.insertInto('stock_document_line').values(lines.map((l, i) => ({
      company_id: t.companyId, document_id: documentId, position: i + 1, product_id: l.productId,
      quantity: l.quantity ?? null, unit_cost: type === 'receipt' ? l.unitCost ?? null : null, note: l.note ?? null,
    }))).execute();
  }

  /** Nouveau bon en brouillon. Un inventaire sans lignes reprend tous les articles suivis, à compter. */
  async createDocument(t: TenantInfo, input: StockDocInput) {
    const id = await this.db.tenant(t.ctx, async (trx) => {
      const head = await this.header(trx, t, input.type, input);
      const d = await trx.insertInto('stock_document').values({ company_id: t.companyId, type: input.type, ...head, number: null, created_by: t.ctx.userId })
        .returning('id').executeTakeFirstOrThrow();
      let lines = input.lines ?? [];
      if (input.type === 'inventory' && !lines.length) {
        const products = await trx.selectFrom('product').select('id').where('track_stock', '=', true).where('archived_at', 'is', null).orderBy('name').execute();
        lines = products.map((p) => ({ productId: p.id, quantity: null }));
      }
      await this.writeLines(trx, t, input.type, d.id, lines);
      await this.audit.tenant(trx, t.ctx, { action: `stock_${input.type}.created`, entityType: 'stock_document', entityId: d.id, data: { reason: head.reason, lines: lines.length } });
      return d.id;
    });
    return this.getDocument(t, id);
  }

  async updateDocument(t: TenantInfo, id: string, input: Omit<StockDocInput, 'type'>) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict('Un bon validé ne se modifie plus : passez un nouveau bon ou un inventaire.', 'document_locked');
      const keep = <K extends keyof typeof input>(k: K, current: (typeof input)[K]) => (input[k] === undefined ? current : input[k]);
      const head = await this.header(trx, t, d.type, {
        warehouseId: keep('warehouseId', d.warehouse_id), destWarehouseId: keep('destWarehouseId', d.dest_warehouse_id), reason: keep('reason', d.reason),
        contactId: keep('contactId', d.contact_id), treasuryAccountId: keep('treasuryAccountId', d.treasury_account_id),
        date: input.date, reference: input.reference, notes: input.notes,
      });
      await trx.updateTable('stock_document').set(head).where('id', '=', id).execute();
      if (input.lines) await this.writeLines(trx, t, d.type, id, input.lines);
      await this.audit.tenant(trx, t.ctx, { action: `stock_${d.type}.updated`, entityType: 'stock_document', entityId: id, data: { fields: Object.keys(input) } });
    });
    return this.getDocument(t, id);
  }

  async removeDocument(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict('Un bon validé ne se supprime pas : passez un bon inverse.', 'document_locked');
      await trx.deleteFrom('stock_document').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `stock_${d.type}.deleted`, entityType: 'stock_document', entityId: id, data: { type: d.type } });
      return { ok: true };
    });
  }

  /**
   * Valide le bon : numéro, mouvements de stock, valeurs figées. Achat comptant : sortie de trésorerie
   * et écriture D 601 / C caisse, banque ou mobile money, dans la même transaction.
   */
  async validateDocument(t: TenantInfo, id: string) {
    await this.db.tenant(t.ctx, async (trx) => {
      const d = await this.doc(trx, id, true);
      if (d.status !== 'draft') throw conflict('Ce bon est déjà validé.', 'already_validated');
      if (d.date > today()) throw badRequest('La date ne peut pas être dans le futur.', undefined, 'future_date');
      const w = await this.warehouseFor(trx, t, d.warehouse_id);
      const dest = d.dest_warehouse_id ? await this.warehouseFor(trx, t, d.dest_warehouse_id) : null;
      const lines = await trx.selectFrom('stock_document_line as l').innerJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
        .select(['l.id', 'l.product_id', 'l.quantity', 'l.unit_cost', 'p.name', 'p.track_stock']).where('l.document_id', '=', id).orderBy('l.position').execute();
      const active = lines.filter((l) => l.quantity !== null && (d.type === 'inventory' || Number(l.quantity) > 0));
      if (!active.length) throw badRequest(d.type === 'inventory' ? 'Saisissez au moins une quantité comptée avant de valider.' : 'Ajoutez au moins une ligne avec une quantité.', undefined, 'no_lines');
      const notTracked = active.find((l) => !l.track_stock);
      if (notTracked) throw conflict(`« ${notTracked.name} » n'est plus suivi en stock : retirez-le du bon.`, 'not_tracked');
      // Un achat comptant sort de l'argent : il faut aussi le droit d'enregistrer des sorties de trésorerie.
      if (d.reason === 'cash_purchase' && !t.permissions.has('cash.create')) {
        throw forbidden("Un achat comptant sort de l'argent de la trésorerie : seul un utilisateur autorisé à enregistrer des dépenses peut le valider.", 'cash_permission_required');
      }
      if (d.reason === 'cash_purchase' && active.some((l) => l.unit_cost === null)) {
        throw badRequest("Indiquez le prix payé de chaque article de l'achat comptant.", undefined, 'unit_cost_required');
      }
      if (d.type === 'issue' || d.type === 'transfer') {
        await this.assertAvailable(trx, w.id, new Map(active.map((l) => [l.product_id, { name: l.name, qty: Number(l.quantity) }])), '');
      }

      const number = await nextNumber(trx, t.companyId, `stock_${d.type}`, PREFIX[d.type], Number(d.date.slice(0, 4)));
      const motive = d.type === 'receipt' ? RECEIPT_REASONS[d.reason as keyof typeof RECEIPT_REASONS] : d.type === 'issue' ? ISSUE_REASONS[d.reason as keyof typeof ISSUE_REASONS] : null;
      const label = `${TITLE[d.type]} ${number}${motive ? ` — ${motive}` : ''}${dest ? ` : ${w.name} → ${dest.name}` : ''}`;
      let total = 0;
      for (const l of active) {
        const qty = Number(l.quantity);
        let value = 0, unitCost: number | null = null, expected: number | null = null;
        if (d.type === 'receipt') {
          const m = await this.move(trx, t, { productId: l.product_id, warehouseId: w.id, direction: 'in', quantity: qty, value: l.unit_cost === null ? undefined : franc(qty * Number(l.unit_cost)),
            date: d.date, reason: 'receipt', documentId: d.id, label });
          value = Number(m!.value); unitCost = round2(value / qty);
        } else if (d.type === 'issue') {
          const m = await this.move(trx, t, { productId: l.product_id, warehouseId: w.id, direction: 'out', quantity: qty, date: d.date, reason: 'issue', documentId: d.id, label });
          value = Number(m!.value); unitCost = round2(value / qty);
        } else if (d.type === 'transfer') {
          value = await this.transferLine(trx, t, { productId: l.product_id, fromId: w.id, toId: dest!.id, quantity: qty, date: d.date, documentId: d.id, label });
          unitCost = round2(value / qty);
        } else {
          expected = await this.level(trx, l.product_id, w.id);
          const diff = round3(qty - expected);
          if (diff !== 0) {
            const m = await this.move(trx, t, { productId: l.product_id, warehouseId: w.id, direction: diff > 0 ? 'in' : 'out', quantity: Math.abs(diff), date: d.date, reason: 'adjustment',
              documentId: d.id, label: `${label} : compté ${fmt(qty)}, attendu ${fmt(expected)}` });
            value = (diff > 0 ? 1 : -1) * Number(m!.value);
            unitCost = round2(Math.abs(value) / Math.abs(diff));
          }
        }
        total += value;
        await trx.updateTable('stock_document_line').set({ expected, unit_cost: unitCost, value }).where('id', '=', l.id).execute();
      }
      // Lignes d'inventaire non comptées : écartées, le stock de ces articles reste inchangé.
      if (d.type === 'inventory') await trx.deleteFrom('stock_document_line').where('document_id', '=', id).where('quantity', 'is', null).execute();

      let treasuryMovementId: string | null = null;
      if (d.reason === 'cash_purchase' && total > 0) {
        const mv = await this.treasury.record(trx, t, {
          accountId: d.treasury_account_id!, date: d.date, direction: 'out', amount: franc(total), category: 'goods_purchase',
          label: `Achat comptant de marchandises ${number}`, contactId: d.contact_id, sourceType: 'stock_purchase', sourceId: d.id, reference: d.reference,
        });
        treasuryMovementId = mv.id;
      }
      await trx.updateTable('stock_document').set({
        status: 'done', number, total_value: franc(total), treasury_movement_id: treasuryMovementId, validated_at: new Date(), validated_by: t.ctx.userId,
      }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `stock_${d.type}.validated`, entityType: 'stock_document', entityId: id, data: { number, reason: d.reason, lines: active.length, value: franc(total) } });
    });
    return this.getDocument(t, id);
  }
}

const movementRow = <R extends { quantity: string; value: string; qtyAfter: string; valueAfter: string; whQtyAfter: string }>(r: R) => ({
  ...r, quantity: Number(r.quantity), value: Number(r.value), qtyAfter: Number(r.qtyAfter), valueAfter: Number(r.valueAfter), whQtyAfter: Number(r.whQtyAfter),
});
