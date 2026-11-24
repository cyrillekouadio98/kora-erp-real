import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup, TIERS } from './helpers';

/** Listes de prix par client : paliers de quantité et remise générale (fonctionnalité activée à la demande). */
describe('Listes de prix', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let feed: string, corn: string, wholesaler: string, retail: string, list: string;
  const invoice = async (contactId: string, lines: [string, number, number][]) => (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId,
    lines: lines.map(([productId, quantity, unitPrice]) => ({ productId, description: 'Article', quantity, unitPrice, vatRate: 18 })) })).body;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    feed = (await owner.agent.post('/company/products').send({ name: 'Aliment ponte 50 kg', salePrice: 18000, vatRate: 18, unit: 'sac' })).body.id;
    corn = (await owner.agent.post('/company/products').send({ name: 'Maïs', salePrice: 250, vatRate: 18, unit: 'kg' })).body.id;
    wholesaler = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Grossiste Adjamé' })).body.id;
    retail = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Ferme Koné' })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.get('/company/price-lists')).body.error.code).toBe('feature_not_enabled');
    expect((await owner.agent.patch(`/company/contacts/${wholesaler}`).send({ priceListId: '00000000-0000-0000-0000-000000000000' })).body.error.code).toBe('feature_not_enabled');
  });

  it('crée une liste avec paliers et l’affecte à un client', async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/price_lists`).send({ enabled: true });
    list = (await owner.agent.post('/company/price-lists').send({ name: 'Grossiste', discountPct: 5 })).body.id;
    expect((await owner.agent.post('/company/price-lists').send({ name: 'grossiste' })).body.error.code).toBe('duplicate_name');
    expect((await owner.agent.put(`/company/price-lists/${list}/items`).send({ items: [
      { productId: feed, minQuantity: 1, price: 17000 }, { productId: feed, minQuantity: 10, price: 16500 },
    ] })).body).toEqual({ ok: true, items: 2 });
    expect((await owner.agent.patch(`/company/contacts/${wholesaler}`).send({ priceListId: list })).body.priceListId).toBe(list);
    const tariff = (await owner.agent.get(`/company/price-lists/for-contact/${wholesaler}`)).body.tariff;
    expect(tariff).toMatchObject({ name: 'Grossiste', discountPct: 5, items: [{ minQuantity: 1, price: 17000 }, { minQuantity: 10, price: 16500 }] });
    expect((await owner.agent.get(`/company/price-lists/for-contact/${retail}`)).body).toEqual({ tariff: null });
    expect((await owner.agent.get('/company/price-lists')).body).toMatchObject([{ name: 'Grossiste', items: 2, customers: 1 }]);
  });

  it('prend le prix de la liste comme référence des remises', async () => {
    const w = await invoice(wholesaler, [[feed, 12, 16500], [feed, 3, 16000], [corn, 10, 238]]);
    expect(w.lines.map((l: any) => [l.listPrice, l.discount])).toEqual([[null, 0], [17000, 3000], [null, 0]]);
    const r = await invoice(retail, [[feed, 1, 17000]]);
    expect(r.lines.map((l: any) => [l.listPrice, l.discount])).toEqual([[18000, 1000]]);
  });

  it("libère les clients d'une liste archivée et ne se désactive plus une fois utilisée", async () => {
    expect((await owner.agent.patch(`/company/price-lists/${list}`).send({ archived: true })).body).toEqual({ ok: true });
    expect((await owner.agent.get('/company/contacts').query({ kind: 'customer' })).body.find((c: any) => c.id === wholesaler).priceListId).toBeNull();
    expect((await sales.agent.put(`/platform/companies/${owner.companyId}/features/price_lists`).send({ enabled: false })).body.error.code).toBe('feature_in_use');
  });
});
