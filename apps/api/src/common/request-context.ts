import type { Request } from 'express';
import type { Entitlements } from '../modules/billing/entitlements';
import type { SubscriptionStatus } from '../db/schema';
import type { TenantContext } from '../db/database.service';

export interface AuthInfo {
  userId: string;
  sessionId: string;
  email: string;
  activeCompanyId: string | null;
  activeSiteId: string | null;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  platformRoles: string[];
}

export interface TenantInfo {
  ctx: TenantContext;
  companyId: string;
  membershipId: string;
  isOwner: boolean;
  permissions: Set<string>;
  entitlements: Entitlements;
  companyStatus: 'active' | 'suspended' | 'closed';
  subscriptionStatus: SubscriptionStatus | null;
  readOnly: boolean;
  /** Site choisi dans l'en-tête (null : tous les sites autorisés). */
  siteId: string | null;
  /** Sites auxquels l'utilisateur est limité (null : tous). */
  allowedSiteIds: string[] | null;
}

export interface KoraRequest extends Request {
  auth?: AuthInfo;
  tenant?: TenantInfo;
  rawBody?: Buffer;
}

export const clientIp = (req: Request) => (req.ip ?? req.socket?.remoteAddress ?? null);
