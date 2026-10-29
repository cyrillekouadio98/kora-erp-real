import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import { Pool, types } from 'pg';
import { config } from '../config';
import type { DB } from './schema';

// numeric -> chaîne (pas de flottant pour les montants) ; date -> chaîne ISO
types.setTypeParser(1700, (v) => v);
types.setTypeParser(1082, (v) => v);

export type Trx = Transaction<DB>;

/** Contexte d'une requête liée à une entreprise. Seul AccessGuard le construit. */
export interface TenantContext {
  companyId: string;
  userId: string;
  actorType: 'user' | 'support';
  ip?: string | null;
}

declare const tenantBrand: unique symbol;
/** Transaction dont app.company_id est posé : seule voie d'accès aux tables métier. */
export type TenantTrx = Trx & { readonly [tenantBrand]: true };

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  /** Rôle kora_app : soumis à la RLS, pour toutes les requêtes des utilisateurs. */
  readonly app: Kysely<DB>;
  /** Rôle kora_platform : opérations de la plateforme (abonnements, console éditeur). */
  readonly platformDb: Kysely<DB>;

  constructor() {
    this.app = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.db.appUrl, max: 20 }) }) });
    this.platformDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.db.platformUrl, max: 5 }) }) });
  }

  /** Transaction isolée sur une entreprise : la base filtre toutes les lignes par app.company_id. */
  async tenant<T>(ctx: TenantContext, fn: (trx: TenantTrx) => Promise<T>): Promise<T> {
    if (!ctx.companyId || !ctx.userId) throw new Error('Contexte entreprise incomplet');
    return this.app.transaction().execute(async (trx) => {
      await sql`select set_config('app.company_id', ${ctx.companyId}, true), set_config('app.user_id', ${ctx.userId}, true)`.execute(trx);
      return fn(trx as TenantTrx);
    });
  }

  /** Transaction sans entreprise active : l'utilisateur ne voit que ses propres adhésions. */
  async asUser<T>(userId: string | null, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.app.transaction().execute(async (trx) => {
      if (userId) await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
      return fn(trx);
    });
  }

  /** Transaction d'authentification : autorise la recherche d'un compte par e-mail ou par jeton de session. */
  async identity<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.app.transaction().execute(async (trx) => {
      await sql`select set_config('app.identity_lookup', 'on', true)`.execute(trx);
      return fn(trx);
    });
  }

  /** Transaction de la plateforme (rôle kora_platform, sans accès aux données métier). */
  async platform<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.platformDb.transaction().execute(fn);
  }

  async onModuleDestroy() {
    await Promise.all([this.app.destroy(), this.platformDb.destroy()]);
  }
}

/** Pose le contexte entreprise sur une transaction déjà ouverte (création d'entreprise, invitation). */
export async function setTenantContext(trx: Trx, companyId: string, userId: string): Promise<TenantTrx> {
  await sql`select set_config('app.company_id', ${companyId}, true), set_config('app.user_id', ${userId}, true)`.execute(trx);
  return trx as TenantTrx;
}
