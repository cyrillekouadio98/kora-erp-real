/*
 * PostgreSQL 16 local sans Docker ni installation système (binaires du paquet embedded-postgres).
 * Premier lancement : initialise .pgdata/, crée les rôles (init.sql) et les bases kora + kora_test,
 * comme le fait infra/db/create-databases.sh dans le conteneur. Ctrl+C pour arrêter.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', '.pgdata');
const port = Number(process.env.PGPORT ?? 5432);
const firstRun = !existsSync(join(dataDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres_dev', port, persistent: true, onLog: () => {} });

if (firstRun) {
  console.log(`Initialisation de PostgreSQL dans ${dataDir}…`);
  await pg.initialise();
}
await pg.start();

if (firstRun) {
  const admin = pg.getPgClient();
  await admin.connect();
  await admin.query(readFileSync(join(here, 'init.sql'), 'utf8'));
  for (const db of ['kora', 'kora_test']) {
    await admin.query(`CREATE DATABASE ${db} OWNER kora_owner`);
    const c = pg.getPgClient(db);
    await c.connect();
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO kora_owner;');
    await c.end();
  }
  await admin.end();
  console.log('Rôles kora_owner, kora_app, kora_platform et bases kora, kora_test créés.');
}

console.log(`PostgreSQL prêt sur localhost:${port} (Ctrl+C pour arrêter).`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
