/* Applique les migrations SQL versionnées, dans l'ordre, une seule fois chacune. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../config';

/**
 * Migrations renumérotées lors de la fusion de la branche des modules métier : une base qui les a appliquées
 * sous leur ancien nom ne doit pas les rejouer (elles échoueraient) ni prendre leur ancien numéro pour une autre.
 */
const RENAMED: Record<string, string> = {
  '0002_paiements_non_affectes.sql': '0037_paiements_non_affectes.sql',
  '0003_totp_anti_rejeu.sql': '0038_totp_anti_rejeu.sql',
};

export async function migrate(url = config.db.ownerUrl, log = console.log) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const [from, to] of Object.entries(RENAMED)) {
      const r = await client.query('UPDATE schema_migration SET name = $2 WHERE name = $1 AND NOT EXISTS (SELECT 1 FROM schema_migration WHERE name = $2)', [from, to]);
      if (r.rowCount) log(`→ migration ${from} déjà appliquée, renommée ${to}`);
    }
    const done = new Set((await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name));
    const dir = join(__dirname, 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log(`→ migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().then(() => console.log('Migrations à jour.'), (e) => { console.error(e); process.exit(1); });
}
