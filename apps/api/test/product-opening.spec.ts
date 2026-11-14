import { INestApplication } from '@nestjs/common';
import { createApp, resetDb, signup } from './helpers';

describe("Création d'un article avec son stock initial", () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
  });
  afterAll(async () => { await app.close(); });

  it("enregistre l'article et son stock de départ en une fois, au prix d'achat par défaut", async () => {
    const res = await owner.agent.post('/company/products').send({ name: 'Sac de riz 25 kg', salePrice: 15_000, purchasePrice: 12_000, vatRate: 18, unit: 'sac', openingStock: { quantity: 40 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ trackStock: true, stockQty: 40 });
    const mv = (await owner.agent.get(`/company/stock/${res.body.id}/movements`)).body;
    expect(mv.product).toMatchObject({ stock_qty: 40, stock_value: 480_000, avg_cost: 12_000 });
    expect(mv.movements).toHaveLength(1);
    expect(mv.movements[0]).toMatchObject({ reason: 'opening', quantity: 40, value: 480_000 });
    // Coût saisi : il prime sur le prix d'achat. Le stock initial reste ensuite unique.
    const b = (await owner.agent.post('/company/products').send({ name: 'Huile 5 L', salePrice: 6000, purchasePrice: 4000, vatRate: 18, openingStock: { quantity: 10, unitCost: 3800 } })).body;
    expect((await owner.agent.get(`/company/stock/${b.id}/movements`)).body.movements[0]).toMatchObject({ value: 38_000 });
    expect((await owner.agent.post(`/company/stock/${b.id}/opening`).send({ quantity: 5, unitCost: 3800 })).body.error.code).toBe('already_has_movements');
    expect((await owner.agent.get('/company/accounting/trial-balance')).body.balanced).toBe(true);
  });

  it("refuse un stock pour un service, et n'enregistre alors pas l'article", async () => {
    const before = (await owner.agent.get('/company/products')).body.length;
    const res = await owner.agent.post('/company/products').send({ kind: 'service', name: 'Livraison', salePrice: 2000, vatRate: 18, openingStock: { quantity: 3 } });
    expect(res.body.error.code).toBe('service_not_stockable');
    const bad = await owner.agent.post('/company/products').send({ name: 'Savon', salePrice: 500, vatRate: 18, openingStock: { quantity: -2 } });
    expect(bad.status).toBe(400);
    expect((await owner.agent.get('/company/products')).body.length).toBe(before);
  });

  it("supprime un article jamais utilisé, et demande d'archiver un article qui a servi", async () => {
    const unused = (await owner.agent.post('/company/products').send({ name: 'Article en double', salePrice: 1000, vatRate: 18 })).body;
    const del = await owner.agent.delete(`/company/products/${unused.id}`);
    expect(del.status).toBe(200);
    expect((await owner.agent.get('/company/products?archived=all')).body.find((p: any) => p.id === unused.id)).toBeUndefined();
    expect((await owner.agent.delete(`/company/products/${unused.id}`)).status).toBe(404);
    // Article avec stock initial : il a un mouvement, donc il s'archive.
    const stocked = (await owner.agent.post('/company/products').send({ name: 'Ciment 50 kg', salePrice: 5000, purchasePrice: 4500, vatRate: 18, openingStock: { quantity: 2 } })).body;
    const refused = await owner.agent.delete(`/company/products/${stocked.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'product_in_use' });
    expect(refused.body.error.message).toMatch(/mouvements de stock.*Archivez/);
  });
});
