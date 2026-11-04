/** Droits d'une formule : modules, quotas et options. Le code ne teste jamais le nom d'une formule. */
export interface Entitlements {
  modules: string[];
  quotas: { users: number | null; companies: number | null; storage_mb: number | null; employees: number | null };
  features: { export_advanced: boolean; api: boolean; support_level: string };
}

export const ALL_MODULES = ['contacts', 'sales', 'cash', 'purchases', 'bank', 'accounting', 'hr', 'payroll'];

export function normalizeEntitlements(raw: unknown, overrides?: unknown): Entitlements {
  const base = (raw ?? {}) as Partial<Entitlements>;
  const ov = ((overrides as Record<string, unknown>)?.entitlements ?? {}) as Partial<Entitlements>;
  return {
    modules: Array.from(new Set([...(base.modules ?? []), ...(ov.modules ?? [])])),
    quotas: { users: null, companies: null, storage_mb: null, employees: null, ...base.quotas, ...ov.quotas },
    features: { export_advanced: false, api: false, support_level: 'email', ...base.features, ...ov.features },
  };
}

/** Formules de départ — prix en FCFA ; une base existante reçoit les changements par une nouvelle version (migration). */
export const DEFAULT_PLANS: Array<{ code: string; name: string; sort: number; monthly: number; yearly: number; trialDays: number; entitlements: Entitlements }> = [
  { code: 'starter', name: 'Starter', sort: 1, monthly: 20000, yearly: 200000, trialDays: 14,
    entitlements: { modules: ['contacts', 'sales', 'cash'], quotas: { users: 5, companies: 1, storage_mb: 2048, employees: 0 }, features: { export_advanced: false, api: false, support_level: 'email' } } },
  { code: 'business', name: 'Business', sort: 2, monthly: 40000, yearly: 400000, trialDays: 14,
    entitlements: { modules: ['contacts', 'sales', 'cash', 'purchases', 'bank', 'accounting'], quotas: { users: 10, companies: 1, storage_mb: 10240, employees: 0 }, features: { export_advanced: true, api: false, support_level: 'email_48h' } } },
  { code: 'premium', name: 'Premium', sort: 3, monthly: 75000, yearly: 750000, trialDays: 14,
    entitlements: { modules: ALL_MODULES, quotas: { users: 15, companies: 1, storage_mb: 51200, employees: 50 }, features: { export_advanced: true, api: true, support_level: 'priority_24h' } } },
  { code: 'cabinet', name: 'Cabinet', sort: 4, monthly: 150000, yearly: 1500000, trialDays: 14,
    entitlements: { modules: ALL_MODULES, quotas: { users: null, companies: 10, storage_mb: 102400, employees: 50 }, features: { export_advanced: true, api: true, support_level: 'priority' } } },
  { code: 'enterprise', name: 'Enterprise', sort: 5, monthly: 0, yearly: 0, trialDays: 0,
    entitlements: { modules: ALL_MODULES, quotas: { users: null, companies: null, storage_mb: null, employees: null }, features: { export_advanced: true, api: true, support_level: 'dedicated' } } },
];
export const DEFAULT_TRIAL_PLAN = 'business';
