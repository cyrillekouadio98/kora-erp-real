/** Applications de l'écran d'accueil : une tuile et une icône par domaine de Kora. */

const P = '#8a4f7d', T = '#5ccfb8', O = '#f08a3c', C = '#ef7b7b', Y = '#f4bf4f', N = '#2c5d7c', B = '#4f9be8', G = '#2f9a72', W = '#ffffff';

const ICONS: Record<string, React.ReactNode> = {
  dashboard: <>
    <rect x="6" y="26" width="10" height="16" rx="2" fill={P} /><rect x="19" y="16" width="10" height="26" rx="2" fill={C} /><rect x="32" y="6" width="10" height="36" rx="2" fill={Y} />
  </>,
  sales: <>
    <path d="M8 16h32l-3 26H11z" fill={O} /><path d="M8 16h32l-1.4 12H9.4z" fill={C} opacity=".85" />
    <path d="M17 19v-6a7 7 0 0 1 14 0v6" stroke={P} strokeWidth="3.5" fill="none" strokeLinecap="round" />
  </>,
  purchases: <>
    <rect x="15" y="13" width="24" height="14" rx="2" fill={T} />
    <path d="M4 7h6l5 23h23" stroke={N} strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="18" cy="38" r="4" fill={P} /><circle cx="34" cy="38" r="4" fill={P} />
  </>,
  treasury: <>
    <rect x="4" y="8" width="30" height="20" rx="3" fill={T} /><circle cx="19" cy="18" r="5" fill={W} opacity=".55" />
    <path d="M24 30h20v8a10 4 0 0 1-20 0z" fill={O} /><ellipse cx="34" cy="30" rx="10" ry="4" fill={Y} />
  </>,
  accounting: <>
    <rect x="10" y="4" width="28" height="40" rx="4" fill={N} /><rect x="14" y="8" width="20" height="9" rx="1.5" fill={T} />
    {[24, 31, 38].map((y, r) => [17, 24, 31].map((x, c) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2.6" fill={r === 2 && c === 2 ? O : [Y, C, W][c]} opacity={c === 2 && r < 2 ? .8 : 1} />))}
  </>,
  stock: <>
    <rect x="6" y="24" width="18" height="18" rx="2" fill={O} /><rect x="24" y="24" width="18" height="18" rx="2" fill={T} /><rect x="15" y="6" width="18" height="18" rx="2" fill={P} />
    <rect x="13" y="24" width="4" height="6" fill={W} opacity=".55" /><rect x="31" y="24" width="4" height="6" fill={W} opacity=".55" /><rect x="22" y="6" width="4" height="6" fill={W} opacity=".55" />
  </>,
  products: <>
    <path d="M6 8v14l20 20 16-16L22 6H8a2 2 0 0 0-2 2z" fill={C} /><path d="M26 42l16-16-9-9-16 16z" fill={Y} opacity=".85" /><circle cx="14" cy="14" r="3.5" fill={W} />
  </>,
  contacts: <>
    <circle cx="18" cy="16" r="7" fill={P} /><path d="M4 42a14 13 0 0 1 28 0z" fill={P} />
    <circle cx="32" cy="18" r="6" fill={T} opacity=".9" /><path d="M20 42a12 11 0 0 1 24 0z" fill={T} opacity=".9" />
  </>,
  employees: <>
    <rect x="8" y="8" width="32" height="36" rx="4" fill={B} /><rect x="19" y="4" width="10" height="8" rx="2" fill={N} />
    <circle cx="24" cy="22" r="6" fill={W} /><rect x="14" y="33" width="20" height="4" rx="2" fill={Y} />
  </>,
  leave: <>
    <circle cx="30" cy="16" r="10" fill={Y} />
    <path d="M4 31c6-5 10-5 16 0s10 5 16 0 8-4 8-4v17H4z" fill={B} /><path d="M4 38c6-5 10-5 16 0s10 5 16 0 8-4 8-4v10H4z" fill={T} />
  </>,
  payroll: <>
    <rect x="8" y="4" width="26" height="36" rx="3" fill={P} /><rect x="13" y="11" width="16" height="3" rx="1.5" fill={W} opacity=".6" /><rect x="13" y="18" width="11" height="3" rx="1.5" fill={W} opacity=".6" />
    <circle cx="34" cy="34" r="10" fill={G} /><path d="M29 34l3.5 3.5L39 31" stroke={W} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </>,
  me: <>
    <circle cx="24" cy="24" r="20" fill={T} /><circle cx="24" cy="19" r="7" fill={W} />
    <path d="M12 38c2-7 7-10 12-10s10 3 12 10c-3.5 3-7.6 4.6-12 4.6S15.5 41 12 38z" fill={W} />
  </>,
  company: <>
    <rect x="8" y="8" width="20" height="36" rx="2" fill={N} /><rect x="26" y="20" width="14" height="24" rx="2" fill={O} />
    {[14, 21, 28].map((y) => [12, 19].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="5" height="4" rx="1" fill={Y} />))}
    <rect x="30" y="26" width="6" height="4" rx="1" fill={W} opacity=".6" /><rect x="30" y="33" width="6" height="4" rx="1" fill={W} opacity=".6" />
  </>,
  users: <>
    <circle cx="11" cy="20" r="5" fill={Y} /><path d="M2 38a9 9 0 0 1 18 0z" fill={Y} />
    <circle cx="37" cy="20" r="5" fill={T} /><path d="M28 38a9 9 0 0 1 18 0z" fill={T} />
    <circle cx="24" cy="15" r="7" fill={P} /><path d="M12 42a12 12 0 0 1 24 0z" fill={P} />
  </>,
  roles: <>
    <path d="M24 21h18v6h-4v6h-6v-6h-8z" fill={P} /><circle cx="16" cy="24" r="11" fill={Y} /><circle cx="16" cy="24" r="4" fill={W} />
  </>,
  billing: <>
    <path d="M39 18A16 16 0 0 0 9 18" stroke={T} strokeWidth="5" fill="none" strokeLinecap="round" /><path d="M41 12l-1 9-8-4z" fill={T} />
    <path d="M9 30a16 16 0 0 0 30 0" stroke={O} strokeWidth="5" fill="none" strokeLinecap="round" /><path d="M7 36l1-9 8 4z" fill={O} />
  </>,
  emails: <>
    <rect x="4" y="10" width="38" height="28" rx="4" fill={C} /><path d="M6 14l17 13 17-13" stroke={W} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="40" cy="11" r="6" fill={Y} />
  </>,
  audit: <>
    <rect x="8" y="6" width="26" height="36" rx="3" fill={B} /><rect x="13" y="13" width="16" height="3" rx="1.5" fill={W} opacity=".6" /><rect x="13" y="20" width="12" height="3" rx="1.5" fill={W} opacity=".6" />
    <path d="M37 36l6 6" stroke={N} strokeWidth="4.5" strokeLinecap="round" /><circle cx="32" cy="31" r="7" stroke={N} strokeWidth="4" fill={W} />
  </>,
  support: <>
    <circle cx="24" cy="24" r="18" fill={C} /><circle cx="24" cy="24" r="13" stroke={W} strokeWidth="10" fill="none" strokeDasharray="10.4 10" strokeDashoffset="5.2" opacity=".9" />
    <circle cx="24" cy="24" r="7" fill={W} />
  </>,
  security: <>
    <path d="M24 4l16 6v12c0 10-7 18-16 22C15 40 8 32 8 22V10z" fill={G} /><path d="M24 4l16 6v12c0 10-7 18-16 22z" fill={T} opacity=".8" />
    <path d="M17 24l5 5 9-10" stroke={W} strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </>,
};

export interface App { key: string; label: string; href: string; perm?: string; module?: string }

/** Même droits que le menu : une application n'apparaît que si le rôle et la formule l'autorisent. */
export const APPS: App[] = [
  { key: 'dashboard', label: 'Tableau de bord', href: '/app/tableau-de-bord' },
  { key: 'sales', label: 'Ventes', href: '/app/ventes/factures', perm: 'sales.read' },
  { key: 'purchases', label: 'Achats', href: '/app/achats/factures', perm: 'purchases.read', module: 'purchases' },
  { key: 'treasury', label: 'Trésorerie', href: '/app/tresorerie', perm: 'cash.read', module: 'cash' },
  { key: 'accounting', label: 'Comptabilité', href: '/app/comptabilite', perm: 'accounting.read', module: 'accounting' },
  { key: 'stock', label: 'Stocks', href: '/app/stocks', perm: 'products.read' },
  { key: 'products', label: 'Articles', href: '/app/articles', perm: 'products.read' },
  { key: 'contacts', label: 'Contacts', href: '/app/contacts', perm: 'contacts.read' },
  { key: 'employees', label: 'Employés', href: '/app/employes', perm: 'employees.read', module: 'hr' },
  { key: 'leave', label: 'Congés', href: '/app/conges', perm: 'leave.read', module: 'hr' },
  { key: 'payroll', label: 'Paie', href: '/app/paie', perm: 'payroll.read', module: 'payroll' },
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

export function AppIcon({ name, size = 62 }: { name: string; size?: number }) {
  return <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">{ICONS[name]}</svg>;
}
