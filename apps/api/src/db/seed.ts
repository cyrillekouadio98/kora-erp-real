/* Données de référence : formules par défaut et, si demandé, un super administrateur de la plateforme. */
import { hash } from '@node-rs/argon2';
import { Client } from 'pg';
import { config } from '../config';
import { DEFAULT_PLANS } from '../modules/billing/entitlements';

export async function seed(url = config.db.ownerUrl, log = console.log) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const p of DEFAULT_PLANS) {
      const plan = await c.query(
        `INSERT INTO plan (code, name, sort_order) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [p.code, p.name, p.sort]);
      const has = await c.query('SELECT 1 FROM plan_version WHERE plan_id = $1', [plan.rows[0].id]);
      if (!has.rowCount) {
        await c.query(
          `INSERT INTO plan_version (plan_id, version, price_monthly, price_yearly, trial_days, entitlements, published_at)
           VALUES ($1, 1, $2, $3, $4, $5, now())`, [plan.rows[0].id, p.monthly, p.yearly, p.trialDays, JSON.stringify(p.entitlements)]);
        log(`Formule ${p.code} créée`);
      }
    }
    const email = process.env.SEED_SUPERADMIN_EMAIL?.toLowerCase();
    const pw = process.env.SEED_SUPERADMIN_PASSWORD;
    if (email && pw) {
      const u = await c.query(
        `INSERT INTO user_account (email, full_name, password_hash) VALUES ($1, 'Administrateur plateforme', $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`, [email, await hash(pw)]);
      await c.query(`INSERT INTO platform_role_assignment (user_id, role) VALUES ($1, 'super_admin') ON CONFLICT DO NOTHING`, [u.rows[0].id]);
      log(`Super administrateur ${email} prêt (activez la double authentification à la première connexion).`);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

if (require.main === module) seed().then(() => console.log('Données de référence à jour.'), (e) => { console.error(e); process.exit(1); });
