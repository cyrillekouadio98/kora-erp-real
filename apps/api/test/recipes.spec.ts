import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup } from './helpers';

/** Fiches techniques : un plat vendu sort ses ingrédients du stock ; coût de revient, marge et portions possibles. */
describe('Fiches techniques', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let garba: string, attieke: string, thon: string, huile: string, service: string, register: string, session: string;
  const stock = async (id: string) => (await owner.agent.get(`/company/stock/${id}/movements`)).body.product.stock_qty;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    const good = async (name: string, unit: string, qty: number, cost: number) => {
      const id = (await owner.agent.post('/company/products').send({ name, unit, salePrice: cost * 2, purchasePrice: cost, vatRate: 0 })).body.id;
      await owner.agent.post(`/company/stock/${id}/opening`).send({ quantity: qty, unitCost: cost });
      return id;
    };
    attieke = await good('Attiéké', 'kg', 10, 800);
    thon = await good('Thon', 'kg', 3, 3000);
    huile = await good('Huile', 'litre', 5, 1500);
    garba = (await owner.agent.post('/company/products').send({ kind: 'service', name: 'Garba', salePrice: 1500, vatRate: 0 })).body.id;
    service = (await owner.agent.post('/company/products').send({ kind: 'service', name: 'Livraison', salePrice: 500, vatRate: 0 })).body.id;
    register = (await owner.agent.post('/company/pos/registers').send({ name: 'Caisse 1' })).body.id;
    session = (await owner.agent.post(`/company/pos/registers/${register}/open`).send({ openingFloat: 0 })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it("reste fermé tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.get('/company/recipes')).body.error.code).toBe('feature_not_enabled');
    const sales = await platformUser(app, 'sales_admin');
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/recipes`).send({ enabled: true });
  });

  it('enregistre la fiche : coût de revient, marge, portions', async () => {
    expect((await owner.agent.put(`/company/recipes/${garba}`).send({ ingredients: [{ ingredientId: service, quantity: 1 }] })).body.error.code).toBe('ingredient_not_stocked');
    expect((await owner.agent.put(`/company/recipes/${garba}`).send({ ingredients: [{ ingredientId: garba, quantity: 1 }] })).body.error.code).toBe('self_ingredient');
    const r = (await owner.agent.put(`/company/recipes/${garba}`).send({ ingredients: [{ ingredientId: attieke, quantity: 0.25 }, { ingredientId: thon, quantity: 0.2 }, { ingredientId: huile, quantity: 0.05 }] })).body;
    // 0,25 × 800 + 0,2 × 3 000 + 0,05 × 1 500 = 875
    expect(r).toMatchObject({ cost: 875, margin: 625, costRate: 58.3, portions: 15 }); // le thon limite : 3 kg / 0,2
    expect((await owner.agent.get('/company/recipes')).body.map((x: any) => x.name)).toEqual(['Garba']);
    // Un ingrédient ne peut pas avoir sa propre fiche (pas d'imbrication).
    expect((await owner.agent.put(`/company/recipes/${thon}`).send({ ingredients: [{ ingredientId: huile, quantity: 0.01 }] })).body.error.code).toBe('nested_recipe');
    const cat = (await owner.agent.get(`/company/pos/registers/${register}/catalog`)).body.find((p: any) => p.id === garba);
    expect(cat).toMatchObject({ stock: 15, recipe: true });
  });

  it('sort les ingrédients du stock à la vente, et les rend si le ticket est remis en brouillon', async () => {
    const t = (await owner.agent.post(`/company/pos/sessions/${session}/tickets`).send({ lines: [{ productId: garba, description: 'Garba', quantity: 4, unitPrice: 1500, vatRate: 0 }], payments: [{ method: 'cash', amount: 6000 }] })).body;
    expect(t.totalTtc).toBe(6000);
    expect([await stock(attieke), await stock(thon), await stock(huile)]).toEqual([9, 2.2, 4.8]);
    // 12 portions au plus restent (2,2 kg de thon) : 12 passe, 12 de plus non.
    const tooMuch = await owner.agent.post(`/company/pos/sessions/${session}/tickets`).send({ lines: [{ productId: garba, description: 'Garba', quantity: 12, unitPrice: 1500, vatRate: 0 }], payments: [{ method: 'cash', amount: 18000 }] });
    expect(tooMuch.body.error.code).toBe('insufficient_stock');
    expect(tooMuch.body.error.message).toContain('Thon');
    // Facture classique : même sortie d'ingrédients ; remise en brouillon : ils reviennent.
    const contact = (await owner.agent.get('/company/contacts?kind=customer')).body[0].id;
    const inv = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: contact, lines: [{ productId: garba, description: 'Garba', quantity: 2, unitPrice: 1500, vatRate: 0 }] })).body.id;
    expect((await owner.agent.post(`/company/sales/documents/${inv}/validate`)).status).toBe(200);
    expect(await stock(thon)).toBe(1.8);
    expect((await owner.agent.post(`/company/sales/documents/${inv}/reset-to-draft`)).status).toBe(200);
    expect(await stock(thon)).toBe(2.2);
  });

  it('supprime la fiche : le plat ne sort plus rien', async () => {
    expect((await owner.agent.put(`/company/recipes/${garba}`).send({ ingredients: [] })).body).toMatchObject({ ingredients: [], cost: 0, portions: null });
    expect((await owner.agent.get('/company/recipes')).body).toEqual([]);
    await owner.agent.post(`/company/pos/sessions/${session}/tickets`).send({ lines: [{ productId: garba, description: 'Garba', quantity: 1, unitPrice: 1500, vatRate: 0 }], payments: [{ method: 'cash', amount: 1500 }] });
    expect(await stock(thon)).toBe(2.2);
  });
});
