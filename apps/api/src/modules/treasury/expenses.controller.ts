import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { isoDate } from '../sales/sales.controller';
import { TreasuryService } from './treasury.service';

const FEATURE = 'expenses';
/** Catégories d'une note de frais : celles des dépenses de trésorerie (même compte de charge). */
export const EXPENSE_CLAIM_CATEGORIES = ['transport', 'fuel', 'telecom', 'supplies', 'maintenance', 'other_expense'] as const;
const today = () => new Date().toISOString().slice(0, 10);
const receipt = z.string().max(960_000, { message: 'Justificatif trop lourd (700 Ko au plus)' });

/** Justificatif en data URL : photo (JPEG, PNG, WebP réduite par le navigateur) ou PDF, 700 Ko au plus. */
function parseReceipt(dataUrl: string) {
  const m = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Justificatif non reconnu : photo JPEG, PNG, WebP ou fichier PDF.', undefined, 'invalid_receipt');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 700_000) throw badRequest('Justificatif trop lourd (700 Ko au plus).', undefined, 'receipt_too_large');
  return { mime: m[1], data };
}

/** Notes de frais : déclaration par l'utilisateur, validation par un responsable, remboursement en trésorerie. */
@ApiTags('Trésorerie')
@Controller('company/expenses')
export class ExpensesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly treasury: TreasuryService) {}

  /** Responsable des notes de frais : qui peut enregistrer des dépenses de trésorerie. */
  private manager(t: TenantInfo) { return t.permissions.has('cash.create'); }

  private async claim(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Note de frais');
    const c = await trx.selectFrom('expense_claim').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!c) throw notFound('Note de frais');
    return c;
  }

  @Permission(null) @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get()
  index(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const f = parse(z.object({ scope: z.enum(['mine', 'all']).default('mine'), status: z.enum(['submitted', 'approved', 'rejected', 'paid']).optional() }), query);
    if (f.scope === 'all' && !this.manager(t)) throw forbidden();
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('expense_claim as e').innerJoin('user_account as u', 'u.id', 'e.user_id').leftJoin('user_account as d', 'd.id', 'e.decided_by')
        .leftJoin('expense_receipt as r', (j) => j.onRef('r.claim_id', '=', 'e.id').onRef('r.company_id', '=', 'e.company_id'))
        .select(['e.id', 'e.code', 'e.user_id', 'u.full_name as user', 'e.date', 'e.category', 'e.label', 'e.amount', 'e.status', 'd.full_name as decided_by', 'e.decided_at', 'e.reject_reason', 'e.paid_at', 'e.created_at', 'r.mime as receipt_mime']);
      if (f.scope === 'mine') q = q.where('e.user_id', '=', t.ctx.userId);
      if (f.status) q = q.where('e.status', '=', f.status);
      const rows = await q.orderBy('e.created_at', 'desc').limit(500).execute();
      const claims = rows.map((r) => ({ id: r.id, code: r.code, userId: r.user_id, user: r.user, date: r.date, category: r.category, label: r.label, amount: Number(r.amount), status: r.status,
        decidedBy: r.decided_by, decidedAt: r.decided_at, rejectReason: r.reject_reason, paidAt: r.paid_at, createdAt: r.created_at, receipt: r.receipt_mime ? `/company/expenses/${r.id}/receipt` : null }));
      const sum = (s: string) => claims.filter((c) => c.status === s).reduce((x, c) => x + c.amount, 0);
      return { manager: this.manager(t), claims, totals: { submitted: sum('submitted'), approved: sum('approved'), paid: sum('paid') } };
    });
  }

  @Permission(null) @RequireFeature(FEATURE)
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(z.object({
      date: isoDate, category: z.enum(EXPENSE_CLAIM_CATEGORIES, { message: 'Catégorie inconnue' }),
      label: z.string().trim().min(2, { message: 'Décrivez la dépense' }).max(200),
      amount: z.coerce.number().positive({ message: 'Le montant doit être positif' }).max(1e9).transform((v) => Math.round(v)),
      receipt: receipt.nullable().optional(),
    }).strict(), body);
    if (input.date > today()) throw badRequest('La date de la dépense ne peut pas être dans le futur.', undefined, 'future_date');
    if (t.readOnly) throw forbidden();
    const file = input.receipt ? parseReceipt(input.receipt) : null;
    return this.db.tenant(t.ctx, async (trx) => {
      const code = await nextNumber(trx, t.companyId, 'expense_claim', 'NDF');
      const c = await trx.insertInto('expense_claim').values({ company_id: t.companyId, code, user_id: t.ctx.userId, date: input.date, category: input.category, label: input.label, amount: input.amount,
        decided_by: null, decided_at: null, reject_reason: null, movement_id: null, paid_at: null }).returning('id').executeTakeFirstOrThrow();
      if (file) await trx.insertInto('expense_receipt').values({ company_id: t.companyId, claim_id: c.id, mime: file.mime, data: file.data }).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'expense_claim.submitted', entityType: 'expense_claim', entityId: c.id, data: { code, amount: input.amount, label: input.label } });
      return { id: c.id, code };
    });
  }

  /** Justificatif ajouté ou remplacé par l'auteur, tant que la note n'est pas décidée. */
  @Permission(null) @RequireFeature(FEATURE) @HttpCode(200)
  @Put(':id/receipt')
  setReceipt(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const file = parseReceipt(parse(z.object({ receipt }).strict(), body).receipt);
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await this.claim(trx, id);
      if (c.user_id !== t.ctx.userId) throw forbidden();
      if (c.status !== 'submitted') throw conflict('Cette note de frais est déjà décidée.', 'claim_decided');
      await trx.insertInto('expense_receipt').values({ company_id: t.companyId, claim_id: c.id, mime: file.mime, data: file.data })
        .onConflict((oc) => oc.columns(['company_id', 'claim_id']).doUpdateSet({ mime: file.mime, data: file.data, updated_at: new Date() })).execute();
      return { ok: true };
    });
  }

  @Permission(null) @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get(':id/receipt')
  async getReceipt(@Tenant() t: TenantInfo, @Param('id') id: string, @Res() res: Response) {
    const r = await this.db.tenant(t.ctx, async (trx) => {
      const c = await this.claim(trx, id);
      if (c.user_id !== t.ctx.userId && !this.manager(t)) throw forbidden();
      return trx.selectFrom('expense_receipt').select(['mime', 'data']).where('claim_id', '=', id).executeTakeFirst();
    });
    if (!r) throw notFound('Justificatif');
    res.setHeader('Content-Type', r.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    res.send(r.data);
  }

  /** Retrait d'une note par son auteur, tant qu'elle n'est pas décidée. */
  @Permission(null) @RequireFeature(FEATURE)
  @Delete(':id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await this.claim(trx, id);
      if (c.user_id !== t.ctx.userId) throw forbidden();
      if (c.status !== 'submitted') throw conflict('Cette note de frais est déjà décidée : elle ne se retire plus.', 'claim_decided');
      await trx.deleteFrom('expense_claim').where('id', '=', id).execute();
      return { ok: true };
    });
  }

  /** Décision du responsable : on ne valide pas sa propre note, sauf le propriétaire de l'entreprise. */
  private async decide(t: TenantInfo, id: string, status: 'approved' | 'rejected', reason?: string) {
    if (!this.manager(t)) throw forbidden();
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await this.claim(trx, id);
      if (c.status !== 'submitted') throw conflict('Cette note de frais est déjà décidée.', 'claim_decided');
      if (c.user_id === t.ctx.userId && !t.isOwner) throw forbidden('Une note de frais se fait valider par un autre responsable.', 'own_claim');
      await trx.updateTable('expense_claim').set({ status, decided_by: t.ctx.userId, decided_at: new Date(), reject_reason: reason ?? null }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `expense_claim.${status}`, entityType: 'expense_claim', entityId: id, data: { code: c.code, amount: Number(c.amount), reason } });
      return { ok: true };
    });
  }

  @Permission(null) @RequireFeature(FEATURE) @HttpCode(200)
  @Post(':id/approve')
  approve(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.decide(t, id, 'approved'); }

  @Permission(null) @RequireFeature(FEATURE) @HttpCode(200)
  @Post(':id/reject')
  reject(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, { message: 'Indiquez le motif du refus' }).max(300) }).strict(), body);
    return this.decide(t, id, 'rejected', reason);
  }

  /** Remboursement d'une note validée : dépense enregistrée sur le compte choisi (caisse, banque, mobile money). */
  @Permission('cash.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post(':id/pay')
  pay(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ accountId: z.string().uuid({ message: 'Choisissez le compte de paiement' }), date: isoDate.optional() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await this.claim(trx, id);
      if (c.status !== 'approved') throw conflict(c.status === 'paid' ? 'Cette note de frais est déjà remboursée.' : "Cette note de frais n'est pas validée.", 'claim_not_approved');
      const user = await trx.selectFrom('user_account').select('full_name').where('id', '=', c.user_id).executeTakeFirstOrThrow();
      const m = await this.treasury.addManualIn(trx, t, { kind: 'expense', accountId: input.accountId, date: input.date ?? today(), amount: Number(c.amount), category: c.category,
        label: `Note de frais ${c.code} — ${user.full_name} : ${c.label}`, reference: c.code });
      await trx.updateTable('expense_claim').set({ status: 'paid', movement_id: m.id, paid_at: new Date() }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'expense_claim.paid', entityType: 'expense_claim', entityId: id, data: { code: c.code, amount: Number(c.amount) } });
      return { ok: true, movementId: m.id };
    });
  }
}
