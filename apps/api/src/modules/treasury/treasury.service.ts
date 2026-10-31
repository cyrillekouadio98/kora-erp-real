import { Injectable } from '@nestjs/common';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid, uuidv7 } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { MovementSource, PaymentMethod, TreasuryKind } from '../../db/schema';
import { AccountingService } from '../accounting/accounting.service';
import { AuditService } from '../audit/audit.service';

/** Catégories saisissables à la main (les autres sont posées par les ventes, achats, virements et arrêtés). */
export const EXPENSE_CATEGORIES = ['rent', 'electricity', 'water', 'fuel', 'transport', 'telecom', 'supplies', 'maintenance', 'salaries', 'taxes', 'bank_fees', 'owner_withdrawal', 'other_expense'];
export const INCOME_CATEGORIES = ['capital', 'loan', 'other_income'];

/** Compte utilisé par défaut selon le mode de paiement. */
const KIND_FOR_METHOD: Record<PaymentMethod, TreasuryKind> = { cash: 'cash', mobile_money: 'mobile_money', bank_transfer: 'bank', cheque: 'bank', card: 'bank' };

export interface MovementInput {
  accountId: string; date: string; direction: 'in' | 'out'; amount: number; category: string; label: string;
  contactId?: string | null; sourceType: MovementSource; sourceId?: string | null; transferId?: string | null; reversalOf?: string | null; reference?: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class TreasuryService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly accounting: AccountingService) {}

  private async account(trx: TenantTrx, id: string, lock = false) {
    if (!isUuid(id)) throw notFound('Compte de trésorerie');
    const a = await trx.selectFrom('treasury_account').selectAll().where('id', '=', id).$if(lock, (q) => q.forUpdate()).executeTakeFirst();
    if (!a) throw notFound('Compte de trésorerie');
    return a;
  }

  /** Solde courant (solde d'ouverture + entrées − sorties), éventuellement arrêté à une date. */
  async balance(trx: TenantTrx, accountId: string, until?: string) {
    const a = await this.account(trx, accountId);
    const rows = await trx.selectFrom('treasury_movement').select(['direction', 'amount']).where('account_id', '=', accountId)
      .$if(!!until, (q) => q.where('date', '<=', until!)).execute();
    return Number(a.opening_balance) + rows.reduce((s, m) => s + (m.direction === 'in' ? 1 : -1) * Number(m.amount), 0);
  }

  /** Compte indiqué, ou compte actif par défaut pour ce mode de paiement. */
  async resolveAccount(trx: TenantTrx, accountId: string | null | undefined, method: PaymentMethod) {
    if (accountId) {
      const a = await this.account(trx, accountId);
      if (a.archived_at) throw conflict(`Le compte « ${a.name} » est archivé.`, 'account_archived');
      return a;
    }
    const kind = KIND_FOR_METHOD[method];
    const a = await trx.selectFrom('treasury_account').selectAll().where('kind', '=', kind).where('archived_at', 'is', null).orderBy('created_at').executeTakeFirst();
    if (!a) throw badRequest(`Aucun compte ${kind === 'cash' ? 'de caisse' : kind === 'bank' ? 'bancaire' : 'mobile money'} actif : créez-en un dans Trésorerie ou choisissez le compte.`, undefined, 'no_account');
    return a;
  }

  /**
   * Inscrit un mouvement dans la transaction de l'opération qui le provoque.
   * La caisse ne peut jamais devenir négative : on ne sort pas d'espèces qu'on n'a pas.
   */
  async record(trx: TenantTrx, t: TenantInfo, m: MovementInput) {
    const a = await this.account(trx, m.accountId, true);
    if (a.archived_at) throw conflict(`Le compte « ${a.name} » est archivé.`, 'account_archived');
    if (m.date > today()) throw badRequest('La date du mouvement ne peut pas être dans le futur.', undefined, 'future_date');
    if (m.date < a.opening_date) throw badRequest(`La date est antérieure à l'ouverture du compte « ${a.name} » (${a.opening_date}).`, undefined, 'before_opening');
    if (m.direction === 'out' && a.kind === 'cash') {
      const available = await this.balance(trx, a.id);
      if (m.amount > available) {
        throw conflict(`Solde insuffisant dans « ${a.name} » : ${available.toLocaleString('fr-FR')} FCFA disponibles pour une sortie de ${m.amount.toLocaleString('fr-FR')} FCFA.`, 'insufficient_cash');
      }
    }
    const row = await trx.insertInto('treasury_movement').values({
      company_id: t.companyId, account_id: a.id, date: m.date, direction: m.direction, amount: m.amount, category: m.category, label: m.label,
      contact_id: m.contactId ?? null, source_type: m.sourceType, source_id: m.sourceId ?? null, transfer_id: m.transferId ?? null,
      reversal_of: m.reversalOf ?? null, reversed_by: null, reference: m.reference ?? null, created_by: t.ctx.userId,
    }).returning(['id']).executeTakeFirstOrThrow();
    await this.accounting.postMovement(trx, t, row.id);
    return row;
  }

  // ------------------------------------------------------------------ comptes
  async accounts(t: TenantInfo, includeArchived = false) {
    return this.db.tenant(t.ctx, async (trx) => {
      const accounts = await trx.selectFrom('treasury_account').selectAll().$if(!includeArchived, (q) => q.where('archived_at', 'is', null)).orderBy('created_at').execute();
      const sums = await trx.selectFrom('treasury_movement').select(['account_id', 'direction', 'amount', 'date']).execute();
      const now = today();
      const monthStart = `${now.slice(0, 7)}-01`;
      return accounts.map((a) => {
        const mine = sums.filter((m) => m.account_id === a.id);
        const signed = (m: { direction: string; amount: string }) => (m.direction === 'in' ? 1 : -1) * Number(m.amount);
        return {
          id: a.id, kind: a.kind, name: a.name, bankName: a.bank_name, accountNumber: a.account_number, ledgerCode: a.ledger_code, openingBalance: Number(a.opening_balance), openingDate: a.opening_date,
          archivedAt: a.archived_at, balance: Number(a.opening_balance) + mine.reduce((s, m) => s + signed(m), 0),
          monthIn: mine.filter((m) => m.date >= monthStart && m.direction === 'in').reduce((s, m) => s + Number(m.amount), 0),
          monthOut: mine.filter((m) => m.date >= monthStart && m.direction === 'out').reduce((s, m) => s + Number(m.amount), 0),
        };
      });
    });
  }

  async createAccount(t: TenantInfo, input: { kind: TreasuryKind; name: string; bankName?: string | null; accountNumber?: string | null; openingBalance?: number; openingDate?: string }) {
    if (input.kind === 'cash' && (input.openingBalance ?? 0) < 0) throw badRequest("Le solde d'ouverture d'une caisse ne peut pas être négatif.", undefined, 'negative_cash');
    return this.db.tenant(t.ctx, async (trx) => {
      const exists = await trx.selectFrom('treasury_account').select('id').where('name', '=', input.name).executeTakeFirst();
      if (exists) throw conflict(`Un compte s'appelle déjà « ${input.name} ».`, 'account_name_taken');
      // Sous-compte comptable suivant, sur 6 chiffres : 571100, 571200… (caisse), 521100… (banque), 552100… (mobile money)
      const root = { cash: '571', bank: '521', mobile_money: '552' }[input.kind];
      const used = new Set((await trx.selectFrom('ledger_account').select('code').where('code', 'like', `${root}%`).execute()).map((u) => u.code));
      const suffixes = [...Array.from({ length: 9 }, (_, i) => (i + 1) * 100), ...Array.from({ length: 999 }, (_, i) => i + 1)];
      const ledgerCode = suffixes.map((n) => `${root}${String(n).padStart(3, '0')}`).find((c) => !used.has(c) && c !== `${root}000`);
      if (!ledgerCode) throw conflict(`Plus aucun sous-compte ${root} disponible.`, 'no_ledger_code');
      await trx.insertInto('ledger_account').values({ company_id: t.companyId, code: ledgerCode, name: input.name, is_system: true }).execute();
      const a = await trx.insertInto('treasury_account').values({
        company_id: t.companyId, kind: input.kind, name: input.name, bank_name: input.bankName ?? null, account_number: input.accountNumber ?? null, ledger_code: ledgerCode,
        opening_balance: input.openingBalance ?? 0, opening_date: input.openingDate ?? today(),
      }).returning('id').executeTakeFirstOrThrow();
      await this.accounting.postOpening(trx, t, a.id);
      await this.audit.tenant(trx, t.ctx, { action: 'treasury_account.created', entityType: 'treasury_account', entityId: a.id, data: { name: input.name, kind: input.kind, openingBalance: input.openingBalance ?? 0 } });
      return a;
    });
  }

  async updateAccount(t: TenantInfo, id: string, input: { name?: string; bankName?: string | null; accountNumber?: string | null; openingBalance?: number; openingDate?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.account(trx, id, true);
      if (input.name && input.name !== a.name) {
        const exists = await trx.selectFrom('treasury_account').select('id').where('name', '=', input.name).executeTakeFirst();
        if (exists) throw conflict(`Un compte s'appelle déjà « ${input.name} ».`, 'account_name_taken');
      }
      if (a.kind === 'cash' && (input.openingBalance ?? 0) < 0) throw badRequest("Le solde d'ouverture d'une caisse ne peut pas être négatif.", undefined, 'negative_cash');
      if (input.openingDate) {
        const first = await trx.selectFrom('treasury_movement').select('date').where('account_id', '=', id).orderBy('date').limit(1).executeTakeFirst();
        if (first && first.date < input.openingDate) throw badRequest(`Des mouvements existent dès le ${first.date} : la date d'ouverture ne peut pas être postérieure.`, undefined, 'opening_after_movements');
      }
      const patch: Record<string, unknown> = {};
      if (input.name) {
        patch.name = input.name;
        await trx.updateTable('ledger_account').set({ name: input.name }).where('code', '=', a.ledger_code).execute();
      }
      if (input.bankName !== undefined) patch.bank_name = input.bankName;
      if (input.accountNumber !== undefined) patch.account_number = input.accountNumber;
      if (input.openingBalance !== undefined) patch.opening_balance = input.openingBalance;
      if (input.openingDate) patch.opening_date = input.openingDate;
      if (Object.keys(patch).length) await trx.updateTable('treasury_account').set(patch).where('id', '=', id).execute();
      if (input.openingBalance !== undefined || input.openingDate) await this.accounting.postOpening(trx, t, id);
      // Le solde d'ouverture change tout l'historique du compte : il est tracé avec sa valeur précédente.
      await this.audit.tenant(trx, t.ctx, { action: 'treasury_account.updated', entityType: 'treasury_account', entityId: id, data: {
        name: input.name ?? a.name, ...(input.openingBalance !== undefined ? { openingBalance: { from: Number(a.opening_balance), to: input.openingBalance } } : {}),
      } });
      return { ok: true };
    });
  }

  async setArchived(t: TenantInfo, id: string, archived: boolean) {
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.account(trx, id, true);
      if (archived && a.archived_at) throw conflict('Ce compte est déjà archivé.', 'invalid_state');
      if (!archived && !a.archived_at) throw conflict("Ce compte n'est pas archivé.", 'invalid_state');
      if (archived) {
        const bal = await this.balance(trx, id);
        if (bal !== 0) throw conflict(`Le compte « ${a.name} » a encore un solde de ${bal.toLocaleString('fr-FR')} FCFA : videz-le par un virement avant de l'archiver.`, 'account_not_empty');
      }
      await trx.updateTable('treasury_account').set({ archived_at: archived ? new Date() : null }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: archived ? 'treasury_account.archived' : 'treasury_account.restored', entityType: 'treasury_account', entityId: id, data: { name: a.name } });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ mouvements
  async movements(t: TenantInfo, f: { accountId?: string; kind?: TreasuryKind; from?: string; to?: string; category?: string; q?: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('treasury_movement as m')
        .innerJoin('treasury_account as a', (j) => j.onRef('a.id', '=', 'm.account_id').onRef('a.company_id', '=', 'm.company_id'))
        .leftJoin('contact as c', (j) => j.onRef('c.id', '=', 'm.contact_id').onRef('c.company_id', '=', 'm.company_id'))
        .leftJoin('user_account as u', 'u.id', 'm.created_by')
        .select(['m.id', 'm.date', 'm.direction', 'm.amount', 'm.category', 'm.label', 'm.reference', 'm.source_type as sourceType', 'm.source_id as sourceId',
          'm.transfer_id as transferId', 'm.reversal_of as reversalOf', 'm.reversed_by as reversedBy', 'm.created_at as createdAt',
          'a.id as accountId', 'a.name as accountName', 'a.kind as accountKind', 'c.id as contactId', 'c.name as contactName', 'u.full_name as by'])
        .orderBy('m.date').orderBy('m.created_at').limit(5000);
      if (f.accountId) q = q.where('m.account_id', '=', f.accountId);
      if (f.kind) q = q.where('a.kind', '=', f.kind);
      if (f.from) q = q.where('m.date', '>=', f.from);
      if (f.to) q = q.where('m.date', '<=', f.to);
      if (f.category) q = q.where('m.category', '=', f.category);
      if (f.q) {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('m.label', 'ilike', like), eb('m.reference', 'ilike', like), eb('c.name', 'ilike', like)]));
      }
      const rows = (await q.execute()).map((r) => ({ ...r, amount: Number(r.amount) }));
      // Solde progressif quand on consulte un seul compte sans autre filtre que la période.
      if (f.accountId && !f.category && !f.q) {
        let running = f.from ? await this.balance(trx, f.accountId, addDaysIso(f.from, -1)) : Number((await this.account(trx, f.accountId)).opening_balance);
        const opening = running;
        const withBalance = rows.map((r) => ({ ...r, balanceAfter: (running += (r.direction === 'in' ? 1 : -1) * r.amount) }));
        return { opening, movements: withBalance.reverse(), closing: running };
      }
      return { opening: null, movements: rows.reverse(), closing: null };
    });
  }

  async addManual(t: TenantInfo, input: { kind: 'expense' | 'income'; accountId: string; date?: string; amount: number; category: string; label: string; contactId?: string | null; reference?: string | null }) {
    const allowed = input.kind === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
    if (!allowed.includes(input.category)) throw badRequest('Catégorie inconnue.', undefined, 'unknown_category');
    return this.db.tenant(t.ctx, async (trx) => {
      if (input.contactId) {
        if (!isUuid(input.contactId) || !(await trx.selectFrom('contact').select('id').where('id', '=', input.contactId).executeTakeFirst())) throw badRequest('Contact introuvable.', undefined, 'unknown_contact');
      }
      const m = await this.record(trx, t, {
        accountId: input.accountId, date: input.date ?? today(), direction: input.kind === 'expense' ? 'out' : 'in', amount: input.amount,
        category: input.category, label: input.label, contactId: input.contactId, sourceType: input.kind, reference: input.reference,
      });
      await this.audit.tenant(trx, t.ctx, { action: `treasury.${input.kind}_recorded`, entityType: 'treasury_movement', entityId: m.id, data: { amount: input.amount, category: input.category, label: input.label } });
      return m;
    });
  }

  /** Virement interne : une sortie et une entrée liées, dans la même transaction. */
  async transfer(t: TenantInfo, input: { fromAccountId: string; toAccountId: string; amount: number; date?: string; label?: string | null; reference?: string | null }) {
    if (input.fromAccountId === input.toAccountId) throw badRequest('Choisissez deux comptes différents.', undefined, 'same_account');
    return this.db.tenant(t.ctx, async (trx) => {
      const from = await this.account(trx, input.fromAccountId);
      const to = await this.account(trx, input.toAccountId);
      const transferId = uuidv7();
      const date = input.date ?? today();
      const label = input.label || `Virement de ${from.name} vers ${to.name}`;
      await this.record(trx, t, { accountId: from.id, date, direction: 'out', amount: input.amount, category: 'transfer', label, sourceType: 'transfer', transferId, reference: input.reference });
      await this.record(trx, t, { accountId: to.id, date, direction: 'in', amount: input.amount, category: 'transfer', label, sourceType: 'transfer', transferId, reference: input.reference });
      await this.audit.tenant(trx, t.ctx, { action: 'treasury.transfer_recorded', entityType: 'treasury_movement', entityId: transferId, data: { from: from.name, to: to.name, amount: input.amount } });
      return { transferId };
    });
  }

  /** Arrêté de caisse : le montant compté devient le solde ; l'écart éventuel est inscrit comme mouvement. */
  async cashCount(t: TenantInfo, accountId: string, input: { counted: number; note?: string | null }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.account(trx, accountId, true);
      if (a.kind !== 'cash') throw badRequest("L'arrêté de caisse ne concerne que les comptes de caisse.", undefined, 'not_cash');
      const expected = await this.balance(trx, accountId);
      const diff = input.counted - expected;
      if (diff !== 0) {
        await this.record(trx, t, {
          accountId, date: today(), direction: diff > 0 ? 'in' : 'out', amount: Math.abs(diff), category: 'cash_difference', sourceType: 'cash_count',
          label: `Écart d'arrêté de caisse (compté ${input.counted.toLocaleString('fr-FR')}, attendu ${expected.toLocaleString('fr-FR')})${input.note ? ` — ${input.note}` : ''}`,
        });
      }
      await this.audit.tenant(trx, t.ctx, { action: 'treasury.cash_counted', entityType: 'treasury_account', entityId: accountId, data: { account: a.name, expected, counted: input.counted, difference: diff } });
      return { expected, counted: input.counted, difference: diff };
    });
  }

  /** Contre-passation : annule un mouvement saisi à la main par un mouvement inverse. Les paiements se corrigent depuis leur facture. */
  async reverse(t: TenantInfo, id: string, reason: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      if (!isUuid(id)) throw notFound('Mouvement');
      const m = await trx.selectFrom('treasury_movement').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw notFound('Mouvement');
      if (m.reversed_by) throw conflict('Ce mouvement est déjà contre-passé.', 'already_reversed');
      if (m.source_type === 'reversal') throw conflict('Une contre-passation ne se contre-passe pas.', 'invalid_state');
      if (!['expense', 'income', 'transfer'].includes(m.source_type)) throw conflict('Ce mouvement provient d’une facture ou d’un arrêté de caisse : il ne se contre-passe pas ici.', 'not_reversible');
      const legs = m.transfer_id
        ? await trx.selectFrom('treasury_movement').selectAll().where('transfer_id', '=', m.transfer_id).where('reversed_by', 'is', null).forUpdate().execute()
        : [m];
      // Un virement s'annule en entier (ses deux jambes) ; la caisse refusera si les espèces ont déjà été dépensées.
      for (const leg of legs) {
        const r = await this.record(trx, t, {
          accountId: leg.account_id, date: today(), direction: leg.direction === 'in' ? 'out' : 'in', amount: Number(leg.amount), category: leg.category,
          label: `Contre-passation : ${leg.label} — ${reason}`, contactId: leg.contact_id, sourceType: 'reversal', reversalOf: leg.id, reference: leg.reference,
        });
        await trx.updateTable('treasury_movement').set({ reversed_by: r.id }).where('id', '=', leg.id).execute();
      }
      await this.audit.tenant(trx, t.ctx, { action: 'treasury.movement_reversed', entityType: 'treasury_movement', entityId: id, data: { label: m.label, amount: Number(m.amount), reason } });
      return { ok: true };
    });
  }

  async summary(t: TenantInfo) {
    const accounts = await this.accounts(t);
    const by = (k: TreasuryKind) => accounts.filter((a) => a.kind === k).reduce((s, a) => s + a.balance, 0);
    return {
      total: accounts.reduce((s, a) => s + a.balance, 0), cash: by('cash'), bank: by('bank'), mobileMoney: by('mobile_money'),
      monthIn: accounts.reduce((s, a) => s + a.monthIn, 0), monthOut: accounts.reduce((s, a) => s + a.monthOut, 0),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance: a.balance })),
    };
  }
}

function addDaysIso(d: string, n: number) { return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10); }
