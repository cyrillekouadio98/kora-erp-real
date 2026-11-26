import type { Entitlements } from '../modules/billing/entitlements';
import { forbidden } from './errors';

/**
 * Modules de Kora activables entreprise par entreprise depuis la console éditeur.
 * La clé est le préfixe des permissions du module (« stock » pour stock.read, stock.create…) :
 * retirer un module retire ces permissions à tous les utilisateurs de l'entreprise (menus masqués,
 * accès refusé par l'API), sans toucher aux données.
 * plan : module d'abonnement qui l'inclut (null = inclus dans toutes les formules).
 * requires : modules sans lesquels il ne fonctionne pas.
 */
export interface ModuleDef { key: string; label: string; description: string; plan: string | null; requires: string[] }

/** Socle : toujours actif, jamais désactivable (les ventes, leurs tiers et leurs règlements alimentent tout le reste). */
export const CORE_MODULES = [
  { key: 'contacts', label: 'Contacts', description: 'Clients, fournisseurs et autres tiers.' },
  { key: 'products', label: 'Articles', description: 'Biens et prestations vendus ou achetés.' },
  { key: 'sales', label: 'Ventes', description: 'Devis, commandes, factures, avoirs et relances.' },
  { key: 'cash', label: 'Trésorerie', description: 'Caisse et mobile money : les règlements des factures y sont enregistrés.' },
];

export const MODULES: ModuleDef[] = [
  { key: 'purchases', label: 'Achats', description: 'Bons de commande et factures fournisseurs, échéancier.', plan: 'purchases', requires: [] },
  { key: 'stock', label: 'Stocks', description: 'Entrepôts, entrées et sorties, inventaires, valorisation.', plan: null, requires: [] },
  { key: 'bank', label: 'Banque', description: 'Comptes bancaires dans la trésorerie.', plan: 'bank', requires: [] },
  { key: 'pos', label: 'Point de vente', description: 'Caisses enregistreuses, sessions et tickets.', plan: null, requires: ['stock'] },
  { key: 'accounting', label: 'Comptabilité', description: 'Écritures, journaux, balance, états financiers. Retirée, les écritures continuent de se passer en arrière-plan.', plan: 'accounting', requires: [] },
  { key: 'reports', label: 'Rapports', description: 'Rapport de gestion et point journalier.', plan: null, requires: [] },
  { key: 'calendar', label: 'Calendrier', description: 'Rendez-vous et événements de l’équipe.', plan: null, requires: [] },
  { key: 'employees', label: 'Employés', description: 'Dossiers du personnel et espace de chaque employé.', plan: 'hr', requires: [] },
  { key: 'leave', label: 'Congés', description: 'Demandes et soldes de congés et d’absences.', plan: 'hr', requires: ['employees'] },
  { key: 'evaluations', label: 'Évaluations', description: 'Entretiens et évaluations du personnel.', plan: 'hr', requires: ['employees'] },
  { key: 'payroll', label: 'Paie', description: 'Contrats, bulletins, déclarations sociales et fiscales.', plan: 'payroll', requires: ['employees'] },
];
export const moduleDef = (key: string) => MODULES.find((m) => m.key === key);

/** Choix de la console : true = ajouté, false = retiré ; absent = selon la formule. */
export type ModuleChoices = Record<string, boolean>;

/**
 * État effectif de chaque module : choix de la console, sinon formule.
 * Un module ajouté hors formule ouvre son module d'abonnement (hr, payroll…) ; ses voisins du même
 * module d'abonnement restent fermés tant qu'ils ne sont pas ajoutés eux aussi.
 * disabled : modules fermés alors que leur module d'abonnement est ouvert (retirés, ou voisins d'un ajout) ;
 * les modules simplement absents de la formule gardent leur refus habituel (« passez à une formule supérieure »).
 */
export function applyModuleChoices(ent: Entitlements, choices: ModuleChoices) {
  const inPlan = (m: ModuleDef) => !m.plan || ent.modules.includes(m.plan);
  const enabled = (m: ModuleDef) => choices[m.key] ?? inPlan(m);
  const modules = new Set(ent.modules);
  for (const m of MODULES) if (enabled(m) && m.plan) modules.add(m.plan);
  const disabled = new Set(MODULES.filter((m) => !enabled(m) && (!m.plan || modules.has(m.plan))).map((m) => m.key));
  return { entitlements: { ...ent, modules: [...modules] }, disabledModules: disabled, state: (m: ModuleDef) => ({ inPlan: inPlan(m), enabled: enabled(m), choice: choices[m.key] ?? null }) };
}

/** Refuse l'accès à un module retiré pour l'entreprise (contrôles qui ne passent pas par une permission du module). */
export function assertModuleOn(t: { disabledModules: Set<string> }, key: string) {
  if (t.disabledModules.has(key)) throw forbidden(`Le module ${moduleDef(key)?.label ?? key} n'est pas activé pour votre entreprise. Contactez Kora ERP pour l'activer.`, 'module_disabled');
}
