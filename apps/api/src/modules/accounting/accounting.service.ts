import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { EntrySource } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

/**
 * Règles d'imputation SYSCOHADA révisé appliquées par la comptabilisation automatique.
 * Biens et lignes libres → 701 / 601 ; services → 706 / 605. Un reclassement se fait par écriture d'OD.
 */
export const ACCOUNTS = {
  customer: '411', supplier: '401', suspense: '471', vatCollected: '4431', vatDeductible: '4452', transfer: '585', otherCharges: '658', otherIncome: '758',
  salesGoods: '701', salesServices: '706', purchaseGoods: '601', purchaseServices: '605',
};
const MOVEMENT_COUNTERPART: Record<string, string> = {
  rent: '6222', electricity: '6052', water: '6051', fuel: '6053', transport: '618', telecom: '628', supplies: '6055', maintenance: '624',
  salaries: '661', taxes: '641', bank_fees: '631', owner_withdrawal: '104', other_expense: '658', capital: '101', loan: '162', other_income: '758',
  transfer: ACCOUNTS.transfer, net_salary: '422',
};

/** Rubriques du compte de résultat (deux premiers chiffres du compte). */
const INCOME_HEADINGS: Record<string, string> = {
  '60': 'Achats et variations de stocks', '61': 'Transports', '62': 'Services extérieurs', '63': 'Autres services extérieurs', '64': 'Impôts et taxes',
  '65': 'Autres charges', '66': 'Charges de personnel', '67': 'Frais financiers', '68': 'Dotations aux amortissements', '69': 'Dotations aux provisions',
  '70': 'Ventes', '71': "Subventions d'exploitation", '72': 'Production immobilisée', '73': 'Variations de stocks de produits', '75': 'Autres produits',
  '77': 'Revenus financiers', '78': 'Transferts de charges', '79': 'Reprises de provisions', '89': 'Impôts sur le résultat',
};

export interface LineInput { account: string; contactId?: string | null; label: string; debit?: number; credit?: number }
interface EntryInput { journal: string; date: string; label: string; reference?: string | null; sourceType: EntrySource; sourceId?: string | null; reversalOf?: string | null; lines: LineInput[] }

const round = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class AccountingService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  // ------------------------------------------------------------------ écriture
  private async assertOpen(trx: TenantTrx, t: TenantInfo, date: string) {
    const c = await trx.selectFrom('company').select('accounting_locked_until').where('id', '=', t.companyId).executeTakeFirstOrThrow();
    if (c.accounting_locked_until && date <= c.accounting_locked_until) {
      throw conflict(`La comptabilité est clôturée jusqu'au ${c.accounting_locked_until} : aucune écriture ne peut être passée au ${date}.`, 'period_locked');
    }
  }

  /** Regroupe les lignes identiques (même compte, même tiers, même sens) et retire les montants nuls. */
  private compact(lines: LineInput[]) {
    const out = new Map<string, LineInput>();
    for (const l of lines) {
      const debit = round(l.debit ?? 0), credit = round(l.credit ?? 0);
      if (!debit && !credit) continue;
      const key = `${l.account}|${l.contactId ?? ''}|${debit ? 'D' : 'C'}|${l.label}`;
      const prev = out.get(key);
      if (prev) { prev.debit = round((prev.debit ?? 0) + debit); prev.credit = round((prev.credit ?? 0) + credit); } else out.set(key, { ...l, debit, credit });
    }
    return [...out.values()];
  }

  private async writeLines(trx: TenantTrx, t: TenantInfo, entryId: string, lines: LineInput[]) {
    await trx.deleteFrom('journal_line').where('entry_id', '=', entryId).execute();
    const rows = this.compact(lines);
    if (rows.length) {
      await trx.insertInto('journal_line').values(rows.map((l, i) => ({
        company_id: t.companyId, entry_id: entryId, position: i + 1, account_code: l.account, contact_id: l.contactId ?? null, label: l.label, debit: l.debit ?? 0, credit: l.credit ?? 0,
      }))).execute();
    }
    return rows;
  }

  private async assertAccounts(trx: TenantTrx, lines: LineInput[]) {
    const codes = [...new Set(lines.map((l) => l.account))];
    if (!codes.length) return;
    const found = await trx.selectFrom('ledger_account').select(['code', 'archived_at']).where('code', 'in', codes).execute();
    const missing = codes.filter((c) => !found.some((f) => f.code === c));
    if (missing.length) throw badRequest(`Compte${missing.length > 1 ? 's' : ''} inconnu${missing.length > 1 ? 's' : ''} dans le plan comptable : ${missing.join(', ')}.`, undefined, 'unknown_account');
    const archived = found.filter((f) => f.archived_at).map((f) => f.code);
    if (archived.length) throw badRequest(`Compte archivé : ${archived.join(', ')}.`, undefined, 'archived_account');
  }

  /** Numéro définitif (VT-2026-00001…) et passage au statut validé ; la base vérifie l'équilibre en fin de transaction. */
  private async post(trx: TenantTrx, t: TenantInfo, entryId: string, journal: string, date: string) {
    const lines = await trx.selectFrom('journal_line').select(['debit', 'credit']).where('entry_id', '=', entryId).execute();
    const d = round(lines.reduce((s, l) => s + Number(l.debit), 0)), c = round(lines.reduce((s, l) => s + Number(l.credit), 0));
    if (lines.length < 2 || d !== c || d === 0) {
      throw badRequest(`L'écriture n'est pas équilibrée : débit ${d.toLocaleString('fr-FR')} / crédit ${c.toLocaleString('fr-FR')}.`, { debit: d, credit: c }, 'unbalanced_entry');
    }
    await this.assertOpen(trx, t, date);
    const number = await nextNumber(trx, t.companyId, `journal_${journal}`, journal, Number(date.slice(0, 4)));
    await trx.updateTable('journal_entry').set({ status: 'posted', number, posted_by: t.ctx.userId, posted_at: new Date() }).where('id', '=', entryId).execute();
    return number;
  }

  /** Crée et valide une écriture dans la transaction de l'opération qui la provoque. */
  async postEntry(trx: TenantTrx, t: TenantInfo, e: EntryInput) {
    await this.assertAccounts(trx, e.lines);
    const entry = await trx.insertInto('journal_entry').values({
      company_id: t.companyId, journal_code: e.journal, date: e.date, label: e.label, reference: e.reference ?? null, source_type: e.sourceType,
      source_id: e.sourceId ?? null, reversal_of: e.reversalOf ?? null, number: null, reversed_by: null, created_by: t.ctx.userId, posted_by: null,
    }).returning('id').executeTakeFirstOrThrow();
    await this.writeLines(trx, t, entry.id, e.lines);
    const number = await this.post(trx, t, entry.id, e.journal, e.date);
    return { id: entry.id, number };
  }

  private async already(trx: TenantTrx, sourceType: EntrySource, sourceId: string) {
    return !!(await trx.selectFrom('journal_entry').select('id').where('source_type', '=', sourceType).where('source_id', '=', sourceId).executeTakeFirst());
  }

  // ------------------------------------------------------------------ comptabilisation automatique
  /** Facture de vente ou avoir émis : 411 client / 70x ventes / 4431 TVA facturée (sens inversé pour un avoir). */
  async postSalesDocument(trx: TenantTrx, t: TenantInfo, documentId: string) {
    if (await this.already(trx, 'sales_document', documentId)) return;
    const d = await trx.selectFrom('sales_document').selectAll().where('id', '=', documentId).executeTakeFirstOrThrow();
    if (d.type === 'quote' || d.status === 'draft') return;
    const lines = await trx.selectFrom('sales_document_line as l').leftJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .select(['l.total_ht', 'l.total_vat', 'l.vat_rate', 'p.kind']).where('l.document_id', '=', documentId).execute();
    const customer = (d.customer as any)?.name ?? 'Client';
    const label = `${d.type === 'credit_note' ? 'Avoir' : 'Facture'} ${d.number} — ${customer}`;
    // Un avoir passe la même écriture en sens inverse.
    const flip = d.type === 'credit_note';
    const side = (amount: number, normal: 'debit' | 'credit') => ((normal === 'debit') !== flip ? { debit: amount } : { credit: amount });
    const out: LineInput[] = [{ account: ACCOUNTS.customer, contactId: d.contact_id, label, ...side(Number(d.total_ttc), 'debit') }];
    for (const l of lines) {
      out.push({ account: l.kind === 'service' ? ACCOUNTS.salesServices : ACCOUNTS.salesGoods, label, ...side(Number(l.total_ht), 'credit') });
      out.push({ account: ACCOUNTS.vatCollected, label: `TVA facturée ${Number(l.vat_rate)} % — ${d.number}`, ...side(Number(l.total_vat), 'credit') });
    }
    await this.postEntry(trx, t, { journal: 'VT', date: d.issue_date, label, sourceType: 'sales_document', sourceId: d.id, lines: out });
  }

  /** Facture fournisseur validée : 60x achats / 4452 TVA récupérable / 401 fournisseur. */
  async postPurchaseDocument(trx: TenantTrx, t: TenantInfo, documentId: string) {
    if (await this.already(trx, 'purchase_document', documentId)) return;
    const d = await trx.selectFrom('purchase_document').selectAll().where('id', '=', documentId).executeTakeFirstOrThrow();
    if (d.type !== 'invoice' || d.status === 'draft') return;
    const lines = await trx.selectFrom('purchase_document_line as l').leftJoin('product as p', (j) => j.onRef('p.id', '=', 'l.product_id').onRef('p.company_id', '=', 'l.company_id'))
      .select(['l.total_ht', 'l.total_vat', 'l.vat_rate', 'p.kind']).where('l.document_id', '=', documentId).execute();
    const label = `Facture ${d.supplier_ref ? `${d.supplier_ref} ` : ''}(${d.number}) — ${(d.supplier as any)?.name ?? 'Fournisseur'}`;
    const out: LineInput[] = [];
    for (const l of lines) {
      out.push({ account: l.kind === 'service' ? ACCOUNTS.purchaseServices : ACCOUNTS.purchaseGoods, label, debit: Number(l.total_ht) });
      out.push({ account: ACCOUNTS.vatDeductible, label: `TVA récupérable ${Number(l.vat_rate)} % — ${d.number}`, debit: Number(l.total_vat) });
    }
    out.push({ account: ACCOUNTS.supplier, contactId: d.contact_id, label, credit: Number(d.total_ttc) });
    await this.postEntry(trx, t, { journal: 'AC', date: d.issue_date, label, reference: d.supplier_ref, sourceType: 'purchase_document', sourceId: d.id, lines: out });
  }

  /** Mouvement de trésorerie : compte 5x du compte de trésorerie contre le compte de la catégorie (411, 401, 585, charges, produits…). */
  async postMovement(trx: TenantTrx, t: TenantInfo, movementId: string) {
    if (await this.already(trx, 'treasury_movement', movementId)) return;
    const m = await trx.selectFrom('treasury_movement as m').innerJoin('treasury_account as a', (j) => j.onRef('a.id', '=', 'm.account_id').onRef('a.company_id', '=', 'm.company_id'))
      .selectAll('m').select('a.ledger_code').where('m.id', '=', movementId).executeTakeFirstOrThrow();
    let counterpart: string; let contactId: string | null = null;
    if (m.category === 'customer_payment' || m.category === 'customer_refund') { counterpart = ACCOUNTS.customer; contactId = m.contact_id; }
    else if (m.category === 'supplier_payment') { counterpart = ACCOUNTS.supplier; contactId = m.contact_id; }
    else if (m.category === 'cash_difference') counterpart = m.direction === 'in' ? ACCOUNTS.otherIncome : ACCOUNTS.otherCharges;
    else counterpart = MOVEMENT_COUNTERPART[m.category] ?? (m.direction === 'in' ? ACCOUNTS.otherIncome : ACCOUNTS.otherCharges);
    const amount = Number(m.amount);
    const treasury = { account: m.ledger_code, label: m.label, ...(m.direction === 'in' ? { debit: amount } : { credit: amount }) };
    const other = { account: counterpart, contactId, label: m.label, ...(m.direction === 'in' ? { credit: amount } : { debit: amount }) };
    await this.postEntry(trx, t, { journal: 'TR', date: m.date, label: m.label, reference: m.reference, sourceType: 'treasury_movement', sourceId: m.id, lines: [treasury, other] });
  }

  /** Écart entre le solde d'ouverture d'un compte de trésorerie et ce qui est déjà passé en à-nouveaux. */
  private async openingGap(trx: TenantTrx, accountId: string) {
    const a = await trx.selectFrom('treasury_account').select(['id', 'name', 'ledger_code', 'opening_balance', 'opening_date']).where('id', '=', accountId).executeTakeFirstOrThrow();
    const posted = await trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
      .select((eb) => [eb.fn.sum<string>('l.debit').as('d'), eb.fn.sum<string>('l.credit').as('c')])
      .where('e.source_type', '=', 'treasury_opening').where('e.reference', '=', accountId).where('l.account_code', '=', a.ledger_code).executeTakeFirst();
    return { account: a, gap: round(Number(a.opening_balance) - (Number(posted?.d ?? 0) - Number(posted?.c ?? 0))) };
  }

  /**
   * Passe en à-nouveaux le solde d'ouverture d'un compte de trésorerie (D 5x / C 471), ou seulement
   * la différence quand il a été modifié. Le 471 est soldé par le comptable avec le bilan d'ouverture.
   */
  async postOpening(trx: TenantTrx, t: TenantInfo, accountId: string) {
    const { account: a, gap } = await this.openingGap(trx, accountId);
    if (!gap) return;
    const label = `Solde d'ouverture — ${a.name}`;
    const amount = Math.abs(gap);
    await this.postEntry(trx, t, {
      journal: 'AN', date: a.opening_date, label, reference: a.id, sourceType: 'treasury_opening', sourceId: null,
      lines: [
        { account: a.ledger_code, label, ...(gap > 0 ? { debit: amount } : { credit: amount }) },
        { account: ACCOUNTS.suspense, label, ...(gap > 0 ? { credit: amount } : { debit: amount }) },
      ],
    });
  }

  /** Opérations validées pas encore comptabilisées (données saisies avant l'activation de la comptabilité). */
  private async pending(trx: TenantTrx) {
    const has = (type: EntrySource) => (eb: any) => eb.not(eb.exists(eb.selectFrom('journal_entry as e').select('e.id').where('e.source_type', '=', type).whereRef('e.source_id', '=', 'x.id')));
    const sales = await trx.selectFrom('sales_document as x').select(['x.id', 'x.issue_date as date', 'x.created_at']).where('x.type', 'in', ['invoice', 'credit_note']).where('x.status', '!=', 'draft').where(has('sales_document')).execute();
    const purchases = await trx.selectFrom('purchase_document as x').select(['x.id', 'x.issue_date as date', 'x.created_at']).where('x.type', '=', 'invoice').where('x.status', '!=', 'draft').where(has('purchase_document')).execute();
    const movements = await trx.selectFrom('treasury_movement as x').select(['x.id', 'x.date', 'x.created_at']).where(has('treasury_movement')).execute();
    const openings = [];
    for (const a of await trx.selectFrom('treasury_account').select(['id', 'opening_date', 'created_at']).execute()) {
      if ((await this.openingGap(trx, a.id)).gap) openings.push({ id: a.id, date: a.opening_date, created_at: a.created_at, kind: 'opening' as const });
    }
    return [...openings, ...sales.map((s) => ({ ...s, kind: 'sales' as const })), ...purchases.map((p) => ({ ...p, kind: 'purchase' as const })), ...movements.map((m) => ({ ...m, kind: 'movement' as const }))]
      .sort((a, b) => a.date.localeCompare(b.date) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  async status(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await trx.selectFrom('company').select('accounting_locked_until').where('id', '=', t.companyId).executeTakeFirstOrThrow();
      return { pending: (await this.pending(trx)).length, lockedUntil: c.accounting_locked_until };
    });
  }

  /** Comptabilise l'historique (idempotent) : chaque opération validée reçoit son écriture. */
  async sync(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      await sql`select seed_accounting(${t.companyId}::uuid), seed_accounting_extra(${t.companyId}::uuid)`.execute(trx);
      const todo = await this.pending(trx);
      for (const op of todo) {
        if (op.kind === 'sales') await this.postSalesDocument(trx, t, op.id);
        else if (op.kind === 'purchase') await this.postPurchaseDocument(trx, t, op.id);
        else if (op.kind === 'opening') await this.postOpening(trx, t, op.id);
        else await this.postMovement(trx, t, op.id);
      }
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.synced', data: { entries: todo.length } });
      return { posted: todo.length };
    });
  }

  // ------------------------------------------------------------------ écritures manuelles (OD)
  private async entry(trx: TenantTrx, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Écriture');
    const e = await trx.selectFrom('journal_entry').selectAll().where('id', '=', id).$if(lock, (q) => q.forUpdate()).executeTakeFirst();
    if (!e) throw notFound('Écriture');
    return e;
  }

  async getEntry(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await this.entry(trx, id);
      const lines = await trx.selectFrom('journal_line as l').innerJoin('ledger_account as a', (j) => j.onRef('a.code', '=', 'l.account_code').onRef('a.company_id', '=', 'l.company_id'))
        .leftJoin('contact as c', (j) => j.onRef('c.id', '=', 'l.contact_id').onRef('c.company_id', '=', 'l.company_id'))
        .select(['l.id', 'l.account_code as account', 'a.name as accountName', 'l.contact_id as contactId', 'c.name as contactName', 'l.label', 'l.debit', 'l.credit'])
        .where('l.entry_id', '=', id).orderBy('l.position').execute();
      return {
        id: e.id, journal: e.journal_code, number: e.number, date: e.date, label: e.label, reference: e.reference, status: e.status, sourceType: e.source_type, sourceId: e.source_id,
        reversalOf: e.reversal_of, reversedBy: e.reversed_by, lines: lines.map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) })),
      };
    });
  }

  async createManual(t: TenantInfo, input: { journal: string; date: string; label: string; reference?: string | null; lines: LineInput[] }) {
    if (!['OD', 'AN'].includes(input.journal)) throw badRequest('Les écritures manuelles se passent dans le journal des opérations diverses (OD) ou des à-nouveaux (AN).', undefined, 'manual_journal');
    const id = await this.db.tenant(t.ctx, async (trx) => {
      await this.assertAccounts(trx, input.lines);
      const e = await trx.insertInto('journal_entry').values({
        company_id: t.companyId, journal_code: input.journal, date: input.date, label: input.label, reference: input.reference ?? null, source_type: 'manual',
        source_id: null, reversal_of: null, number: null, reversed_by: null, created_by: t.ctx.userId, posted_by: null,
      }).returning('id').executeTakeFirstOrThrow();
      await this.writeLines(trx, t, e.id, input.lines);
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.entry_created', entityType: 'journal_entry', entityId: e.id, data: { label: input.label } });
      return e.id;
    });
    return this.getEntry(t, id);
  }

  async updateManual(t: TenantInfo, id: string, input: { date?: string; label?: string; reference?: string | null; lines?: LineInput[] }) {
    await this.db.tenant(t.ctx, async (trx) => {
      const e = await this.entry(trx, id, true);
      if (e.status !== 'draft') throw conflict('Cette écriture est validée : contre-passez-la pour la corriger.', 'entry_posted');
      const patch: Record<string, unknown> = {};
      if (input.date) patch.date = input.date;
      if (input.label) patch.label = input.label;
      if (input.reference !== undefined) patch.reference = input.reference;
      if (Object.keys(patch).length) await trx.updateTable('journal_entry').set(patch).where('id', '=', id).execute();
      if (input.lines) { await this.assertAccounts(trx, input.lines); await this.writeLines(trx, t, id, input.lines); }
    });
    return this.getEntry(t, id);
  }

  async deleteManual(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const e = await this.entry(trx, id, true);
      if (e.status !== 'draft') throw conflict('Une écriture validée ne se supprime pas : contre-passez-la.', 'entry_posted');
      await trx.deleteFrom('journal_entry').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.entry_deleted', entityType: 'journal_entry', entityId: id, data: { label: e.label } });
      return { ok: true };
    });
  }

  async postManual(t: TenantInfo, id: string) {
    await this.db.tenant(t.ctx, async (trx) => {
      const e = await this.entry(trx, id, true);
      if (e.status !== 'draft') throw conflict('Cette écriture est déjà validée.', 'entry_posted');
      const number = await this.post(trx, t, id, e.journal_code, e.date);
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.entry_posted', entityType: 'journal_entry', entityId: id, data: { number, label: e.label } });
    });
    return this.getEntry(t, id);
  }

  /** Contre-passation d'une écriture manuelle validée. Les écritures automatiques se corrigent depuis leur document (avoir, contre-passation de trésorerie). */
  async reverse(t: TenantInfo, id: string, input: { date?: string; reason: string }) {
    const newId = await this.db.tenant(t.ctx, async (trx) => {
      const e = await this.entry(trx, id, true);
      if (e.status !== 'posted') throw conflict("Seule une écriture validée se contre-passe ; un brouillon se modifie ou se supprime.", 'entry_draft');
      if (e.reversed_by) throw conflict('Cette écriture est déjà contre-passée.', 'already_reversed');
      if (e.source_type !== 'manual') throw conflict("Cette écriture provient d'un document : corrigez le document (avoir, contre-passation en trésorerie).", 'not_reversible');
      const lines = await trx.selectFrom('journal_line').selectAll().where('entry_id', '=', id).orderBy('position').execute();
      const r = await this.postEntry(trx, t, {
        journal: e.journal_code, date: input.date ?? today(), label: `Contre-passation de ${e.number} — ${input.reason}`, reference: e.number, sourceType: 'reversal', sourceId: e.id, reversalOf: e.id,
        lines: lines.map((l) => ({ account: l.account_code, contactId: l.contact_id, label: l.label, debit: Number(l.credit), credit: Number(l.debit) })),
      });
      await trx.updateTable('journal_entry').set({ reversed_by: r.id }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.entry_reversed', entityType: 'journal_entry', entityId: id, data: { number: e.number, reversal: r.number, reason: input.reason } });
      return r.id;
    });
    return this.getEntry(t, newId);
  }

  // ------------------------------------------------------------------ plan comptable et clôture
  async accounts(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await trx.selectFrom('ledger_account').select(['code', 'name', 'is_system as isSystem', 'archived_at as archivedAt']).orderBy(sql`code collate "C"`).execute();
      const used = await trx.selectFrom('journal_line').select('account_code').distinct().execute();
      return rows.map((r) => ({ ...r, used: used.some((u) => u.account_code === r.code) }));
    });
  }

  async addAccount(t: TenantInfo, input: { code: string; name: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      // Un sous-compte doit se rattacher à un compte existant du plan (ex. 6011 sous 601).
      const parents = await trx.selectFrom('ledger_account').select('code').where(sql<boolean>`${input.code} like code || '%'`).where('code', '!=', input.code).execute();
      if (!parents.length) throw badRequest(`Le compte ${input.code} doit être un sous-compte d'un compte existant du plan SYSCOHADA (par exemple 6011 sous 601).`, undefined, 'no_parent_account');
      const exists = await trx.selectFrom('ledger_account').select('code').where('code', '=', input.code).executeTakeFirst();
      if (exists) throw conflict(`Le compte ${input.code} existe déjà.`, 'account_exists');
      await trx.insertInto('ledger_account').values({ company_id: t.companyId, code: input.code, name: input.name, is_system: false }).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.account_created', entityType: 'ledger_account', entityId: input.code, data: { name: input.name } });
      return { code: input.code, name: input.name };
    });
  }

  /** Clôture : plus aucune écriture validée à cette date ou avant. Les brouillons de la période doivent être validés ou supprimés d'abord. */
  async lock(t: TenantInfo, until: string) {
    if (until >= today()) throw badRequest("La date de clôture doit être passée.", undefined, 'lock_in_future');
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await trx.selectFrom('company').select('accounting_locked_until').where('id', '=', t.companyId).executeTakeFirstOrThrow();
      if (c.accounting_locked_until && until < c.accounting_locked_until) throw conflict(`La comptabilité est déjà clôturée jusqu'au ${c.accounting_locked_until} : une clôture ne se défait pas.`, 'already_locked');
      const drafts = await trx.selectFrom('journal_entry').select('id').where('status', '=', 'draft').where('date', '<=', until).execute();
      if (drafts.length) throw conflict(`${drafts.length} écriture(s) en brouillon datée(s) de la période : validez-les ou supprimez-les avant de clôturer.`, 'drafts_in_period');
      const pending = (await this.pending(trx)).filter((p) => p.date <= until);
      if (pending.length) throw conflict(`${pending.length} opération(s) de la période ne sont pas encore comptabilisées : lancez la comptabilisation avant de clôturer.`, 'pending_in_period');
      await trx.updateTable('company').set({ accounting_locked_until: until }).where('id', '=', t.companyId).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.period_locked', entityType: 'company', entityId: t.companyId, data: { until, previous: c.accounting_locked_until } });
      return { lockedUntil: until };
    });
  }

  // ------------------------------------------------------------------ états
  private linesQuery(trx: TenantTrx, to?: string) {
    return trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
      .where('e.status', '=', 'posted').$if(!!to, (q) => q.where('e.date', '<=', to!));
  }

  async entries(t: TenantInfo, f: { journal?: string; from?: string; to?: string; q?: string; status?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('journal_entry as e').select(['e.id', 'e.journal_code as journal', 'e.number', 'e.date', 'e.label', 'e.reference', 'e.status', 'e.source_type as sourceType', 'e.reversed_by as reversedBy',
        (eb) => eb.selectFrom('journal_line as l').whereRef('l.entry_id', '=', 'e.id').select((x) => x.fn.sum<string>('l.debit').as('s')).as('total')])
        .orderBy('e.date', 'desc').orderBy('e.created_at', 'desc').limit(2000);
      if (f.journal) q = q.where('e.journal_code', '=', f.journal);
      if (f.from) q = q.where('e.date', '>=', f.from);
      if (f.to) q = q.where('e.date', '<=', f.to);
      if (f.status) q = q.where('e.status', '=', f.status as any);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('e.label', 'ilike', like), eb('e.number', 'ilike', like), eb('e.reference', 'ilike', like)]));
      }
      const entries = await q.execute();
      const lines = entries.length ? await trx.selectFrom('journal_line as l')
        .leftJoin('contact as c', (j) => j.onRef('c.id', '=', 'l.contact_id').onRef('c.company_id', '=', 'l.company_id'))
        .select(['l.entry_id', 'l.account_code as account', 'c.name as contactName', 'l.label', 'l.debit', 'l.credit'])
        .where('l.entry_id', 'in', entries.map((e) => e.id)).orderBy('l.position').execute() : [];
      return entries.map((e) => ({
        ...e, total: Number(e.total ?? 0),
        lines: lines.filter((l) => l.entry_id === e.id).map(({ entry_id: _e, ...l }) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) })),
      }));
    });
  }

  /** Grand livre d'un compte (ou d'une racine : 411 inclut 4111…) avec solde progressif. */
  async ledger(t: TenantInfo, f: { account: string; from?: string; to?: string; contactId?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const acc = await trx.selectFrom('ledger_account').select(['code', 'name']).where('code', '=', f.account).executeTakeFirst();
      if (!acc) throw notFound('Compte');
      const base = () => this.linesQuery(trx, f.to).where((eb) => eb.or([eb('l.account_code', '=', f.account), eb('l.account_code', 'like', `${f.account}%`)]))
        .$if(!!f.contactId, (q) => q.where('l.contact_id', '=', f.contactId!));
      const before = f.from ? await base().where('e.date', '<', f.from).select((eb) => [eb.fn.sum<string>('l.debit').as('d'), eb.fn.sum<string>('l.credit').as('c')]).executeTakeFirst() : null;
      const rows = await base().$if(!!f.from, (q) => q.where('e.date', '>=', f.from!))
        .leftJoin('contact as c', (j) => j.onRef('c.id', '=', 'l.contact_id').onRef('c.company_id', '=', 'l.company_id'))
        .select(['l.id', 'e.id as entryId', 'e.date', 'e.number', 'e.journal_code as journal', 'l.account_code as account', 'l.label', 'c.name as contactName', 'l.debit', 'l.credit'])
        .orderBy('e.date').orderBy('e.number').execute();
      const opening = before ? Number(before.d ?? 0) - Number(before.c ?? 0) : 0;
      let running = opening;
      const lines = rows.map((r) => ({ ...r, debit: Number(r.debit), credit: Number(r.credit), balance: round((running += Number(r.debit) - Number(r.credit))) }));
      return { account: acc, opening, lines, totalDebit: round(lines.reduce((s, l) => s + l.debit, 0)), totalCredit: round(lines.reduce((s, l) => s + l.credit, 0)), closing: round(running) };
    });
  }

  /** Balance générale : soldes d'ouverture, mouvements de la période, soldes de clôture, par compte. */
  async trialBalance(t: TenantInfo, f: { from?: string; to?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.linesQuery(trx, f.to).select(['l.account_code as account', 'e.date', 'l.debit', 'l.credit']).execute();
      const names = await trx.selectFrom('ledger_account').select(['code', 'name']).execute();
      const acc = new Map<string, { account: string; name: string; openD: number; openC: number; d: number; c: number }>();
      for (const r of rows) {
        const a = acc.get(r.account) ?? { account: r.account, name: names.find((n) => n.code === r.account)?.name ?? '', openD: 0, openC: 0, d: 0, c: 0 };
        if (f.from && r.date < f.from) { a.openD += Number(r.debit); a.openC += Number(r.credit); } else { a.d += Number(r.debit); a.c += Number(r.credit); }
        acc.set(r.account, a);
      }
      const accounts = [...acc.values()].sort((a, b) => (a.account < b.account ? -1 : 1)).map((a) => {
        const open = a.openD - a.openC, close = open + a.d - a.c;
        return { account: a.account, name: a.name, openingDebit: round(Math.max(open, 0)), openingCredit: round(Math.max(-open, 0)), debit: round(a.d), credit: round(a.c),
          closingDebit: round(Math.max(close, 0)), closingCredit: round(Math.max(-close, 0)) };
      });
      const sum = (k: keyof (typeof accounts)[number]) => round(accounts.reduce((s, a) => s + (a[k] as number), 0));
      const totals = { openingDebit: sum('openingDebit'), openingCredit: sum('openingCredit'), debit: sum('debit'), credit: sum('credit'), closingDebit: sum('closingDebit'), closingCredit: sum('closingCredit') };
      return { accounts, totals, balanced: totals.debit === totals.credit && totals.closingDebit === totals.closingCredit };
    });
  }

  /** Aide à la déclaration de TVA : TVA facturée (4431) moins TVA récupérable (445x) sur la période. */
  async vat(t: TenantInfo, f: { from: string; to: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.linesQuery(trx, f.to).where('e.date', '>=', f.from)
        .where((eb) => eb.or([eb('l.account_code', 'like', '4431%'), eb('l.account_code', 'like', '445%'), eb('l.account_code', 'like', '70%')]))
        .select(['l.account_code as account', 'l.label', 'l.debit', 'l.credit']).execute();
      const net = (pred: (a: string) => boolean, sign: 1 | -1) => round(rows.filter((r) => pred(r.account)).reduce((s, r) => s + sign * (Number(r.credit) - Number(r.debit)), 0));
      const collected = net((a) => a.startsWith('4431'), 1);
      const deductible = net((a) => a.startsWith('445'), -1);
      const byRate = new Map<string, number>();
      for (const r of rows.filter((x) => x.account.startsWith('4431'))) {
        const rate = /(\d+(?:[.,]\d+)?) %/.exec(r.label)?.[1] ?? '?';
        byRate.set(rate, round((byRate.get(rate) ?? 0) + Number(r.credit) - Number(r.debit)));
      }
      return {
        from: f.from, to: f.to, revenueHt: net((a) => a.startsWith('70'), 1), collected, deductible,
        due: round(Math.max(collected - deductible, 0)), credit: round(Math.max(deductible - collected, 0)),
        collectedByRate: [...byRate.entries()].map(([rate, amount]) => ({ rate: Number(rate.replace(',', '.')), amount })).sort((a, b) => b.rate - a.rate),
      };
    });
  }

  /** Compte de résultat simplifié : charges (6) et produits (7) par rubrique, résultat de la période. */
  async incomeStatement(t: TenantInfo, f: { from?: string; to?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.linesQuery(trx, f.to).$if(!!f.from, (q) => q.where('e.date', '>=', f.from!))
        .where((eb) => eb.or([eb('l.account_code', 'like', '6%'), eb('l.account_code', 'like', '7%'), eb('l.account_code', 'like', '89%')]))
        .select(['l.account_code as account', 'l.debit', 'l.credit']).execute();
      const groups = new Map<string, number>();
      for (const r of rows) {
        const k = r.account.slice(0, 2);
        const v = r.account.startsWith('7') ? Number(r.credit) - Number(r.debit) : Number(r.debit) - Number(r.credit);
        groups.set(k, round((groups.get(k) ?? 0) + v));
      }
      const lines = [...groups.entries()].sort().map(([code, amount]) => ({ code, label: INCOME_HEADINGS[code] ?? `Comptes ${code}`, amount, kind: code.startsWith('7') ? 'income' : 'charge' }));
      const income = round(lines.filter((l) => l.kind === 'income').reduce((s, l) => s + l.amount, 0));
      const charges = round(lines.filter((l) => l.kind === 'charge').reduce((s, l) => s + l.amount, 0));
      return { lines, income, charges, result: round(income - charges) };
    });
  }

  /** Export des écritures validées (colonnes proches du fichier des écritures comptables). */
  async exportRows(t: TenantInfo, f: { from?: string; to?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.linesQuery(trx, f.to).$if(!!f.from, (q) => q.where('e.date', '>=', f.from!))
        .innerJoin('journal as j', (jn) => jn.onRef('j.code', '=', 'e.journal_code').onRef('j.company_id', '=', 'e.company_id'))
        .innerJoin('ledger_account as a', (jn) => jn.onRef('a.code', '=', 'l.account_code').onRef('a.company_id', '=', 'l.company_id'))
        .leftJoin('contact as c', (jn) => jn.onRef('c.id', '=', 'l.contact_id').onRef('c.company_id', '=', 'l.company_id'))
        .select(['e.journal_code', 'j.name as journal_name', 'e.number', 'e.date', 'l.account_code', 'a.name as account_name', 'c.code as contact_code', 'c.name as contact_name',
          'e.reference', 'l.label', 'l.debit', 'l.credit', 'e.posted_at'])
        .orderBy('e.date').orderBy('e.number').orderBy('l.position').execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.exported', data: { lines: rows.length, from: f.from, to: f.to } });
      return rows.map((r) => ({
        JournalCode: r.journal_code, JournalLib: r.journal_name, EcritureNum: r.number, EcritureDate: r.date, CompteNum: r.account_code, CompteLib: r.account_name,
        CompAuxNum: r.contact_code ?? '', CompAuxLib: r.contact_name ?? '', PieceRef: r.reference ?? r.number, EcritureLib: r.label,
        Debit: Number(r.debit).toFixed(2).replace('.', ','), Credit: Number(r.credit).toFixed(2).replace('.', ','), ValidDate: r.posted_at ? new Date(r.posted_at).toISOString().slice(0, 10) : '',
      }));
    });
  }
}
