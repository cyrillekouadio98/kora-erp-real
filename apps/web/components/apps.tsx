import { useId } from 'react';

/** Applications de l'écran d'accueil : une tuile et une icône par domaine de Kora. */

/**
 * Identité Kora : chaque application a sa couleur (tuile pleine en dégradé, du foncé au clair)
 * et un pictogramme blanc au trait, dessiné sur une grille de 48.
 */
const TILES: Record<string, [string, string]> = {
  dashboard: ['#0f766e', '#14b8a6'], sales: ['#c2410c', '#fb923c'], purchases: ['#0369a1', '#38bdf8'], treasury: ['#15803d', '#22c55e'],
  accounting: ['#1e3a8a', '#3b82f6'], stock: ['#a16207', '#eab308'], products: ['#a21caf', '#d946ef'], contacts: ['#3f6212', '#65a30d'],
  employees: ['#4338ca', '#818cf8'], leave: ['#0e7490', '#06b6d4'], payroll: ['#6d28d9', '#a855f7'], me: ['#be185d', '#f472b6'],
  company: ['#334155', '#64748b'], users: ['#44403c', '#78716c'], roles: ['#b91c1c', '#f87171'], billing: ['#065f46', '#10b981'],
  emails: ['#0f172a', '#475569'], audit: ['#78350f', '#d97706'], support: ['#be123c', '#fb7185'], security: ['#14532d', '#16a34a'],
};

const GLYPHS: Record<string, React.ReactNode> = {
  dashboard: <><path d="M12 36h24" /><path d="M15 32v-6M21 32V18M27 32v-9M33 32V14" /></>,
  sales: <><path d="M14.5 19h19l-1.6 16.5H16.1z" /><path d="M19 19v-2.5a5 5 0 0 1 10 0V19" /></>,
  purchases: <><path d="M10 15h17v15H10z" /><path d="M27 21h6l5 5v4H27" /><circle cx="16" cy="33" r="2.6" /><circle cx="32" cy="33" r="2.6" /></>,
  treasury: <><path d="M12 18h22.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 12 32.5z" /><path d="M12 18l17-5.5V18" /><path d="M36 23h-6a3 3 0 0 0 0 6h6" /></>,
  accounting: <><path d="M24 13v22M18 35h12M13 17h22" /><path d="M13 17l-4 8a4 3 0 0 0 8 0zM35 17l-4 8a4 3 0 0 0 8 0z" /></>,
  stock: <><path d="M24 11.5l11.5 6v13l-11.5 6-11.5-6v-13z" /><path d="M12.5 17.5l11.5 6 11.5-6M24 23.5v13" /></>,
  products: <><path d="M12.5 12.5h11l12 12-11 11-12-12z" /><circle cx="18.5" cy="18.5" r="2" /></>,
  contacts: <><path d="M16 12h17a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H16z" /><path d="M12 17h4M12 24h4M12 31h4" /><circle cx="25.5" cy="21" r="3.2" /><path d="M20 31a5.5 5 0 0 1 11 0" /></>,
  employees: <><rect x="14" y="13" width="20" height="23" rx="2.5" /><path d="M21 10h6" /><circle cx="24" cy="21.5" r="3.4" /><path d="M18.5 31.5a5.5 4.5 0 0 1 11 0" /></>,
  leave: <><circle cx="24" cy="21" r="5" /><path d="M24 11v2M15 21h-2M35 21h-2M17 14l1.4 1.4M31 14l-1.4 1.4" /><path d="M11 31c4.3-3 8.7-3 13 0s8.7 3 13 0M15 36.5c3-2 6-2 9 0s6 2 9 0" /></>,
  payroll: <><rect x="10" y="15" width="28" height="18" rx="2.5" /><circle cx="24" cy="24" r="4" /><path d="M15 20v.01M33 28v.01" /></>,
  me: <><circle cx="24" cy="24" r="12.5" /><circle cx="24" cy="21" r="4" /><path d="M16.5 32.5c1.6-3.2 4.2-4.8 7.5-4.8s5.9 1.6 7.5 4.8" /></>,
  company: <><path d="M15 36V12.5h12V36M27 20h7v16M12 36h24" /><path d="M19.5 18h3M19.5 23h3M19.5 28h3M30.5 25h0M30.5 30h0" /></>,
  users: <><circle cx="19" cy="20" r="4.2" /><path d="M11 34a8 7.5 0 0 1 16 0" /><circle cx="30.5" cy="19" r="3.3" /><path d="M28.5 26.3a7 6.5 0 0 1 8.5 6.7" /></>,
  roles: <><circle cx="18" cy="24" r="5.5" /><path d="M23.5 24H37M32 24v4.5M36.5 24v4" /></>,
  billing: <><rect x="11" y="15" width="26" height="18" rx="2.5" /><path d="M11 21h26M16 28h6" /></>,
  emails: <><rect x="11" y="15" width="26" height="18" rx="2.5" /><path d="M11.5 16.5l12.5 9 12.5-9" /></>,
  audit: <><path d="M15 12h12.5l5.5 5.5V36H15z" /><path d="M27 12v6h6" /><circle cx="23.5" cy="26" r="3.6" /><path d="M26.2 28.7l3.3 3.3" /></>,
  support: <><circle cx="24" cy="24" r="11.5" /><circle cx="24" cy="24" r="5" /><path d="M16 16l4.5 4.5M32 16l-4.5 4.5M16 32l4.5-4.5M32 32l-4.5-4.5" /></>,
  security: <><path d="M24 11l11 4v8c0 7-4.8 11.5-11 14-6.2-2.5-11-7-11-14v-8z" /><path d="M19 24l3.5 3.5L29.5 21" /></>,
};

export interface AppPage { href: string; label: string; perm?: string; module?: string }
/** base : préfixe des adresses de l'application ; pages : son menu, affiché dans la barre du haut. */
export interface App extends AppPage { key: string; base?: string; pages?: AppPage[] }

/** Même droits que le menu : une application n'apparaît que si le rôle et la formule l'autorisent. */
export const APPS: App[] = [
  { key: 'dashboard', label: 'Tableau de bord', href: '/app/tableau-de-bord' },
  { key: 'sales', label: 'Ventes', href: '/app/ventes/factures', perm: 'sales.read', base: '/app/ventes', pages: [
    { href: '/app/ventes/devis', label: 'Devis' }, { href: '/app/ventes/commandes', label: 'Bons de commande' }, { href: '/app/ventes/factures', label: 'Factures' },
    { href: '/app/ventes/avoirs', label: 'Avoirs' }, { href: '/app/ventes/relances', label: 'Relances clients' },
  ] },
  { key: 'purchases', label: 'Achats', href: '/app/achats/factures', perm: 'purchases.read', module: 'purchases', base: '/app/achats', pages: [
    { href: '/app/achats/commandes', label: 'Bons de commande' }, { href: '/app/achats/factures', label: 'Factures fournisseurs' },
    { href: '/app/achats/echeancier', label: 'Échéancier' },
  ] },
  { key: 'treasury', label: 'Trésorerie', href: '/app/tresorerie', perm: 'cash.read', module: 'cash', pages: [
    { href: '/app/tresorerie', label: "Vue d'ensemble" }, { href: '/app/tresorerie/caisse', label: 'Caisse' },
    { href: '/app/tresorerie/banque', label: 'Banque' }, { href: '/app/tresorerie/mobile-money', label: 'Mobile money' },
  ] },
  { key: 'accounting', label: 'Comptabilité', href: '/app/comptabilite', perm: 'accounting.read', module: 'accounting' },
  { key: 'stock', label: 'Stocks', href: '/app/stocks', perm: 'stock.read', pages: [
    { href: '/app/stocks', label: "Vue d'ensemble" }, { href: '/app/stocks/operations', label: 'Entrées et sorties' },
    { href: '/app/stocks/inventaires', label: 'Inventaires' }, { href: '/app/stocks/mouvements', label: 'Mouvements' },
    { href: '/app/stocks/valorisation', label: 'Valorisation' }, { href: '/app/stocks/entrepots', label: 'Entrepôts' },
  ] },
  { key: 'products', label: 'Articles', href: '/app/articles', perm: 'products.read' },
  { key: 'contacts', label: 'Contacts', href: '/app/contacts', perm: 'contacts.read' },
  { key: 'employees', label: 'Employés', href: '/app/employes', perm: 'employees.read', module: 'hr' },
  { key: 'leave', label: 'Congés', href: '/app/conges', perm: 'leave.read', module: 'hr' },
  { key: 'payroll', label: 'Paie', href: '/app/paie', perm: 'payroll.read', module: 'payroll', pages: [
    { href: '/app/paie', label: "Vue d'ensemble" }, { href: '/app/paie/fiches', label: 'Bulletins' }, { href: '/app/paie/prestations', label: 'Temps et absences' },
    { href: '/app/paie/contrats', label: 'Contrats' }, { href: '/app/paie/solde', label: 'Départs' }, { href: '/app/paie/analyse', label: 'Masse salariale' },
    { href: '/app/paie/configuration', label: 'Paramètres' },
  ] },
  { key: 'me', label: 'Mon espace', href: '/app/moi', perm: 'employees.self', module: 'hr' },
  { key: 'company', label: 'Entreprise', href: '/app/entreprise', perm: 'settings.read' },
  { key: 'users', label: 'Utilisateurs', href: '/app/utilisateurs', perm: 'users.read' },
  { key: 'roles', label: 'Rôles', href: '/app/roles', perm: 'users.read' },
  { key: 'billing', label: 'Abonnement', href: '/app/abonnement', perm: 'billing.read' },
  { key: 'emails', label: 'E-mails', href: '/app/emails', perm: 'settings.read' },
  { key: 'audit', label: "Journal d'audit", href: '/app/journal', perm: 'audit.read' },
  { key: 'support', label: 'Support', href: '/app/support', perm: 'settings.admin' },
  { key: 'security', label: 'Ma sécurité', href: '/app/securite' },
];

const under = (path: string, href: string) => path === href || path.startsWith(`${href}/`);
/** L'adresse la plus précise l'emporte : /app/tresorerie/caisse → « Caisse », pas « Vue d'ensemble ». */
export const activeHref = (path: string, hrefs: string[]) => hrefs.filter((h) => under(path, h)).sort((x, y) => y.length - x.length)[0];
export const currentApp = (path: string) => {
  const base = activeHref(path, APPS.map((a) => a.base ?? a.href));
  return APPS.find((a) => (a.base ?? a.href) === base);
};

/** Tuile de l'application : fond en dégradé à sa couleur, pictogramme blanc. */
export function AppIcon({ name, size = 62 }: { name: string; size?: number }) {
  const id = `tile-${useId().replace(/:/g, '')}`;
  const [from, to] = TILES[name] ?? TILES.dashboard;
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={from} /><stop offset="1" stopColor={to} /></linearGradient></defs>
      <rect width="48" height="48" rx="12" fill={`url(#${id})`} />
      <g fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">{GLYPHS[name]}</g>
    </svg>
  );
}
