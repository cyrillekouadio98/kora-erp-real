import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup, TIERS } from './helpers';

/** Unités de mesure : acheter et vendre au sac, stock tenu au kg (fonctionnalité activée à la demande). */
describe('Unités de mesure', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let feed: string, other: string, customer: string, supplier: string, sac: string;
  const stock = async () => (await owner.agent.get('/company/stock')).body.items.find((i: any) => i.id === feed);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    feed = (await owner.agent.post('/company/products').send({ name: 'Aliment ponte', salePrice: 360, purchasePrice: 300, vatRate: 18, unit: 'kg' })).body.id;
    other = (await owner.agent.post('/company/products').send({ name: 'Maïs', salePrice: 250, purchasePrice: 200, vatRate: 18, unit: 'kg' })).body.id;
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Ferme Koné' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Provenderie du Sud' })).body.id;
    await owner.agent.get('/company/stock/warehouses'); // entrepôt principal créé comme à l'ouverture de Stocks
  });
  afterAll(async () => { await app.close(); });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.put(`/company/products/${feed}/units`).send({ units: [{ name: 'sac', factor: 50 }] })).body.error.code).toBe('feature_not_enabled');
    expect((await owner.agent.get('/company/products')).body[0].units).toBeUndefined();
  });

  it('définit les unités d’un article', async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/units`).send({ enabled: true });
    expect((await owner.agent.put(`/company/products/${feed}/units`).send({ units: [{ name: 'kg', factor: 1 }] })).body.error.code).toBe('duplicate_unit');
    const u = (await owner.agent.put(`/company/products/${feed}/units`).send({ units: [{ name: 'sac', factor: 50, salePrice: 17000, purchasePrice: 15000 }] })).body;
    expect(u).toMatchObject([{ name: 'sac', factor: 50, salePrice: 17000, purchasePrice: 15000 }]);
    sac = u[0].id;
    expect((await owner.agent.get('/company/products')).body.find((p: any) => p.id === feed).units).toHaveLength(1);
  });

  it('achète au sac et compte le stock en kg', async () => {
    const d = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'PS-1',
      lines: [{ productId: feed, unitId: sac, description: 'Aliment ponte', quantity: 10, unitPrice: 15000, vatRate: 18 }] });
    expect(d.body.lines[0]).toMatchObject({ unit: 'sac', unitFactor: 50, quantity: 10 });
    expect((await owner.agent.post(`/company/purchases/documents/${d.body.id}/validate`)).status).toBe(200);
    expect(await stock()).toMatchObject({ quantity: 500, value: 150000, avgCost: 300 });
  });

  it('vend au sac et au kg, et réserve en kg', async () => {
    const inv = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [
      { productId: feed, unitId: sac, description: 'Aliment ponte', quantity: 2, unitPrice: 16500, vatRate: 18 },
      { productId: feed, description: 'Aliment ponte', quantity: 30, unit: 'kg', unitPrice: 360, vatRate: 18 },
    ] });
    expect(inv.body.lines[0]).toMatchObject({ unit: 'sac', unitFactor: 50, listPrice: 17000, discount: 1000 });
    expect(inv.body.lines[1]).toMatchObject({ unit: 'kg', unitFactor: 1, listPrice: null });
    expect((await owner.agent.post(`/company/sales/documents/${inv.body.id}/validate`)).status).toBe(200);
    expect((await stock()).quantity).toBe(370);
    const order = await owner.agent.post('/company/sales/documents').send({ type: 'order', contactId: customer, lines: [{ productId: feed, unitId: sac, description: 'Aliment ponte', quantity: 1, unitPrice: 17000, vatRate: 18 }] });
    await owner.agent.post(`/company/sales/documents/${order.body.id}/validate`);
    expect(await stock()).toMatchObject({ quantity: 370, reserved: 50, available: 320 });
  });

  it("refuse une unité d'un autre article et protège les unités utilisées", async () => {
    expect((await owner.agent.post('/company/sales/documents').send({ type: 'quote', contactId: customer, lines: [{ productId: other, unitId: sac, description: 'Maïs', quantity: 1, unitPrice: 1, vatRate: 18 }] })).body.error.code).toBe('unknown_unit');
    expect((await owner.agent.put(`/company/products/${feed}/units`).send({ units: [{ id: sac, name: 'sac', factor: 25 }] })).body.error.code).toBe('unit_factor_locked');
    expect((await owner.agent.put(`/company/products/${feed}/units`).send({ units: [] })).body).toEqual([]);
    expect((await sales.agent.put(`/platform/companies/${owner.companyId}/features/units`).send({ enabled: false })).body.error.code).toBe('feature_in_use');
  });
});
