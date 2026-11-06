/*
 * Prépare une base PostgreSQL hébergée pour Kora ERP, à lancer une fois depuis votre poste, à la racine du projet :
 *   node infra/db/setup-hosted.mjs "postgres://ADMIN:MOTDEPASSE@HOTE:5432/postgres"
 * L'adresse est celle du rôle administrateur fourni par l'hébergeur. Le script crée les rôles kora_owner (migrations),
 * kora_app (API, soumis à la RLS) et kora_platform (console), applique les migrations et les données de référence,
 * puis affiche les trois adresses de connexion à reporter dans l'hébergeur de l'API.
 *
 * - Supabase (détecté par l'adresse, ou --schema) : les tables vont dans un schéma « kora » de la base postgres, hors de
 *   portée de l'API publique de Supabase ; connexions par le pooler (port 5432 pour les migrations, 6543 pour l'API).
 * - Autres hébergeurs (Neon…) : une base « kora » dédiée.
 * Options : --sans-migrations (rôles seulement). SEED_SUPERADMIN_EMAIL et SEED_SUPERADMIN_PASSWORD, s'ils sont définis,
 * créent le compte de la console éditeur. Relancé, le script régénère les mots de passe : reportez les nouvelles adresses.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const args = process.argv.slice(2);
const adminUrl = args.find((a) => !a.startsWith('--')) ?? process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error('Usage : node infra/db/setup-hosted.mjs "postgres://ADMIN:MOTDEPASSE@HOTE:5432/postgres" [--schema] [--sans-migrations]');
  process.exit(1);
}
const admin = new URL(adminUrl);
const supabase = /\.supabase\.(com|co)$/.test(admin.hostname);
const schemaMode = supabase || args.includes('--schema');
const pooler = admin.hostname.endsWith('pooler.supabase.com');
// Le pooler de Supabase lit le projet dans le nom d'utilisateur (postgres.<projet>) : chaque rôle garde ce suffixe.
const suffix = pooler && admin.username.includes('.') ? admin.username.slice(admin.username.indexOf('.')) : '';
// Certificat de Supabase signé par sa propre autorité : connexion chiffrée sans vérification de la chaîne.
if (supabase) admin.searchParams.set('sslmode', 'no-verify');
const DB = schemaMode ? admin.pathname.slice(1) || 'postgres' : 'kora';
const SCHEMA = 'kora';

const ROLES = [
  { name: 'kora_owner', attrs: 'LOGIN BYPASSRLS', env: 'DATABASE_OWNER_URL', port: null },
  { name: 'kora_app', attrs: 'LOGIN NOSUPERUSER NOBYPASSRLS', env: 'DATABASE_APP_URL', port: pooler ? '6543' : null },
  { name: 'kora_platform', attrs: 'LOGIN NOSUPERUSER NOBYPASSRLS', env: 'DATABASE_PLATFORM_URL', port: pooler ? '6543' : null },
];
const urlFor = (role, password, port) => {
  const u = new URL(admin.toString());
  u.username = role + suffix; u.password = password; u.pathname = `/${DB}`;
  if (port) u.port = port;
  return u.toString();
};
const connect = async (url) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };

const out = {};
const c = await connect(admin.toString());
try {
  for (const r of ROLES) {
    const password = randomBytes(24).toString('base64url');
    const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r.name])).rowCount;
    // Les mots de passe ne passent pas par les paramètres ($1) : CREATE ROLE ne les accepte pas ; ils ne contiennent que [A-Za-z0-9_-].
    await c.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${r.name} ${r.attrs} PASSWORD '${password}'`);
    out[r.env] = urlFor(r.name, password, r.port);
    console.log(`Rôle ${r.name} ${exists ? 'mis à jour' : 'créé'}.`);
  }
  // Pour créer ce dont kora_owner est propriétaire, l'administrateur doit pouvoir endosser ce rôle.
  await c.query('GRANT kora_owner TO CURRENT_USER').catch(() => {});
  if (!(await c.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'kora_owner'`)).rows[0].rolbypassrls) {
    console.error("\nkora_owner n'a pas l'attribut BYPASSRLS : les migrations qui modifient des données échoueraient. Arrêt ; voyez la documentation de l'hébergeur.");
    process.exit(1);
  }
  if (schemaMode) {
    // Extension demandée par la première migration : déjà présente sur Supabase, sinon installée par l'administrateur.
    await c.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA} AUTHORIZATION kora_owner`);
    for (const r of ROLES) await c.query(`ALTER ROLE ${r.name} SET search_path TO ${SCHEMA}, public`);
    await c.query(`GRANT USAGE ON SCHEMA public TO kora_owner WITH GRANT OPTION`).catch(() => {});
    await c.query(`SET ROLE kora_owner; GRANT USAGE ON SCHEMA ${SCHEMA} TO kora_app, kora_platform; RESET ROLE;`);
    console.log(`Schéma ${SCHEMA} prêt dans la base ${DB}.`);
  } else if (!(await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])).rowCount) {
    await c.query(`CREATE DATABASE ${DB} OWNER kora_owner`);
    console.log(`Base ${DB} créée.`);
  }
} finally {
  await c.end();
}

if (!schemaMode) {
  const u = new URL(admin.toString()); u.pathname = `/${DB}`;
  const d = await connect(u.toString());
  try { await d.query('REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO kora_owner;'); } finally { await d.end(); }
}

if (!args.includes('--sans-migrations')) {
  for (const task of ['db:migrate', 'db:seed']) {
    console.log(`\n→ npm run ${task}`);
    // Compte de la console : seulement celui donné à la commande, jamais celui du .env de développement.
    const seed = { SEED_SUPERADMIN_EMAIL: process.env.SEED_SUPERADMIN_EMAIL ?? '', SEED_SUPERADMIN_PASSWORD: process.env.SEED_SUPERADMIN_PASSWORD ?? '' };
    const r = spawnSync('npm', ['run', task, '-w', 'apps/api'], { stdio: 'inherit', env: { ...process.env, ...out, ...seed, NODE_ENV: 'development' } });
    if (r.status !== 0) { console.error(`\nÉchec de ${task}.`); process.exit(1); }
  }
}

console.log("\nBase prête. Variables à reporter dans l'hébergeur de l'API (gardez-les secrètes) :\n");
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
