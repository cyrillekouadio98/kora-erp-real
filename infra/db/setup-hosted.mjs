/*
 * Prépare une base PostgreSQL hébergée (Neon, Supabase…) pour N'Ora ERP, à lancer une fois depuis votre poste :
 *   node infra/db/setup-hosted.mjs "postgres://ADMIN:MOTDEPASSE@HOTE/neondb?sslmode=require"
 * L'adresse est celle du rôle administrateur fourni par l'hébergeur. Le script crée les rôles kora_owner (migrations),
 * kora_app (API, soumis à la RLS) et kora_platform (console), la base kora, puis affiche les trois adresses de connexion
 * à reporter dans l'hébergeur de l'API. Relancé, il régénère les mots de passe : reportez alors les nouvelles adresses.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.argv[2] ?? process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error('Usage : node infra/db/setup-hosted.mjs "postgres://ADMIN:MOTDEPASSE@HOTE/BASE?sslmode=require"');
  process.exit(1);
}
const DB = 'kora';
const ROLES = [
  { name: 'kora_owner', attrs: 'LOGIN BYPASSRLS', env: 'DATABASE_OWNER_URL' },
  { name: 'kora_app', attrs: 'LOGIN NOSUPERUSER NOBYPASSRLS', env: 'DATABASE_APP_URL' },
  { name: 'kora_platform', attrs: 'LOGIN NOSUPERUSER NOBYPASSRLS', env: 'DATABASE_PLATFORM_URL' },
];
const urlFor = (role, password, database) => {
  const u = new URL(adminUrl);
  u.username = role; u.password = password; u.pathname = `/${database}`;
  return u.toString();
};
const connect = async (url) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };

const admin = await connect(adminUrl);
const out = [];
try {
  for (const r of ROLES) {
    const password = randomBytes(24).toString('base64url');
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r.name])).rowCount;
    // Les mots de passe ne passent pas par les paramètres ($1) : CREATE ROLE ne les accepte pas ; ils ne contiennent que [A-Za-z0-9_-].
    await admin.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${r.name} ${r.attrs} PASSWORD '${password}'`);
    out.push(`${r.env}=${urlFor(r.name, password, DB)}`);
    console.log(`Rôle ${r.name} ${exists ? 'mis à jour' : 'créé'}.`);
  }
  // Pour créer une base dont kora_owner est propriétaire, l'administrateur doit pouvoir endosser ce rôle.
  await admin.query('GRANT kora_owner TO CURRENT_USER').catch(() => {});
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])).rowCount) {
    await admin.query(`CREATE DATABASE ${DB} OWNER kora_owner`);
    console.log(`Base ${DB} créée.`);
  }
  const bypass = (await admin.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'kora_owner'`)).rows[0].rolbypassrls;
  if (!bypass) console.warn('Attention : kora_owner n\'a pas l\'attribut BYPASSRLS ; les migrations qui modifient des données échoueront. Voyez la documentation de votre hébergeur.');
} finally {
  await admin.end();
}

const db = await connect(urlFor(new URL(adminUrl).username, decodeURIComponent(new URL(adminUrl).password), DB));
try {
  await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO kora_owner;');
} finally {
  await db.end();
}

console.log('\nBase prête. Variables à reporter dans l\'hébergeur de l\'API (gardez-les secrètes) :\n');
console.log(out.join('\n'));
