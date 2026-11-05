import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, ownerClient, platformUser, resetDb, signup, uniqueEmail } from './helpers';

describe('Console : préparation d’une entreprise pour un client', () => {
  let app: INestApplication;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let id: string;
  const ownerEmail = uniqueEmail('proprio');
  const mails = async () => {
    const c = await ownerClient();
    try { return (await c.query('SELECT to_address, subject FROM email_message WHERE company_id = $1 ORDER BY created_at', [id])).rows; } finally { await c.end(); }
  };
  beforeAll(async () => { await resetDb(); app = await createApp(); sales = await platformUser(app, 'sales_admin'); });
  afterAll(async () => { await app.close(); });

  it('crée l’entreprise sans en être membre, avec la formule choisie', async () => {
    const support = await platformUser(app, 'support');
    expect((await support.agent.post('/platform/setup').send({ name: 'Pirate SARL', planCode: 'starter', billingCycle: 'monthly' })).status).toBe(403);
    const client = await signup(app);
    expect((await client.agent.get('/platform/setup')).status).toBe(403);

    const r = await sales.agent.post('/platform/setup').send({ name: 'Boulangerie du Plateau', legalForm: 'SARL', city: 'Abidjan', planCode: 'starter', billingCycle: 'yearly' });
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ status: 'preparing', subscription: { planCode: 'starter', billingCycle: 'yearly', userQuota: 5 }, company: { name: 'Boulangerie du Plateau', city: 'Abidjan' } });
    expect(r.body.sites).toHaveLength(1);
    expect(r.body.accounts.map((a: any) => a.kind).sort()).toEqual(['cash', 'mobile_money']); // Starter : pas de banque
    expect((await sales.agent.post(`/platform/setup/${r.body.id}/accounts`).send({ kind: 'bank', name: 'SGCI' })).body.error.code).toBe('module_not_in_plan');
    expect(r.body.canHandOver).toBe(false); // pas encore de propriétaire
    // L'équipe de l'éditeur n'a aucune adhésion : l'espace entreprise lui reste fermé.
    const c = await ownerClient();
    try { expect((await c.query('SELECT count(*)::int AS n FROM company_membership WHERE company_id = $1', [id])).rows[0].n).toBe(0); } finally { await c.end(); }
    expect((await sales.agent.get('/platform/companies')).body.find((x: any) => x.id === id)).toMatchObject({ preparing: true });
  });

  it('paramètre la fiche, la formule, les sites, la trésorerie et les utilisateurs', async () => {
    await sales.agent.patch(`/platform/setup/${id}/company`).send({ rccm: 'CI-ABJ-2026-B-1234', taxId: '2612345A', address: 'Rue du Commerce' });
    await sales.agent.patch(`/platform/setup/${id}/subscription`).send({ planCode: 'business', billingCycle: 'monthly', trialDays: 30 });
    const site = await sales.agent.post(`/platform/setup/${id}/sites`).send({ name: 'Boutique Cocody', city: 'Abidjan' });
    expect(site.body.sites.map((s: any) => s.name)).toContain('Boutique Cocody');
    expect(site.body.accounts.some((a: any) => a.name === 'Caisse Boutique Cocody')).toBe(true);
    const bank = await sales.agent.post(`/platform/setup/${id}/accounts`).send({ kind: 'bank', name: 'SGCI', bankName: 'Société Générale Côte d’Ivoire' });
    expect(bank.body.checklist.find((i: any) => i.key === 'treasury').done).toBe(false); // numéro de compte manquant
    const sgci = bank.body.accounts.find((a: any) => a.name === 'SGCI');
    const s = await sales.agent.patch(`/platform/setup/${id}/accounts/${sgci.id}`).send({ accountNumber: 'CI008 01234 000123456789 12' });
    expect(s.body.checklist.find((i: any) => i.key === 'treasury').done).toBe(true);
    expect(s.body.checklist.find((i: any) => i.key === 'company').done).toBe(true);
    expect(s.body.subscription).toMatchObject({ planCode: 'business', trialDays: 30, userQuota: 10 });

    const cocody = site.body.sites.find((x: any) => x.name === 'Boutique Cocody').id;
    const users = Array.from({ length: 10 }, (_, i) => ({ name: `Vendeur ${i}`, email: uniqueEmail('vendeur'), roleKey: 'sales_rep', siteIds: [cocody] }));
    expect((await sales.agent.put(`/platform/setup/${id}/people`).send({ owner: { name: 'Awa Koné', email: ownerEmail }, users })).body.error.code).toBe('quota_users');
    expect((await sales.agent.put(`/platform/setup/${id}/people`).send({ owner: { name: 'Awa Koné', email: ownerEmail }, users: [{ ...users[0], roleKey: 'owner' }] })).body.error.code).toBe('unknown_role');
    const p = await sales.agent.put(`/platform/setup/${id}/people`).send({ owner: { name: 'Awa Koné', email: ownerEmail }, users: users.slice(0, 2), notes: 'Démarrage le 1er décembre' });
    expect(p.body).toMatchObject({ canHandOver: true, owner: { email: ownerEmail }, notes: 'Démarrage le 1er décembre' });
    expect(await mails()).toEqual([]); // rien n'est envoyé avant la remise
  });

  it('remet l’entreprise : invitations envoyées, console verrouillée, le propriétaire prend la main', async () => {
    const h = await sales.agent.post(`/platform/setup/${id}/hand-over`);
    expect(h.status).toBe(200);
    expect(h.body.status).toBe('handed_over');
    expect(h.body.sites).toBeUndefined(); // la console ne voit plus le contenu
    expect(h.body.links.users).toHaveLength(2);
    expect((await mails()).map((m: any) => m.subject).sort()).toEqual(["Boulangerie du Plateau vous invite sur N'Ora ERP", "Boulangerie du Plateau vous invite sur N'Ora ERP", "Votre espace Boulangerie du Plateau est prêt sur N'Ora ERP"]);
    expect((await sales.agent.patch(`/platform/setup/${id}/company`).send({ city: 'Bouaké' })).body.error.code).toBe('setup_handed_over');
    expect((await sales.agent.post(`/platform/setup/${id}/hand-over`)).body.error.code).toBe('setup_handed_over');

    // Lien perdu : nouvelle invitation, l'ancienne ne marche plus
    const again = await sales.agent.post(`/platform/setup/${id}/resend-owner`);
    const old = new URL(h.body.links.owner.inviteUrl).searchParams.get('token');
    const owner = request.agent(app.getHttpServer());
    expect((await owner.post('/invitations/accept').send({ token: old, fullName: 'Awa Koné', password: 'MotDePasse123' })).status).toBe(404);
    const ok = await owner.post('/invitations/accept').send({ token: new URL(again.body.inviteUrl).searchParams.get('token'), fullName: 'Awa Koné', password: 'MotDePasse123' });
    expect(ok.status).toBe(201);
    const ctx = (await owner.get('/company/context')).body;
    expect(ctx).toMatchObject({ isOwner: true, readOnly: false, company: { name: 'Boulangerie du Plateau' } });
    expect(ctx.permissions).toContain('settings.admin');
    expect((await owner.get('/company')).body).toMatchObject({ rccm: 'CI-ABJ-2026-B-1234', city: 'Abidjan' });
    expect((await owner.get('/company/subscription')).body.plan.code).toBe('business');
    expect((await sales.agent.get(`/platform/setup/${id}`)).body.status).toBe('active');
    expect((await sales.agent.post(`/platform/setup/${id}/resend-owner`)).body.error.code).toBe('owner_joined');
    // Le journal du client montre ce que l'éditeur a fait en son nom
    const audit = (await owner.get('/company/audit')).body;
    expect((audit.items ?? audit).some((a: any) => a.action === 'company.handed_over' && a.actorType === 'platform')).toBe(true);
  });
});
