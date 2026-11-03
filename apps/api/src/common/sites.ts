import { forbidden } from './errors';
import type { TenantInfo } from './request-context';

/** Sites dont on montre les données : le site choisi, sinon ceux permis à l'utilisateur ; null = tous. */
/** Identifiant qui ne correspond à aucun site : filtre vide quand la limite ne laisse aucun site. */
export const NONE = '00000000-0000-0000-0000-000000000000';

export const siteScope = (t: TenantInfo): string[] | null => (t.siteId ? [t.siteId] : t.allowedSiteIds);

/** Site d'un nouvel enregistrement : le site choisi, ou le seul permis ; null laisse la base prendre le site principal. */
export const workingSite = (t: TenantInfo): string | null => t.siteId ?? (t.allowedSiteIds?.length ? t.allowedSiteIds[0] : null);

/** Un utilisateur limité à certains sites n'accède pas aux données des autres. */
export function assertSiteAccess(t: TenantInfo, siteId: string | null | undefined) {
  if (siteId && t.allowedSiteIds && !t.allowedSiteIds.includes(siteId)) {
    throw forbidden("Ce document appartient à un site auquel vous n'avez pas accès.", 'site_forbidden');
  }
}

/** Filtre « site dans le périmètre » pour une requête Kysely (colonne site_id de la table indiquée). */
export function inScope<Q extends { where: (...a: any[]) => Q }>(q: Q, t: TenantInfo, column: string): Q {
  const scope = siteScope(t);
  if (!scope) return q;
  return scope.length ? q.where(column, 'in', scope) : q.where(column, '=', NONE);
}
