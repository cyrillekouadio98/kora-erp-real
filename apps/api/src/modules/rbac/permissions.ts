/**
 * Catalogue des permissions par entreprise : `module.action`.
 * Les rôles standard reprennent la matrice du dossier de conception (§4.3).
 */
export const ACTIONS = {
  read: 'Consulter', create: 'Créer', update: 'Modifier', validate: 'Valider',
  cancel: 'Annuler', export: 'Exporter', admin: 'Administrer',
} as const;
export type Action = keyof typeof ACTIONS;

/** Modules métier (soumis à l'abonnement) et module d'entitlement correspondant. */
export const BUSINESS_MODULES = {
  contacts: { label: 'Contacts', entitlement: 'contacts' },
  products: { label: 'Articles', entitlement: 'sales' },
  sales: { label: 'Devis et ventes', entitlement: 'sales' },
  purchases: { label: 'Achats', entitlement: 'purchases' },
  cash: { label: 'Caisse', entitlement: 'cash' },
  bank: { label: 'Banque', entitlement: 'bank' },
  accounting: { label: 'Comptabilité', entitlement: 'accounting' },
  employees: { label: 'Employés', entitlement: 'hr' },
  leave: { label: 'Congés et absences', entitlement: 'hr' },
  payroll: { label: 'Paie', entitlement: 'payroll' },
} as const;
export type BusinessModule = keyof typeof BUSINESS_MODULES;

/** Modules d'administration, toujours disponibles quelle que soit la formule. */
export const CORE_PERMISSIONS: Record<string, string> = {
  'users.read': 'Voir les utilisateurs et les rôles',
  'users.admin': 'Gérer les utilisateurs, invitations et rôles',
  'settings.read': "Voir les paramètres de l'entreprise",
  'settings.admin': "Modifier les paramètres de l'entreprise",
  'audit.read': "Consulter le journal d'audit",
  'audit.export': "Exporter le journal d'audit",
  'billing.read': "Voir l'abonnement et les factures",
  'billing.admin': "Changer de formule, résilier, payer l'abonnement",
};

/** Permissions sensibles : jamais attribuées sans décision explicite d'un propriétaire. */
export const SENSITIVE_PERMISSIONS: Record<string, string> = {
  'payroll.salaries': 'Voir les salaires et bulletins de tous les employés',
  'employees.bank_details': 'Voir et modifier les coordonnées bancaires des employés',
  'settings.tax': 'Modifier les paramètres fiscaux',
  'accounting.close': 'Clôturer une période ou un exercice',
  'accounting.reverse': 'Contre-passer une écriture validée',
  'data.export_all': "Exporter l'intégralité des données de l'entreprise",
};

/** Accès limités à ses propres données (espace employé). */
export const SELF_PERMISSIONS: Record<string, string> = {
  'employees.self': 'Voir sa propre fiche',
  'leave.self': 'Demander et suivre ses congés',
  'payroll.self': 'Voir ses propres bulletins',
};

export function allPermissions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [m, def] of Object.entries(BUSINESS_MODULES)) {
    for (const [a, label] of Object.entries(ACTIONS)) out[`${m}.${a}`] = `${def.label} : ${label.toLowerCase()}`;
  }
  return { ...out, ...CORE_PERMISSIONS, ...SENSITIVE_PERMISSIONS, ...SELF_PERMISSIONS };
}
export const PERMISSION_KEYS = new Set(Object.keys(allPermissions()));
export const isSensitive = (p: string) => p in SENSITIVE_PERMISSIONS;

/** Module d'abonnement requis par une permission (null = toujours disponible). */
export function entitlementFor(permission: string): string | null {
  const mod = permission.split('.')[0] as BusinessModule;
  return BUSINESS_MODULES[mod]?.entitlement ?? null;
}

const LETTERS: Record<string, Action> = { L: 'read', C: 'create', M: 'update', V: 'validate', N: 'cancel', E: 'export', A: 'admin' };
function expand(matrix: Partial<Record<BusinessModule, string>>): string[] {
  const out: string[] = [];
  for (const [m, letters] of Object.entries(matrix)) for (const l of letters!) out.push(`${m}.${LETTERS[l]}`);
  return out;
}

export interface RoleTemplate { key: string; name: string; description: string; permissions: string[] }

/** Rôles standard copiés dans chaque nouvelle entreprise (modifiables, sauf « owner »). */
export const DEFAULT_ROLES: RoleTemplate[] = [
  {
    key: 'owner', name: 'Propriétaire / administrateur', description: "Tous les droits sur l'entreprise",
    permissions: [
      ...expand({ contacts: 'LCMNEA', products: 'LCMNEA', sales: 'LCMVNEA', purchases: 'LCMVNEA', cash: 'LCMVNEA', bank: 'LCMVNEA', accounting: 'LCMVNEA', employees: 'LCMNEA', leave: 'LCMVNEA', payroll: 'LCMVNEA' }),
      ...Object.keys(CORE_PERMISSIONS), ...Object.keys(SENSITIVE_PERMISSIONS),
    ],
  },
  {
    key: 'director', name: 'Directeur / gérant', description: 'Pilotage et validations',
    permissions: [...expand({ contacts: 'LE', products: 'LE', sales: 'LVE', purchases: 'LVE', cash: 'LVE', bank: 'LVE', accounting: 'LE', employees: 'LE', leave: 'LV', payroll: 'LVE' }), 'users.read', 'settings.read', 'audit.read', 'billing.read'],
  },
  {
    key: 'accountant', name: 'Comptable', description: 'Comptabilité, achats et banque',
    permissions: [...expand({ contacts: 'LCME', products: 'LCME', sales: 'LE', purchases: 'LCMVNE', cash: 'LE', bank: 'LCMVNE', accounting: 'LCMVNE', payroll: 'LE' }), 'settings.read', 'settings.tax', 'accounting.close', 'accounting.reverse'],
  },
  {
    key: 'finance_manager', name: 'Responsable financier', description: 'Trésorerie et validations financières',
    permissions: [...expand({ contacts: 'LE', products: 'LE', sales: 'LVE', purchases: 'LVE', cash: 'LVE', bank: 'LCMVNE', accounting: 'LVE', payroll: 'LE' }), 'settings.read', 'billing.read'],
  },
  { key: 'cashier', name: 'Caissier', description: 'Encaissements et décaissements', permissions: expand({ contacts: 'L', products: 'L', sales: 'L', cash: 'LC' }) },
  { key: 'sales_rep', name: 'Commercial', description: 'Clients, devis et ventes', permissions: expand({ contacts: 'LCM', products: 'L', sales: 'LCM' }) },
  { key: 'hr_manager', name: 'Responsable RH', description: 'Employés et congés', permissions: expand({ employees: 'LCMNE', leave: 'LCMVNE', payroll: 'L' }) },
  { key: 'payroll_manager', name: 'Gestionnaire de paie', description: 'Calcul et validation de la paie', permissions: [...expand({ employees: 'LM', leave: 'L', payroll: 'LCMVE' }), 'payroll.salaries', 'employees.bank_details'] },
  { key: 'employee', name: 'Employé', description: 'Espace personnel', permissions: Object.keys(SELF_PERMISSIONS) },
  { key: 'auditor', name: 'Auditeur / consultant', description: 'Lecture seule, accès limité dans le temps', permissions: [...expand({ contacts: 'L', products: 'LE', sales: 'LE', purchases: 'LE', cash: 'LE', bank: 'LE', accounting: 'LE' }), 'settings.read', 'audit.read'] },
];

// Garde-fou : chaque permission d'un rôle standard existe dans le catalogue.
for (const r of DEFAULT_ROLES) for (const p of r.permissions) {
  if (!PERMISSION_KEYS.has(p)) throw new Error(`Permission inconnue dans le rôle ${r.key} : ${p}`);
}
