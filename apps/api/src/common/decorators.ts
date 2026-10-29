import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { KoraRequest } from './request-context';

export const META = {
  public: 'kora:public',
  pendingMfa: 'kora:pendingMfa',
  platformRoles: 'kora:platformRoles',
  permission: 'kora:permission',
  tenant: 'kora:tenant',
  whenReadOnly: 'kora:whenReadOnly',
} as const;

/** Route accessible sans connexion. */
export const Public = () => SetMetadata(META.public, true);
/** Route accessible avant la vérification du second facteur. */
export const AllowPendingMfa = () => SetMetadata(META.pendingMfa, true);
/** Route de la console éditeur, réservée à certains rôles de plateforme. */
export const PlatformRoles = (...roles: string[]) => SetMetadata(META.platformRoles, roles);
/** Route liée à l'entreprise active, exigeant une permission (ou null : simple adhésion). */
export const Permission = (permission: string | null) => SetMetadata(META.permission, permission ?? '');
/** Autorisée même si l'entreprise est en lecture seule (suspension, résiliation) : consultation, export, paiement. */
export const AllowWhenReadOnly = () => SetMetadata(META.whenReadOnly, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<KoraRequest>().auth!);
export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<KoraRequest>().tenant!);
