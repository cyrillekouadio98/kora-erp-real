import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, resetDb, signup, uniqueEmail, TIERS } from './helpers';

describe('Multi-sites : magasins, succursales et transferts inter-sites', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let main: string, cocody: string, oil: string, customer: string;
  let mainWh: string, cocodyWh: string;
  const as = async (siteId: string | null) => expect((await owner.agent.post('/company/sites/active').send({ siteId })).status).toBe(200);
  const line = (quantity: number) => ({ productId: oil, description: 'Huile 5 L', quantity, unitPrice: 6000, vatRate: 18 });

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    oil = (await owner.agent.post('/company/products').send({ name: 'Huile végétale 5 L', salePrice: 6000, purchasePrice: 4000, vatRate: 18, unit: 'bidon' })).body.id;
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Maquis Chez Tantie' })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it('crée une succursale avec son entrepôt et sa caisse', async () => {
    const sites = (await owner.agent.get('/company/sites')).body;
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ code: 'S01', isDefault: true, accounts: 3 });
    main = sites[0].id;
    const created = await owner.agent.post('/company/sites').send({ name: 'Magasin Cocody', city: 'Abidjan' });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe('S02');
    cocody = created.body.id;
    expect((await owner.agent.get('/company/sites')).body.find((s: any) => s.id === cocody)).toMatchObject({ warehouses: 1, accounts: 1, employees: 0 });
    const whs = (await owner.agent.get('/company/stock/warehouses')).body;
    mainWh = whs.find((w: any) => w.siteId === main).id;
    cocodyWh = whs.find((w: any) => w.siteId === cocody).id;
    expect(whs.find((w: any) => w.id === cocodyWh)).toMatchObject({ name: 'Dépôt Magasin Cocody', siteName: 'Magasin Cocody' });
    const ctx = (await owner.agent.get('/company/context')).body;
    expect(ctx.sites).toHaveLength(2);
    expect(ctx).toMatchObject({ siteId: null, siteRestricted: false });
  });

  it('transfère la marchandise du site principal vers la succursale', async () => {
    await owner.agent.post(`/company/stock/${oil}/opening`).send({ quantity: 20, unitCost: 4000, warehouseId: mainWh });
    const doc = (await owner.agent.post('/company/stock/documents').send({ type: 'transfer', warehouseId: mainWh, destWarehouseId: cocodyWh, lines: [{ productId: oil, quantity: 8 }] })).body;
    expect((await owner.agent.post(`/company/stock/documents/${doc.id}/validate`)).status).toBe(200);
    await as(cocody);
    const stock = (await owner.agent.get('/company/stock')).body;
    expect(stock.warehouses.map((w: any) => w.id)).toEqual([cocodyWh]);
    expect(stock.items.find((i: any) => i.id === oil)).toMatchObject({ quantity: 8, value: 32_000 });
    // La succursale voit le transfert qu'elle a reçu
    expect((await owner.agent.get('/company/stock/documents').query({ type: 'transfer' })).body.map((d: any) => d.id)).toContain(doc.id);
    await as(main);
    expect((await owner.agent.get('/company/stock')).body.items.find((i: any) => i.id === oil).quantity).toBe(12);
  });

  it('rattache les ventes au site affiché : son stock, sa caisse, ses chiffres', async () => {
    await as(cocody);
    const inv = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [line(5)] })).body;
    expect(inv).toMatchObject({ siteId: cocody, siteName: 'Magasin Cocody' });
    expect((await owner.agent.post(`/company/sales/documents/${inv.id}/validate`)).status).toBe(200);
    expect((await owner.agent.get('/company/stock')).body.items.find((i: any) => i.id === oil).quantity).toBe(3);
    await owner.agent.post(`/company/sales/documents/${inv.id}/payments`).send({ amount: 35_400, method: 'cash' });
    const accounts = (await owner.agent.get('/company/treasury/accounts')).body;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Caisse Magasin Cocody', balance: 35_400 });

    // Une vente trop grosse pour la succursale est refusée, même si le site principal a du stock
    const big = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [line(10)] })).body.id;
    expect((await owner.agent.post(`/company/sales/documents/${big}/validate`)).body.error.code).toBe('insufficient_stock');
    await owner.agent.delete(`/company/sales/documents/${big}`);

    await as(main);
    expect((await owner.agent.get('/company/sales/documents').query({ type: 'invoice' })).body).toHaveLength(0);
    await as(null);
    expect((await owner.agent.get('/company/sales/documents').query({ type: 'invoice' })).body).toHaveLength(1);

    const from = new Date().toISOString().slice(0, 8) + '01', to = new Date().toISOString().slice(0, 10);
    const overview = (await owner.agent.get('/company/sites/overview').query({ from, to })).body;
    expect(overview.sites.find((s: any) => s.id === cocody)).toMatchObject({ salesHt: 30_000, invoices: 1, collected: 35_400, cash: 35_400, stockValue: 12_000, result: 30_000 });
    expect(overview.sites.find((s: any) => s.id === main)).toMatchObject({ salesHt: 0, stockValue: 48_000 });

    // L'écriture de vente porte le site de la facture
    const entries = (await owner.agent.get('/company/accounting/entries').query({ journal: 'VT' })).body;
    expect(entries).toHaveLength(1);
  });

  it('limite un utilisateur à sa succursale, jusque dans la base', async () => {
    const roles = (await owner.agent.get('/company/roles')).body;
    const roleIds = ['director', 'sales_rep', 'payroll_manager'].map((k) => roles.find((r: any) => r.key === k).id);
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('gerant'), roleIds, siteIds: [cocody] });
    expect(inv.status).toBe(201);
    const agent = request.agent(app.getHttpServer());
    await agent.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Gérant Cocody', password: 'MotDePasse123' });

    const ctx = (await agent.get('/company/context')).body;
    expect(ctx).toMatchObject({ siteId: cocody, siteRestricted: true });
    expect(ctx.sites.map((s: any) => s.id)).toEqual([cocody]);
    expect((await agent.post('/company/sites/active').send({ siteId: main })).status).toBe(404);

    // Un document du site principal reste introuvable, même par son identifiant
    await as(main);
    const other = (await owner.agent.post('/company/sales/documents').send({ type: 'quote', contactId: customer, lines: [line(1)] })).body;
    expect(other.siteId).toBe(main);
    expect((await agent.get(`/company/sales/documents/${other.id}`)).status).toBe(404);
    expect((await agent.get('/company/sales/documents').query({ type: 'quote' })).body).toHaveLength(0);
    expect((await agent.get('/company/treasury/accounts')).body.map((a: any) => a.name)).toEqual(['Caisse Magasin Cocody']);

    // Ce qu'il crée appartient à sa succursale ; il ne peut pas créer pour un autre site
    const mine = await agent.post('/company/sales/documents').send({ type: 'quote', contactId: customer, lines: [line(1)] });
    expect(mine.body).toMatchObject({ siteId: cocody });
    expect((await agent.post('/company/sales/documents').send({ type: 'quote', contactId: customer, warehouseId: mainWh, lines: [line(1)] })).body.error.code).toBe('site_forbidden');
    expect((await agent.post('/company/payroll/runs').send({ period: new Date().toISOString().slice(0, 7) })).body.error.code).toBe('site_restricted');
  });

  it('protège le site principal et un site encore utilisé', async () => {
    expect((await owner.agent.patch(`/company/sites/${main}`).send({ archived: true })).body.error.code).toBe('default_site');
    expect((await owner.agent.patch(`/company/sites/${cocody}`).send({ archived: true })).body.error.code).toBe('site_in_use');
    expect((await owner.agent.patch(`/company/sites/${cocody}`).send({ isDefault: true })).status).toBe(200);
    expect((await owner.agent.get('/company/sites')).body.find((s: any) => s.isDefault).id).toBe(cocody);
  });
});
