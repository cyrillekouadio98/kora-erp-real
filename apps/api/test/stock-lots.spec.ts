import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup, TIERS } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Lots et dates de péremption : fonctionnalité activée à la demande (V1.2). */
describe('Stocks : lots et dates de péremption', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let other: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let feed: string, customer: string, supplier: string, dp: string, mag: string;
  const lots = async (query: Record<string, unknown> = {}) => (await owner.agent.get('/company/stock/lots').query(query)).body;
  const byLot = async () => Object.fromEntries((await lots({ productId: feed })).lots.map((l: any) => [`${l.lotNumber}@${l.warehouse}`, l.quantity]));
  const purchase = async (lines: any[]) => {
    const d = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: `F-${Date.now()}`, lines });
    expect(d.status).toBe(201);
    return owner.agent.post(`/company/purchases/documents/${d.body.id}/validate`);
  };
  const line = (quantity: number, lotNumber?: string, expiryDate?: string) => ({ productId: feed, description: 'Aliment ponte 50 kg', quantity, unitPrice: 15000, vatRate: 18, ...(lotNumber ? { lotNumber, expiryDate } : {}) });

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    other = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    feed = (await owner.agent.post('/company/products').send({ name: 'Aliment ponte 50 kg', salePrice: 18000, purchasePrice: 15000, vatRate: 18, unit: 'sac' })).body.id;
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Ferme Koné' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Provenderie du Sud' })).body.id;
    dp = (await owner.agent.get('/company/stock/warehouses')).body[0].id;
    mag = (await owner.agent.post('/company/stock/warehouses').send({ code: 'MAG', name: 'Magasin' })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.get('/company/stock/lots')).body.error.code).toBe('feature_not_enabled');
    expect((await owner.agent.patch(`/company/stock/${feed}`).send({ trackLots: true })).body.error.code).toBe('feature_not_enabled');
    expect((await owner.agent.get('/company/products')).body.find((p: any) => p.id === feed).trackLots).toBe(false);
  });

  it('exige un lot à chaque entrée une fois activée', async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/stock_lots`).send({ enabled: true });
    expect((await owner.agent.patch(`/company/stock/${feed}`).send({ trackLots: true })).status).toBe(200);
    expect((await owner.agent.post(`/company/stock/${feed}/opening`).send({ quantity: 10, unitCost: 15000 })).body.error.code).toBe('lot_required');
    expect((await owner.agent.post(`/company/stock/${feed}/opening`).send({ quantity: 10, unitCost: 15000, lotNumber: 'L0', expiryDate: day(100) })).status).toBe(200);
    expect((await purchase([line(5)])).body.error.code).toBe('lot_required');
    expect((await purchase([line(20, 'A', day(10)), line(30, 'B', day(60))])).status).toBe(200);
    expect(await byLot()).toEqual({ 'A@Dépôt principal': 20, 'B@Dépôt principal': 30, 'L0@Dépôt principal': 10 });
  });

  it('vend le lot qui périme le plus tôt, et le rend si la facture repasse en brouillon', async () => {
    const d = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ productId: feed, description: 'Aliment ponte', quantity: 25, unitPrice: 18000, vatRate: 18 }] });
    expect((await owner.agent.post(`/company/sales/documents/${d.body.id}/validate`)).status).toBe(200);
    expect(await byLot()).toEqual({ 'B@Dépôt principal': 25, 'L0@Dépôt principal': 10 });
    expect((await owner.agent.post(`/company/sales/documents/${d.body.id}/reset-to-draft`).send({ reason: 'Erreur de quantité' })).status).toBe(200);
    expect(await byLot()).toEqual({ 'A@Dépôt principal': 20, 'B@Dépôt principal': 30, 'L0@Dépôt principal': 10 });
  });

  it('signale les lots périmés et bientôt périmés, sans les vendre en premier', async () => {
    const r = await owner.agent.post('/company/stock/documents').send({ type: 'receipt', warehouseId: dp, reason: 'found', lines: [{ productId: feed, quantity: 4, lotNumber: 'C', expiryDate: day(-1) }] });
    expect((await owner.agent.post(`/company/stock/documents/${r.body.id}/validate`)).status).toBe(200);
    const exp = await lots({ status: 'expired' });
    expect(exp.lots.map((l: any) => [l.lotNumber, l.quantity, l.status])).toEqual([['C', 4, 'expired']]);
    expect(exp.expired).toMatchObject({ lots: 1 });
    expect((await lots({ status: 'expiring', days: 30 })).lots.map((l: any) => l.lotNumber)).toEqual(['A']);
    // Transfert : les lots valables partent d'abord et sont recréés à l'arrivée.
    const tr = await owner.agent.post('/company/stock/documents').send({ type: 'transfer', warehouseId: dp, destWarehouseId: mag, lines: [{ productId: feed, quantity: 22 }] });
    expect((await owner.agent.post(`/company/stock/documents/${tr.body.id}/validate`)).status).toBe(200);
    expect(await byLot()).toEqual({ 'A@Magasin': 20, 'B@Magasin': 2, 'B@Dépôt principal': 28, 'C@Dépôt principal': 4, 'L0@Dépôt principal': 10 });
    // Destruction : le bon de sortie prend le lot périmé en premier.
    const out = await owner.agent.post('/company/stock/documents').send({ type: 'issue', warehouseId: dp, reason: 'expired', lines: [{ productId: feed, quantity: 4 }] });
    expect((await owner.agent.post(`/company/stock/documents/${out.body.id}/validate`)).status).toBe(200);
    expect((await byLot())['C@Dépôt principal']).toBeUndefined();
  });

  it("ne touche pas les autres entreprises et ne se désactive plus une fois utilisée", async () => {
    expect((await other.agent.get('/company/stock/lots')).body.error.code).toBe('feature_not_enabled');
    expect((await sales.agent.put(`/platform/companies/${owner.companyId}/features/stock_lots`).send({ enabled: false })).body.error.code).toBe('feature_in_use');
    expect((await owner.agent.patch(`/company/stock/${feed}`).send({ trackLots: false })).body.error.code).toBe('lots_not_empty');
  });
});
