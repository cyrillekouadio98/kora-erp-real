import { Injectable } from '@nestjs/common';
import { badRequest, conflict } from '../../common/errors';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { StockService } from '../stock/stock.service';
import { AccountingService } from './accounting.service';

const round = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const starts = (code: string, prefixes: string[]) => prefixes.some((p) => code.startsWith(p));
const isManagement = (code: string) => /^[678]/.test(code);

/**
 * Rubriques du bilan (présentation simplifiée du système normal SYSCOHADA révisé).
 * Les comptes de tiers (classe 4) et de trésorerie (classe 5) vont à l'actif ou au passif selon le sens de leur solde.
 */
const ASSETS = [
  { key: 'intangible', label: 'Immobilisations incorporelles', gross: ['21'], depreciation: ['281', '291'] },
  { key: 'tangible', label: 'Immobilisations corporelles', gross: ['22', '23', '24'], depreciation: ['282', '283', '284', '292', '293', '294'] },
  { key: 'advances_fixed', label: 'Avances et acomptes versés sur immobilisations', gross: ['25'], depreciation: ['295'] },
  { key: 'financial', label: 'Immobilisations financières', gross: ['26', '27'], depreciation: ['296', '297'] },
  { key: 'stocks', label: 'Stocks et encours', gross: ['31', '32', '33', '34', '35', '36', '37', '38'], depreciation: ['39'] },
];
const SECTIONS = { fixed: 'Actif immobilisé', current: 'Actif circulant', cashAssets: 'Trésorerie — actif', equity: 'Capitaux propres et ressources assimilées',
  debts: 'Dettes financières et ressources assimilées', currentLiabilities: 'Passif circulant', cashLiabilities: 'Trésorerie — passif' };

/** Soldes significatifs de gestion SYSCOHADA : chaque solde se déduit du précédent. */
const SIG_BLOCKS: { key: string; label: string; plus?: string[]; minus?: string[]; from?: string }[] = [
  { key: 'commercialMargin', label: 'Marge commerciale', plus: ['701'], minus: ['601', '6031'] },
  { key: 'revenue', label: "Chiffre d'affaires", plus: ['70'] },
  { key: 'addedValue', label: 'Valeur ajoutée', from: 'revenue', plus: ['71', '72', '73', '75'], minus: ['60', '61', '62', '63', '64', '65'] },
  { key: 'ebitda', label: "Excédent brut d'exploitation", from: 'addedValue', minus: ['66'] },
  { key: 'operatingResult', label: "Résultat d'exploitation", from: 'ebitda', plus: ['781', '791', '798', '799'], minus: ['681', '691'] },
  { key: 'financialResult', label: 'Résultat financier', plus: ['77', '787', '797'], minus: ['67', '687', '697'] },
  { key: 'ordinaryResult', label: 'Résultat des activités ordinaires', from: 'operatingResult' },
  { key: 'exceptionalResult', label: 'Résultat hors activités ordinaires', plus: ['82', '84', '86', '88'], minus: ['81', '83', '85'] },
  { key: 'netResult', label: 'Résultat net', from: 'ordinaryResult', minus: ['87', '89'] },
];

@Injectable()
export class FinancialService {
  constructor(private readonly db: DatabaseService, private readonly accounting: AccountingService, private readonly stock: StockService, private readonly audit: AuditService) {}

  /** Solde (débit − crédit) de chaque compte, écritures validées, sur une période. */
  private async balances(trx: TenantTrx, to: string, from?: string) {
    const rows = await trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
      .select((eb) => ['l.account_code as code', eb.fn.sum<string>('l.debit').as('d'), eb.fn.sum<string>('l.credit').as('c')])
      .where('e.status', '=', 'posted').where('e.date', '<=', to).$if(!!from, (q) => q.where('e.date', '>=', from!)).groupBy('l.account_code').execute();
    return new Map(rows.map((r) => [r.code, round(Number(r.d ?? 0) - Number(r.c ?? 0))]));
  }

  private async names(trx: TenantTrx) {
    return new Map((await trx.selectFrom('ledger_account').select(['code', 'name']).execute()).map((a) => [a.code, a.name]));
  }

  // ------------------------------------------------------------------ bilan
  async balanceSheet(t: TenantInfo, date: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const bal = await this.balances(trx, date);
      const names = await this.names(trx);
      const yearStart = `${date.slice(0, 4)}-01-01`;
      const current = await this.balances(trx, date, yearStart);
      const detail = (codes: string[], sign: 1 | -1) => codes.map((c) => ({ code: c, name: names.get(c) ?? '', amount: round(sign * bal.get(c)!) })).filter((x) => x.amount);
      const codes = [...bal.keys()].sort();
      const sum = (cs: string[], sign: 1 | -1) => round(cs.reduce((s, c) => s + sign * bal.get(c)!, 0));

      // Actif immobilisé et stocks : brut, amortissements et dépréciations, net
      const fixed = ASSETS.map((r) => {
        const g = codes.filter((c) => starts(c, r.gross));
        const d = codes.filter((c) => starts(c, r.depreciation));
        const gross = sum(g, 1), depreciation = sum(d, -1);
        return { key: r.key, label: r.label, gross, depreciation, net: round(gross - depreciation), accounts: [...detail(g, 1), ...detail(d, 1)] };
      });
      // Tiers et trésorerie selon le sens du solde
      const debit = (pred: (c: string) => boolean) => codes.filter((c) => pred(c) && bal.get(c)! > 0);
      const credit = (pred: (c: string) => boolean) => codes.filter((c) => pred(c) && bal.get(c)! < 0);
      const tier = (c: string) => c.startsWith('4');
      const line = (key: string, label: string, cs: string[], sign: 1 | -1) => ({ key, label, net: sum(cs, sign), accounts: detail(cs, sign) });
      const receivables = [
        line('supplier_advances', 'Fournisseurs, avances versées', debit((c) => c.startsWith('409')), 1),
        line('customers', 'Clients', debit((c) => c.startsWith('41')), 1),
        line('other_receivables', 'Autres créances', debit((c) => tier(c) && !c.startsWith('409') && !c.startsWith('41')), 1),
      ];
      const cashAssets = line('cash', 'Banques, caisses, monnaie électronique', debit((c) => c.startsWith('5')), 1);

      // Capitaux propres : le résultat comprend les comptes de gestion non encore soldés par une clôture
      const mgmtBefore = codes.filter((c) => isManagement(c));
      const currentResult = round(-[...current.entries()].filter(([c]) => isManagement(c)).reduce((s, [, v]) => s + v, 0));
      const unclosedPrevious = round(-sum(mgmtBefore, 1) - currentResult);
      const equity = [
        line('capital', 'Capital et compte de l’exploitant', codes.filter((c) => c.startsWith('10')), -1),
        line('reserves', 'Réserves', codes.filter((c) => c.startsWith('11')), -1),
        line('retained', 'Report à nouveau', codes.filter((c) => c.startsWith('12')), -1),
        line('pending_results', 'Résultats en instance d’affectation', codes.filter((c) => c.startsWith('13')), -1),
        ...(unclosedPrevious ? [{ key: 'unclosed', label: 'Résultat d’exercices antérieurs non clôturés', net: unclosedPrevious, accounts: [] }] : []),
        { key: 'current_result', label: `Résultat de l’exercice ${date.slice(0, 4)} (au ${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)})`, net: currentResult, accounts: [] },
        line('grants', 'Subventions et provisions réglementées', codes.filter((c) => starts(c, ['14', '15'])), -1),
      ];
      const debts = [line('borrowings', 'Emprunts et dettes financières', codes.filter((c) => starts(c, ['16', '17', '18', '19'])), -1)];
      const currentLiabilities = [
        line('customer_advances', 'Clients, avances reçues', credit((c) => c.startsWith('41')), -1),
        line('suppliers', 'Fournisseurs d’exploitation', credit((c) => c.startsWith('40')), -1),
        line('tax_social', 'Dettes fiscales et sociales', credit((c) => starts(c, ['42', '43', '44'])), -1),
        line('other_debts', 'Autres dettes', credit((c) => tier(c) && !starts(c, ['40', '41', '42', '43', '44'])), -1),
      ];
      const cashLiabilities = line('overdrafts', 'Banques, découverts et crédits de trésorerie', credit((c) => c.startsWith('5')), -1);

      const total = (rows: { net: number }[]) => round(rows.reduce((s, r) => s + r.net, 0));
      const totalAssets = round(total(fixed) + total(receivables) + cashAssets.net);
      const totalLiabilities = round(total(equity) + total(debts) + total(currentLiabilities) + cashLiabilities.net);
      return {
        date, currency: 'XOF',
        assets: [
          { section: SECTIONS.fixed, rows: fixed.filter((r) => r.key !== 'stocks'), total: total(fixed.filter((r) => r.key !== 'stocks')) },
          { section: SECTIONS.current, rows: [fixed.find((r) => r.key === 'stocks')!, ...receivables], total: round(fixed.find((r) => r.key === 'stocks')!.net + total(receivables)) },
          { section: SECTIONS.cashAssets, rows: [cashAssets], total: cashAssets.net },
        ],
        liabilities: [
          { section: SECTIONS.equity, rows: equity, total: total(equity) },
          { section: SECTIONS.debts, rows: debts, total: total(debts) },
          { section: SECTIONS.currentLiabilities, rows: currentLiabilities, total: total(currentLiabilities) },
          { section: SECTIONS.cashLiabilities, rows: [cashLiabilities], total: cashLiabilities.net },
        ],
        totalAssets, totalLiabilities, balanced: totalAssets === totalLiabilities,
      };
    });
  }

  // ------------------------------------------------------------------ soldes de gestion
  async managementBalances(t: TenantInfo, f: { from: string; to: string }) {
    return this.db.tenant(t.ctx, async (trx) => {
      // Les écritures de clôture sont exclues : elles soldent les comptes de gestion sans être de l'activité.
      const rows = await trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
        .select((eb) => ['l.account_code as code', eb.fn.sum<string>('l.debit').as('d'), eb.fn.sum<string>('l.credit').as('c')])
        .where('e.status', '=', 'posted').where('e.source_type', '!=', 'year_closing').where('e.date', '>=', f.from).where('e.date', '<=', f.to)
        .where((eb) => eb.or([eb('l.account_code', 'like', '6%'), eb('l.account_code', 'like', '7%'), eb('l.account_code', 'like', '8%')]))
        .groupBy('l.account_code').execute();
      // Produits en positif (crédit − débit), charges en positif (débit − crédit)
      const amount = (prefixes: string[], kind: 'income' | 'charge') => round(rows.filter((r) => starts(r.code, prefixes))
        .reduce((s, r) => s + (kind === 'income' ? Number(r.c) - Number(r.d) : Number(r.d) - Number(r.c)), 0));
      const values: Record<string, number> = {};
      const lines = SIG_BLOCKS.map((b) => {
        const base = b.from ? values[b.from] : 0;
        const plus = b.plus ? amount(b.plus, 'income') : 0;
        const minus = b.minus ? amount(b.minus, 'charge') : 0;
        let value = round(base + plus - minus);
        if (b.key === 'ordinaryResult') value = round(values.operatingResult + values.financialResult);
        if (b.key === 'netResult') value = round(values.ordinaryResult + values.exceptionalResult - minus);
        values[b.key] = value;
        return { key: b.key, label: b.label, value, ...(b.plus ? { plus } : {}), ...(b.minus ? { minus } : {}) };
      });
      return { from: f.from, to: f.to, lines, netResult: values.netResult };
    });
  }

  // ------------------------------------------------------------------ clôture d'exercice
  private async checklistIn(trx: TenantTrx, year: number) {
    const start = `${year}-01-01`, end = `${year}-12-31`;
    const closed = await trx.selectFrom('fiscal_year_closing').selectAll().where('year', '=', year).executeTakeFirst();
    const blocking: string[] = [];
    const warnings: string[] = [];
    if (end >= today()) blocking.push(`L'exercice ${year} n'est pas terminé (il se termine le 31/12/${year}).`);
    const previous = await trx.selectFrom('fiscal_year_closing').select('year').where('year', '=', year - 1).executeTakeFirst();
    const previousActivity = await trx.selectFrom('journal_entry').select('id').where('status', '=', 'posted').where('date', '<', start).where('date', '>=', `${year - 1}-01-01`).executeTakeFirst();
    if (!previous && previousActivity) blocking.push(`L'exercice ${year - 1} n'est pas clôturé : les exercices se clôturent dans l'ordre.`);
    const pending = (await this.accounting.pending(trx)).filter((p) => p.date <= end);
    if (pending.length) blocking.push(`${pending.length} opération(s) de l'exercice ne sont pas comptabilisées : lancez la comptabilisation.`);
    const drafts = await trx.selectFrom('journal_entry').select('id').where('status', '=', 'draft').where('date', '<=', end).execute();
    if (drafts.length) blocking.push(`${drafts.length} écriture(s) en brouillon datées de l'exercice : validez-les ou supprimez-les.`);

    const bal = await this.balances(trx, end);
    const totalDebitCredit = [...bal.values()].reduce((s, v) => s + v, 0);
    if (round(totalDebitCredit) !== 0) blocking.push('La balance n’est pas équilibrée.');
    const sumPrefix = (p: string) => round([...bal.entries()].filter(([c]) => c.startsWith(p)).reduce((s, [, v]) => s + v, 0));
    if (sumPrefix('471')) warnings.push(`Le compte d'attente 471 n'est pas soldé (${sumPrefix('471').toLocaleString('fr-FR')} FCFA) : régularisez-le avec votre expert-comptable.`);
    if (sumPrefix('585')) warnings.push(`Le compte de virements internes 585 n'est pas soldé (${sumPrefix('585').toLocaleString('fr-FR')} FCFA) : un virement n'a qu'une de ses deux jambes.`);
    const stockValue = await this.stock.valueAt(trx, end);
    if (round(stockValue - sumPrefix('31')) !== 0) {
      warnings.push(`Le compte de stock 31 (${sumPrefix('31').toLocaleString('fr-FR')} FCFA) ne correspond pas à la valeur du stock au 31/12 (${stockValue.toLocaleString('fr-FR')} FCFA) : comptabilisez la variation de stock à cette date.`);
    }
    const mgmt = await this.balances(trx, end, start);
    const result = round(-[...mgmt.entries()].filter(([c]) => isManagement(c)).reduce((s, [, v]) => s + v, 0));
    return { year, start, end, closed: closed ? { result: Number(closed.result), closedAt: closed.closed_at, warnings: closed.warnings } : null, blocking, warnings, result };
  }

  async checklist(t: TenantInfo, year: number) {
    return this.db.tenant(t.ctx, (trx) => this.checklistIn(trx, year));
  }

  async years(t: TenantInfo) {
    return this.db.tenant(t.ctx, async (trx) => {
      const first = await trx.selectFrom('journal_entry').select('date').where('status', '=', 'posted').orderBy('date').limit(1).executeTakeFirst();
      const closings = await trx.selectFrom('fiscal_year_closing').select(['year', 'result', 'closed_at as closedAt']).execute();
      const from = first ? Number(first.date.slice(0, 4)) : Number(today().slice(0, 4));
      const out = [];
      for (let y = Number(today().slice(0, 4)); y >= from; y--) {
        const c = closings.find((x) => x.year === y);
        out.push({ year: y, closed: !!c, result: c ? Number(c.result) : null, closedAt: c?.closedAt ?? null });
      }
      return out;
    });
  }

  /**
   * Clôture : écriture de détermination du résultat au 31 décembre (comptes 6, 7 et 8 soldés
   * contre 131 bénéfice ou 139 perte), puis verrouillage de l'exercice. Irréversible.
   */
  async close(t: TenantInfo, year: number, acknowledgeWarnings: boolean) {
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await this.checklistIn(trx, year);
      if (c.closed) throw conflict(`L'exercice ${year} est déjà clôturé.`, 'already_closed');
      if (c.blocking.length) throw conflict(`Clôture impossible : ${c.blocking.join(' ')}`, 'closing_blocked');
      if (c.warnings.length && !acknowledgeWarnings) throw conflict(`Points à vérifier avant la clôture : ${c.warnings.join(' ')}`, 'warnings_not_acknowledged');

      const mgmt = await this.balances(trx, c.end, c.start);
      const label = `Détermination du résultat de l'exercice ${year}`;
      const lines = [...mgmt.entries()].filter(([code, v]) => isManagement(code) && v)
        .map(([code, v]) => ({ account: code, label, ...(v > 0 ? { credit: v } : { debit: -v }) }));
      let entryId: string | null = null;
      if (lines.length) {
        lines.push(c.result >= 0 ? { account: '131', label, credit: c.result } : { account: '139', label, debit: -c.result });
        entryId = (await this.accounting.postEntry(trx, t, { journal: 'OD', date: c.end, label, reference: `CLOTURE-${year}`, sourceType: 'year_closing', sourceId: null, lines })).id;
      }
      const company = await trx.selectFrom('company').select('accounting_locked_until').where('id', '=', t.companyId).executeTakeFirstOrThrow();
      if (!company.accounting_locked_until || company.accounting_locked_until < c.end) {
        await trx.updateTable('company').set({ accounting_locked_until: c.end }).where('id', '=', t.companyId).execute();
      }
      await trx.insertInto('fiscal_year_closing').values({ company_id: t.companyId, year, result: c.result, entry_id: entryId, warnings: JSON.stringify(c.warnings), closed_by: t.ctx.userId }).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'accounting.year_closed', entityType: 'fiscal_year', entityId: String(year), data: { result: c.result, warnings: c.warnings } });
      return { year, result: c.result, lockedUntil: c.end };
    });
  }

  assertYear(year: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Exercice invalide.', undefined, 'invalid_year');
  }
}
