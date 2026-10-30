import 'reflect-metadata';
import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { encrypt } from '../src/common/crypto';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { config } from '../src/config';
import { migrate } from '../src/db/migrate';
import { seed } from '../src/db/seed';

export async function ownerClient() {
  const c = new Client({ connectionString: config.db.ownerUrl });
  await c.connect();
  return c;
}

/** Base de test vierge : schéma recréé, migrations et données de référence appliquées. */
export async function resetDb() {
  // Garde-fou : ce reset supprime tout le schéma, il ne doit jamais toucher la base de développement.
  if (!new URL(config.db.ownerUrl).pathname.endsWith('_test')) {
    throw new Error(`Les tests refusent de s'exécuter hors d'une base *_test (reçu : ${config.db.ownerUrl}).`);
  }
  const c = await ownerClient();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(config.db.ownerUrl, () => {});
  await seed(config.db.ownerUrl, () => {});
}

export async function createApp(extraControllers: Type<unknown>[] = []): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule], controllers: extraControllers }).compile();
  const app = mod.createNestApplication({ rawBody: true, logger: ['error'] });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

let n = 0;
export function uniqueEmail(prefix = 'user') { n += 1; return `${prefix}.${Date.now()}.${n}@test.ci`; }

export async function signup(app: INestApplication, opts: { companyName?: string; email?: string } = {}) {
  const agent = request.agent(app.getHttpServer());
  const email = opts.email ?? uniqueEmail();
  const res = await agent.post('/auth/signup').send({ fullName: 'Utilisateur Test', email, password: 'MotDePasse123', companyName: opts.companyName ?? `Société ${email}` });
  if (res.status !== 201) throw new Error(`signup ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, userId: res.body.userId as string, companyId: res.body.companyId as string };
}

/** Crée un utilisateur de la plateforme avec double authentification active, puis le connecte. */
export async function platformUser(app: INestApplication, role: string) {
  const email = uniqueEmail(role);
  const secret = authenticator.generateSecret();
  const c = await ownerClient();
  const u = await c.query(`INSERT INTO user_account (email, full_name, password_hash, mfa_enabled, totp_secret_enc) VALUES ($1,$2,$3,true,$4) RETURNING id`,
    [email, `Plateforme ${role}`, await hash('MotDePasse123'), encrypt(secret)]);
  await c.query(`INSERT INTO platform_role_assignment (user_id, role) VALUES ($1,$2)`, [u.rows[0].id, role]);
  await c.end();
  const agent = request.agent(app.getHttpServer());
  const r = await agent.post('/auth/login').send({ email, password: 'MotDePasse123', code: authenticator.generate(secret) });
  if (r.status !== 200) throw new Error(`login plateforme ${r.status}`);
  return { agent, userId: u.rows[0].id as string, email };
}
