import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, uniqueEmail, TIERS } from './helpers';

describe('Gestion des stocks : entrepôts, bons, inventaires, valorisation', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let oil: string, customer: string, supplier: string, cash: string, dp: string, mag: string;
  const year = new Date().getFullYear();
  const product = async () => (await owner.agent.get(`/company/stock/${oil}/movements`)).body.product;
  const item = async (warehouseId?: string) => (await owner.agent.get('/company/stock').query(warehouseId ? { warehouseId } : {})).body.items.find((i: any) => i.id === oil);
  const doc = async (body: Record<string, unknown>) => {
    const d = await owner.agent.post('/company/stock/documents').send(body);
    expect(d.status).toBe(201);
    return d.body;
  };
  const validate = (id: string) => owner.agent.post(`/company/stock/documents/${id}/validate`);
  const invoice = async (quantity: number, warehouseId: string) => {
    const d = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, warehouseId, lines: [{ productId: oil, description: 'Huile 5 L', quantity, unitPrice: 6000, vatRate: 18 }] });
    expect(d.body.warehouseId).toBe(warehouseId);
    return owner.agent.post(`/company/sales/documents/${d.body.id}/validate`);
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    oil = (await owner.agent.post('/company/products').send({ name: 'Huile végétale 5 L', salePrice: 6000, purchasePrice: 4000, vatRate: 18, unit: 'bidon' })).body.id;
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Maquis Chez Tantie' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Grossiste Adjamé' })).body.id;
    cash = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.kind === 'cash').id;
  });
  afterAll(async () => { await app.close(); });

  it("crée le dépôt principal et d'autres entrepôts", async () => {
    const list = (await owner.agent.get('/company/stock/warehouses')).body;
    expect(list).toEqual([expect.objectContaining({ code: 'DP', name: 'Dépôt principal', isDefault: true })]);
    dp = list[0].id;
    const r = await owner.agent.post('/company/stock/warehouses').send({ code: 'mag', name: 'Magasin Treichville' });
    expect(r.status).toBe(201);
    mag = r.body.id;
    expect((await owner.agent.post('/company/stock/warehouses').send({ code: 'MAG', name: 'Doublon' })).body.error.code).toBe('duplicate_code');
    expect((await owner.agent.get('/company/roles')).body.map((x: any) => x.key)).toContain('storekeeper');
  });

  it('transfère entre entrepôts sans changer la valeur du stock', async () => {
    await owner.agent.post(`/company/stock/${oil}/opening`).send({ quantity: 100, unitCost: 4000 });
    const t = await doc({ type: 'transfer', warehouseId: dp, destWarehouseId: mag, lines: [{ productId: oil, quantity: 30 }] });
    const done = (await validate(t.id)).body;
    expect(done).toMatchObject({ status: 'done', number: `BT-${year}-00001`, totalValue: 120_000 });
    expect(await product()).toMatchObject({ stock_qty: 100, stock_value: 400_000 });
    expect(await item(mag)).toMatchObject({ quantity: 30, value: 120_000 });
    expect(await item(dp)).toMatchObject({ quantity: 70 });

    const tooMuch = await doc({ type: 'transfer', warehouseId: mag, destWarehouseId: dp, lines: [{ productId: oil, quantity: 31 }] });
    expect((await validate(tooMuch.id)).body.error.code).toBe('insufficient_stock');
    expect((await owner.agent.delete(`/company/stock/documents/${tooMuch.id}`)).status).toBe(200);
    expect((await owner.agent.post('/company/stock/documents').send({ type: 'transfer', warehouseId: dp, destWarehouseId: dp, lines: [] })).body.error.code).toBe('same_warehouse');
  });

  it("vend depuis l'entrepôt choisi sur la facture", async () => {
    const r = await invoice(40, mag);
    expect(r.body.error.code).toBe('insufficient_stock');
    expect(r.body.error.message).toContain('Magasin Treichville');
    expect((await invoice(10, mag)).status).toBe(200);
    expect(await item(mag)).toMatchObject({ quantity: 20 });
    expect(await product()).toMatchObject({ stock_qty: 90, stock_value: 360_000 });
  });

  it('sort la casse au coût moyen par bon de sortie', async () => {
    expect((await owner.agent.post('/company/stock/documents').send({ type: 'issue', warehouseId: dp, lines: [] })).body.error.code).toBe('reason_required');
    const s = await doc({ type: 'issue', warehouseId: dp, reason: 'loss', notes: 'Bidons percés à la livraison', lines: [{ productId: oil, quantity: 5 }] });
    expect((await validate(s.id)).body).toMatchObject({ number: `BS-${year}-00001`, totalValue: 20_000, lines: [expect.objectContaining({ unitCost: 4000, value: 20_000 })] });
    expect(await product()).toMatchObject({ stock_qty: 85, stock_value: 340_000 });
    // Un bon validé est intangible
    expect((await owner.agent.patch(`/company/stock/documents/${s.id}`).send({ notes: 'x' })).body.error.code).toBe('document_locked');
    expect((await owner.agent.delete(`/company/stock/documents/${s.id}`)).body.error.code).toBe('document_locked');
    expect((await validate(s.id)).body.error.code).toBe('already_validated');
  });

  it('entre un achat comptant payé en caisse : stock, trésorerie et écriture 601', async () => {
    expect((await owner.agent.post('/company/stock/documents').send({ type: 'receipt', reason: 'cash_purchase', lines: [] })).body.error.code).toBe('treasury_account_required');
    await owner.agent.post('/company/treasury/movements').send({ kind: 'income', accountId: cash, amount: 100_000, category: 'capital', label: 'Apport' });
    const r = await doc({ type: 'receipt', warehouseId: dp, reason: 'cash_purchase', treasuryAccountId: cash, contactId: supplier, lines: [{ productId: oil, quantity: 15 }] });
    expect((await validate(r.id)).body.error.code).toBe('unit_cost_required');
    await owner.agent.patch(`/company/stock/documents/${r.id}`).send({ lines: [{ productId: oil, quantity: 15, unitCost: 4400 }] });
    const done = (await validate(r.id)).body;
    expect(done).toMatchObject({ number: `BE-${year}-00001`, totalValue: 66_000, treasuryAccount: expect.objectContaining({ id: cash }) });
    expect(await product()).toMatchObject({ stock_qty: 100, stock_value: 406_000, avg_cost: 4060 });
    const acc = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === cash);
    expect(acc.balance).toBe(34_000);
    const tb = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(tb.accounts.find((a: any) => a.account === '601000')).toMatchObject({ closingDebit: 66_000 });
    expect(tb.balanced).toBe(true);
    // La sortie de caisse d'un achat comptant ne se contre-passe pas seule : elle suit le bon.
    const mv = (await owner.agent.get('/company/treasury/movements').query({ accountId: cash })).body.movements.find((m: any) => m.sourceType === 'stock_purchase');
    expect((await owner.agent.post(`/company/treasury/movements/${mv.id}/reverse`).send({ reason: 'essai' })).body.error.code).toBe('not_reversible');
  });

  it("valide un inventaire complet : seuls les articles comptés sont ajustés", async () => {
    const inv = await doc({ type: 'inventory', warehouseId: dp });
    expect(inv.lines).toEqual([expect.objectContaining({ productId: oil, quantity: null, expected: 80 })]);
    expect((await validate(inv.id)).body.error.code).toBe('no_lines');
    await owner.agent.patch(`/company/stock/documents/${inv.id}`).send({ lines: [{ productId: oil, quantity: 78 }] });
    const done = (await validate(inv.id)).body;
    expect(done).toMatchObject({ number: `INV-${year}-00001`, totalValue: -8120, lines: [expect.objectContaining({ expected: 80, quantity: 78, value: -8120 })] });
    expect(await product()).toMatchObject({ stock_qty: 98, stock_value: 397_880 });
    expect(await item(dp)).toMatchObject({ quantity: 78 });
  });

  it('calcule réservé, à recevoir et la suggestion de réapprovisionnement', async () => {
    const order = await owner.agent.post('/company/sales/documents').send({ type: 'order', contactId: customer, lines: [{ productId: oil, description: 'Huile', quantity: 12, unitPrice: 6000, vatRate: 18 }] });
    await owner.agent.post(`/company/sales/documents/${order.body.id}/validate`);
    const po = await owner.agent.post('/company/purchases/documents').send({ type: 'order', contactId: supplier, warehouseId: mag, lines: [{ productId: oil, description: 'Huile', quantity: 50, unitPrice: 4000, vatRate: 18 }] });
    await owner.agent.post(`/company/purchases/documents/${po.body.id}/validate`);
    await owner.agent.patch(`/company/stock/${oil}`).send({ minStock: 150 });
    expect(await item()).toMatchObject({ quantity: 98, reserved: 12, available: 86, incoming: 50, forecast: 136, toOrder: true, suggested: 164 });
    expect(await item(mag)).toMatchObject({ quantity: 20, reserved: 0, incoming: 50 });
    // La facture fournisseur issue de la commande garde l'entrepôt d'arrivée.
    const draft = (await owner.agent.post(`/company/purchases/documents/${po.body.id}/convert`)).body;
    expect(draft.warehouseId).toBe(mag);
  });

  it('valorise le stock par entrepôt et le rapproche du compte 311', async () => {
    const v = (await owner.agent.get('/company/stock/valuation').query({ date: today() })).body;
    expect(v).toMatchObject({ total: 397_880, stockValue: 397_880, ledger: 400_000, gap: -2120 });
    expect(Object.fromEntries(v.byWarehouse.map((w: any) => [w.code, w.value]))).toEqual({ DP: 316_680, MAG: 81_200 });
    expect((await owner.agent.get('/company/stock/valuation').query({ date: today(), warehouseId: mag })).body.items).toEqual([expect.objectContaining({ quantity: 20, value: 81_200 })]);
    const j = (await owner.agent.get('/company/stock/movements').query({ reason: 'transfer' })).body;
    expect(j.movements.map((m: any) => `${m.direction}:${m.warehouseCode}`).sort()).toEqual(['in:MAG', 'out:DP']);
  });

  it("le magasinier valide les bons mais pas un achat comptant, qui sort de l'argent", async () => {
    const role = (await owner.agent.get('/company/roles')).body.find((r: any) => r.key === 'storekeeper');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('magasinier'), roleIds: [role.id] });
    const token = new URL(inv.body.inviteUrl).searchParams.get('token');
    const sk = request.agent(app.getHttpServer());
    expect((await sk.post('/invitations/accept').send({ token, fullName: 'Magasinier', password: 'MotDePasse123' })).status).toBe(201);
    const issue = await sk.post('/company/stock/documents').send({ type: 'issue', warehouseId: dp, reason: 'consumption', lines: [{ productId: oil, quantity: 1 }] });
    expect((await sk.post(`/company/stock/documents/${issue.body.id}/validate`)).status).toBe(200);
    const buy = await sk.post('/company/stock/documents').send({ type: 'receipt', reason: 'cash_purchase', treasuryAccountId: cash, lines: [{ productId: oil, quantity: 1, unitCost: 4000 }] });
    expect((await sk.post(`/company/stock/documents/${buy.body.id}/validate`)).body.error.code).toBe('cash_permission_required');
    expect((await sk.patch(`/company/stock/${oil}`).send({ minStock: 1 })).status).toBe(403);
    expect((await sk.post('/company/products').send({ name: 'Interdit', salePrice: 1, vatRate: 18 })).status).toBe(403);
  });

  it("n'archive pas un entrepôt qui contient du stock ni l'entrepôt par défaut", async () => {
    expect((await owner.agent.patch(`/company/stock/warehouses/${mag}`).send({ archived: true })).body.error.code).toBe('warehouse_not_empty');
    expect((await owner.agent.patch(`/company/stock/warehouses/${dp}`).send({ archived: true })).body.error.code).toBe('default_warehouse');
    expect((await owner.agent.patch(`/company/stock/warehouses/${mag}`).send({ isDefault: true })).status).toBe(200);
    const list = (await owner.agent.get('/company/stock/warehouses')).body;
    expect(list.find((w: any) => w.isDefault).code).toBe('MAG');
  });
});
