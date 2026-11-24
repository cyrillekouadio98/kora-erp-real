import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, notFound } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { isoDate } from '../sales/sales.controller';

const FEATURE = 'crm';
export const STAGES = ['new', 'qualified', 'quote', 'negotiation', 'won', 'lost'] as const;
/** Probabilité de gain par étape, pour le montant pondéré du portefeuille. */
export const PROBABILITY: Record<(typeof STAGES)[number], number> = { new: 10, qualified: 30, quote: 50, negotiation: 75, won: 100, lost: 0 };
const KINDS = ['call', 'meeting', 'email', 'note', 'task'] as const;

const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const Fields = z.object({
  title: z.string().trim().min(2, { message: "Donnez un intitulé à l'opportunité" }).max(160),
  contactId: z.string().uuid().nullable().optional(),
  prospectName: text(160), prospectPhone: text(40), prospectEmail: z.string().trim().toLowerCase().email({ message: 'Adresse e-mail invalide' }).max(254).nullable().optional().or(z.literal('').transform(() => null)),
  amount: z.coerce.number().min(0).max(1e13).transform((v) => Math.round(v)).optional(),
  expectedClose: isoDate.nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  source: text(60), notes: text(4000),
  stage: z.enum(STAGES).optional(),
  lostReason: text(300),
  quoteId: z.string().uuid().nullable().optional(),
});

/** Suivi commercial : opportunités par étape, actions et prochaine action, devis lié. */
@ApiTags('Suivi commercial')
@Controller('company/opportunities')
export class OpportunitiesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private async opp(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Opportunité');
    const o = await trx.selectFrom('opportunity').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!o) throw notFound('Opportunité');
    return o;
  }

  /** Contrôles communs : client existant et non fournisseur seul, commercial membre actif, devis du même client. */
  private async check(trx: TenantTrx, input: { contactId?: string | null; ownerId?: string | null; quoteId?: string | null }, contactId: string | null) {
    if (input.contactId) {
      const c = await trx.selectFrom('contact').select(['id', 'kind', 'name', 'archived_at']).where('id', '=', input.contactId).executeTakeFirst();
      if (!c || c.archived_at) throw badRequest('Client introuvable ou archivé.', undefined, 'unknown_contact');
      if (c.kind === 'supplier') throw badRequest(`${c.name} est enregistré comme fournisseur uniquement.`, undefined, 'not_a_customer');
    }
    if (input.ownerId && !(await trx.selectFrom('company_membership').select('id').where('user_id', '=', input.ownerId).where('status', '=', 'active').executeTakeFirst())) {
      throw badRequest("Le commercial choisi n'est pas un utilisateur actif de l'entreprise.", undefined, 'unknown_owner');
    }
    if (input.quoteId) {
      const q = await trx.selectFrom('sales_document').select(['id', 'contact_id', 'type']).where('id', '=', input.quoteId).executeTakeFirst();
      if (!q || q.type === 'credit_note') throw badRequest('Devis introuvable.', undefined, 'unknown_quote');
      if (q.contact_id !== contactId) throw badRequest("Ce devis n'est pas celui du client de l'opportunité.", undefined, 'quote_other_contact');
    }
  }

  @Permission('sales.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get()
  index(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = parse(z.object({ ownerId: z.string().optional(), q: z.string().trim().max(100).optional(), closed: z.enum(['open', 'recent', 'all']).default('recent') }), query);
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('opportunity as o').leftJoin('contact as c', (j) => j.onRef('c.id', '=', 'o.contact_id').onRef('c.company_id', '=', 'o.company_id'))
        .leftJoin('user_account as u', 'u.id', 'o.owner_id')
        .leftJoin('sales_document as d', (j) => j.onRef('d.id', '=', 'o.quote_id').onRef('d.company_id', '=', 'o.company_id'))
        .select(['o.id', 'o.code', 'o.title', 'o.contact_id', 'o.prospect_name', 'o.stage', 'o.amount', 'o.expected_close', 'o.owner_id', 'o.source', 'o.closed_at', 'o.updated_at',
          'c.name as contact_name', 'u.full_name as owner_name', 'd.number as quote_number', 'd.total_ttc as quote_total',
          (eb) => eb.selectFrom('opportunity_activity as a').whereRef('a.opportunity_id', '=', 'o.id').where('a.done_at', 'is', null).where('a.due_date', 'is not', null)
            .select(sql<string>`json_build_object('kind', a.kind, 'note', a.note, 'dueDate', a.due_date)`.as('n')).orderBy('a.due_date').limit(1).as('next_action')]);
      if (f.ownerId && isUuid(f.ownerId)) q = q.where('o.owner_id', '=', f.ownerId);
      if (f.q) { const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; q = q.where((eb) => eb.or([eb('o.title', 'ilike', like), eb('o.prospect_name', 'ilike', like), eb('c.name', 'ilike', like), eb('o.code', 'ilike', like)])); }
      // Affaires closes : masquées, ou celles des 90 derniers jours.
      if (f.closed === 'open') q = q.where('o.closed_at', 'is', null);
      if (f.closed === 'recent') q = q.where((eb) => eb.or([eb('o.closed_at', 'is', null), eb('o.closed_at', '>=', new Date(Date.now() - 90 * 86_400_000))]));
      const rows = await q.orderBy('o.updated_at', 'desc').limit(1000).execute();
      const today = new Date().toISOString().slice(0, 10);
      const list = rows.map((o) => {
        const next = o.next_action as unknown as { kind: string; note: string; dueDate: string } | null;
        return { id: o.id, code: o.code, title: o.title, contactId: o.contact_id, customer: o.contact_name ?? o.prospect_name, prospect: !o.contact_id, stage: o.stage, amount: Number(o.amount),
          expectedClose: o.expected_close, ownerId: o.owner_id, owner: o.owner_name, source: o.source, closedAt: o.closed_at, quote: o.quote_number ? { number: o.quote_number, total: Number(o.quote_total) } : null,
          nextAction: next, overdue: !!next && next.dueDate < today };
      });
      const open = list.filter((o) => !o.closedAt);
      const monthStart = `${today.slice(0, 7)}-01`;
      const closedThisMonth = (stage: string) => list.filter((o) => o.stage === stage && o.closedAt && new Date(o.closedAt).toISOString().slice(0, 10) >= monthStart);
      const members = await trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id').select(['u.id', 'u.full_name as name']).where('m.status', '=', 'active').orderBy('u.full_name').execute();
      return {
        opportunities: list, members,
        summary: {
          open: open.length, pipeline: open.reduce((s, o) => s + o.amount, 0), weighted: Math.round(open.reduce((s, o) => s + (o.amount * PROBABILITY[o.stage]) / 100, 0)),
          overdue: open.filter((o) => o.overdue).length,
          wonThisMonth: { count: closedThisMonth('won').length, amount: closedThisMonth('won').reduce((s, o) => s + o.amount, 0) }, lostThisMonth: closedThisMonth('lost').length,
        },
      };
    });
  }

  @Permission('sales.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get(':id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const o = await this.opp(trx, id);
      const activities = await trx.selectFrom('opportunity_activity as a').leftJoin('user_account as u', 'u.id', 'a.user_id')
        .select(['a.id', 'a.kind', 'a.note', 'a.due_date as dueDate', 'a.done_at as doneAt', 'a.created_at as createdAt', 'u.full_name as user']).where('a.opportunity_id', '=', id).orderBy('a.created_at', 'desc').execute();
      const quotes = o.contact_id ? await trx.selectFrom('sales_document').select(['id', 'number', 'type', 'status', 'total_ttc as total', 'issue_date as date']).where('contact_id', '=', o.contact_id)
        .where('type', 'in', ['quote', 'order', 'invoice']).orderBy('created_at', 'desc').limit(30).execute() : [];
      return {
        id: o.id, code: o.code, title: o.title, contactId: o.contact_id, prospectName: o.prospect_name, prospectPhone: o.prospect_phone, prospectEmail: o.prospect_email,
        stage: o.stage, amount: Number(o.amount), expectedClose: o.expected_close, ownerId: o.owner_id, source: o.source, quoteId: o.quote_id, lostReason: o.lost_reason, notes: o.notes,
        closedAt: o.closed_at, createdAt: o.created_at, activities, quotes: quotes.map((q) => ({ ...q, total: Number(q.total) })),
      };
    });
  }

  @Permission('sales.create') @RequireFeature(FEATURE)
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(Fields.strict(), body);
    if (!input.contactId && !input.prospectName) throw badRequest('Choisissez un client ou indiquez le nom du prospect.', undefined, 'customer_required');
    return this.db.tenant(t.ctx, async (trx) => {
      await this.check(trx, input, input.contactId ?? null);
      const code = await nextNumber(trx, t.companyId, 'opportunity', 'OPP');
      const stage = input.stage ?? (input.quoteId ? 'quote' : 'new');
      if (stage === 'lost' && !input.lostReason) throw badRequest('Indiquez pourquoi l’affaire est perdue.', undefined, 'lost_reason_required');
      const o = await trx.insertInto('opportunity').values({
        company_id: t.companyId, code, title: input.title, contact_id: input.contactId ?? null, prospect_name: input.contactId ? null : input.prospectName ?? null,
        prospect_phone: input.prospectPhone ?? null, prospect_email: input.prospectEmail ?? null, stage, amount: input.amount ?? 0, expected_close: input.expectedClose ?? null,
        owner_id: input.ownerId === undefined ? t.ctx.userId : input.ownerId, source: input.source ?? null, quote_id: input.quoteId ?? null, lost_reason: input.lostReason ?? null,
        notes: input.notes ?? null, closed_at: stage === 'won' || stage === 'lost' ? new Date() : null, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'opportunity.created', entityType: 'opportunity', entityId: o.id, data: { code, title: input.title, amount: input.amount ?? 0 } });
      return { id: o.id, code };
    });
  }

  @Permission('sales.update') @RequireFeature(FEATURE)
  @Patch(':id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(Fields.partial().strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const o = await this.opp(trx, id);
      const contactId = input.contactId !== undefined ? input.contactId : o.contact_id;
      if (!contactId && !(input.prospectName ?? o.prospect_name)) throw badRequest('Choisissez un client ou indiquez le nom du prospect.', undefined, 'customer_required');
      await this.check(trx, input, contactId);
      const patch: Record<string, unknown> = {};
      const map: Record<string, string> = { title: 'title', contactId: 'contact_id', prospectName: 'prospect_name', prospectPhone: 'prospect_phone', prospectEmail: 'prospect_email', amount: 'amount',
        expectedClose: 'expected_close', ownerId: 'owner_id', source: 'source', notes: 'notes', lostReason: 'lost_reason', quoteId: 'quote_id' };
      for (const [k, col] of Object.entries(map)) if ((input as any)[k] !== undefined) patch[col] = (input as any)[k];
      // Client choisi : le prospect est devenu client, son devis précédent (autre client) ne tient plus.
      if (input.contactId && input.contactId !== o.contact_id && input.quoteId === undefined && o.quote_id) patch.quote_id = null;
      let stage = input.stage ?? o.stage;
      if (input.quoteId && !input.stage && (stage === 'new' || stage === 'qualified')) stage = 'quote';
      if (stage !== o.stage) {
        patch.stage = stage;
        patch.closed_at = stage === 'won' || stage === 'lost' ? new Date() : null;
        if (stage !== 'lost') patch.lost_reason = null;
      }
      if (stage === 'lost' && !(input.lostReason ?? o.lost_reason)) throw badRequest('Indiquez pourquoi l’affaire est perdue.', undefined, 'lost_reason_required');
      if (Object.keys(patch).length) await trx.updateTable('opportunity').set(patch).where('id', '=', id).execute();
      if (patch.stage) {
        await trx.insertInto('opportunity_activity').values({ company_id: t.companyId, opportunity_id: id, kind: 'note', note: `Étape : ${o.stage} → ${stage}${stage === 'lost' ? ` (${input.lostReason ?? o.lost_reason})` : ''}`, user_id: t.ctx.userId, done_at: new Date() }).execute();
        await this.audit.tenant(trx, t.ctx, { action: 'opportunity.stage_changed', entityType: 'opportunity', entityId: id, data: { code: o.code, from: o.stage, to: stage } });
      }
      return { ok: true };
    });
  }

  /** Action sur l'opportunité : faite (appel, rendez-vous, e-mail, note) ou à faire (avec une date). */
  @Permission('sales.update') @RequireFeature(FEATURE)
  @Post(':id/activities')
  addActivity(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ kind: z.enum(KINDS), note: z.string().trim().min(1, { message: "Décrivez l'action" }).max(2000), dueDate: isoDate.nullable().optional() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const o = await this.opp(trx, id);
      const a = await trx.insertInto('opportunity_activity').values({ company_id: t.companyId, opportunity_id: o.id, kind: input.kind, note: input.note, due_date: input.dueDate ?? null,
        done_at: input.dueDate ? null : new Date(), user_id: t.ctx.userId }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('opportunity').set({ updated_at: new Date() }).where('id', '=', o.id).execute();
      return { id: a.id };
    });
  }

  @Permission('sales.update') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('activities/:id/done')
  done(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Action');
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await trx.updateTable('opportunity_activity').set({ done_at: new Date() }).where('id', '=', id).where('done_at', 'is', null).returning('id').executeTakeFirst();
      if (!a) throw conflict('Action introuvable ou déjà faite.', 'activity_done');
      return { ok: true };
    });
  }

  @Permission('sales.update') @RequireFeature(FEATURE)
  @Delete('activities/:id')
  removeActivity(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Action');
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await trx.deleteFrom('opportunity_activity').where('id', '=', id).where('user_id', '=', t.ctx.userId).returning('id').executeTakeFirst();
      if (!a) throw conflict('Seul son auteur peut supprimer une action.', 'not_author');
      return { ok: true };
    });
  }
}
