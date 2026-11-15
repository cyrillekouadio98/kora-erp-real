import { INestApplication } from '@nestjs/common';
import { createApp, resetDb, signup, TIERS } from './helpers';

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

  it("réserve un article au site de l'entrepôt de son stock initial", async () => {
    const created = await owner.agent.post('/company/sites').send({ name: 'Materiels et Poussins', city: 'Bouaflé' });
    expect(created.status).toBe(201);
    const site2 = created.body.id;
    const whs = (await owner.agent.get('/company/stock/warehouses')).body;
    const wh2 = whs.find((w: any) => w.siteId === site2).id;
    const main = whs.find((w: any) => w.siteId !== site2).siteId;
    const as = async (siteId: string | null) => expect((await owner.agent.post('/company/sites/active').send({ siteId })).status).toBe(200);

    const chicks = (await owner.agent.post('/company/products').send({ name: 'Poussins chair', salePrice: 600, purchasePrice: 450, vatRate: 0, openingStock: { quantity: 500, warehouseId: wh2 } })).body;
    expect(chicks.siteId).toBe(site2);
    // Codes numérotés par site : le site S02 commence à 1, sans suivre les articles communs.
    expect(chicks.code).toBe('ART-S02-00001');
    expect((await owner.agent.get(`/company/products/next-code?siteId=${site2}`)).body.code).toBe('ART-S02-00002');
    const feeder = (await owner.agent.post('/company/products').send({ name: 'Mangeoire 3 kg', salePrice: 1500, vatRate: 18, siteId: site2 })).body;
    expect(feeder.code).toBe('ART-S02-00002');
    const mainItem = (await owner.agent.post('/company/products').send({ name: 'Riz parfumé', salePrice: 800, vatRate: 18, siteId: main })).body;
    expect(mainItem.code).toBe('ART-S01-00001');
    const common = (await owner.agent.post('/company/products').send({ name: 'Sachet plastique', salePrice: 25, vatRate: 18 })).body;
    expect(common.siteId).toBeNull();
    expect(common.code).toMatch(/^ART-\d{5}$/);
    expect((await owner.agent.get('/company/products/next-code')).body.code).toBe(`ART-${String(Number(common.code.slice(4)) + 1).padStart(5, '0')}`);
    // Site choisi explicitement mais entrepôt d'un autre site : refusé.
    const mismatch = await owner.agent.post('/company/products').send({ name: 'Mangeoire', salePrice: 3000, vatRate: 18, siteId: main, openingStock: { quantity: 2, warehouseId: wh2 } });
    expect(mismatch.body.error.code).toBe('warehouse_other_site');

    const names = async () => (await owner.agent.get('/company/products')).body.map((p: any) => p.name);
    await as(main);
    expect(await names()).not.toContain('Poussins chair');
    expect(await names()).toContain('Sachet plastique');
    expect((await owner.agent.get('/company/stock')).body.items.map((p: any) => p.name)).not.toContain('Poussins chair');
    await as(site2);
    expect(await names()).toEqual(expect.arrayContaining(['Poussins chair', 'Sachet plastique']));
    expect((await owner.agent.get('/company/stock')).body.items.find((p: any) => p.name === 'Poussins chair')).toMatchObject({ quantity: 500 });
    // Caisse de chaque site : seuls ses articles et les articles communs y sont proposés.
    await as(main);
    const reg1 = (await owner.agent.post('/company/pos/registers').send({ name: 'Caisse principale' })).body.id;
    await as(site2);
    const reg2 = (await owner.agent.post('/company/pos/registers').send({ name: 'Caisse poussins' })).body.id;
    const catalog = async (r: string) => (await owner.agent.get(`/company/pos/registers/${r}/catalog`)).body.map((p: any) => p.name);
    expect(await catalog(reg1)).not.toContain('Poussins chair');
    expect(await catalog(reg2)).toEqual(expect.arrayContaining(['Poussins chair', 'Sachet plastique']));
    await as(null);
    expect(await names()).toEqual(expect.arrayContaining(['Poussins chair', 'Sachet plastique']));
    // Rattachement modifiable : l'article devient commun à tous les sites.
    expect((await owner.agent.patch(`/company/products/${chicks.id}`).send({ siteId: null })).body.siteId).toBeNull();
  });

  it("ajoute le stock initial en modifiant un article qui n'a encore aucun mouvement", async () => {
    await owner.agent.post('/company/sites/active').send({ siteId: null });
    const p = (await owner.agent.post('/company/products').send({ name: 'Abreuvoir 5 L', salePrice: 2500, purchasePrice: 1800, vatRate: 18 })).body;
    const res = await owner.agent.patch(`/company/products/${p.id}`).send({ salePrice: 2700, openingStock: { quantity: 12 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ salePrice: 2700, stockQty: 12 });
    const mv = (await owner.agent.get(`/company/stock/${p.id}/movements`)).body.movements;
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ reason: 'opening', quantity: 12, value: 21_600 });
    // Une seconde fois : refusé, et la modification envoyée avec n'est pas enregistrée.
    const again = await owner.agent.patch(`/company/products/${p.id}`).send({ salePrice: 9999, openingStock: { quantity: 3 } });
    expect(again.body.error.code).toBe('already_has_movements');
    expect((await owner.agent.get('/company/products')).body.find((x: any) => x.id === p.id).salePrice).toBe(2700);
  });

  it('rattache les clients et fournisseurs au site affiché, avec des codes par site', async () => {
    const sites = (await owner.agent.get('/company/sites')).body;
    const main = sites.find((x: any) => x.code === 'S01').id, s2 = sites.find((x: any) => x.code === 'S02').id;
    const as = async (siteId: string | null) => expect((await owner.agent.post('/company/sites/active').send({ siteId })).status).toBe(200);

    await as(s2);
    expect((await owner.agent.get('/company/contacts/next-code?kind=customer&siteId=' + s2)).body.code).toBe('CLI-S02-00001');
    const farm = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Ferme Kouassi' })).body;
    expect(farm).toMatchObject({ siteId: s2, code: 'CLI-S02-00001' });
    const supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Couvoir du Centre' })).body;
    expect(supplier).toMatchObject({ siteId: s2, code: 'FRS-S02-00001' });
    await as(null);
    const common = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Client national' })).body;
    expect(common.siteId).toBeNull();
    expect(common.code).toMatch(/^CLI-\d{5}$/);
    const mainCustomer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Boutique Plateau', siteId: main })).body;
    expect(mainCustomer.code).toBe('CLI-S01-00001');

    const names = async () => (await owner.agent.get('/company/contacts')).body.map((c: any) => c.name);
    await as(main);
    expect(await names()).toEqual(expect.arrayContaining(['Client national', 'Boutique Plateau']));
    expect(await names()).not.toContain('Ferme Kouassi');
    await as(s2);
    expect(await names()).toEqual(expect.arrayContaining(['Ferme Kouassi', 'Couvoir du Centre', 'Client national']));
    expect(await names()).not.toContain('Boutique Plateau');
    await as(null);
    // Changement de site : le code ne change pas.
    expect((await owner.agent.patch(`/company/contacts/${farm.id}`).send({ siteId: null })).body).toMatchObject({ siteId: null, code: 'CLI-S02-00001' });
  });
});
