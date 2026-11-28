import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { assertSiteAccess, workingSite } from '../../common/sites';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { computeTotals } from '../sales/sales.service';
import { PosService } from './pos.service';

const FEATURE = 'restaurant_tables';
const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
const uuid = (msg: string) => z.string().uuid({ message: msg });
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const qty = z.coerce.number().positive({ message: 'La quantité doit être positive' }).max(1e6).transform((v) => Math.round(v * 1000) / 1000);
const amount = z.coerce.number().min(0, { message: 'Le montant ne peut pas être négatif' }).max(1e13).transform((v) => Math.round(v));
const name = (what: string) => z.string().trim().min(1, { message: `Donnez un nom ${what}` }).max(40);
const TableFields = z.object({
  areaId: uuid('Salle introuvable'), name: name('à la table'), seats: z.coerce.number().int().min(1).max(50).optional(),
  shape: z.enum(['square', 'round', 'long']).optional(), x: z.coerce.number().int().min(0).max(29).optional(), y: z.coerce.number().int().min(0).max(29).optional(),
});
const PaySchema = z.object({
  sessionId: uuid('Session de caisse introuvable'),
  contactId: uuid('Client introuvable').nullable().optional(),
  payments: z.array(z.object({
    method: z.enum(['cash', 'mobile_money', 'card'], { message: 'Mode de paiement : espèces, mobile money ou carte' }),
    amount, reference: text(100),
  }).strict()).min(1, { message: 'Indiquez le paiement' }).max(5),
}).strict();

/**
 * Restaurant : plan de salle (salles et tables d'un site) et commandes à table.
 * Une table occupée porte une commande ouverte ; les serveurs y ajoutent des articles au fil du repas,
 * la transfèrent d'une table à l'autre, puis la caisse l'encaisse : elle devient un ticket de caisse ordinaire.
 */
@ApiTags('Point de vente')
@Controller('company/restaurant')
export class RestaurantController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly pos: PosService) {}

  /** Site du plan : celui de la caisse demandée, sinon le site choisi, sinon le site affiché ou le site principal. */
  private async siteOf(trx: TenantTrx, t: TenantInfo, f: { registerId?: string; siteId?: string }) {
    let siteId: string | undefined;
    if (f.registerId) {
      if (!isUuid(f.registerId)) throw notFound('Caisse');
      const r = await trx.selectFrom('pos_register').select('site_id').where('id', '=', f.registerId).executeTakeFirst();
      if (!r) throw notFound('Caisse');
      siteId = r.site_id;
    } else if (f.siteId) {
      if (!isUuid(f.siteId)) throw notFound('Site');
      siteId = f.siteId;
    } else siteId = workingSite(t) ?? (await trx.selectFrom('site').select('id').where('is_default', '=', true).executeTakeFirstOrThrow()).id;
    assertSiteAccess(t, siteId);
    return siteId;
  }

  private async area(trx: TenantTrx, t: TenantInfo, id: string) {
    if (!isUuid(id)) throw notFound('Salle');
    const a = await trx.selectFrom('dining_area').selectAll().where('id', '=', id).executeTakeFirst();
    if (!a) throw notFound('Salle');
    assertSiteAccess(t, a.site_id);
    return a;
  }

  private async table(trx: TenantTrx, t: TenantInfo, id: string) {
    if (!isUuid(id)) throw notFound('Table');
    const x = await trx.selectFrom('dining_table').selectAll().where('id', '=', id).executeTakeFirst();
    if (!x) throw notFound('Table');
    assertSiteAccess(t, x.site_id);
    return x;
  }

  private async order(trx: TenantTrx, t: TenantInfo, id: string, open = true) {
    if (!isUuid(id)) throw notFound('Commande');
    const o = await trx.selectFrom('table_order').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!o) throw notFound('Commande');
    assertSiteAccess(t, o.site_id);
    if (open && o.status !== 'open') throw conflict(o.status === 'paid' ? 'Cette commande est déjà encaissée.' : 'Cette commande est annulée.', 'order_closed');
    return o;
  }

  private async orderOut(trx: TenantTrx, id: string) {
    const o = await trx.selectFrom('table_order as o').innerJoin('dining_table as d', (j) => j.onRef('d.id', '=', 'o.table_id').onRef('d.company_id', '=', 'o.company_id'))
      .innerJoin('dining_area as a', (j) => j.onRef('a.id', '=', 'd.area_id').onRef('a.company_id', '=', 'd.company_id'))
      .leftJoin('user_account as u', 'u.id', 'o.opened_by')
      .select(['o.id', 'o.status', 'o.guests', 'o.note', 'o.opened_at as openedAt', 'o.ticket_id as ticketId', 'o.table_id as tableId', 'd.name as tableName', 'a.name as areaName', 'u.full_name as openedBy'])
      .where('o.id', '=', id).executeTakeFirstOrThrow();
    const rows = await trx.selectFrom('table_order_line as l').leftJoin('user_account as u', 'u.id', 'l.created_by')
      .leftJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .leftJoin('kitchen_ticket as k', (j) => j.onRef('k.id', '=', 'l.kitchen_ticket_id').onRef('k.company_id', '=', 'l.company_id'))
      .select(['l.id', 'l.product_id as productId', 'l.description', 'l.unit', 'l.quantity', 'l.unit_price as unitPrice', 'l.vat_rate as vatRate', 'l.note', 'l.created_at as createdAt', 'u.full_name as createdBy',
        'l.sent_at as sentAt', 'p.prep_station as station', 'k.status as ticketStatus', 'k.number as ticketNumber'])
      .where('l.order_id', '=', id).orderBy('l.created_at').execute();
    const lines = rows.map((l) => ({ ...l, station: l.station ?? 'none', quantity: n(l.quantity), unitPrice: n(l.unitPrice), vatRate: n(l.vatRate) }));
    const totals = computeTotals(lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })));
    const tickets = await trx.selectFrom('kitchen_ticket').select(['id', 'number', 'station', 'status', 'created_at as createdAt', 'ready_at as readyAt']).where('order_id', '=', id).where('status', '!=', 'cancelled').orderBy('created_at').execute();
    return { ...o, lines: lines.map((l, i) => ({ ...l, totalTtc: totals.lines[i].ht + totals.lines[i].vat })), totals: { ht: totals.ht, vat: totals.vat, ttc: totals.ttc },
      tickets, unsent: lines.filter((l) => !l.sentAt).length };
  }

  // ------------------------------------------------------------------ plan de salle

  /** Plan d'un site : salles, tables et commande en cours de chaque table occupée. */
  @Permission('pos.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get('floor')
  floor(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = parse(z.object({ registerId: z.string().optional(), siteId: z.string().optional() }), query);
    return this.db.tenant(t.ctx, async (trx) => {
      const siteId = await this.siteOf(trx, t, f);
      const areas = await trx.selectFrom('dining_area').select(['id', 'name', 'position']).where('site_id', '=', siteId).where('archived_at', 'is', null).orderBy('position').orderBy('name').execute();
      const tables = await trx.selectFrom('dining_table').select(['id', 'area_id as areaId', 'name', 'seats', 'shape', 'x', 'y']).where('site_id', '=', siteId).where('archived_at', 'is', null).orderBy('name').execute();
      const orders = await trx.selectFrom('table_order as o').leftJoin('user_account as u', 'u.id', 'o.opened_by')
        .select(['o.id', 'o.table_id', 'o.guests', 'o.opened_at', 'u.full_name as openedBy']).where('o.site_id', '=', siteId).where('o.status', '=', 'open').execute();
      const lines = orders.length ? await trx.selectFrom('table_order_line').select(['order_id', 'quantity', 'unit_price', 'vat_rate'])
        .where('order_id', 'in', orders.map((o) => o.id)).execute() : [];
      const tk = orders.length ? await trx.selectFrom('kitchen_ticket').select(['order_id', 'status']).where('order_id', 'in', orders.map((o) => o.id)).where('status', 'in', ['pending', 'ready']).execute() : [];
      const total = (id: string) => computeTotals(lines.filter((l) => l.order_id === id).map((l) => ({ description: '-', quantity: n(l.quantity), unitPrice: n(l.unit_price), vatRate: n(l.vat_rate) }))).ttc;
      return {
        siteId,
        areas: areas.map((a) => ({ ...a, tables: tables.filter((x) => x.areaId === a.id).map((x) => {
          const o = orders.find((y) => y.table_id === x.id);
          return { ...x, order: o ? { id: o.id, guests: o.guests, openedAt: o.opened_at, openedBy: o.openedBy, items: lines.filter((l) => l.order_id === o.id).length, total: total(o.id),
            pending: tk.filter((k) => k.order_id === o.id && k.status === 'pending').length, ready: tk.filter((k) => k.order_id === o.id && k.status === 'ready').length } : null };
        }) })),
      };
    });
  }

  @Permission('pos.admin') @RequireFeature(FEATURE)
  @Post('areas')
  createArea(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(z.object({ name: name('à la salle'), siteId: z.string().optional(), registerId: z.string().optional() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const siteId = await this.siteOf(trx, t, input);
      if (await trx.selectFrom('dining_area').select('id').where('site_id', '=', siteId).where('archived_at', 'is', null).where((eb) => eb.fn('lower', ['name']), '=', input.name.toLowerCase()).executeTakeFirst()) {
        throw conflict(`Une salle s'appelle déjà « ${input.name} ».`, 'area_exists');
      }
      const last = await trx.selectFrom('dining_area').select((eb) => eb.fn.max('position').as('p')).where('site_id', '=', siteId).executeTakeFirst();
      const a = await trx.insertInto('dining_area').values({ company_id: t.companyId, site_id: siteId, name: input.name, position: n(last?.p as any) + 1 }).returning('id').executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'restaurant.area_created', entityType: 'dining_area', entityId: a.id, data: { name: input.name } });
      return { id: a.id };
    });
  }

  @Permission('pos.admin') @RequireFeature(FEATURE)
  @Patch('areas/:id')
  updateArea(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ name: name('à la salle').optional(), position: z.coerce.number().int().min(0).max(1000).optional(), archived: z.boolean().optional() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.area(trx, t, id);
      if (input.archived) {
        const busy = await trx.selectFrom('table_order as o').innerJoin('dining_table as d', (j) => j.onRef('d.id', '=', 'o.table_id').onRef('d.company_id', '=', 'o.company_id'))
          .select('o.id').where('d.area_id', '=', id).where('o.status', '=', 'open').executeTakeFirst();
        if (busy) throw conflict('Une table de cette salle est occupée : encaissez ou annulez sa commande avant de retirer la salle.', 'area_busy');
        await trx.updateTable('dining_table').set({ archived_at: new Date() }).where('area_id', '=', id).where('archived_at', 'is', null).execute();
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.position !== undefined) patch.position = input.position;
      if (input.archived !== undefined) patch.archived_at = input.archived ? new Date() : null;
      if (Object.keys(patch).length) await trx.updateTable('dining_area').set(patch).where('id', '=', id).execute();
      if (input.archived) await this.audit.tenant(trx, t.ctx, { action: 'restaurant.area_archived', entityType: 'dining_area', entityId: id, data: { name: a.name } });
      return { ok: true };
    });
  }

  @Permission('pos.admin') @RequireFeature(FEATURE)
  @Post('tables')
  createTable(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(TableFields.strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.area(trx, t, input.areaId);
      if (a.archived_at) throw conflict('Cette salle est retirée du plan.', 'area_archived');
      await this.uniqueName(trx, a.site_id, input.name);
      const x = await trx.insertInto('dining_table').values({ company_id: t.companyId, site_id: a.site_id, area_id: a.id, name: input.name, seats: input.seats ?? 4, shape: input.shape ?? 'square', x: input.x ?? 0, y: input.y ?? 0 })
        .returning('id').executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'restaurant.table_created', entityType: 'dining_table', entityId: x.id, data: { name: input.name, area: a.name } });
      return { id: x.id };
    });
  }

  private async uniqueName(trx: TenantTrx, siteId: string, tableName: string, except?: string) {
    let q = trx.selectFrom('dining_table').select('id').where('site_id', '=', siteId).where('archived_at', 'is', null).where((eb) => eb.fn('lower', ['name']), '=', tableName.toLowerCase());
    if (except) q = q.where('id', '!=', except);
    if (await q.executeTakeFirst()) throw conflict(`Une table s'appelle déjà « ${tableName} ».`, 'table_exists');
  }

  @Permission('pos.admin') @RequireFeature(FEATURE)
  @Patch('tables/:id')
  updateTable(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(TableFields.partial().extend({ archived: z.boolean().optional() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const x = await this.table(trx, t, id);
      const patch: Record<string, unknown> = {};
      if (input.areaId && input.areaId !== x.area_id) {
        const a = await this.area(trx, t, input.areaId);
        if (a.site_id !== x.site_id || a.archived_at) throw badRequest('Choisissez une salle du même site.', undefined, 'area_other_site');
        patch.area_id = a.id;
      }
      if (input.name !== undefined && input.name !== x.name) { await this.uniqueName(trx, x.site_id, input.name, id); patch.name = input.name; }
      for (const k of ['seats', 'shape', 'x', 'y'] as const) if (input[k] !== undefined) patch[k] = input[k];
      if (input.archived !== undefined) {
        if (input.archived && await trx.selectFrom('table_order').select('id').where('table_id', '=', id).where('status', '=', 'open').executeTakeFirst()) {
          throw conflict('Cette table est occupée : encaissez ou annulez sa commande avant de la retirer.', 'table_busy');
        }
        patch.archived_at = input.archived ? new Date() : null;
      }
      if (Object.keys(patch).length) await trx.updateTable('dining_table').set(patch).where('id', '=', id).execute();
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ commandes

  /** Ouvre la table : une commande vide, avec le nombre de couverts. */
  @Permission('pos.create') @RequireFeature(FEATURE)
  @Post('tables/:id/orders')
  open(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ guests: z.coerce.number().int().min(1).max(200).optional(), note: text(300) }).strict(), body ?? {});
    return this.db.tenant(t.ctx, async (trx) => {
      const x = await this.table(trx, t, id);
      if (x.archived_at) throw conflict('Cette table est retirée du plan.', 'table_archived');
      if (await trx.selectFrom('table_order').select('id').where('table_id', '=', id).where('status', '=', 'open').executeTakeFirst()) {
        throw conflict(`La table ${x.name} est déjà occupée.`, 'table_busy');
      }
      const o = await trx.insertInto('table_order').values({ company_id: t.companyId, site_id: x.site_id, table_id: id, guests: input.guests ?? Math.min(x.seats, 2), note: input.note ?? null, opened_by: t.ctx.userId })
        .returning('id').executeTakeFirstOrThrow();
      return this.orderOut(trx, o.id);
    });
  }

  @Permission('pos.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get('orders/:id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => { await this.order(trx, t, id, false); return this.orderOut(trx, id); });
  }

  @Permission('pos.create') @RequireFeature(FEATURE)
  @Patch('orders/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ guests: z.coerce.number().int().min(1).max(200).optional(), note: text(300) }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      await this.order(trx, t, id);
      const patch: Record<string, unknown> = {};
      if (input.guests !== undefined) patch.guests = input.guests;
      if (input.note !== undefined) patch.note = input.note;
      if (Object.keys(patch).length) await trx.updateTable('table_order').set(patch).where('id', '=', id).execute();
      return this.orderOut(trx, id);
    });
  }

  /** Ajoute des articles à la commande, au prix de l'article (une ligne par envoi, avec sa remarque éventuelle). */
  @Permission('pos.create') @RequireFeature(FEATURE)
  @Post('orders/:id/lines')
  addLines(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ lines: z.array(z.object({ productId: uuid('Article introuvable'), quantity: qty, note: text(200) }).strict()).min(1).max(100) }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const o = await this.order(trx, t, id);
      const ids = [...new Set(input.lines.map((l) => l.productId))];
      const products = await trx.selectFrom('product').select(['id', 'name', 'unit', 'sale_price', 'vat_rate', 'archived_at', 'site_id']).where('id', 'in', ids).execute();
      for (const pid of ids) {
        const p = products.find((x) => x.id === pid);
        if (!p || p.archived_at || (p.site_id && p.site_id !== o.site_id)) throw badRequest('Un ou plusieurs articles sont introuvables ou archivés.', undefined, 'unknown_product');
      }
      // Même article sans remarque : la quantité de la ligne existante augmente (« 2 × Bière » plutôt que deux lignes).
      const existing = await trx.selectFrom('table_order_line').select(['id', 'product_id', 'quantity']).where('order_id', '=', id).where('note', 'is', null).where('sent_at', 'is', null).execute();
      const fresh: typeof input.lines = [];
      for (const l of input.lines) {
        const same = !l.note && existing.find((e) => e.product_id === l.productId);
        if (same) {
          const quantity = Math.round((n(same.quantity) + l.quantity) * 1000) / 1000;
          await trx.updateTable('table_order_line').set({ quantity }).where('id', '=', same.id).execute();
          same.quantity = String(quantity);
        } else fresh.push(l);
      }
      if (fresh.length) await trx.insertInto('table_order_line').values(fresh.map((l) => {
        const p = products.find((x) => x.id === l.productId)!;
        return { company_id: t.companyId, site_id: o.site_id, order_id: id, product_id: p.id, description: p.name, unit: p.unit, quantity: l.quantity, unit_price: n(p.sale_price), vat_rate: n(p.vat_rate), note: l.note ?? null, created_by: t.ctx.userId };
      })).execute();
      return this.orderOut(trx, id);
    });
  }

  @Permission('pos.create') @RequireFeature(FEATURE)
  @Patch('orders/:id/lines/:lineId')
  updateLine(@Tenant() t: TenantInfo, @Param('id') id: string, @Param('lineId') lineId: string, @Body() body: unknown) {
    const input = parse(z.object({ quantity: qty.optional(), note: text(200) }).strict(), body);
    if (!isUuid(lineId)) throw notFound('Ligne');
    return this.db.tenant(t.ctx, async (trx) => {
      await this.order(trx, t, id);
      const line = await trx.selectFrom('table_order_line').select(['description', 'quantity', 'sent_at']).where('id', '=', lineId).where('order_id', '=', id).executeTakeFirst();
      if (!line) throw notFound('Ligne');
      if (line.sent_at) {
        // Déjà en préparation : on n'y ajoute rien (nouvel envoi), on n'en retire qu'avec l'accord du responsable.
        if (input.note !== undefined || (input.quantity ?? 0) > n(line.quantity)) throw conflict('Cet article est déjà envoyé : ajoutez-le de nouveau pour en commander plus.', 'line_sent');
        this.assertManager(t);
      }
      const patch: Record<string, unknown> = {};
      if (input.quantity !== undefined) patch.quantity = input.quantity;
      if (input.note !== undefined) patch.note = input.note;
      if (Object.keys(patch).length) await trx.updateTable('table_order_line').set(patch).where('id', '=', lineId).execute();
      if (line.sent_at && input.quantity !== undefined) await this.audit.tenant(trx, t.ctx, { action: 'restaurant.sent_line_reduced', entityType: 'table_order', entityId: id, data: { description: line.description, from: n(line.quantity), to: input.quantity } });
      return this.orderOut(trx, id);
    });
  }

  @Permission('pos.create') @RequireFeature(FEATURE)
  @Delete('orders/:id/lines/:lineId')
  removeLine(@Tenant() t: TenantInfo, @Param('id') id: string, @Param('lineId') lineId: string) {
    if (!isUuid(lineId)) throw notFound('Ligne');
    return this.db.tenant(t.ctx, async (trx) => {
      await this.order(trx, t, id);
      const line = await trx.selectFrom('table_order_line').select(['sent_at']).where('id', '=', lineId).where('order_id', '=', id).executeTakeFirst();
      if (!line) throw notFound('Ligne');
      if (line.sent_at) this.assertManager(t);
      const r = await trx.deleteFrom('table_order_line').where('id', '=', lineId).returning(['description', 'quantity']).executeTakeFirstOrThrow();
      if (line.sent_at) await this.audit.tenant(trx, t.ctx, { action: 'restaurant.sent_line_removed', entityType: 'table_order', entityId: id, data: { description: r.description, quantity: n(r.quantity) } });
      return this.orderOut(trx, id);
    });
  }

  /** Transfère la commande sur une table libre du même site (les clients changent de place). */
  @Permission('pos.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('orders/:id/move')
  move(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ tableId: uuid('Table introuvable') }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const o = await this.order(trx, t, id);
      const x = await this.table(trx, t, input.tableId);
      if (x.site_id !== o.site_id || x.archived_at) throw badRequest('Choisissez une table du même établissement.', undefined, 'table_other_site');
      if (x.id === o.table_id) return this.orderOut(trx, id);
      if (await trx.selectFrom('table_order').select('id').where('table_id', '=', x.id).where('status', '=', 'open').executeTakeFirst()) throw conflict(`La table ${x.name} est déjà occupée.`, 'table_busy');
      await trx.updateTable('table_order').set({ table_id: x.id }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'restaurant.order_moved', entityType: 'table_order', entityId: id, data: { to: x.name } });
      return this.orderOut(trx, id);
    });
  }

  /** Encaisse la commande sur une session de caisse ouverte du même site : elle devient un ticket de caisse. */
  @Permission('pos.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('orders/:id/pay')
  async pay(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(PaySchema, body);
    const ticketId = await this.db.tenant(t.ctx, async (trx) => {
      const o = await this.order(trx, t, id);
      const lines = await trx.selectFrom('table_order_line').selectAll().where('order_id', '=', id).orderBy('created_at').execute();
      if (!lines.length) throw badRequest('La commande est vide : ajoutez des articles ou annulez-la.', undefined, 'order_empty');
      if (!isUuid(input.sessionId)) throw notFound('Session de caisse');
      const s = await trx.selectFrom('pos_session').select(['site_id']).where('id', '=', input.sessionId).executeTakeFirst();
      if (s && s.site_id !== o.site_id) throw badRequest("Encaissez la commande sur une caisse de l'établissement de la table.", undefined, 'session_other_site');
      const tableName = (await trx.selectFrom('dining_table').select('name').where('id', '=', o.table_id).executeTakeFirstOrThrow()).name;
      const ticket = await this.pos.sellIn(trx, t, input.sessionId, {
        contactId: input.contactId ?? null, payments: input.payments,
        lines: lines.map((l) => ({ productId: l.product_id, description: l.description, quantity: n(l.quantity), unit: l.unit, unitPrice: n(l.unit_price), vatRate: n(l.vat_rate) })),
      });
      await trx.updateTable('sales_document').set({ notes: `Table ${tableName} · ${o.guests} couvert${o.guests > 1 ? 's' : ''}` }).where('id', '=', ticket).execute();
      await trx.updateTable('table_order').set({ status: 'paid', ticket_id: ticket, closed_by: t.ctx.userId, closed_at: new Date() }).where('id', '=', id).execute();
      return ticket;
    });
    return this.pos.ticket(t, ticketId);
  }

  /** Annule la commande : libre si elle est vide, sinon motif obligatoire et droit de valider en caisse. */
  @Permission('pos.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('orders/:id/cancel')
  cancel(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ reason: text(300) }).strict(), body ?? {});
    return this.db.tenant(t.ctx, async (trx) => {
      await this.order(trx, t, id);
      const all = await trx.selectFrom('table_order_line').select(['description', 'quantity', 'sent_at']).where('order_id', '=', id).execute();
      const lines = all.filter((l) => l.sent_at);
      if (lines.length) {
        if (!t.permissions.has('pos.validate')) throw forbidden("Annuler une commande déjà envoyée en cuisine demande l'accord du responsable de caisse.", 'cancel_needs_manager');
        if (!input.reason) throw badRequest("Indiquez pourquoi la commande est annulée.", undefined, 'reason_required');
      }
      await trx.updateTable('table_order').set({ status: 'cancelled', cancel_reason: input.reason ?? null, closed_by: t.ctx.userId, closed_at: new Date() }).where('id', '=', id).execute();
      await trx.updateTable('kitchen_ticket').set({ status: 'cancelled' }).where('order_id', '=', id).where('status', 'in', ['pending', 'ready']).execute();
      if (lines.length) await this.audit.tenant(trx, t.ctx, { action: 'restaurant.order_cancelled', entityType: 'table_order', entityId: id, data: { reason: input.reason, lines: lines.map((l) => `${n(l.quantity)} × ${l.description}`) } });
      return { ok: true };
    });
  }

  private assertManager(t: TenantInfo) {
    if (!t.permissions.has('pos.validate')) throw forbidden("Cet article est déjà envoyé en préparation : seul le responsable de caisse peut le retirer.", 'line_sent_needs_manager');
  }

  // ------------------------------------------------------------------ cuisine et bar

  /**
   * Envoie en préparation les articles pas encore envoyés : un bon par poste (cuisine, bar) ; les articles
   * sans préparation (boissons servies telles quelles) sont simplement marqués envoyés. Renvoie les bons à imprimer.
   */
  @Permission('pos.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('orders/:id/send')
  send(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const o = await this.order(trx, t, id);
      const lines = await trx.selectFrom('table_order_line as l').leftJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
        .select(['l.id', 'p.prep_station as station']).where('l.order_id', '=', id).where('l.sent_at', 'is', null).execute();
      if (!lines.length) throw conflict('Tout est déjà envoyé : ajoutez des articles avant un nouvel envoi.', 'nothing_to_send');
      const now = new Date();
      const created: string[] = [];
      for (const station of ['kitchen', 'bar'] as const) {
        const ids = lines.filter((l) => (l.station ?? 'none') === station).map((l) => l.id);
        if (!ids.length) continue;
        // Numéro du jour sur le site, sous verrou pour que deux serveurs n'obtiennent pas le même.
        await trx.selectFrom('site').select('id').where('id', '=', o.site_id).forUpdate().executeTakeFirst();
        const day = new Date(now.getTime()); day.setUTCHours(0, 0, 0, 0);
        const last = await trx.selectFrom('kitchen_ticket').select((eb) => eb.fn.max('number').as('m')).where('site_id', '=', o.site_id).where('created_at', '>=', day).executeTakeFirst();
        const k = await trx.insertInto('kitchen_ticket').values({ company_id: t.companyId, site_id: o.site_id, order_id: id, station, number: n(last?.m as any) + 1, created_by: t.ctx.userId })
          .returning('id').executeTakeFirstOrThrow();
        await trx.updateTable('table_order_line').set({ sent_at: now, kitchen_ticket_id: k.id }).where('id', 'in', ids).execute();
        created.push(k.id);
      }
      const none = lines.filter((l) => !['kitchen', 'bar'].includes(l.station ?? 'none')).map((l) => l.id);
      if (none.length) await trx.updateTable('table_order_line').set({ sent_at: now }).where('id', 'in', none).execute();
      return { order: await this.orderOut(trx, id), tickets: created.length ? await this.ticketsOut(trx, created) : [] };
    });
  }

  /** Bons avec leurs articles, la table et le serveur (écran du poste et impression). */
  private async ticketsOut(trx: TenantTrx, ids: string[]) {
    if (!ids.length) return [];
    const rows = await trx.selectFrom('kitchen_ticket as k').innerJoin('table_order as o', (j) => j.onRef('o.id', '=', 'k.order_id').onRef('o.company_id', '=', 'k.company_id'))
      .innerJoin('dining_table as d', (j) => j.onRef('d.id', '=', 'o.table_id').onRef('d.company_id', '=', 'o.company_id'))
      .leftJoin('user_account as u', 'u.id', 'k.created_by')
      .select(['k.id', 'k.number', 'k.station', 'k.status', 'k.created_at as createdAt', 'k.ready_at as readyAt', 'k.order_id as orderId', 'd.name as tableName', 'o.guests', 'u.full_name as waiter'])
      .where('k.id', 'in', ids).orderBy('k.created_at').execute();
    const lines = await trx.selectFrom('table_order_line').select(['kitchen_ticket_id', 'description', 'quantity', 'note']).where('kitchen_ticket_id', 'in', ids).orderBy('created_at').execute();
    return rows.map((k) => ({ ...k, lines: lines.filter((l) => l.kitchen_ticket_id === k.id).map((l) => ({ description: l.description, quantity: n(l.quantity), note: l.note })) }));
  }

  /** Écran d'un poste : bons à préparer (du plus ancien au plus récent) et bons prêts pas encore servis. */
  @Permission('pos.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get('kitchen')
  board(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = parse(z.object({ station: z.enum(['kitchen', 'bar']).default('kitchen'), registerId: z.string().optional(), siteId: z.string().optional() }), query);
    return this.db.tenant(t.ctx, async (trx) => {
      const siteId = await this.siteOf(trx, t, f);
      const ids = (await trx.selectFrom('kitchen_ticket').select('id').where('site_id', '=', siteId).where('station', '=', f.station).where('status', 'in', ['pending', 'ready'])
        .orderBy('created_at').limit(200).execute()).map((x) => x.id);
      const counts = await trx.selectFrom('kitchen_ticket').select(['station', (eb) => eb.fn.countAll<string>().as('c')]).where('site_id', '=', siteId).where('status', '=', 'pending').groupBy('station').execute();
      const tickets = await this.ticketsOut(trx, ids);
      return { siteId, station: f.station, pending: tickets.filter((k) => k.status === 'pending'), ready: tickets.filter((k) => k.status === 'ready'),
        counts: Object.fromEntries(counts.map((c) => [c.station, Number(c.c)])) };
    });
  }

  /** Le poste annonce le bon prêt ; « pending » le remet à préparer (erreur de manipulation). */
  @Permission('pos.read') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('kitchen/:id/:status')
  mark(@Tenant() t: TenantInfo, @Param('id') id: string, @Param('status') status: string) {
    if (!['ready', 'pending', 'served'].includes(status)) throw notFound('Action');
    if (!isUuid(id)) throw notFound('Bon');
    return this.db.tenant(t.ctx, async (trx) => {
      const k = await trx.selectFrom('kitchen_ticket').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!k) throw notFound('Bon');
      assertSiteAccess(t, k.site_id);
      if (k.status === 'cancelled') throw conflict('Ce bon est annulé : la commande a été annulée.', 'ticket_cancelled');
      // Servir un plat revient au serveur (droit de prendre les commandes) ; l'annoncer prêt, au poste.
      if (status === 'served' && !t.permissions.has('pos.create')) throw forbidden();
      const patch = status === 'ready' ? { status: 'ready' as const, ready_at: new Date(), ready_by: t.ctx.userId }
        : status === 'served' ? { status: 'served' as const, served_at: new Date() } : { status: 'pending' as const, ready_at: null, ready_by: null, served_at: null };
      await trx.updateTable('kitchen_ticket').set(patch).where('id', '=', id).execute();
      return { ok: true };
    });
  }

  /** Articles et leur poste de préparation (cuisine, bar, aucun). */
  @Permission('pos.admin') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get('stations')
  stations(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, (trx) => trx.selectFrom('product').select(['id', 'code', 'name', 'kind', 'prep_station as station']).where('archived_at', 'is', null).orderBy('name').limit(2000).execute());
  }

  @Permission('pos.admin') @RequireFeature(FEATURE)
  @Put('stations')
  setStations(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(z.object({ productIds: z.array(uuid('Article introuvable')).min(1).max(2000), station: z.enum(['kitchen', 'bar', 'none']) }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const r = await trx.updateTable('product').set({ prep_station: input.station }).where('id', 'in', input.productIds).returning('id').execute();
      return { updated: r.length };
    });
  }
}
