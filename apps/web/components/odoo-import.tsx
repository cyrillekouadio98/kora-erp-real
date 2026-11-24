'use client';
import { api } from '@/lib/api';
import { Cell, simplify, toNumber } from '@/lib/import-files';
import { CONTACTS_IMPORT, PRODUCTS_IMPORT } from './import-configs';
import type { ImportConfig, ImportField, Rec } from './import';

/**
 * Reprise des données d'Odoo : les exports Excel d'Odoo (versions françaises et anglaises) sont lus par l'assistant d'import commun.
 * Toutes les reprises chiffrées passent par le compte d'attente 471000 : une fois les étapes terminées, son solde nul prouve
 * que le stock, les tiers et la balance repris s'accordent ; un écart montre ce qui manque.
 */
export const SUSPENSE = '471000';
const round2 = (n: number) => Math.round(n * 100) / 100;

/** « [REF-01] Huile 5 L » (affichage Odoo d'un article) → « Huile 5 L ». */
export const odooName = (raw: unknown) => String(raw ?? '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
/** Vrai / Faux d'un export Odoo. */
const truthy = (raw: Cell) => /^(vrai|true|oui|yes|1|x)$/i.test(String(raw ?? '').trim());

function finder<T extends { id: string; code?: string | null; name: string; taxId?: string | null }>(list: T[]) {
  const map = new Map<string, T>();
  for (const x of list) {
    if (x.taxId) map.set(`t:${simplify(x.taxId)}`, x);
    map.set(`n:${simplify(x.name)}`, x);
    if (x.code) map.set(`c:${simplify(x.code)}`, x);
  }
  return (raw: unknown) => {
    const s = simplify(odooName(raw));
    // Odoo affiche un contact rattaché sous la forme « Société, Personne » : la société porte le solde.
    const parent = simplify(String(raw ?? '').split(',')[0]);
    return s ? map.get(`c:${s}`) ?? map.get(`n:${s}`) ?? map.get(`t:${s}`) ?? map.get(`n:${parent}`) : undefined;
  };
}

/** Taxes Odoo (« TVA 18% », « 18% », « Exonéré ») → taux de Kora. */
export function odooVat(raw: Cell) {
  const s = String(raw ?? '');
  if (/exo|0\s*%/i.test(s) && !/18|9\s*%/.test(s)) return 0;
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*%?/);
  if (!m) throw new Error(`TVA : « ${raw} » non reconnue (18 %, 9 % ou 0 %)`);
  let n = toNumber(m[1]);
  if (n > 0 && n < 1) n = Math.round(n * 100);
  if (![18, 9, 0].includes(n)) throw new Error(`TVA : 18 %, 9 % ou 0 % (« ${raw} »)`);
  return n;
}

/** Numéro de compte Odoo (« 411100 Clients », « 41110000 ») → les chiffres du compte. */
export function odooAccount(raw: Cell) {
  const m = String(raw ?? '').replace(/\s/g, ' ').trim().match(/^(\d[\d ]*)/);
  const digits = m ? m[1].replace(/\s/g, '') : '';
  if (digits.length < 2) throw new Error(`Compte : numéro attendu (« ${raw} »)`);
  return digits;
}

/** Compte de Kora le plus proche : le compte à 6 chiffres s'il existe, sinon le compte parent existant (4111 → 411000…). */
export function nearestAccount(digits: string, accounts: Set<string>) {
  for (let n = Math.min(6, digits.length); n >= 2; n--) {
    const code = digits.slice(0, n).padEnd(6, '0');
    if (accounts.has(code)) return code;
  }
  return null;
}

/* ---------- 1. Contacts ---------- */

/** Conditions de paiement Odoo (« 30 jours », « 30 Days », « Paiement immédiat ») → nombre de jours. */
const paymentDays = (raw: Cell) => {
  if (/immediat|immediate/i.test(simplify(raw))) return 0;
  const m = String(raw).match(/(\d+)/);
  if (!m) throw new Error(`Délai de paiement : « ${raw} » non reconnu`);
  return Number(m[1]);
};

const contactAliases: Record<string, string[]> = {
  name: ['display name', 'nom affiche', 'name', 'nom complet'],
  phone: ['phone', 'telephone', 'mobile'],
  email: ['email', 'courriel'],
  taxId: ['n tva', 'numero de tva', 'tax id', 'vat', 'tva'],
  rccm: ['company id', 'numero d immatriculation', 'registre de commerce', 'company registry', 'n d immatriculation'],
  paymentTermsDays: ['conditions de paiement client', 'customer payment terms', 'payment terms', 'conditions de paiement'],
  address: ['street', 'rue', 'adresse'],
  city: ['city', 'ville'],
  notes: ['internal notes', 'notes internes', 'comment'],
};

export const ODOO_CONTACTS: ImportConfig = {
  ...CONTACTS_IMPORT,
  title: 'Odoo · Clients et fournisseurs',
  intro: <><p>Dans Odoo : <b>Contacts</b>, vue liste, cochez tout, <b>Action → Exporter</b> au format Excel avec les champs <i>Nom affiché, Est une société, Téléphone, Courriel, N° TVA, N° d'immatriculation, Rue, Ville, Conditions de paiement client</i>, et <i>Rang client / Rang fournisseur</i>.</p>
    <p>Pour une <b>entreprise</b>, Kora exige téléphone, e-mail, NCC (N° TVA d'Odoo), RCCM et délai de paiement : complétez les colonnes vides avec « Valeur si vide » (par exemple un délai de 30 jours) ou corrigez le fichier des lignes en erreur.</p></>,
  fields: [
    ...CONTACTS_IMPORT.fields.map((f): ImportField => {
      const extra = contactAliases[f.key] ?? [];
      if (f.key === 'legalType') return { ...f, aliases: [...(f.aliases ?? []), 'est une societe', 'is a company', 'company type', 'type de societe'],
        parse: (raw) => (truthy(raw) || /societe|company|entreprise/i.test(simplify(raw)) ? 'company' : /individu|personne|individual|person|faux|false|non|no|0/i.test(simplify(raw)) ? 'individual' : (() => { throw new Error(`Forme : « ${raw} » non reconnue`); })()) };
      if (f.key === 'paymentTermsDays') return { ...f, aliases: [...(f.aliases ?? []), ...extra], parse: paymentDays };
      if (f.key === 'kind') return f;
      return { ...f, aliases: [...extra, ...(f.aliases ?? [])] };
    }),
    { key: 'customerRank', label: 'Rang client (Odoo)', type: 'number', aliases: ['customer rank', 'rang client'] },
    { key: 'supplierRank', label: 'Rang fournisseur (Odoo)', type: 'number', aliases: ['supplier rank', 'rang fournisseur'] },
  ],
  check: (r, ctx, seen) => {
    // Les rangs d'Odoo disent si le partenaire a déjà été client, fournisseur ou les deux.
    if (r.customerRank !== undefined || r.supplierRank !== undefined) {
      const c = (r.customerRank ?? 0) > 0, s = (r.supplierRank ?? 0) > 0;
      if (c || s) r.kind = c && s ? 'both' : s ? 'supplier' : 'customer';
    }
    return CONTACTS_IMPORT.check!(r, ctx, seen);
  },
  template: { file: 'exemple-export-odoo-contacts.csv', rows: [
    ['Nom affiché', 'Est une société', 'Téléphone', 'Courriel', 'N° TVA', "N° d'immatriculation", 'Rue', 'Ville', 'Conditions de paiement client', 'Rang client', 'Rang fournisseur'],
    ['Maquis Chez Tantie', 'Vrai', '+225 07 00 00 00 00', 'contact@tantie.ci', '1234567A', 'CI-ABJ-2020-B-12345', 'Cocody Angré', 'Abidjan', '30 jours', 3, 0],
  ] },
};

/* ---------- 2. Articles, avec leur stock ---------- */

type ProductCtx = { exists: (r: unknown) => any };
export const ODOO_PRODUCTS: ImportConfig<ProductCtx> = {
  ...PRODUCTS_IMPORT,
  title: 'Odoo · Articles et stock',
  intro: <><p>Dans Odoo : <b>Inventaire → Produits</b> (ou Ventes → Produits), vue liste, <b>Action → Exporter</b> avec les champs <i>Nom, Référence interne, Code-barres, Type de produit, Unité de mesure, Prix de vente, Coût, Taxes à la vente</i> et <i>Quantité en stock</i>.</p>
    <p>Chaque article est créé avec un code Kora (ART-…) ; la référence Odoo est gardée dans sa description. Si la quantité en stock est renseignée, le <b>stock initial</b> est enregistré au coût Odoo, avec le compte d'attente {SUSPENSE} en contrepartie (contrôle final de la reprise). Indiquez la <b>date de reprise</b> dans « Valeur si vide » de la date du stock initial (aujourd'hui sinon).</p></>,
  fields: [
    { ...PRODUCTS_IMPORT.fields.find((f) => f.key === 'name')!, aliases: ['nom', 'name', 'nom du produit', 'product name', 'article', 'produit'] },
    { key: 'ref', label: 'Référence Odoo', aliases: ['reference interne', 'internal reference', 'default code', 'ref interne'] },
    { key: 'kind', label: 'Type', type: 'choice', default: 'good', aliases: ['type de produit', 'product type', 'type d article', 'detailed type'], choices: [
      { value: 'good', label: 'Bien', match: ['article stockable', 'stockable', 'storable product', 'consommable', 'consumable', 'biens', 'goods', 'produit', 'product', 'combo'] },
      { value: 'service', label: 'Service', match: ['services', 'prestation'] }] },
    { key: 'unit', label: 'Unité', aliases: ['unite de mesure', 'unit of measure', 'udm', 'uom'], parse: (raw) => String(raw).trim().replace(/^unit(e|é)s?$/i, 'unité').replace(/^units?$/i, 'unité').slice(0, 20) },
    { key: 'barcode', label: 'Code-barres', aliases: ['barcode', 'code barre', 'ean13'] },
    { key: 'salePrice', label: 'Prix de vente HT', type: 'number', required: true, aliases: ['prix de vente', 'sales price', 'list price', 'prix'] },
    { key: 'purchasePrice', label: 'Coût', type: 'number', aliases: ['cout', 'cost', 'standard price', 'prix de revient'] },
    { key: 'vatRate', label: 'TVA (%)', default: '18', aliases: ['taxes a la vente', 'customer taxes', 'taxes clients', 'taxes', 'tva'], parse: odooVat },
    { key: 'openingDate', label: 'Date du stock initial', type: 'date', aliases: ['date d ouverture', 'date de reprise'] },
    { key: 'quantity', label: 'Quantité en stock', type: 'number', aliases: ['quantite en stock', 'quantity on hand', 'qty available', 'quantite disponible', 'en stock', 'on hand'] },
    { key: 'description', label: 'Description', aliases: ['description de vente', 'sales description', 'description'] },
  ],
  check: (r, ctx, seen) => {
    if (r.quantity !== undefined && r.quantity < 0) return { error: 'Stock négatif dans Odoo : corrigez-le (inventaire) avant la reprise' };
    if (r.quantity && r.kind === 'service') return { error: 'Un service ne se stocke pas' };
    return PRODUCTS_IMPORT.check!(r, ctx, seen);
  },
  save: async ([r]) => {
    const description = [r.ref ? `Réf. Odoo : ${r.ref}` : '', r.description ?? ''].filter(Boolean).join('\n') || null;
    const body: Record<string, unknown> = { name: r.name, kind: r.kind ?? 'good', unit: r.unit, salePrice: r.salePrice, purchasePrice: r.purchasePrice ?? null, vatRate: r.vatRate ?? 18, description,
      barcode: r.barcode ? String(r.barcode).replace(/\s/g, '') : null };
    if (r.quantity > 0 && (r.kind ?? 'good') === 'good') body.openingStock = { quantity: r.quantity, unitCost: r.purchasePrice ?? 0, counterpart: SUSPENSE, ...(r.openingDate ? { date: r.openingDate } : {}) };
    const p = await api('/company/products', { body });
    return r.quantity > 0 ? `${p.code} · stock ${r.quantity.toLocaleString('fr-FR')}` : p.code;
  },
  after: <>Le stock initial apparaît dans Stocks ; sa valeur est passée au journal des à-nouveaux contre le compte {SUSPENSE}.</>,
  template: { file: 'exemple-export-odoo-articles.csv', rows: [
    ['Nom', 'Référence interne', 'Code-barres', 'Type de produit', 'Unité de mesure', 'Prix de vente', 'Coût', 'Taxes à la vente', 'Quantité en stock'],
    ['Huile végétale 5 L', 'HUI-5L', '6151234567890', 'Article stockable', 'Unités', 6000, 4000, 'TVA 18%', 24],
    ['Livraison Abidjan', '', '', 'Service', 'Unités', 2500, '', 'TVA 18%', ''],
  ] },
};

/* ---------- 3. Factures non soldées (créances clients et dettes fournisseurs) ---------- */

type OpenCtx = { contact: (r: unknown) => any; accounts: Set<string> };
const CHUNK = 150;
const chunks = <T,>(rows: T[]) => Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK));

export const ODOO_OPEN_INVOICES: ImportConfig<OpenCtx> = {
  title: 'Odoo · Factures non soldées', what: 'écritures', one: 'écriture', feminine: true,
  intro: <><p>Dans Odoo : <b>Comptabilité → Clients → Factures</b> (puis <b>Fournisseurs → Factures</b>), filtre <i>Non payées</i>, vue liste, <b>Action → Exporter</b> avec <i>Partenaire, Numéro, Date de facturation, Date d'échéance, Montant dû signé</i>. Importez les clients et les fournisseurs séparément en choisissant le côté ci-dessous.</p>
    <p>Chaque facture devient une ligne au compte 411000 (client) ou 401000 (fournisseur) rattachée au tiers, dans une écriture d'à-nouveaux <b>en brouillon</b> équilibrée par le compte {SUSPENSE}. Les règlements se saisissent ensuite en trésorerie sur le tiers. Un avoir client (montant négatif) passe au crédit ; vérifiez à part les avoirs fournisseurs.</p></>,
  fields: [
    { key: 'openingDate', label: "Date d'ouverture dans Kora", type: 'date', required: true, aliases: ['date d ouverture', 'date de reprise'] },
    { key: 'contact', label: 'Partenaire', required: true, aliases: ['partner', 'partenaire', 'client', 'fournisseur', 'customer', 'vendor', 'nom du partenaire'] },
    { key: 'number', label: 'Numéro', required: true, aliases: ['number', 'numero', 'name', 'n facture', 'reference'] },
    { key: 'dueDate', label: "Date d'échéance", type: 'date', aliases: ['due date', 'date d echeance', 'invoice date due', 'echeance'] },
    { key: 'amount', label: 'Montant dû', type: 'number', required: true, aliases: ['montant du signe', 'amount due signed', 'montant du', 'amount due', 'residual', 'reste a payer', 'montant residuel'] },
  ],
  settings: () => [{ key: 'side', label: 'Côté', default: 'customer', options: [{ value: 'customer', label: 'Factures clients (411000)' }, { value: 'supplier', label: 'Factures fournisseurs (401000)' }] }],
  load: async () => {
    const [contacts, accounts] = await Promise.all([api<any[]>('/company/contacts?archived=all'), api<any[]>('/company/accounting/accounts')]);
    return { contact: finder(contacts), accounts: new Set(accounts.filter((a) => !a.archivedAt).map((a) => a.code)) };
  },
  check: (r, ctx, seen) => {
    if (!r.amount) return { skip: 'Facture soldée' };
    const k = ctx.contact(r.contact);
    if (!k) return { error: `Partenaire « ${r.contact} » introuvable : importez d'abord les contacts` };
    r.contactId = k.id;
    const key = `${k.id}|${simplify(r.number)}`;
    if (seen.has(key)) return { skip: 'En double dans le fichier' };
    seen.add(key);
  },
  group: (rows) => chunks(rows),
  checkGroup: (g) => (new Set(g.map((r) => r.openingDate)).size > 1 ? "Une seule date d'ouverture par fichier" : undefined),
  save: async (g, _ctx, s) => {
    const supplier = s.side === 'supplier';
    const account = supplier ? '401000' : '411000';
    const lines = g.map((r) => {
      // Client : montant positif = créance (débit), négatif = avoir. Fournisseur : dette au crédit, quel que soit le signe donné par Odoo.
      const v = supplier ? -Math.abs(r.amount) : r.amount;
      const label = `${supplier ? 'Facture fournisseur' : 'Facture'} ${String(r.number).slice(0, 80)}${r.dueDate ? ` (échéance ${r.dueDate.split('-').reverse().join('/')})` : ''}`;
      return { account, label: label.slice(0, 200), debit: v > 0 ? round2(v) : 0, credit: v < 0 ? round2(-v) : 0, contactId: r.contactId };
    });
    const net = round2(lines.reduce((t, l) => t + l.debit - l.credit, 0));
    const label = supplier ? 'Reprise Odoo — dettes fournisseurs' : 'Reprise Odoo — créances clients';
    if (net) lines.push({ account: SUSPENSE, label, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0, contactId: null as any });
    await api('/company/accounting/entries', { body: { journal: 'AN', date: g[0].openingDate, label, reference: 'ODOO', lines } });
    return `${g.length} facture${g.length > 1 ? 's' : ''} en brouillon`;
  },
  after: <>Les écritures sont en brouillon dans Comptabilité → Écritures (journal AN) : vérifiez-les puis validez-les.</>,
  template: { file: 'exemple-export-odoo-factures.csv', rows: [
    ['Partenaire', 'Numéro', 'Date de facturation', "Date d'échéance", 'Montant dû signé'],
    ['Maquis Chez Tantie', 'FAC/2026/00112', '15/10/2026', '14/11/2026', 354000],
  ] },
};

/* ---------- 4. Balance : soldes des autres comptes ---------- */

type BalanceCtx = { accounts: Set<string> };
const RESULT = { profit: '131000', loss: '139000' };

export const ODOO_BALANCE: ImportConfig<BalanceCtx> = {
  title: 'Odoo · Soldes des comptes', what: 'écritures', one: 'écriture', feminine: true,
  intro: <><p>Dans Odoo : <b>Comptabilité → Configuration → Plan comptable</b>, vue liste, <b>Action → Exporter</b> avec <i>Code, Nom</i> et <i>Solde courant</i> (ou la <b>Balance générale</b> à la date de reprise, exportée en Excel, avec ses colonnes Débit et Crédit).</p>
    <p>Une écriture d'à-nouveaux <b>en brouillon</b> reprend les comptes de capitaux, d'immobilisations et de tiers. Sont écartés car repris par les autres étapes : les <b>stocks</b> (classe 3, étape Articles), les <b>clients et fournisseurs</b> (40 et 41, étape Factures) et la <b>trésorerie</b> (classe 5 : saisissez le solde de chaque caisse et banque dans Trésorerie avec la contrepartie {SUSPENSE}). Les charges et produits non clôturés sont regroupés en résultat ({RESULT.profit} ou {RESULT.loss}). Un compte absent de Kora est repris sur son compte parent.</p></>,
  fields: [
    { key: 'openingDate', label: "Date d'ouverture dans Kora", type: 'date', required: true, aliases: ['date d ouverture', 'date de reprise'] },
    { key: 'account', label: 'Compte', required: true, aliases: ['code', 'account', 'numero de compte', 'compte'], parse: odooAccount },
    { key: 'name', label: 'Intitulé', aliases: ['nom', 'name', 'libelle', 'intitule du compte'] },
    { key: 'balance', label: 'Solde (débit +)', type: 'number', aliases: ['solde courant', 'current balance', 'solde', 'balance', 'solde final'] },
    { key: 'debit', label: 'Débit', type: 'number', aliases: ['debit', 'total debit'] },
    { key: 'credit', label: 'Crédit', type: 'number', aliases: ['credit', 'total credit'] },
  ],
  load: async () => ({ accounts: new Set((await api<any[]>('/company/accounting/accounts')).filter((a) => !a.archivedAt).map((a) => a.code)) }),
  check: (r, ctx) => {
    const v = round2(r.balance ?? (r.debit ?? 0) - (r.credit ?? 0));
    if (!v) return { skip: 'Compte soldé' };
    const a: string = r.account;
    if (a.startsWith('3')) return { skip: 'Stock : repris par l’étape Articles' };
    if (a.startsWith('40') || a.startsWith('41')) return { skip: 'Clients ou fournisseurs : repris par l’étape Factures' };
    if (a.startsWith('5')) return { skip: 'Trésorerie : saisie dans Trésorerie' };
    if (a === '999999' || /^[6-8]/.test(a)) { r.target = 'result'; r.value = v; return; }
    if (a.startsWith('9')) return { skip: 'Compte analytique' };
    if (a.startsWith(SUSPENSE.slice(0, 3))) return { skip: 'Compte d’attente : sert au contrôle de la reprise' };
    const target = nearestAccount(a, ctx.accounts);
    if (!target) return { error: `Compte ${a} : aucun compte proche dans le plan de Kora (ajoutez-le dans « Plan comptable »)` };
    r.target = target; r.value = v;
  },
  group: (rows) => chunks(rows),
  checkGroup: (g) => (new Set(g.map((r) => r.openingDate)).size > 1 ? "Une seule date d'ouverture par fichier" : undefined),
  save: async (g) => {
    const lines: { account: string; label: string; debit: number; credit: number }[] = [];
    let result = 0;
    for (const r of g) {
      if (r.target === 'result') { result = round2(result + r.value); continue; }
      const label = `Reprise Odoo — ${r.account}${r.name ? ` ${r.name}` : ''}`.slice(0, 200);
      lines.push({ account: r.target, label, debit: r.value > 0 ? r.value : 0, credit: r.value < 0 ? -r.value : 0 });
    }
    // Charges (débit) et produits (crédit) non clôturés : le solde net est le résultat, bénéfice au crédit, perte au débit.
    if (result) lines.push({ account: result < 0 ? RESULT.profit : RESULT.loss, label: 'Reprise Odoo — résultat', debit: result > 0 ? result : 0, credit: result < 0 ? -result : 0 });
    const net = round2(lines.reduce((t, l) => t + l.debit - l.credit, 0));
    if (net) lines.push({ account: SUSPENSE, label: 'Reprise Odoo — contrepartie', debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 });
    if (lines.length < 2) return 'Rien à reprendre';
    await api('/company/accounting/entries', { body: { journal: 'AN', date: g[0].openingDate, label: 'Reprise Odoo — soldes des comptes', reference: 'ODOO', lines } });
    return `${g.length} compte${g.length > 1 ? 's' : ''} en brouillon`;
  },
  after: <>L'écriture est en brouillon dans Comptabilité → Écritures (journal AN) : vérifiez-la puis validez-la.</>,
  template: { file: 'exemple-export-odoo-plan-comptable.csv', rows: [
    ['Code', 'Nom', 'Solde courant'],
    ['101300', 'Capital souscrit, appelé, versé', -10000000],
    ['244100', 'Matériel de bureau', 2500000],
  ] },
};

export type { Rec };
