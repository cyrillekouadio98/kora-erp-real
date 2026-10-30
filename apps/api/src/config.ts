import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Fichier .env local (racine du dépôt ou dossier courant), sans écraser les variables déjà définies. Jamais en test.
if (process.env.NODE_ENV !== 'test') {
  const file = ['.env', '../../.env'].map((p) => resolve(process.cwd(), p)).find(existsSync);
  if (file) process.loadEnvFile(file);
}

/** Configuration lue une fois au démarrage depuis les variables d'environnement. */
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  webUrl: req('WEB_URL', 'http://localhost:3000'),
  db: {
    ownerUrl: req('DATABASE_OWNER_URL', 'postgres://kora_owner:kora_owner_dev@localhost:5432/kora'),
    appUrl: req('DATABASE_APP_URL', 'postgres://kora_app:kora_app_dev@localhost:5432/kora'),
    platformUrl: req('DATABASE_PLATFORM_URL', 'postgres://kora_platform:kora_platform_dev@localhost:5432/kora'),
  },
  session: {
    cookieName: 'kora_session',
    ttlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  },
  security: {
    maxFailedLogins: 5,
    lockMinutes: 15,
    /** Clé de 32 octets (base64) pour chiffrer les secrets TOTP. */
    encryptionKey: req('ENCRYPTION_KEY', 'ZGV2LW9ubHktMzItYnl0ZXMta2V5LWNoYW5nZS1tZSE='),
  },
  payments: {
    sandboxSecret: req('PAYMENT_SANDBOX_SECRET', 'sandbox-secret-dev'),
  },
  jobs: {
    billingIntervalMs: Number(process.env.BILLING_INTERVAL_MS ?? 10 * 60 * 1000),
    enabled: process.env.JOBS_ENABLED !== 'false',
  },
  get isProd() { return this.env === 'production'; },
};
