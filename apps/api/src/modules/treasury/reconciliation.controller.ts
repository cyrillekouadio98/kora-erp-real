import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, notFound } from '../../common/errors';
import { RequireFeature } from '../../common/features';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { isoDate } from '../sales/sales.controller';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, TreasuryService } from './treasury.service';

const FEATURE = 'bank_reconciliation';
/** Écart de dates toléré entre le relevé et Kora (jours de valeur, remise de chèque…). */
const WINDOW_DAYS = 7;
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

const ImportSchema = z.object({
  accountId: z.string().uuid({ message: 'Choisissez un compte' }),
  lines: z.array(z.object({
    date: isoDate, label: z.string().trim().min(1).max(300),
    amount: z.coerce.number().refine((v) => v !== 0, { message: 'Montant nul' }).refine((v) => Math.abs(v) <= 1e13).transform(round2),
    reference: z.string().trim().max(100).transform((v) => v || null).nullable().optional(),
  }).strict()).min(1, { message: 'Le relevé est vide' }).max(5000),
}).strict();

/** Rapprochement bancaire : relevé importé, pointé ligne à ligne avec les mouvements de trésorerie. */
@ApiTags('Trésorerie')
@Controller('company/treasury/reconciliation')
export class ReconciliationController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly treasury: TreasuryService) {}

  private async account(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Compte');
    const a = await trx.selectFrom('treasury_account').select(['id', 'name', 'kind', 'archived_at']).where('id', '=', id).executeTakeFirst();
    if (!a) throw notFound('Compte');
    if (a.kind === 'cash') throw badRequest("Une caisse n'a pas de relevé : le rapprochement concerne la banque et le mobile money.", undefined, 'cash_account');
    return a;
  }

  private async line(trx: TenantTrx, id: string) {
    if (!isUuid(id)) throw notFound('Ligne de relevé');
    const l = await trx.selectFrom('bank_statement_line').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!l) throw notFound('Ligne de relevé');
    return l;
  }

  /** Mouvements validés du compte, pas encore pointés (hors contre-passations, qui s'annulent entre elles). */
  private openMovements(trx: TenantTrx, accountId: string) {
    return trx.selectFrom('treasury_movement as m').select(['m.id', 'm.date', 'm.direction', 'm.amount', 'm.label', 'm.reference', 'm.category'])
      .where('m.account_id', '=', accountId).where('m.status', '=', 'posted').where('m.reversed_by', 'is', null).where('m.reversal_of', 'is', null)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('bank_statement_line as b').select('b.id').whereRef('b.movement_id', '=', 'm.id'))))
      .orderBy('m.date').execute();
  }

  /** Pointe chaque ligne en attente qui n'a qu'un mouvement possible : même montant, date la plus proche dans la fenêtre. */
  private async autoMatch(trx: TenantTrx, t: TenantInfo, accountId: string) {
    const lines = await trx.selectFrom('bank_statement_line').select(['id', 'date', 'amount', 'reference']).where('account_id', '=', accountId)
      .where('movement_id', 'is', null).where('ignored_at', 'is', null).orderBy('date').orderBy('imported_at').execute();
    const moves = await this.openMovements(trx, accountId);
    const used = new Set<string>();
    let matched = 0;
    for (const l of lines) {
      const cands = moves.filter((m) => !used.has(m.id) && round2((m.direction === 'in' ? 1 : -1) * Number(m.amount)) === Number(l.amount) && days(m.date, l.date) <= WINDOW_DAYS)
        .map((m) => ({ m, gap: days(m.date, l.date), ref: !!l.reference && !!m.reference && l.reference.toLowerCase() === m.reference.toLowerCase() }))
        .sort((a, b) => Number(b.ref) - Number(a.ref) || a.gap - b.gap);
      if (!cands.length) continue;
      // Ambigu (deux mouvements aussi proches, sans référence pour départager) : laissé au pointage manuel.
      if (cands.length > 1 && !cands[0].ref && cands[0].gap === cands[1].gap) continue;
      used.add(cands[0].m.id);
      await trx.updateTable('bank_statement_line').set({ movement_id: cands[0].m.id, matched_by: t.ctx.userId, matched_at: new Date() }).where('id', '=', l.id).execute();
      matched++;
    }
    return matched;
  }

  @Permission('cash.read') @RequireFeature(FEATURE) @AllowWhenReadOnly()
  @Get()
  get(@Tenant() t: TenantInfo, @Query('accountId') accountId: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.account(trx, accountId);
      const lines = await trx.selectFrom('bank_statement_line as b').leftJoin('treasury_movement as m', (j) => j.onRef('m.id', '=', 'b.movement_id').onRef('m.company_id', '=', 'b.company_id'))
        .select(['b.id', 'b.date', 'b.label', 'b.amount', 'b.reference', 'b.movement_id', 'b.ignored_at', 'm.date as m_date', 'm.label as m_label', 'm.reference as m_reference'])
        .where('b.account_id', '=', a.id).orderBy('b.date', 'desc').orderBy('b.imported_at', 'desc').execute();
      const open = await this.openMovements(trx, a.id);
      const first = lines.length ? lines[lines.length - 1].date : null;
      const shown = first ? open.filter((m) => days(m.date, first) <= 31 || m.date >= first) : [];
      const signed = (m: { direction: string; amount: string }) => round2((m.direction === 'in' ? 1 : -1) * Number(m.amount));
      const out = lines.map((l) => {
        const status = l.movement_id ? 'matched' : l.ignored_at ? 'ignored' : 'pending';
        const suggestions = status === 'pending' ? open.filter((m) => signed(m) === Number(l.amount)).sort((x, y) => days(x.date, l.date) - days(y.date, l.date)).slice(0, 3)
          .map((m) => ({ id: m.id, date: m.date, label: m.label, reference: m.reference, gapDays: Math.round(days(m.date, l.date)) })) : [];
        return { id: l.id, date: l.date, label: l.label, amount: Number(l.amount), reference: l.reference, status, suggestions,
          movement: l.movement_id ? { id: l.movement_id, date: l.m_date, label: l.m_label, reference: l.m_reference } : null };
      });
      const sum = (xs: { amount: number }[]) => round2(xs.reduce((s, x) => s + x.amount, 0));
      return {
        account: { id: a.id, name: a.name, kind: a.kind, balance: await this.treasury.balance(trx, a.id) },
        lines: out,
        movements: shown.map((m) => ({ id: m.id, date: m.date, label: m.label, reference: m.reference, amount: signed(m), category: m.category })),
        summary: {
          pending: out.filter((l) => l.status === 'pending').length, matched: out.filter((l) => l.status === 'matched').length, ignored: out.filter((l) => l.status === 'ignored').length,
          pendingAmount: sum(out.filter((l) => l.status === 'pending')), unmatchedMovements: shown.length, unmatchedAmount: round2(shown.reduce((s, m) => s + signed(m), 0)),
          from: first, to: lines[0]?.date ?? null,
        },
      };
    });
  }

  /** Import d'un relevé : les lignes déjà importées (même date, montant, libellé et référence) sont écartées, puis pointage automatique. */
  @Permission('cash.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('import')
  import(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(ImportSchema, body);
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.account(trx, input.accountId);
      if (a.archived_at) throw conflict(`Le compte « ${a.name} » est archivé.`, 'account_archived');
      const key = (l: { date: string; amount: number | string; label: string; reference?: string | null }) => `${l.date}|${Number(l.amount).toFixed(2)}|${l.label.trim().toLowerCase()}|${(l.reference ?? '').toLowerCase()}`;
      const existing = new Map<string, number>();
      for (const l of await trx.selectFrom('bank_statement_line').select(['date', 'amount', 'label', 'reference']).where('account_id', '=', a.id).execute()) existing.set(key(l), (existing.get(key(l)) ?? 0) + 1);
      const fresh = input.lines.filter((l) => { const k = key(l); const n = existing.get(k) ?? 0; if (n > 0) { existing.set(k, n - 1); return false; } return true; });
      if (fresh.length) {
        await trx.insertInto('bank_statement_line').values(fresh.map((l) => ({ company_id: t.companyId, account_id: a.id, date: l.date, label: l.label, amount: l.amount, reference: l.reference ?? null, imported_by: t.ctx.userId }))).execute();
      }
      const matched = await this.autoMatch(trx, t, a.id);
      await this.audit.tenant(trx, t.ctx, { action: 'bank_statement.imported', entityType: 'treasury_account', entityId: a.id, data: { account: a.name, imported: fresh.length, duplicates: input.lines.length - fresh.length, matched } });
      return { imported: fresh.length, duplicates: input.lines.length - fresh.length, matched };
    });
  }

  @Permission('cash.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('auto')
  auto(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => { await this.account(trx, accountId); return { matched: await this.autoMatch(trx, t, accountId) }; });
  }

  /** Pointage manuel : la ligne et le mouvement doivent être du même compte et du même montant. */
  @Permission('cash.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('lines/:id/match')
  match(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const { movementId } = parse(z.object({ movementId: z.string().uuid() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.line(trx, id);
      if (l.movement_id) throw conflict('Cette ligne est déjà pointée.', 'already_matched');
      const m = (await this.openMovements(trx, l.account_id)).find((x) => x.id === movementId);
      if (!m) throw conflict('Ce mouvement est introuvable sur ce compte, annulé ou déjà pointé.', 'movement_unavailable');
      if (round2((m.direction === 'in' ? 1 : -1) * Number(m.amount)) !== Number(l.amount)) throw badRequest('Le montant du mouvement ne correspond pas à celui du relevé.', undefined, 'amount_mismatch');
      await trx.updateTable('bank_statement_line').set({ movement_id: m.id, matched_by: t.ctx.userId, matched_at: new Date(), ignored_at: null }).where('id', '=', l.id).execute();
      return { ok: true };
    });
  }

  @Permission('cash.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('lines/:id/unmatch')
  unmatch(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.line(trx, id);
      await trx.updateTable('bank_statement_line').set({ movement_id: null, matched_by: null, matched_at: null }).where('id', '=', l.id).execute();
      return { ok: true };
    });
  }

  /** Écarte une ligne (doublon du relevé, opération sans rapport avec Kora) ou la remet en attente. */
  @Permission('cash.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('lines/:id/ignore')
  ignore(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const { ignored } = parse(z.object({ ignored: z.boolean() }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.line(trx, id);
      if (l.movement_id) throw conflict('Dépointez la ligne avant de l’écarter.', 'already_matched');
      await trx.updateTable('bank_statement_line').set({ ignored_at: ignored ? new Date() : null }).where('id', '=', l.id).execute();
      return { ok: true };
    });
  }

  /** Opération du relevé absente de Kora (frais bancaires, agios, virement reçu) : enregistrée comme dépense ou recette, puis pointée. */
  @Permission('cash.create') @RequireFeature(FEATURE) @HttpCode(200)
  @Post('lines/:id/record')
  record(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({
      category: z.enum([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES] as [string, ...string[]], { message: 'Catégorie inconnue' }),
      label: z.string().trim().min(2).max(200).optional(), contactId: z.string().uuid().nullable().optional(),
    }).strict(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.line(trx, id);
      if (l.movement_id) throw conflict('Cette ligne est déjà pointée.', 'already_matched');
      const m = await this.treasury.addManualIn(trx, t, { kind: Number(l.amount) < 0 ? 'expense' : 'income', accountId: l.account_id, date: l.date, amount: Math.abs(Number(l.amount)),
        category: input.category, label: input.label ?? l.label, contactId: input.contactId ?? null, reference: l.reference });
      await trx.updateTable('bank_statement_line').set({ movement_id: m.id, matched_by: t.ctx.userId, matched_at: new Date(), ignored_at: null }).where('id', '=', l.id).execute();
      return { ok: true, movementId: m.id };
    });
  }

  /** Retire une ligne importée par erreur (seulement si elle n'est pas pointée). */
  @Permission('cash.create') @RequireFeature(FEATURE)
  @Delete('lines/:id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const l = await this.line(trx, id);
      if (l.movement_id) throw conflict('Dépointez la ligne avant de la supprimer.', 'already_matched');
      await trx.deleteFrom('bank_statement_line').where('id', '=', l.id).execute();
      return { ok: true };
    });
  }
}
