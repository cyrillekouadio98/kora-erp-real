import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Fichier .env local (racine du dépôt ou dossier courant), sans écraser les variables déjà définies. Jamais en test.
if (process.env.NODE_ENV !== 'test') {
  const file = ['.env', '../../.env'].map((p) => resolve(process.cwd(), p)).find(existsSync);
  if (file) process.loadEnvFile(file);
}

/** Configuration lue une fois au démarrage depuis les variables d'environnement. */
const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';

/**
 * Lit une variable obligatoire. La valeur de développement n'est utilisée qu'hors production :
 * en production, la variable doit être fournie ET différente de cette valeur (connue publiquement).
 */
function req(name: string, devFallback?: string): string {
  const v = process.env[name] || (isProd ? undefined : devFallback);
  if (v === undefined || v === '') throw new Error(`Variable d'environnement manquante : ${name}`);
  if (isProd && devFallback !== undefined && v === devFallback) {
    throw new Error(`${name} utilise la valeur de développement : interdit en production, fournissez un secret propre à l'environnement.`);
  }
  return v;
}

/** Les mots de passe de développement des rôles PostgreSQL (infra/db/init.sql) sont refusés en production. */
function dbUrl(name: string, devFallback: string): string {
  const v = req(name, devFallback);
  if (isProd && /:kora_(owner|app|platform)_dev@/.test(v)) {
    throw new Error(`${name} utilise un mot de passe de développement : interdit en production.`);
  }
  return v;
}

function encryptionKey(): string {
  const v = req('ENCRYPTION_KEY', 'ZGV2LW9ubHktMzItYnl0ZXMta2V5LWNoYW5nZS1tZSE=');
  if (Buffer.from(v, 'base64').length !== 32) throw new Error('ENCRYPTION_KEY doit faire 32 octets (base64) : openssl rand -base64 32');
  return v;
}

/**
 * Proxys de confiance devant l'API, pour lire l'adresse IP réelle du client (limite de débit, journal).
 * Nombre de sauts (1 = le serveur Next.js seul ; 2 = un répartiteur de charge devant Next.js),
 * ou liste d'adresses/sous-réseaux au format Express (« loopback, 10.0.0.0/8 »).
 */
function trustProxy(): number | string {
  const v = (process.env.TRUST_PROXY ?? '1').trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true') throw new Error("TRUST_PROXY=true ferait confiance à n'importe quel en-tête X-Forwarded-For : indiquez un nombre de sauts ou des adresses.");
  return v;
}

export const config = {
  env,
  /** Double authentification exigée pour la console éditeur : partout sauf en développement local (PLATFORM_MFA_REQUIRED force le choix). */
  platformMfaRequired: process.env.PLATFORM_MFA_REQUIRED ? process.env.PLATFORM_MFA_REQUIRED === 'true' : env !== 'development',
  port: Number(process.env.PORT ?? 3001),
  trustProxy: trustProxy(),
  webUrl: req('WEB_URL', 'http://localhost:3000'),
  db: {
    ownerUrl: dbUrl('DATABASE_OWNER_URL', 'postgres://kora_owner:kora_owner_dev@localhost:5432/kora'),
    appUrl: dbUrl('DATABASE_APP_URL', 'postgres://kora_app:kora_app_dev@localhost:5432/kora'),
    platformUrl: dbUrl('DATABASE_PLATFORM_URL', 'postgres://kora_platform:kora_platform_dev@localhost:5432/kora'),
  },
  session: {
    cookieName: 'kora_session',
    ttlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  },
  security: {
    maxFailedLogins: 5,
    lockMinutes: 15,
    /** Clé de 32 octets (base64) pour chiffrer les secrets TOTP. */
    encryptionKey: encryptionKey(),
  },
  payments: {
    /**
     * Secret du prestataire de test. null en production : le prestataire de test n'y est jamais
     * branché (quiconque connaît le secret pourrait forger des notifications de paiement).
     */
    sandboxSecret: isProd ? null : (process.env.PAYMENT_SANDBOX_SECRET || 'sandbox-secret-dev'),
  },
  mail: {
    /** smtp://utilisateur:motdepasse@serveur:587 — sans valeur, les e-mails restent dans Kora (mode développement). */
    smtpUrl: process.env.SMTP_URL || null,
    from: process.env.MAIL_FROM ?? 'Kora ERP <no-reply@kora.local>',
    intervalMs: Number(process.env.MAIL_INTERVAL_MS ?? 15_000),
  },
  jobs: {
    billingIntervalMs: Number(process.env.BILLING_INTERVAL_MS ?? 10 * 60 * 1000),
    enabled: process.env.JOBS_ENABLED !== 'false',
    /** Secret de POST /jobs/tick (tâches déclenchées par un planificateur externe) ; absent, la route n'existe pas. */
    cronSecret: process.env.CRON_SECRET || null,
  },
  /** Connexions par rôle et par instance : réduire sur un hébergement sans serveur (Vercel), où les instances se multiplient. */
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 20),
  isProd,
};

// En production, l'interface ne peut pas pointer vers localhost (les autres valeurs de développement
// sont déjà refusées par req() et dbUrl(), et le prestataire de paiement de test n'existe pas).
if (config.isProd && config.webUrl.includes('localhost')) {
  throw new Error('Valeurs de développement interdites en production : WEB_URL');
}
