import { Injectable } from '@nestjs/common';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService, TenantTrx } from '../../db/database.service';

const round = (n: number) => Math.round(n * 100) / 100;
const split = (v: number) => ({ debit: round(Math.max(v, 0)), credit: round(Math.max(-v, 0)) });
const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/** Classes du plan SYSCOHADA révisé, pour les sous-totaux de la balance. */
export const CLASSES: Record<string, string> = {
  '1': 'Comptes de ressources durables', '2': "Comptes d'actif immobilisé", '3': 'Comptes de stocks', '4': 'Comptes de tiers', '5': 'Comptes de trésorerie',
  '6': 'Comptes de charges des activités ordinaires', '7': 'Comptes de produits des activités ordinaires', '8': 'Comptes des autres charges et des autres produits', '9': 'Comptes analytiques',
};
/** Racines des comptes collectifs : 41 clients, 40 fournisseurs (avec leurs sous-comptes). */
const ROOTS = { customer: '41', supplier: '40' } as const;

export interface BalanceFilter { from?: string; to?: string; accountFrom?: string; accountTo?: string; withClosing?: boolean; compareFrom?: string; compareTo?: string }
interface Sums { priorD: number; priorC: number; d: number; c: number }

/**
 * États de balance (présentations usuelles des logiciels comptables) :
 * - balance des comptes en 4, 6 ou 8 colonnes et balance développée (comparaison avec une autre période),
 * - balance des tiers (un solde par client, fournisseur ou autre tiers),
 * - balance âgée des clients ou des fournisseurs, par tranche de retard d'après la date d'échéance.
 */
@Injectable()
export class BalancesService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Cumuls par compte : mouvements antérieurs à « from » (toutes écritures, donc les exercices clôturés s'annulent)
   * et mouvements de la période. L'écriture de détermination du résultat est écartée de la période sauf demande :
   * la balance montre alors les charges et produits de l'exercice même après la clôture.
   */
  private async sums(trx: TenantTrx, f: { from?: string; to?: string; withClosing?: boolean; accountFrom?: string; accountTo?: string }) {
    const rows = await trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
      .select((eb) => ['l.account_code as account',
        eb.fn.sum<string>(f.from ? eb.case().when('e.date', '<', f.from).then(eb.ref('l.debit')).else(0).end() : eb.lit(0)).as('priorD'),
        eb.fn.sum<string>(f.from ? eb.case().when('e.date', '<', f.from).then(eb.ref('l.credit')).else(0).end() : eb.lit(0)).as('priorC'),
        eb.fn.sum<string>(eb.case().when(this.inPeriod(eb, f)).then(eb.ref('l.debit')).else(0).end()).as('d'),
        eb.fn.sum<string>(eb.case().when(this.inPeriod(eb, f)).then(eb.ref('l.credit')).else(0).end()).as('c')])
      .where('e.status', '=', 'posted').$if(!!f.to, (q) => q.where('e.date', '<=', f.to!))
      .$if(!!f.accountFrom, (q) => q.where('l.account_code', '>=', f.accountFrom!.padEnd(6, '0')))
      .$if(!!f.accountTo, (q) => q.where('l.account_code', '<=', f.accountTo!.padEnd(6, '9')))
      .groupBy('l.account_code').execute();
    return new Map<string, Sums>(rows.map((r) => [r.account, { priorD: Number(r.priorD ?? 0), priorC: Number(r.priorC ?? 0), d: Number(r.d ?? 0), c: Number(r.c ?? 0) }]));
  }

  private inPeriod(eb: any, f: { from?: string; withClosing?: boolean }) {
    const conds = [];
    if (f.from) conds.push(eb('e.date', '>=', f.from));
    if (!f.withClosing) conds.push(eb('e.source_type', '!=', 'year_closing'));
    return conds.length ? eb.and(conds) : eb.lit(true);
  }

  private async names(trx: TenantTrx) {
    return new Map((await trx.selectFrom('ledger_account').select(['code', 'name']).execute()).map((a) => [a.code, a.name]));
  }

  /**
   * Balance des comptes. Chaque ligne porte toutes les colonnes ; l'interface choisit la présentation :
   * 4 colonnes (mouvements, soldes), 6 colonnes (mouvements antérieurs, mouvements, soldes cumulés),
   * 8 colonnes (+ soldes de la période), développée (+ solde de la période comparée).
   */
  async accountBalance(t: TenantInfo, f: BalanceFilter) {
    return this.db.tenant(t.ctx, async (trx) => {
      const names = await this.names(trx);
      const cur = await this.sums(trx, f);
      const compare = f.compareTo ? await this.sums(trx, { ...f, from: f.compareFrom, to: f.compareTo }) : null;
      const codes = [...new Set([...cur.keys(), ...(compare?.keys() ?? [])])].sort();
      const accounts = codes.map((account) => {
        const s = cur.get(account) ?? { priorD: 0, priorC: 0, d: 0, c: 0 };
        const prior = s.priorD - s.priorC, period = s.d - s.c, closing = prior + period;
        const o = split(prior), p = split(period), cl = split(closing);
        const cs = compare?.get(account);
        return {
          account, name: names.get(account) ?? '', class: account[0],
          priorDebit: round(s.priorD), priorCredit: round(s.priorC), openingDebit: o.debit, openingCredit: o.credit,
          debit: round(s.d), credit: round(s.c), periodDebit: p.debit, periodCredit: p.credit, closingDebit: cl.debit, closingCredit: cl.credit,
          compare: cs ? round(cs.priorD - cs.priorC + cs.d - cs.c) : compare ? 0 : null,
        };
      }).filter((a) => a.priorDebit || a.priorCredit || a.debit || a.credit || a.compare);
      type Row = (typeof accounts)[number];
      const KEYS = ['priorDebit', 'priorCredit', 'openingDebit', 'openingCredit', 'debit', 'credit', 'periodDebit', 'periodCredit', 'closingDebit', 'closingCredit', 'compare'] as const;
      // Les soldes d'un groupe se recalculent sur le solde net du groupe, comme sur une balance imprimée.
      const total = (rows: Row[]) => {
        const sum = (k: (typeof KEYS)[number]) => round(rows.reduce((s, a) => s + Number(a[k] ?? 0), 0));
        const net = (d: number, c: number) => split(d - c);
        const t = Object.fromEntries(KEYS.map((k) => [k, sum(k)])) as Record<(typeof KEYS)[number], number>;
        const o = net(t.openingDebit, t.openingCredit), p = net(t.periodDebit, t.periodCredit), cl = net(t.closingDebit, t.closingCredit);
        return { ...t, netOpeningDebit: o.debit, netOpeningCredit: o.credit, netPeriodDebit: p.debit, netPeriodCredit: p.credit, netClosingDebit: cl.debit, netClosingCredit: cl.credit };
      };
      const classes = [...new Set(accounts.map((a) => a.class))].map((c) => ({ class: c, label: CLASSES[c] ?? `Classe ${c}`, ...total(accounts.filter((a) => a.class === c)) }));
      const totals = total(accounts);
      return {
        from: f.from ?? null, to: f.to ?? null, compareFrom: f.compareFrom ?? null, compareTo: f.compareTo ?? null,
        accounts, classes,
        groups: { balanceSheet: total(accounts.filter((a) => a.class <= '5')), management: total(accounts.filter((a) => a.class >= '6')) },
        totals,
        balanced: totals.debit === totals.credit && totals.priorDebit === totals.priorCredit && totals.closingDebit === totals.closingCredit,
      };
    });
  }

  /** Lignes des comptes de tiers jusqu'à une date : celles qui portent un tiers, et celles des comptes collectifs 40/41. */
  private tiersLines(trx: TenantTrx, f: { to?: string; kind: 'all' | 'customer' | 'supplier' }) {
    return trx.selectFrom('journal_line as l').innerJoin('journal_entry as e', (j) => j.onRef('e.id', '=', 'l.entry_id').onRef('e.company_id', '=', 'l.company_id'))
      .where('e.status', '=', 'posted').$if(!!f.to, (q) => q.where('e.date', '<=', f.to!))
      .where((eb) => f.kind === 'all'
        ? eb.or([eb('l.contact_id', 'is not', null), eb('l.account_code', 'like', `${ROOTS.customer}%`), eb('l.account_code', 'like', `${ROOTS.supplier}%`)])
        : eb('l.account_code', 'like', `${ROOTS[f.kind]}%`));
  }

  private async contacts(trx: TenantTrx, ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((list.length ? await trx.selectFrom('contact').select(['id', 'code', 'name', 'kind']).where('id', 'in', list).execute() : []).map((c) => [c.id, c]));
  }

  /**
   * Balance des tiers : pour chaque tiers et chaque compte collectif, mouvements antérieurs, mouvements
   * de la période et solde. Les écritures d'un compte collectif sans tiers sont regroupées sur une ligne « Sans tiers ».
   */
  async thirdPartyBalance(t: TenantInfo, f: { from?: string; to?: string; kind: 'all' | 'customer' | 'supplier' }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.tiersLines(trx, f)
        .select((eb) => ['l.account_code as account', 'l.contact_id as contactId',
          eb.fn.sum<string>(f.from ? eb.case().when('e.date', '<', f.from).then(eb.ref('l.debit')).else(0).end() : eb.lit(0)).as('priorD'),
          eb.fn.sum<string>(f.from ? eb.case().when('e.date', '<', f.from).then(eb.ref('l.credit')).else(0).end() : eb.lit(0)).as('priorC'),
          eb.fn.sum<string>(f.from ? eb.case().when('e.date', '>=', f.from).then(eb.ref('l.debit')).else(0).end() : eb.ref('l.debit')).as('d'),
          eb.fn.sum<string>(f.from ? eb.case().when('e.date', '>=', f.from).then(eb.ref('l.credit')).else(0).end() : eb.ref('l.credit')).as('c')])
        .groupBy(['l.account_code', 'l.contact_id']).execute();
      const names = await this.names(trx);
      const contacts = await this.contacts(trx, rows.map((r) => r.contactId));
      const parties = rows.map((r) => {
        const c = r.contactId ? contacts.get(r.contactId) : undefined;
        const opening = Number(r.priorD ?? 0) - Number(r.priorC ?? 0);
        const debit = round(Number(r.d ?? 0)), credit = round(Number(r.c ?? 0));
        const closing = round(opening + debit - credit);
        return { account: r.account, accountName: names.get(r.account) ?? '', contactId: r.contactId, code: c?.code ?? null, name: c?.name ?? 'Sans tiers',
          openingDebit: split(opening).debit, openingCredit: split(opening).credit, debit, credit, closingDebit: split(closing).debit, closingCredit: split(closing).credit, balance: closing };
      }).filter((p) => p.openingDebit || p.openingCredit || p.debit || p.credit)
        .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0) || (a.contactId ? 0 : 1) - (b.contactId ? 0 : 1) || (a.code ?? '').localeCompare(b.code ?? '', 'fr') || a.name.localeCompare(b.name, 'fr'));
      const KEYS = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit', 'balance'] as const;
      const total = (list: typeof parties) => Object.fromEntries(KEYS.map((k) => [k, round(list.reduce((s, p) => s + p[k], 0))])) as Record<(typeof KEYS)[number], number>;
      const accounts = [...new Set(parties.map((p) => p.account))].map((account) => ({ account, name: names.get(account) ?? '', ...total(parties.filter((p) => p.account === account)) }));
      return { kind: f.kind, from: f.from ?? null, to: f.to ?? null, parties, accounts, totals: total(parties) };
    });
  }

  /**
   * Balance âgée au « date » : pour chaque tiers et chaque compte collectif, les règlements soldent d'abord
   * les pièces les plus anciennes ; le reste dû est classé selon le retard par rapport à la date d'échéance
   * de la facture (date de l'écriture à défaut). Un solde en faveur du tiers (avance, avoir) est « non échu ».
   * Montants positifs : ce que le client doit, ou ce qui est dû au fournisseur.
   */
  async agedBalance(t: TenantInfo, f: { date: string; kind: 'customer' | 'supplier'; steps: number[] }) {
    return this.db.tenant(t.ctx, async (trx) => {
      const rows = await this.tiersLines(trx, { to: f.date, kind: f.kind })
        .leftJoin('sales_document as sd', (j) => j.onRef('sd.company_id', '=', 'e.company_id').onRef('sd.id', '=', 'e.source_id').on('e.source_type', '=', 'sales_document'))
        .leftJoin('purchase_document as pd', (j) => j.onRef('pd.company_id', '=', 'e.company_id').onRef('pd.id', '=', 'e.source_id').on('e.source_type', '=', 'purchase_document'))
        .select(['l.account_code as account', 'l.contact_id as contactId', 'e.date', 'sd.due_date as salesDue', 'pd.due_date as purchaseDue', 'l.debit', 'l.credit'])
        .orderBy('e.date').orderBy('e.number').execute();
      const sign = f.kind === 'customer' ? 1 : -1;
      const steps = [...f.steps].sort((a, b) => a - b);
      const buckets = [{ key: 'notDue', label: 'Non échu' },
        ...steps.map((s, i) => ({ key: `b${i}`, label: `${i ? steps[i - 1] + 1 : 1} à ${s} jours` })), { key: `b${steps.length}`, label: `Plus de ${steps[steps.length - 1]} jours` }];
      const bucketOf = (late: number) => (late <= 0 ? 'notDue' : `b${steps.findIndex((s) => late <= s) === -1 ? steps.length : steps.findIndex((s) => late <= s)}`);

      const groups = new Map<string, { account: string; contactId: string | null; open: { due: string; amount: number }[]; credit: number }>();
      for (const r of rows) {
        const key = `${r.account}|${r.contactId ?? ''}`;
        const g = groups.get(key) ?? { account: r.account, contactId: r.contactId, open: [], credit: 0 };
        const v = sign * (Number(r.debit) - Number(r.credit));
        if (v > 0) g.open.push({ due: (r.salesDue ?? r.purchaseDue ?? r.date) as string, amount: v });
        else g.credit += -v;
        groups.set(key, g);
      }
      const names = await this.names(trx);
      const contacts = await this.contacts(trx, [...groups.values()].map((g) => g.contactId));
      const parties = [...groups.values()].map((g) => {
        // Les règlements soldent d'abord les pièces les plus anciennes (par échéance).
        let left = g.credit;
        const amounts: Record<string, number> = Object.fromEntries(buckets.map((b) => [b.key, 0]));
        for (const item of g.open.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))) {
          const used = Math.min(left, item.amount);
          left -= used;
          if (item.amount - used > 0) amounts[bucketOf(days(item.due, f.date))] += item.amount - used;
        }
        if (left > 0) amounts.notDue -= left;
        const c = g.contactId ? contacts.get(g.contactId) : undefined;
        const rounded = Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, round(v)]));
        return { account: g.account, accountName: names.get(g.account) ?? '', contactId: g.contactId, code: c?.code ?? null, name: c?.name ?? 'Sans tiers',
          balance: round(Object.values(amounts).reduce((s, v) => s + v, 0)), amounts: rounded };
      }).filter((p) => p.balance || Object.values(p.amounts).some((v) => v))
        .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0) || (a.contactId ? 0 : 1) - (b.contactId ? 0 : 1) || (a.code ?? '').localeCompare(b.code ?? '', 'fr'));
      const total = (list: typeof parties) => ({
        balance: round(list.reduce((s, p) => s + p.balance, 0)),
        amounts: Object.fromEntries(buckets.map((b) => [b.key, round(list.reduce((s, p) => s + p.amounts[b.key], 0))])),
      });
      const totals = total(parties);
      return {
        kind: f.kind, date: f.date, buckets, parties,
        accounts: [...new Set(parties.map((p) => p.account))].map((account) => ({ account, name: names.get(account) ?? '', ...total(parties.filter((p) => p.account === account)) })),
        totals: { ...totals, shares: Object.fromEntries(buckets.map((b) => [b.key, totals.balance ? round((totals.amounts[b.key] / totals.balance) * 10000) / 100 : 0])) },
      };
    });
  }
}
