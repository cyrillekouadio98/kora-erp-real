'use client';
import { api } from '@/lib/api';
import { RECEIPT_REASONS } from '@/lib/format';
import { Cell, simplify, toNumber } from '@/lib/import-files';
import type { ImportConfig, ImportField, Rec } from './import';

/** Réglages d'import de chaque module : champs reconnus, vérifications, regroupement en documents et enregistrement. */

const VAT: ImportField = {
  key: 'vatRate', label: 'TVA (%)', default: '18', aliases: ['tva', 'taux tva', 'taux de tva', 'tva %', 'vat'],
  parse: (raw: Cell) => {
    if (/exo/i.test(String(raw))) return 0;
    let n = toNumber(raw);
    if (n > 0 && n < 1) n = Math.round(n * 100);
    if (![18, 9, 0].includes(n)) throw new Error(`TVA : 18 %, 9 % ou 0 % (« ${raw} »)`);
    return n;
  },
};

/** Retrouve un article ou un tiers par son code, son nom (sans tenir compte des accents ni de la casse) ou son NCC. */
function finder<T extends { id: string; code?: string | null; name: string; taxId?: string | null }>(list: T[]) {
  const map = new Map<string, T>();
  for (const x of list) {
    if (x.taxId) map.set(`t:${simplify(x.taxId)}`, x);
    map.set(`n:${simplify(x.name)}`, x);
    if (x.code) map.set(`c:${simplify(x.code)}`, x);
  }
  return (raw: unknown) => { const s = simplify(raw); return s ? map.get(`c:${s}`) ?? map.get(`n:${s}`) ?? map.get(`t:${s}`) : undefined; };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ---------- Articles ---------- */

export const PRODUCTS_IMPORT: ImportConfig<{ exists: (r: unknown) => any }> = {
  title: 'Importer des articles', what: 'articles', one: 'article',
  intro: <><p>Une ligne par article. Le code (ART-00001…) est attribué automatiquement ; un article déjà présent sous le même nom est ignoré.</p>
    <p>Colonnes reconnues : <b>Désignation</b>, <b>Prix de vente HT</b>, Type (bien ou service), Unité, Code-barres, Prix d'achat, TVA (18, 9 ou 0), Description.</p></>,
  fields: [
    { key: 'name', label: 'Désignation', required: true, aliases: ['nom', 'article', 'produit', 'libelle', 'designation article', 'intitule'] },
    { key: 'kind', label: 'Type', type: 'choice', default: 'good', aliases: ['nature', 'type article'], choices: [
      { value: 'good', label: 'Bien', match: ['marchandise', 'produit', 'stocke', 'article', 'b'] }, { value: 'service', label: 'Service', match: ['prestation', 's'] }] },
    { key: 'unit', label: 'Unité', aliases: ['unite de vente', 'conditionnement', 'u'] },
    { key: 'barcode', label: 'Code-barres', aliases: ['ean', 'ean13', 'code barre', 'code barres', 'gencod', 'upc'] },
    { key: 'salePrice', label: 'Prix de vente HT', type: 'number', required: true, aliases: ['prix de vente', 'prix', 'pv', 'pu', 'prix unitaire', 'prix ht', 'tarif'] },
    { key: 'purchasePrice', label: "Prix d'achat", type: 'number', aliases: ['pa', 'cout', 'cout d achat', 'prix achat', 'prix de revient'] },
    VAT,
    { key: 'description', label: 'Description', aliases: ['detail', 'commentaire', 'observations'] },
  ],
  load: async () => ({ exists: finder(await api<any[]>('/company/products?archived=all')) }),
  check: (r, ctx, seen) => {
    const key = simplify(r.name);
    if (r.name.length < 2) return { error: 'Désignation trop courte' };
    if (r.salePrice < 0 || (r.purchasePrice ?? 0) < 0) return { error: 'Prix négatif' };
    if (ctx.exists(r.name)) return { skip: 'Article déjà présent' };
    if (seen.has(key)) return { skip: 'En double dans le fichier' };
    seen.add(key);
  },
  save: async ([r]) => {
    const p = await api('/company/products', { body: { name: r.name, kind: r.kind ?? 'good', unit: r.unit, salePrice: r.salePrice, purchasePrice: r.purchasePrice ?? null, vatRate: r.vatRate ?? 18, description: r.description ?? null, barcode: r.barcode ? String(r.barcode).replace(/\s/g, '') : null } });
    return p.code;
  },
  template: { file: 'modele-import-articles.csv', rows: [
    ['Désignation', 'Type', 'Unité', 'Prix de vente HT', "Prix d'achat", 'TVA', 'Description'],
    ['Huile végétale 5 L', 'Bien', 'bidon', 6000, 4000, 18, ''],
    ['Livraison Abidjan', 'Service', 'forfait', 2500, '', 18, 'Livraison en ville'],
  ] },
};

/** Import d'articles adapté à l'activité : une entreprise de services importe des prestations par défaut. */
export function productsImport(activity?: string): typeof PRODUCTS_IMPORT {
  if (activity !== 'services') return PRODUCTS_IMPORT;
  return {
    ...PRODUCTS_IMPORT, title: 'Importer des prestations', what: 'prestations', one: 'prestation', feminine: true,
    intro: <><p>Une ligne par prestation. Le code est attribué automatiquement ; une prestation déjà présente sous le même nom est ignorée.</p>
      <p>Colonnes reconnues : <b>Désignation</b>, <b>Tarif HT</b>, Unité (heure, jour, forfait…), Coût de revient, TVA (18, 9 ou 0), Description, Type (service par défaut).</p></>,
    fields: PRODUCTS_IMPORT.fields.map((f) => f.key === 'kind' ? { ...f, default: 'service' } : f.key === 'salePrice' ? { ...f, label: 'Tarif HT' } : f.key === 'purchasePrice' ? { ...f, label: 'Coût de revient' } : f),
    save: async ([r], ctx, settings) => PRODUCTS_IMPORT.save([{ ...r, kind: r.kind ?? 'service', unit: r.unit || 'forfait' }], ctx, settings),
    template: { file: 'modele-import-prestations.csv', rows: [
      ['Désignation', 'Unité', 'Tarif HT', 'Coût de revient', 'TVA', 'Description'],
      ['Maintenance informatique', 'heure', 15000, '', 18, 'Intervention sur site'],
      ['Audit comptable', 'forfait', 350000, '', 18, ''],
    ] },
  };
}

/* ---------- Contacts ---------- */

const REQUIRED_CONTACT: Record<string, [string, string][]> = {
  company: [['phone', 'Téléphone'], ['email', 'E-mail'], ['taxId', 'NCC'], ['rccm', 'RCCM'], ['paymentTermsDays', 'Délai de paiement']],
  individual: [['phone', 'Téléphone']],
};

export const CONTACTS_IMPORT: ImportConfig<{ exists: (r: unknown) => any }> = {
  title: 'Importer des clients et fournisseurs', what: 'contacts', one: 'contact',
  intro: <><p>Une ligne par client ou fournisseur. Le code (CLI-, FRS-, TIE-…) est attribué automatiquement ; un tiers déjà présent (même nom ou même NCC) est ignoré.</p>
    <p>Pour une <b>entreprise</b>, Kora exige téléphone, e-mail, NCC, RCCM et délai de paiement ; pour un <b>particulier</b>, le téléphone. Utilisez « Valeur si vide » pour compléter une colonne absente (par exemple un délai de 30 jours).</p></>,
  fields: [
    { key: 'name', label: 'Nom ou raison sociale', required: true, aliases: ['nom', 'raison sociale', 'societe', 'client', 'fournisseur', 'tiers', 'denomination', 'intitule'] },
    { key: 'kind', label: 'Type', type: 'choice', default: 'customer', aliases: ['categorie', 'type de tiers', 'nature'], choices: [
      { value: 'customer', label: 'Client', match: ['clients', 'customer', 'c', 'cli'] }, { value: 'supplier', label: 'Fournisseur', match: ['fournisseurs', 'supplier', 'f', 'frs'] },
      { value: 'both', label: 'Client et fournisseur', match: ['les deux', 'client fournisseur', 'both', 'tie', 'tiers'] }] },
    { key: 'legalType', label: 'Forme', type: 'choice', default: 'company', aliases: ['forme juridique', 'statut', 'personne'], choices: [
      { value: 'company', label: 'Entreprise', match: ['societe', 'personne morale', 'pm', 'sarl', 'sa', 'sas', 'suarl', 'ei', 'company'] },
      { value: 'individual', label: 'Particulier', match: ['personne physique', 'pp', 'individu', 'individual'] }] },
    { key: 'phone', label: 'Téléphone', aliases: ['tel', 'telephone', 'mobile', 'contact', 'portable', 'cellulaire'] },
    { key: 'email', label: 'E-mail', aliases: ['email', 'mail', 'courriel', 'adresse email', 'adresse e mail'] },
    { key: 'taxId', label: 'NCC', aliases: ['compte contribuable', 'n cc', 'numero cc', 'numero contribuable', 'ifu', 'nif', 'n contribuable'] },
    { key: 'rccm', label: 'RCCM', aliases: ['registre du commerce', 'rc', 'n rccm'] },
    { key: 'paymentTermsDays', label: 'Délai de paiement (jours)', type: 'number', aliases: ['delai', 'delai de paiement', 'echeance', 'jours', 'conditions de paiement'] },
    { key: 'address', label: 'Adresse', aliases: ['adresse postale', 'localisation', 'situation geographique'] },
    { key: 'city', label: 'Ville', aliases: ['commune', 'localite'] },
    { key: 'notes', label: 'Notes', aliases: ['observations', 'commentaire', 'remarques'] },
  ],
  load: async () => ({ exists: finder(await api<any[]>('/company/contacts?archived=all')) }),
  check: (r, ctx, seen) => {
    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) return { error: `E-mail invalide (« ${r.email} »)` };
    if (r.paymentTermsDays !== undefined && (r.paymentTermsDays < 0 || r.paymentTermsDays > 365 || !Number.isInteger(r.paymentTermsDays))) return { error: 'Délai de paiement : 0 à 365 jours' };
    const missing = REQUIRED_CONTACT[r.legalType ?? 'company'].filter(([k]) => r[k] === undefined || r[k] === '');
    if (missing.length) return { error: `${r.legalType === 'individual' ? 'Particulier' : 'Entreprise'} : ${missing.map(([, l]) => l).join(', ')} manquant${missing.length > 1 ? 's' : ''}` };
    if (ctx.exists(r.name) || (r.taxId && ctx.exists(r.taxId))) return { skip: 'Tiers déjà présent' };
    const key = simplify(r.name);
    if (seen.has(key)) return { skip: 'En double dans le fichier' };
    seen.add(key);
  },
  save: async ([r]) => {
    const body: Record<string, unknown> = { kind: r.kind ?? 'customer', legalType: r.legalType ?? 'company', name: r.name };
    for (const k of ['phone', 'email', 'taxId', 'rccm', 'paymentTermsDays', 'address', 'city', 'notes']) if (r[k] !== undefined) body[k] = r[k];
    return (await api('/company/contacts', { body })).code;
  },
  template: { file: 'modele-import-contacts.csv', rows: [
    ['Nom ou raison sociale', 'Type', 'Forme', 'Téléphone', 'E-mail', 'NCC', 'RCCM', 'Délai de paiement (jours)', 'Adresse', 'Ville'],
    ['Maquis Chez Tantie', 'Client', 'Entreprise', '+225 07 00 00 00 00', 'contact@tantie.ci', '1234567A', 'CI-ABJ-2020-B-12345', 30, 'Cocody Angré', 'Abidjan'],
    ['Kouassi Jean', 'Client', 'Particulier', '+225 05 00 00 00 00', '', '', '', '', '', 'Bouaké'],
  ] },
};

/* ---------- Stocks : bon d'entrée en brouillon ---------- */

type StockCtx = { product: (r: unknown) => any; warehouses: { id: string; code: string; name: string; isDefault: boolean }[] };
export const STOCK_IMPORT: ImportConfig<StockCtx> = {
  title: 'Importer des quantités en stock', what: "bons d'entrée", one: "bon d'entrée",
  intro: <><p>Les lignes du fichier forment <b>un bon d'entrée en brouillon</b> : vous le relisez dans « Entrées et sorties » puis vous le validez pour mettre le stock à jour.</p>
    <p>Colonnes reconnues : <b>Article</b> (code ART-… ou désignation exacte), <b>Quantité</b>, Coût unitaire, Note. Les articles doivent exister et être suivis en stock ; un même article répété est regroupé ; les lignes en erreur sont laissées de côté.</p></>,
  fields: [
    { key: 'product', label: 'Article (code ou désignation)', required: true, aliases: ['article', 'code', 'code article', 'reference', 'ref', 'designation', 'produit', 'libelle'] },
    { key: 'quantity', label: 'Quantité', type: 'number', required: true, aliases: ['qte', 'qte', 'quantite', 'stock', 'quantite en stock', 'stock reel', 'qte physique'] },
    { key: 'unitCost', label: 'Coût unitaire', type: 'number', aliases: ['cout', 'cout unitaire', 'prix d achat', 'pa', 'cmup', 'prix unitaire', 'pu'] },
    { key: 'note', label: 'Note', aliases: ['observation', 'commentaire', 'lot'] },
  ],
  load: async () => {
    const [products, warehouses] = await Promise.all([api<any[]>('/company/products'), api<any[]>('/company/stock/warehouses')]);
    return { product: finder(products), warehouses: warehouses.filter((w) => !w.archived) };
  },
  settings: (ctx) => [
    { key: 'reason', label: "Motif de l'entrée", default: 'other', options: Object.entries(RECEIPT_REASONS).filter(([k]) => k !== 'cash_purchase').map(([value, label]) => ({ value, label })) },
    ...(ctx.warehouses.length > 1 ? [{ key: 'warehouseId', label: 'Entrepôt', default: ctx.warehouses.find((w) => w.isDefault)?.id, options: ctx.warehouses.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })) }] : []),
  ],
  check: (r, ctx) => {
    const p = ctx.product(r.product);
    if (!p) return { error: `Article « ${r.product} » introuvable` };
    if (!p.trackStock) return { error: `« ${p.name} » n'est pas suivi en stock` };
    if (r.quantity <= 0) return r.quantity === 0 ? { skip: 'Quantité nulle' } : { error: 'Quantité négative' };
    if ((r.unitCost ?? 0) < 0) return { error: 'Coût négatif' };
    r.productId = p.id;
  },
  group: (rows) => (rows.length ? [rows] : []),
  partial: true,
  checkGroup: (g) => (new Set(g.map((r) => r.productId)).size > 2000 ? 'Plus de 2 000 articles : découpez le fichier.' : undefined),
  save: async (g, _ctx, s) => {
    // Un même article sur plusieurs lignes : quantités additionnées, coût moyen pondéré.
    const lines = new Map<string, { productId: string; quantity: number; value: number; costed: boolean; note?: string }>();
    for (const r of g) {
      const l = lines.get(r.productId) ?? { productId: r.productId, quantity: 0, value: 0, costed: false, note: r.note };
      l.quantity += r.quantity;
      if (r.unitCost !== undefined) { l.value += r.unitCost * r.quantity; l.costed = true; }
      lines.set(r.productId, l);
    }
    const d = await api('/company/stock/documents', { body: {
      type: 'receipt', reason: s.reason || 'other', warehouseId: s.warehouseId || null, notes: 'Importé depuis un fichier',
      lines: [...lines.values()].map((l) => ({ productId: l.productId, quantity: Math.round(l.quantity * 1000) / 1000, unitCost: l.costed ? round2(l.value / l.quantity) : null, note: l.note ?? null })),
    } });
    return `Bon en brouillon (${d.lines?.length ?? lines.size} articles)`;
  },
  after: <>Ouvrez <a href="/app/stocks/operations">Entrées et sorties</a> pour relire le bon d'entrée et le valider.</>,
  template: { file: 'modele-import-stock.csv', rows: [['Article', 'Quantité', 'Coût unitaire', 'Note'], ['ART-00001', 24, 4000, ''], ['Riz parfumé 25 kg', 10, 15500, 'Lot 2026-11']] },
};

/* ---------- Comptabilité : écritures d'OD ou d'à-nouveaux en brouillon ---------- */

type EntryCtx = { accounts: Set<string>; contact: (r: unknown) => any };
export const ENTRIES_IMPORT: ImportConfig<EntryCtx> = {
  title: 'Importer des écritures', what: 'écritures', one: 'écriture', feminine: true,
  intro: <><p>Une ligne par ligne d'écriture. Les lignes d'un même <b>N° de pièce</b> forment une écriture ; sans numéro de pièce, les lignes qui se suivent sont regroupées jusqu'à ce que le débit égale le crédit.</p>
    <p>Les écritures sont créées <b>en brouillon</b> dans le journal choisi (OD ou à-nouveaux) : relisez-les puis validez-les. Colonnes : <b>Date</b>, <b>Compte</b>, <b>Libellé</b>, Débit, Crédit, N° de pièce, Tiers (code, nom ou NCC, pour les comptes 40/41).</p></>,
  fields: [
    { key: 'date', label: 'Date', type: 'date', required: true, aliases: ['date ecriture', 'date piece', 'date operation', 'jour'] },
    { key: 'piece', label: 'N° de pièce', aliases: ['piece', 'n piece', 'numero de piece', 'num piece', 'ecriture', 'n ecriture', 'reference', 'ref'] },
    { key: 'account', label: 'Compte', required: true, aliases: ['n compte', 'numero de compte', 'compte general', 'compte comptable', 'cpte', 'n de compte'],
      parse: (raw) => { const s = String(raw).replace(/\s/g, ''); if (!/^[1-9]\d{1,5}$/.test(s)) throw new Error(`Compte : numéro de 2 à 6 chiffres (« ${raw} »)`); return s.padEnd(6, '0'); } },
    { key: 'label', label: 'Libellé', required: true, aliases: ['libelle ecriture', 'intitule', 'designation', 'description', 'libelle operation'] },
    { key: 'debit', label: 'Débit', type: 'number', aliases: ['montant debit', 'debit fcfa', 'd'] },
    { key: 'credit', label: 'Crédit', type: 'number', aliases: ['montant credit', 'credit fcfa', 'c'] },
    { key: 'contact', label: 'Tiers', aliases: ['compte tiers', 'tiers code', 'client fournisseur', 'nom tiers', 'auxiliaire'] },
    { key: 'journal', label: 'Journal', type: 'choice', default: 'OD', aliases: ['code journal', 'jnl'], choices: [
      { value: 'OD', label: 'Opérations diverses (OD)', match: ['od', 'operations diverses'] }, { value: 'AN', label: 'À-nouveaux (AN)', match: ['an', 'a nouveaux', 'ouverture'] }] },
  ],
  load: async () => {
    const [accounts, contacts] = await Promise.all([api<any[]>('/company/accounting/accounts'), api<any[]>('/company/contacts?archived=all')]);
    return { accounts: new Set(accounts.filter((a) => !a.archivedAt).map((a) => a.code)), contact: finder(contacts) };
  },
  check: (r, ctx) => {
    const d = r.debit ?? 0, c = r.credit ?? 0;
    if (d < 0 || c < 0) return { error: 'Montant négatif' };
    if (d > 0 && c > 0) return { error: 'Une ligne est soit au débit, soit au crédit' };
    if (!d && !c) return { skip: 'Ligne sans montant' };
    if (!ctx.accounts.has(r.account)) return { error: `Compte ${r.account} absent du plan comptable (ajoutez-le dans « Plan comptable »)` };
    if (r.contact) {
      const k = ctx.contact(r.contact);
      if (!k) return { error: `Tiers « ${r.contact} » introuvable` };
      r.contactId = k.id;
    }
  },
  group: (rows) => {
    if (rows.some((r) => r.piece)) {
      const by = new Map<string, Rec[]>();
      for (const r of rows) { const k = `${r.journal ?? 'OD'}|${r.piece ?? `ligne-${r._line}`}`; by.set(k, [...(by.get(k) ?? []), r]); }
      return [...by.values()];
    }
    const out: Rec[][] = [];
    let cur: Rec[] = [], bal = 0;
    for (const r of rows) {
      cur.push(r); bal = round2(bal + (r.debit ?? 0) - (r.credit ?? 0));
      if (cur.length >= 2 && bal === 0) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  },
  checkGroup: (g) => {
    if (g.length < 2) return 'Écriture à une seule ligne';
    if (new Set(g.map((r) => r.date)).size > 1) return 'Les lignes d\'une même pièce doivent avoir la même date';
    const d = round2(g.reduce((s, r) => s + (r.debit ?? 0), 0)), c = round2(g.reduce((s, r) => s + (r.credit ?? 0), 0));
    if (d !== c) return `Écriture déséquilibrée : débit ${d.toLocaleString('fr-FR')}, crédit ${c.toLocaleString('fr-FR')}`;
    if (g.length > 200) return 'Plus de 200 lignes dans une écriture';
  },
  save: async (g) => {
    const label = (g.find((r) => r.label.length >= 2)?.label ?? 'Écriture importée').slice(0, 200);
    const e = await api('/company/accounting/entries', { body: {
      journal: g[0].journal ?? 'OD', date: g[0].date, label, reference: g[0].piece ? String(g[0].piece).slice(0, 60) : null,
      lines: g.map((r) => ({ account: r.account, label: r.label.slice(0, 200), debit: r.debit ?? 0, credit: r.credit ?? 0, contactId: r.contactId ?? null })),
    } });
    return g[0].piece ? `Pièce ${g[0].piece}` : `Écriture du ${String(e.date ?? g[0].date).split('-').reverse().join('/')}`;
  },
  after: <>Les écritures sont en brouillon dans l'onglet « Écritures » : vérifiez-les puis validez-les.</>,
  template: { file: 'modele-import-ecritures.csv', rows: [
    ['Date', 'N° de pièce', 'Journal', 'Compte', 'Tiers', 'Libellé', 'Débit', 'Crédit'],
    ['31/01/2026', 'OD-001', 'OD', '622200', '', 'Loyer de janvier', 150000, ''],
    ['31/01/2026', 'OD-001', 'OD', '571100', '', 'Loyer de janvier', '', 150000],
  ] },
};

/* ---------- Factures fournisseurs et factures clients en brouillon ---------- */

type DocCtx = { contact: (r: unknown) => any; product: (r: unknown) => any; refs: Set<string> };
function invoiceImport(side: 'purchase' | 'sale'): ImportConfig<DocCtx> {
  const buy = side === 'purchase';
  const who = buy ? 'Fournisseur' : 'Client';
  return {
    title: buy ? 'Importer des factures fournisseurs' : 'Importer des factures clients', what: 'factures', one: 'facture', feminine: true,
    intro: <><p>Une ligne par ligne de facture. Les lignes d'un même {who.toLowerCase()} et d'une même <b>{buy ? 'référence fournisseur' : 'référence'}</b> forment une facture{buy ? '' : ''}, créée <b>en brouillon</b> : relisez-la puis validez-la pour la comptabiliser{buy ? '' : ' (elle reçoit alors son numéro et la date du jour)'}.</p>
      <p>Colonnes : <b>{who}</b> (code, nom ou NCC), <b>Désignation</b>, <b>Prix unitaire HT</b>, Quantité, TVA, Remise %, Article (code), {buy ? 'Référence fournisseur, Date, Échéance' : 'Référence, Échéance'}.{buy ? ' Une facture déjà saisie avec la même référence est ignorée.' : ''}</p></>,
    fields: [
      { key: 'contact', label: who, required: true, aliases: buy ? ['fournisseur', 'nom fournisseur', 'code fournisseur', 'tiers', 'frs'] : ['client', 'nom client', 'code client', 'tiers'] },
      { key: 'ref', label: buy ? 'Référence fournisseur' : 'Référence', aliases: buy ? ['n facture', 'numero facture', 'ref', 'reference', 'facture', 'n facture fournisseur', 'ref facture'] : ['ref', 'n facture', 'numero', 'reference client', 'bon de commande', 'facture'] },
      ...(buy ? [{ key: 'issueDate', label: 'Date', type: 'date', aliases: ['date facture', 'date de facture', 'date d emission'] } as ImportField] : []),
      { key: 'dueDate', label: 'Échéance', type: 'date', aliases: ['date echeance', 'date d echeance', 'echeance', 'a payer le'] },
      { key: 'product', label: 'Article (code)', aliases: ['code article', 'article', 'ref article', 'code produit'] },
      { key: 'description', label: 'Désignation', required: true, aliases: ['libelle', 'description', 'produit', 'prestation', 'detail'] },
      { key: 'quantity', label: 'Quantité', type: 'number', default: '1', aliases: ['qte', 'quantite', 'nombre', 'nb'] },
      { key: 'unitPrice', label: 'Prix unitaire HT', type: 'number', required: true, aliases: ['prix unitaire', 'pu', 'pu ht', 'prix', 'prix ht', 'montant ht', 'tarif'] },
      VAT,
      { key: 'discountPct', label: 'Remise %', type: 'number', aliases: ['remise', 'rabais', 'taux de remise'] },
    ],
    load: async () => {
      const [contacts, products, docs] = await Promise.all([
        api<any[]>(`/company/contacts?archived=all&kind=${buy ? 'supplier' : 'customer'}`), api<any[]>('/company/products'),
        buy ? api<any[]>('/company/purchases/documents?type=invoice') : Promise.resolve([]),
      ]);
      return { contact: finder(contacts), product: finder(products), refs: new Set(docs.filter((d) => d.supplierRef).map((d) => `${d.contactId}|${simplify(d.supplierRef)}`)) };
    },
    check: (r, ctx) => {
      const k = ctx.contact(r.contact);
      if (!k) return { error: `${who} « ${r.contact} » introuvable (créez-le d'abord dans Contacts)` };
      r.contactId = k.id;
      if (r.quantity !== undefined && r.quantity <= 0) return { error: 'Quantité nulle ou négative' };
      if (r.unitPrice < 0) return { error: 'Prix négatif' };
      if (r.discountPct !== undefined && (r.discountPct < 0 || r.discountPct > 100)) return { error: 'Remise : 0 à 100 %' };
      if (r.product) {
        const p = ctx.product(r.product);
        if (!p) return { error: `Article « ${r.product} » introuvable` };
        r.productId = p.id;
      }
      if (buy && r.ref && ctx.refs.has(`${k.id}|${simplify(r.ref)}`)) return { skip: 'Facture déjà saisie (même référence)' };
    },
    group: (rows) => {
      const by = new Map<string, Rec[]>();
      for (const r of rows) { const k = `${r.contactId}|${r.ref ? simplify(r.ref) : ''}|${r.ref ? '' : r.issueDate ?? ''}`; by.set(k, [...(by.get(k) ?? []), r]); }
      return [...by.values()];
    },
    checkGroup: (g) => {
      if (g.length > 200) return 'Plus de 200 lignes dans une facture';
      if (new Set(g.map((r) => r.issueDate ?? '')).size > 1) return 'Dates différentes pour une même facture';
    },
    save: async (g) => {
      const head = g[0];
      const body: Record<string, unknown> = {
        type: 'invoice', contactId: head.contactId, dueDate: g.find((r) => r.dueDate)?.dueDate ?? null,
        lines: g.map((r) => ({ productId: r.productId ?? null, description: String(r.description).slice(0, 500), quantity: r.quantity ?? 1, unitPrice: r.unitPrice, vatRate: r.vatRate ?? 18, ...(r.discountPct ? { discountPct: r.discountPct } : {}) })),
      };
      if (buy) Object.assign(body, { supplierRef: head.ref ? String(head.ref).slice(0, 60) : null, ...(head.issueDate ? { issueDate: head.issueDate } : {}) });
      else if (head.ref) body.customerRef = String(head.ref).slice(0, 60);
      const d = await api(buy ? '/company/purchases/documents' : '/company/sales/documents', { body });
      return head.ref ? `Brouillon ${head.ref}` : `Brouillon ${d.contactName ?? ''}`.trim();
    },
    after: <>Les factures sont en brouillon dans la liste : ouvrez-les pour les vérifier puis les valider.</>,
    template: { file: buy ? 'modele-import-factures-fournisseurs.csv' : 'modele-import-factures-clients.csv', rows: buy ? [
      ['Fournisseur', 'Référence fournisseur', 'Date', 'Échéance', 'Article (code)', 'Désignation', 'Quantité', 'Prix unitaire HT', 'TVA', 'Remise %'],
      ['FRS-00001', 'FA-2026-118', '05/01/2026', '04/02/2026', 'ART-00001', 'Huile végétale 5 L', 20, 4000, 18, ''],
      ['FRS-00001', 'FA-2026-118', '05/01/2026', '04/02/2026', '', 'Transport', 1, 15000, 18, ''],
    ] : [
      ['Client', 'Référence', 'Échéance', 'Article (code)', 'Désignation', 'Quantité', 'Prix unitaire HT', 'TVA', 'Remise %'],
      ['CLI-00001', 'BC-778', '15/02/2026', 'ART-00001', 'Huile végétale 5 L', 10, 6000, 18, 5],
    ] },
  };
}
export const PURCHASES_IMPORT = invoiceImport('purchase');
export const SALES_IMPORT = invoiceImport('sale');
