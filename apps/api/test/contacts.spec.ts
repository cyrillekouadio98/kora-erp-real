import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, ownerClient, resetDb, signup, uniqueEmail, TIERS } from './helpers';

describe('Contacts (clients et fournisseurs)', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  beforeAll(async () => { await resetDb(); app = await createApp(); owner = await signup(app); });
  afterAll(async () => { await app.close(); });

  it('numérote automatiquement par type de tiers, sans code saisi', async () => {
    expect((await owner.agent.get('/company/contacts/next-code').query({ kind: 'customer' })).body.code).toBe('CLI-00001');
    const c1 = await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Société Ivoirienne de Négoce', email: 'Achats@SIN.ci', taxId: '1234567A' });
    expect(c1.status).toBe(201);
    expect(c1.body).toMatchObject({ code: 'CLI-00001', email: 'achats@sin.ci', countryCode: 'CI', paymentTermsDays: 0 });
    const c2 = await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Maquis Chez Tantie' });
    expect(c2.body.code).toBe('CLI-00002');
    const f1 = await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Grossiste Adjamé', paymentTermsDays: 30 });
    expect(f1.body).toMatchObject({ code: 'FRS-00001', paymentTermsDays: 30 });
    expect((await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'both', name: 'Code imposé', code: 'cli-00001' })).status).toBe(400);
    expect((await owner.agent.get('/company/contacts/next-code').query({ kind: 'customer' })).body.code).toBe('CLI-00003');
    const bad = await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'X', email: 'pas-un-email' });
    expect(bad.status).toBe(400);
  });

  it('exige téléphone, e-mail, NCC, RCCM et délai pour une entreprise ; nom et téléphone pour un particulier', async () => {
    const empty = await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'SARL Incomplète' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('contact_incomplete');
    expect(empty.body.error.details.map((d: any) => d.field)).toEqual(['phone', 'email', 'taxId', 'rccm', 'paymentTermsDays']);
    expect((await owner.agent.post('/company/contacts').send({ kind: 'customer', legalType: 'individual', name: 'Kouadio Jean' })).body.error.details.map((d: any) => d.field)).toEqual(['phone']);
    const person = await owner.agent.post('/company/contacts').send({ kind: 'customer', legalType: 'individual', name: 'Kouadio Jean', phone: '+225 05 11 22 33 44' });
    expect(person.status).toBe(201);
    // Passer un particulier en entreprise demande les informations d'une entreprise
    expect((await owner.agent.patch(`/company/contacts/${person.body.id}`).send({ legalType: 'company' })).body.error.code).toBe('contact_incomplete');
    expect((await owner.agent.patch(`/company/contacts/${person.body.id}`).send({ phone: '' })).body.error.code).toBe('contact_incomplete');
    // Nouveau type de tiers : nouveau code
    const both = await owner.agent.patch(`/company/contacts/${person.body.id}`).send({ kind: 'both' });
    expect(both.body.code).toBe('TIE-00001');
  });

  it('recherche, filtre par type et archive au lieu de supprimer', async () => {
    const list = await owner.agent.get('/company/contacts').query({ q: 'tantie' });
    expect(list.body.map((c: any) => c.name)).toEqual(['Maquis Chez Tantie']);
    const suppliers = await owner.agent.get('/company/contacts').query({ kind: 'supplier' });
    expect(suppliers.body.map((c: any) => c.code)).toEqual(['FRS-00001', 'TIE-00001']); // les tiers « les deux » en font partie

    const id = list.body[0].id;
    expect((await owner.agent.post(`/company/contacts/${id}/archive`)).status).toBe(200);
    expect((await owner.agent.get('/company/contacts').query({ q: 'tantie' })).body).toEqual([]);
    expect((await owner.agent.patch(`/company/contacts/${id}`).send({ name: 'Interdit' })).status).toBe(409);
    expect((await owner.agent.get('/company/contacts').query({ archived: 'true' })).body.map((c: any) => c.id)).toEqual([id]);
    expect((await owner.agent.post(`/company/contacts/${id}/restore`)).status).toBe(200);

    const upd = await owner.agent.patch(`/company/contacts/${id}`).send({ city: 'Abidjan', phone: '+225 07 00 00 00 00' });
    expect(upd.body).toMatchObject({ city: 'Abidjan', code: 'CLI-00002' });
  });

  it("trace chaque opération dans le journal d'audit et exporte en CSV", async () => {
    const csv = await owner.agent.get('/company/contacts/export');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Grossiste Adjamé');
    const audit = await owner.agent.get('/company/audit');
    const actions = (audit.body.items ?? audit.body).map((e: any) => e.action);
    for (const a of ['contact.created', 'contact.updated', 'contact.archived', 'contact.restored', 'contact.exported']) expect(actions).toContain(a);
  });

  it('respecte les permissions des rôles : un caissier consulte mais ne crée pas', async () => {
    const roles = await owner.agent.get('/company/roles');
    const cashierRole = roles.body.find((r: any) => r.key === 'cashier');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('caissier'), roleIds: [cashierRole.id] });
    const token = new URL(inv.body.inviteUrl).searchParams.get('token');
    const cashier = request.agent(app.getHttpServer());
    await cashier.post('/invitations/accept').send({ token, fullName: 'Caissier', password: 'MotDePasse123' });
    expect((await cashier.get('/company/contacts')).status).toBe(200);
    expect((await cashier.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Essai' })).status).toBe(403);
    expect((await cashier.get('/company/contacts/export')).status).toBe(403);
  });

  it("passe en lecture seule quand l'abonnement est suspendu", async () => {
    const c = await ownerClient();
    await c.query(`UPDATE subscription SET status = 'suspended' WHERE company_id = $1`, [owner.companyId]);
    await c.end();
    expect((await owner.agent.get('/company/contacts')).status).toBe(200);
    expect((await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Bloqué' })).status).toBe(423);
  });
});
