import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { hash } from '@node-rs/argon2';
import { createApp, ownerClient, platformUser, resetDb, signup, uniqueEmail } from './helpers';

describe('Console éditeur et accès exceptionnel du support', () => {
  let app: INestApplication;
  beforeAll(async () => { await resetDb(); app = await createApp(); });
  afterAll(async () => { await app.close(); });

  it("la console exige un rôle plateforme et la double authentification", async () => {
    const client = await signup(app);
    expect((await client.agent.get('/platform/companies')).status).toBe(403);

    const email = uniqueEmail('admin');
    const c = await ownerClient();
    const u = await c.query(`INSERT INTO user_account (email, full_name, password_hash) VALUES ($1,'Admin',$2) RETURNING id`, [email, await hash('MotDePasse123')]);
    await c.query(`INSERT INTO platform_role_assignment (user_id, role) VALUES ($1,'super_admin')`, [u.rows[0].id]);
    await c.end();
    const agent = request.agent(app.getHttpServer());
    await agent.post('/auth/login').send({ email, password: 'MotDePasse123' });
    const r = await agent.get('/platform/companies');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('mfa_setup_required');
  });

  it("le support ne voit rien sans accord, puis uniquement le périmètre accordé, sous journalisation visible du client", async () => {
    const client = await signup(app, { companyName: 'Quincaillerie Yopougon' });
    const support = await platformUser(app, 'support');

    expect((await support.agent.get(`/platform/support/companies/${client.companyId}/members`)).status).toBe(403);
    const grant = await support.agent.post('/platform/support-access').send({ companyId: client.companyId, reason: 'Le client signale une erreur de connexion', scope: ['users'], durationMinutes: 60 });
    expect(grant.status).toBe(201);
    expect((await support.agent.get(`/platform/support/companies/${client.companyId}/members`)).status).toBe(403);

    const pending = await client.agent.get('/company/support-access');
    expect(pending.body[0]).toEqual(expect.objectContaining({ status: 'requested', reason: 'Le client signale une erreur de connexion' }));
    expect((await client.agent.post(`/company/support-access/${grant.body.id}/approve`)).status).toBe(200);

    const members = await support.agent.get(`/platform/support/companies/${client.companyId}/members`);
    expect(members.status).toBe(200);
    expect(members.body[0].email).toBe(client.email);
    expect((await support.agent.get(`/platform/support/companies/${client.companyId}/audit`)).status).toBe(403); // hors périmètre

    const audit = await client.agent.get('/company/audit');
    expect(audit.body.find((a: any) => a.action === 'support.viewed')).toEqual(expect.objectContaining({ actorType: 'support', actorId: support.userId }));

    expect((await client.agent.post(`/company/support-access/${grant.body.id}/revoke`)).status).toBe(200);
    expect((await support.agent.get(`/platform/support/companies/${client.companyId}/members`)).status).toBe(403);
  });

  it("un accès accordé à une entreprise ne vaut pas pour une autre", async () => {
    const a = await signup(app);
    const b = await signup(app);
    const support = await platformUser(app, 'support');
    const g = await support.agent.post('/platform/support-access').send({ companyId: a.companyId, reason: 'Diagnostic sur la société A', scope: ['users'] });
    await a.agent.post(`/company/support-access/${g.body.id}/approve`);
    expect((await support.agent.get(`/platform/support/companies/${b.companyId}/members`)).status).toBe(403);
    // B ne peut pas approuver la demande faite à A
    expect((await b.agent.post(`/company/support-access/${g.body.id}/approve`)).status).toBe(404);
  });

  it("suspendre une entreprise la passe en lecture seule ; le client en voit le motif dans son journal", async () => {
    const client = await signup(app);
    const admin = await platformUser(app, 'sales_admin');
    expect((await admin.agent.post(`/platform/companies/${client.companyId}/suspend`).send({ reason: 'Fraude suspectée au paiement' })).status).toBe(200);
    expect((await client.agent.post('/company/roles').send({ name: 'Rôle X', permissions: [] })).status).toBe(423);
    expect((await client.agent.get('/company/export')).status).toBe(200);
    const audit = await client.agent.get('/company/audit');
    expect(audit.body.some((a: any) => a.action === 'company.suspended' && a.data.reason === 'Fraude suspectée au paiement')).toBe(true);
    await admin.agent.post(`/platform/companies/${client.companyId}/reactivate`).send({ reason: 'Vérification terminée' });
    expect((await client.agent.post('/company/roles').send({ name: 'Rôle X', permissions: [] })).status).toBe(201);
  });

  it("le support ne peut pas suspendre une entreprise ni modifier les formules", async () => {
    const client = await signup(app);
    const support = await platformUser(app, 'support');
    expect((await support.agent.post(`/platform/companies/${client.companyId}/suspend`).send({ reason: 'Essai non autorisé' })).status).toBe(403);
    expect((await support.agent.post('/platform/plans').send({ code: 'pirate', name: 'Pirate' })).status).toBe(403);
  });

  it("une nouvelle version de formule ne modifie pas les abonnements existants", async () => {
    const before = await signup(app);
    const admin = await platformUser(app, 'sales_admin');
    const v = await admin.agent.post('/platform/plans/business/versions').send({
      priceMonthly: 45000, priceYearly: 450000, publish: true,
      entitlements: { modules: ['contacts', 'sales', 'cash', 'purchases', 'bank', 'accounting'], quotas: { users: 8, companies: 1, storage_mb: 10240, employees: 0 }, features: { export_advanced: true, api: false, support_level: 'email_48h' } },
    });
    expect(v.status).toBe(201);
    expect((await before.agent.get('/company/subscription')).body.plan.priceMonthly).toBe(35000);
    const after = await signup(app);
    expect((await after.agent.get('/company/subscription')).body.plan.priceMonthly).toBe(45000);
    const plans = await request(app.getHttpServer()).get('/plans');
    expect(plans.body.find((p: any) => p.code === 'business').priceMonthly).toBe(45000);
  });
});
