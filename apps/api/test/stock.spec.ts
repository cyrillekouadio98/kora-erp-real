import { INestApplication } from '@nestjs/common';
import { today } from '../src/modules/sales/sales.service';
import { createApp, ownerClient, resetDb, signup } from './helpers';

describe('Stocks valorisés au CMUP', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let rice: string;
  let customer: string;
  let supplier: string;
  const stock = async () => (await owner.agent.get(`/company/stock/${rice}/movements`)).body.product;
  const sell = async (quantity: number) => {
    const d = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ productId: rice, description: 'Riz 25 kg', quantity, unitPrice: 15000, vatRate: 9 }] });
    return owner.agent.post(`/company/sales/documents/${d.body.id}/validate`);
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    rice = (await owner.agent.post('/company/products').send({ name: 'Riz parfumé 25 kg', salePrice: 15000, vatRate: 9, unit: 'sac' })).body.id;
    customer = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Épicerie du quartier' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ kind: 'supplier', name: 'Importateur de riz' })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it('ne suit en stock que les biens', async () => {
    const svc = await owner.agent.post('/company/products').send({ name: 'Livraison', kind: 'service', salePrice: 5000, vatRate: 18 });
    expect(svc.body.trackStock).toBe(false);
    expect((await owner.agent.patch(`/company/stock/${svc.body.id}`).send({ trackStock: true })).body.error.code).toBe('service_not_stockable');
  });

  it('enregistre le stock initial une seule fois, en à-nouveaux 311 / 471', async () => {
    await owner.agent.post(`/company/stock/${rice}/opening`).send({ quantity: 100, unitCost: 10000 });
    expect(await stock()).toMatchObject({ stock_qty: 100, stock_value: 1_000_000, avg_cost: 10000 });
    expect((await owner.agent.post(`/company/stock/${rice}/opening`).send({ quantity: 1, unitCost: 1 })).body.error.code).toBe('already_has_movements');
    const an = (await owner.agent.get('/company/accounting/entries').query({ journal: 'AN' })).body[0];
    expect(an.lines.map((l: any) => `${l.account} ${l.debit || -l.credit}`).sort()).toEqual(['311000 1000000', '471000 -1000000']);
  });

  it("recalcule le coût moyen à chaque achat (remise déduite)", async () => {
    const bill = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'IMP-1',
      lines: [{ productId: rice, description: 'Riz', quantity: 50, unitPrice: 14000, discountPct: 10, vatRate: 9 }] });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
    // (100 × 10 000 + 50 × 12 600) / 150 = 10 866,67
    expect(await stock()).toMatchObject({ stock_qty: 150, stock_value: 1_630_000, avg_cost: 10866.67 });
  });

  it('sort au coût moyen et refuse de vendre plus que le stock', async () => {
    expect((await sell(30)).body.status).toBe('issued');
    expect(await stock()).toMatchObject({ stock_qty: 120, stock_value: 1_304_000 });
    const tooMuch = await sell(500);
    expect(tooMuch.body.error.code).toBe('insufficient_stock');
    expect(tooMuch.body.error.message).toContain('disponible 120');
    expect(await stock()).toMatchObject({ stock_qty: 120 }); // rien n'a bougé
  });

  it('remet en stock les retours sur avoir, sauf pour une simple remise de prix', async () => {
    const inv = (await owner.agent.get('/company/sales/documents').query({ type: 'invoice', status: 'issued' })).body[0];
    const cn = await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`);
    await owner.agent.patch(`/company/sales/documents/${cn.body.id}`).send({ lines: [{ productId: rice, description: 'Retour', quantity: 10, unitPrice: 15000, vatRate: 9 }] });
    await owner.agent.post(`/company/sales/documents/${cn.body.id}/validate`);
    expect(await stock()).toMatchObject({ stock_qty: 130, stock_value: 1_412_667 });

    const discount = await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`);
    await owner.agent.patch(`/company/sales/documents/${discount.body.id}`).send({ restock: false, lines: [{ productId: rice, description: 'Geste commercial', quantity: 1, unitPrice: 5000, vatRate: 9 }] });
    await owner.agent.post(`/company/sales/documents/${discount.body.id}/validate`);
    expect(await stock()).toMatchObject({ stock_qty: 130 });
  });

  it("corrige le stock par inventaire et vide la valeur avec la dernière unité", async () => {
    const r = await owner.agent.post(`/company/stock/${rice}/count`).send({ counted: 125, reason: 'sacs percés' });
    expect(r.body).toEqual({ expected: 130, counted: 125, difference: -5 });
    expect((await sell(125)).body.status).toBe('issued');
    expect(await stock()).toMatchObject({ stock_qty: 0, stock_value: 0 });
    const card = (await owner.agent.get(`/company/stock/${rice}/movements`)).body.movements;
    expect(card.map((m: any) => m.reason)).toEqual(['sale', 'adjustment', 'sale_return', 'sale', 'purchase', 'opening']);
  });

  it('signale les ruptures et les stocks sous le seuil', async () => {
    const flour = (await owner.agent.post('/company/products').send({ name: 'Farine', salePrice: 1000, vatRate: 18 })).body.id;
    await owner.agent.post(`/company/stock/${flour}/opening`).send({ quantity: 8, unitCost: 600 });
    await owner.agent.patch(`/company/stock/${flour}`).send({ minStock: 10 });
    const o = (await owner.agent.get('/company/stock')).body;
    expect(o.items.find((i: any) => i.id === rice).alert).toBe('out');
    expect(o.items.find((i: any) => i.id === flour).alert).toBe('low');
    expect(o).toMatchObject({ totalValue: 4800, outOfStock: 1, lowStock: 1 });
    expect((await owner.agent.patch(`/company/products/${flour}`).send({ kind: 'service' })).body.error.code).toBe('stock_not_empty');
  });

  it('aligne le compte 311 sur la valeur du stock (variation 6031)', async () => {
    const v = (await owner.agent.post('/company/stock/variation').send({ date: today() })).body;
    // 311 contient le stock initial du riz (1 000 000) et de la farine (4 800) ; il reste 4 800 en stock.
    expect(v).toMatchObject({ stockValue: 4800, booked: 1_004_800, variation: -1_000_000 });
    expect((await owner.agent.post('/company/stock/variation').send({ date: today() })).body.variation).toBe(0);
    const tb = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(tb.accounts.find((a: any) => a.account === '311000')).toMatchObject({ closingDebit: 4800 });
    expect(tb.balanced).toBe(true);
  });

  it('la base interdit un stock négatif et toute retouche des mouvements', async () => {
    const c = await ownerClient();
    try {
      await expect(c.query('UPDATE product SET stock_qty = -1 WHERE id = $1', [rice])).rejects.toThrow(/product_stock_positive_chk/);
      await expect(c.query('UPDATE stock_movement SET quantity = 1 WHERE product_id = $1', [rice])).rejects.toThrow(/ajout seul/);
    } finally { await c.end(); }
  });
});
