import { Injectable } from '@nestjs/common';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { TreasuryService } from '../treasury/treasury.service';
import { AccountingService, LineInput } from './accounting.service';

/**
 * Écritures de constitution d'une société (SYSCOHADA révisé).
 * SA, SAS : libération d'au moins le quart du numéraire, le solde est appelé plus tard (comptes 1011 → 1012 → 1013, 109).
 * SARL : capital entièrement libéré, la souscription est créditée directement au 1013.
 * Les écritures sans banque vont au journal OD ; les versements et les frais passent par la trésorerie (journal TR).
 */
export const LEGAL_FORMS = ['SA', 'SAS', 'SASU', 'SARL', 'SARLU', 'SNC', 'SCS', 'GIE', 'other'] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];
export const STEPS = ['subscription', 'call', 'contribution', 'release', 'uncalled', 'fees', 'balance_call', 'balance_payment'] as const;
export type StepKey = (typeof STEPS)[number];
/** Formes où le numéraire est entièrement libéré à la constitution. */
const FULL_RELEASE: LegalForm[] = ['SARL', 'SARLU'];
/** Formes où au moins le quart du numéraire est libéré à la constitution. */
const QUARTER_RELEASE: LegalForm[] = ['SA', 'SAS', 'SASU'];

const A = {
  uncalled: '101100', calledUnpaid: '101200', paid: '101300', uncalledContrib: '109000',
  nature: '461100', cash: '461200', called: '461300', notary: '471100',
};

export interface FormationInput {
  legalForm: LegalForm; date: string; capital: number; nature: { account: string; label: string; amount: number }[];
  cashPaid: number; deposit: 'bank' | 'notary'; bankAccountId?: string | null;
}
interface Formation extends FormationInput { bankAccountId: string | null }
type Op =
  | { kind: 'entry'; journal: 'OD'; label: string; lines: LineInput[] }
  | { kind: 'movement'; journal: 'TR'; label: string; accountId: string; direction: 'in' | 'out'; amount: number; counterpart: string; category: string };
interface StepRow { id: string; step: StepKey; date: string; amount: number; data: any; entryIds: string[]; movementIds: string[]; createdAt: Date }

const round = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => round(xs.reduce((s, x) => s + x, 0));
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString('fr-FR');

@Injectable()
export class FormationService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly accounting: AccountingService, private readonly treasury: TreasuryService) {}

  // ------------------------------------------------------------------ calculs
  private figures(f: Formation, steps: StepRow[]) {
    const natureTotal = sum(f.nature.map((n) => n.amount));
    const cash = round(f.capital - natureTotal);
    const full = FULL_RELEASE.includes(f.legalForm);
    const uncalled = full ? 0 : round(cash - f.cashPaid);
    const of = (k: StepKey) => sum(steps.filter((s) => s.step === k).map((s) => s.amount));
    const balanceCalled = of('balance_call'), balancePaid = of('balance_payment');
    return { natureTotal, cash, full, uncalled, called: round(natureTotal + (full ? cash : f.cashPaid)), balanceCalled, balancePaid,
      remainingToCall: round(uncalled - balanceCalled), calledUnpaid: round(balanceCalled - balancePaid) };
  }

  /** Écritures d'une étape : la même fonction sert à l'aperçu et au passage. */
  private ops(f: Formation, steps: StepRow[], key: StepKey, input: { amount?: number; fees?: { account: string; label: string; amount: number }[]; accountId?: string | null } = {}): Op[] {
    const x = this.figures(f, steps);
    const bank = input.accountId ?? f.bankAccountId ?? '';
    const natureDebits = (credit: string, label: string): Op[] => (x.natureTotal > 0 ? [{ kind: 'entry', journal: 'OD', label, lines: [
      ...f.nature.map((n) => ({ account: n.account, label: n.label || 'Apport en nature', debit: n.amount })),
      { account: credit, label: 'Apporteurs', credit: x.natureTotal },
    ] }] : []);
    const cashIn = (credit: string, amount: number, label: string): Op[] => (amount <= 0 ? [] : f.deposit === 'notary' && key !== 'balance_payment'
      ? [{ kind: 'entry', journal: 'OD', label: `${label} (fonds chez le notaire)`, lines: [{ account: A.notary, label: 'Notaire, fonds de constitution', debit: amount }, { account: credit, label: 'Apporteurs', credit: amount }] }]
      : [{ kind: 'movement', journal: 'TR', label, accountId: bank, direction: 'in', amount, counterpart: credit, category: 'capital' }]);

    switch (key) {
      case 'subscription': return [{ kind: 'entry', journal: 'OD', label: 'Souscription du capital', lines: [
        ...(x.natureTotal > 0 ? [{ account: A.nature, label: 'Apporteurs, apports en nature', debit: x.natureTotal }] : []),
        ...(x.cash > 0 ? [{ account: A.cash, label: 'Apporteurs, apports en numéraire', debit: x.cash }] : []),
        { account: x.full ? A.paid : A.uncalled, label: x.full ? 'Capital souscrit, appelé, versé' : 'Capital souscrit, non appelé', credit: f.capital },
      ] }];
      case 'call': return [
        { kind: 'entry', journal: 'OD', label: 'Appel du capital', lines: [
          { account: A.called, label: 'Apporteurs, capital appelé non versé', debit: x.called },
          ...(x.natureTotal > 0 ? [{ account: A.nature, label: 'Apporteurs, apports en nature', credit: x.natureTotal }] : []),
          ...(f.cashPaid > 0 ? [{ account: A.cash, label: 'Apporteurs, apports en numéraire', credit: f.cashPaid }] : []),
        ] },
        { kind: 'entry', journal: 'OD', label: 'Constatation du capital appelé', lines: [
          { account: A.uncalled, label: 'Capital souscrit, non appelé', debit: x.called }, { account: A.calledUnpaid, label: 'Capital souscrit, appelé, non versé', credit: x.called },
        ] },
      ];
      case 'contribution': {
        const credit = x.full ? A.nature : A.called;
        return [
          ...natureDebits(credit, 'Réalisation des apports en nature'),
          ...cashIn(x.full ? A.cash : A.called, x.full ? x.cash : f.cashPaid, 'Versement des apports en numéraire'),
          ...(x.full ? [] : [{ kind: 'entry' as const, journal: 'OD' as const, label: 'Capital appelé et versé', lines: [
            { account: A.calledUnpaid, label: 'Capital souscrit, appelé, non versé', debit: x.called }, { account: A.paid, label: 'Capital souscrit, appelé, versé', credit: x.called },
          ] }]),
        ];
      }
      case 'release': {
        const amount = x.full ? x.cash : f.cashPaid;
        return [{ kind: 'movement', journal: 'TR', label: 'Déblocage des fonds de constitution par le notaire', accountId: bank, direction: 'in', amount, counterpart: A.notary, category: 'capital' }];
      }
      case 'uncalled': return [{ kind: 'entry', journal: 'OD', label: 'Capital souscrit, non appelé', lines: [
        { account: A.uncalledContrib, label: 'Apporteurs, capital souscrit, non appelé', debit: x.uncalled }, { account: A.cash, label: 'Apporteurs, apports en numéraire', credit: x.uncalled },
      ] }];
      case 'balance_call': {
        const amount = input.amount ?? x.remainingToCall;
        return [
          { kind: 'entry', journal: 'OD', label: 'Appel du solde du capital', lines: [
            { account: A.called, label: 'Apporteurs, capital appelé non versé', debit: amount }, { account: A.uncalledContrib, label: 'Apporteurs, capital souscrit, non appelé', credit: amount },
          ] },
          { kind: 'entry', journal: 'OD', label: 'Constatation du capital appelé', lines: [
            { account: A.uncalled, label: 'Capital souscrit, non appelé', debit: amount }, { account: A.calledUnpaid, label: 'Capital souscrit, appelé, non versé', credit: amount },
          ] },
        ];
      }
      case 'balance_payment': {
        const amount = input.amount ?? x.calledUnpaid;
        return [
          ...cashIn(A.called, amount, 'Versement du solde du capital appelé'),
          { kind: 'entry', journal: 'OD', label: 'Capital appelé et versé', lines: [
            { account: A.calledUnpaid, label: 'Capital souscrit, appelé, non versé', debit: amount }, { account: A.paid, label: 'Capital souscrit, appelé, versé', credit: amount },
          ] },
        ];
      }
      case 'fees': return (input.fees ?? []).filter((l) => l.amount > 0).map((l) => (
        { kind: 'movement', journal: 'TR', label: `Frais de constitution — ${l.label}`, accountId: bank, direction: 'out', amount: l.amount, counterpart: l.account, category: 'formation_fees' }
      ));
    }
  }

  /** Étape disponible ? Renvoie la raison du refus, ou null. */
  private blocker(f: Formation, steps: StepRow[], key: StepKey): string | null {
    const x = this.figures(f, steps);
    const done = (k: StepKey) => steps.some((s) => s.step === k);
    if (key === 'fees') return null;
    if (key !== 'balance_call' && key !== 'balance_payment' && done(key)) return 'Étape déjà passée.';
    switch (key) {
      case 'subscription': return null;
      case 'call': return x.full ? `Sans objet en ${f.legalForm} : le capital est libéré en entier.` : done('subscription') ? null : 'Passez d’abord la souscription.';
      case 'contribution': return !done('subscription') ? 'Passez d’abord la souscription.' : !x.full && !done('call') ? 'Passez d’abord l’appel du capital.' : null;
      case 'release': return f.deposit !== 'notary' ? 'Sans objet : les fonds sont versés directement en banque.' : (x.full ? x.cash : f.cashPaid) <= 0 ? 'Aucun numéraire versé.' : done('contribution') ? null : 'Passez d’abord la réalisation des apports.';
      case 'uncalled': return x.uncalled <= 0 ? 'Sans objet : tout le numéraire est appelé.' : done('call') ? null : 'Passez d’abord l’appel du capital.';
      case 'balance_call': return x.uncalled <= 0 ? 'Sans objet : tout le numéraire est appelé.' : !done('uncalled') ? 'Passez d’abord le capital non appelé.' : x.remainingToCall <= 0 ? 'Tout le capital est appelé.' : null;
      case 'balance_payment': return x.calledUnpaid <= 0 ? (x.uncalled <= 0 ? 'Sans objet : tout le numéraire est appelé.' : 'Appelez d’abord le solde du capital.') : null;
    }
  }

  // ------------------------------------------------------------------ lecture
  private async load(trx: TenantTrx) {
    const r = await trx.selectFrom('company_formation').selectAll().executeTakeFirst();
    const formation: Formation | null = r ? {
      legalForm: r.legal_form as LegalForm, date: r.formation_date, capital: Number(r.capital), cashPaid: Number(r.cash_paid), deposit: r.deposit,
      bankAccountId: r.bank_account_id, nature: (r.nature ?? []).map((n: any) => ({ account: n.account, label: n.label, amount: Number(n.amount) })),
    } : null;
    const steps: StepRow[] = (await trx.selectFrom('company_formation_step').selectAll().where('cancelled_at', 'is', null).orderBy('created_at').execute())
      .map((s) => ({ id: s.id, step: s.step as StepKey, date: s.date, amount: Number(s.amount), data: s.data, entryIds: s.entry_ids, movementIds: s.movement_ids, createdAt: s.created_at }));
    return { formation, steps };
  }

  async get(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const { formation: f, steps } = await this.load(trx);
      const accounts = await trx.selectFrom('ledger_account').select(['code', 'name']).execute();
      const name = (c: string) => accounts.find((a) => a.code === c)?.name ?? '';
      const ids = steps.flatMap((s) => s.entryIds), mids = steps.flatMap((s) => s.movementIds);
      const entries = ids.length || mids.length ? await trx.selectFrom('journal_entry').select(['id', 'number', 'journal_code', 'source_type', 'source_id'])
        .where((eb) => eb.or([...(ids.length ? [eb('id', 'in', ids)] : []), ...(mids.length ? [eb.and([eb('source_type', '=', 'treasury_movement'), eb('source_id', 'in', mids)])] : [])])).execute() : [];
      const numbers = (s: StepRow) => [...s.entryIds.map((id) => entries.find((e) => e.id === id)), ...s.movementIds.map((id) => entries.find((e) => e.source_id === id))]
        .filter(Boolean).map((e) => ({ id: e!.id, number: e!.number, journal: e!.journal_code }));
      const view = (ops: Op[]) => ops.map((o) => o.kind === 'entry'
        ? { journal: o.journal, label: o.label, lines: o.lines.map((l) => ({ account: l.account, name: name(l.account), label: l.label, debit: l.debit ?? 0, credit: l.credit ?? 0 })) }
        : { journal: o.journal, label: o.label, lines: [
          { account: 'banque', name: 'Compte de trésorerie', label: o.label, debit: o.direction === 'in' ? o.amount : 0, credit: o.direction === 'out' ? o.amount : 0 },
          { account: o.counterpart, name: name(o.counterpart), label: o.label, debit: o.direction === 'out' ? o.amount : 0, credit: o.direction === 'in' ? o.amount : 0 },
        ] });
      const lastId = [...steps].reverse().find((s) => s.step !== 'fees')?.id;
      return {
        formation: f, figures: f ? this.figures(f, steps) : null, names: Object.fromEntries(accounts.filter((a) => /^(1|2|3|46|47|6)/.test(a.code)).map((a) => [a.code, a.name])),
        steps: STEPS.map((key) => ({
          key, blocker: f ? this.blocker(f, steps, key) : 'Enregistrez d’abord la fiche de constitution.',
          preview: f && !['fees'].includes(key) ? view(this.ops(f, steps, key)) : [],
          done: steps.filter((s) => s.step === key).map((s) => ({ id: s.id, date: s.date, amount: s.amount, data: s.data, entries: numbers(s), cancellable: key === 'fees' || s.id === lastId })),
        })),
      };
    });
  }

  // ------------------------------------------------------------------ écriture
  async save(t: TenantInfo, input: FormationInput) {
    return this.db.tenant(t.ctx, async (trx) => {
      const { steps } = await this.load(trx);
      if (steps.some((s) => s.step !== 'fees')) throw conflict('Des écritures de constitution sont déjà passées : annulez-les avant de modifier la fiche.', 'formation_started');
      const f: Formation = { ...input, bankAccountId: input.bankAccountId ?? null };
      const x = this.figures(f, []);
      if (x.cash < 0) throw badRequest(`Les apports en nature (${fmt(x.natureTotal)}) dépassent le capital (${fmt(f.capital)}).`, undefined, 'nature_exceeds_capital');
      if (f.cashPaid > x.cash) throw badRequest(`Le numéraire libéré (${fmt(f.cashPaid)}) dépasse les apports en numéraire (${fmt(x.cash)}).`, undefined, 'paid_exceeds_cash');
      if (x.full) f.cashPaid = x.cash;
      if (QUARTER_RELEASE.includes(f.legalForm) && f.cashPaid < round(x.cash / 4)) {
        throw badRequest(`En ${f.legalForm}, au moins le quart du numéraire est libéré à la constitution : ${fmt(round(x.cash / 4))} FCFA au minimum.`, undefined, 'quarter_release');
      }
      const codes = f.nature.map((n) => n.account);
      if (codes.some((c) => !/^[23]/.test(c))) throw badRequest('Un apport en nature s’inscrit dans un compte d’immobilisation (classe 2) ou de stock (classe 3).', undefined, 'nature_account');
      if (codes.length) {
        const found = await trx.selectFrom('ledger_account').select('code').where('code', 'in', codes).execute();
        const missing = codes.filter((c) => !found.some((a) => a.code === c));
        if (missing.length) throw badRequest(`Compte inconnu dans le plan comptable : ${missing.join(', ')}.`, undefined, 'unknown_account');
      }
      if (f.bankAccountId) {
        if (!isUuid(f.bankAccountId) || !(await trx.selectFrom('treasury_account').select('id').where('id', '=', f.bankAccountId).executeTakeFirst())) throw notFound('Compte de trésorerie');
      } else if (x.cash > 0) throw badRequest('Choisissez le compte bancaire qui reçoit les fonds.', undefined, 'bank_required');
      const row = {
        legal_form: f.legalForm, formation_date: f.date, capital: f.capital, nature: JSON.stringify(f.nature), cash_paid: f.cashPaid, deposit: f.deposit,
        bank_account_id: f.bankAccountId, updated_by: t.ctx.userId, updated_at: new Date(),
      };
      await trx.insertInto('company_formation').values({ company_id: t.companyId, ...row }).onConflict((oc) => oc.column('company_id').doUpdateSet(row)).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.formation_saved', entityType: 'company', entityId: t.companyId, data: { legalForm: f.legalForm, capital: f.capital } });
      return { ok: true };
    });
  }

  async pass(t: TenantInfo, key: StepKey, input: { date: string; amount?: number; accountId?: string | null; fees?: { account: string; label: string; amount: number }[] }) {
    if (input.date > today()) throw badRequest('La date ne peut pas être dans le futur.', undefined, 'future_date');
    return this.db.tenant(t.ctx, async (trx) => {
      await trx.selectFrom('company').select('id').where('id', '=', t.companyId).forUpdate().execute();
      const { formation: f, steps } = await this.load(trx);
      if (!f) throw badRequest('Enregistrez d’abord la fiche de constitution.', undefined, 'formation_missing');
      const blocked = this.blocker(f, steps, key);
      if (blocked) throw conflict(blocked, 'step_unavailable');
      const x = this.figures(f, steps);
      let amount = 0;
      if (key === 'balance_call' || key === 'balance_payment') {
        const max = key === 'balance_call' ? x.remainingToCall : x.calledUnpaid;
        amount = round(input.amount ?? max);
        if (amount <= 0 || amount > max) throw badRequest(`Montant attendu entre 1 et ${fmt(max)} FCFA.`, undefined, 'invalid_amount');
      }
      if (key === 'fees') {
        const fees = (input.fees ?? []).filter((l) => l.amount > 0);
        if (!fees.length) throw badRequest('Indiquez au moins un frais.', undefined, 'fees_required');
        if (fees.some((l) => !l.account.startsWith('6'))) throw badRequest('Les frais de constitution sont des charges (classe 6).', undefined, 'fees_account');
        amount = sum(fees.map((l) => l.amount));
      }
      const ops = this.ops(f, steps, key, { amount, fees: input.fees, accountId: input.accountId });
      const entryIds: string[] = [], movementIds: string[] = [];
      for (const o of ops) {
        if (o.kind === 'entry') {
          const e = await this.accounting.postEntry(trx, t, { journal: o.journal, date: input.date, label: o.label, reference: 'Constitution', sourceType: 'formation', sourceId: null, lines: o.lines });
          entryIds.push(e.id);
        } else {
          if (!o.accountId) throw badRequest('Choisissez le compte de trésorerie.', undefined, 'bank_required');
          const m = await this.treasury.record(trx, t, { accountId: o.accountId, date: input.date, direction: o.direction, amount: o.amount, category: o.category, label: o.label,
            sourceType: 'formation', reference: 'Constitution', counterpart: o.counterpart });
          movementIds.push(m.id);
        }
      }
      if (!['fees', 'balance_call', 'balance_payment'].includes(key)) amount = sum(ops.flatMap((o) => (o.kind === 'entry' ? o.lines.map((l) => l.debit ?? 0) : [o.amount])));
      const step = await trx.insertInto('company_formation_step').values({
        company_id: t.companyId, step: key, date: input.date, amount, data: JSON.stringify(key === 'fees' ? { fees: input.fees, accountId: input.accountId ?? f.bankAccountId } : {}),
        entry_ids: entryIds, movement_ids: movementIds, created_by: t.ctx.userId,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.formation_step', entityType: 'company', entityId: t.companyId, data: { step: key, amount } });
      return { id: step.id };
    });
  }

  /** Annule une étape (la dernière, ou un frais) : contre-passation de ses écritures et de ses mouvements. */
  async cancel(t: TenantInfo, id: string) {
    if (!isUuid(id)) throw notFound('Étape');
    return this.db.tenant(t.ctx, async (trx) => {
      await trx.selectFrom('company').select('id').where('id', '=', t.companyId).forUpdate().execute();
      const { steps } = await this.load(trx);
      const s = steps.find((x) => x.id === id);
      if (!s) throw notFound('Étape');
      const last = [...steps].reverse().find((x) => x.step !== 'fees');
      if (s.step !== 'fees' && last?.id !== s.id) throw conflict('Annulez d’abord les étapes passées après celle-ci.', 'not_last_step');
      const reason = 'Annulation d’une étape de constitution';
      for (const mid of [...s.movementIds].reverse()) await this.treasury.reverseIn(trx, t, { id: mid, transfer_id: null }, reason);
      for (const eid of [...s.entryIds].reverse()) {
        const e = await trx.selectFrom('journal_entry').select(['id', 'journal_code', 'number', 'date', 'reversed_by']).where('id', '=', eid).forUpdate().executeTakeFirstOrThrow();
        if (!e.reversed_by) await this.accounting.reverseAtOwnDate(trx, t, e, reason);
      }
      await trx.updateTable('company_formation_step').set({ cancelled_at: new Date(), cancelled_by: t.ctx.userId }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.formation_step_cancelled', entityType: 'company', entityId: t.companyId, data: { step: s.step, amount: s.amount } });
      return { ok: true };
    });
  }
}
