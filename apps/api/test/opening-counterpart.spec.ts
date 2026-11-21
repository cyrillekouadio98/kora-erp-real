import { INestApplication } from '@nestjs/common';
import { createApp, resetDb, signup } from './helpers';

/** Contrepartie des soldes d'ouverture (stock initial, trésorerie) et reclassement du compte d'attente 471000. */
describe("Soldes d'ouverture : contrepartie choisie et reclassement du compte d'attente", () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  const acc: Record<string, string> = {};
  const product = async (name: string) => (await owner.agent.post('/company/products').send({ name, kind: 'good', salePrice: 1000, vatRate: 18 })).body.id as string;
  const solde = async (code: string) => {
    const r = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(r.balanced).toBe(true);
    const x = r.accounts.find((a: any) => a.account === code);
    return x ? x.closingDebit - x.closingCredit : 0;
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    for (const a of (await owner.agent.get('/company/treasury/accounts')).body) acc[a.kind] = a.id;
  });
  afterAll(async () => { await app.close(); });

  it('passe le stock initial sur la contrepartie choisie', async () => {
    const a = await product('Article apporté');
    expect((await owner.agent.post(`/company/stock/${a}/opening`).send({ quantity: 10, unitCost: 5000, counterpart: '101000' })).status).toBe(200);
    expect(await solde('101000')).toBe(-50_000);
    const b = await product('Article inconnu');
    expect((await owner.agent.post(`/company/stock/${b}/opening`).send({ quantity: 1, unitCost: 1, counterpart: '601000' })).body.error.code).toBe('invalid_request');
    // À la création de l'article aussi.
    const c = await owner.agent.post('/company/products').send({ name: 'Article dû', kind: 'good', salePrice: 1000, vatRate: 18, openingStock: { quantity: 2, unitCost: 10_000, counterpart: '401000' } });
    expect(c.status).toBe(201);
    expect(await solde('401000')).toBe(-20_000);
  });

  it("garde la contrepartie du compte de trésorerie, 121000 par défaut", async () => {
    const list = async () => (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === acc.cash);
    expect((await list()).openingCounterpart).toBe('121000');
    await owner.agent.patch(`/company/treasury/accounts/${acc.cash}`).send({ openingBalance: 300_000, openingCounterpart: '471000' });
    expect((await list()).openingCounterpart).toBe('471000');
    const bank = await owner.agent.post('/company/treasury/accounts').send({ kind: 'bank', name: 'Banque prêt', openingBalance: 1_000_000, openingCounterpart: '162000' });
    expect(bank.status).toBe(201);
    expect(await solde('162000')).toBe(-1_000_000);
  });

  it("reclasse le compte d'attente, en une ou plusieurs fois", async () => {
    const d = await product('Article en attente');
    await owner.agent.post(`/company/stock/${d}/opening`).send({ quantity: 4, unitCost: 50_000, counterpart: '471000' });
    const s = (await owner.agent.get('/company/accounting/suspense')).body;
    expect(s.balance).toBe(-500_000);
    expect(s.origins.map((o: any) => `${o.sourceType} ${o.balance}`).sort()).toEqual(['stock_opening -200000', 'treasury_opening -300000']);

    const date = new Date().toISOString().slice(0, 10);
    expect((await owner.agent.post('/company/accounting/suspense/reclassify').send({ counterpart: '471000', date })).body.error.code).toBe('same_account');
    expect((await owner.agent.post('/company/accounting/suspense/reclassify').send({ counterpart: '101000', amount: 600_000, date })).body.error.code).toBe('amount_out_of_range');
    const part = await owner.agent.post('/company/accounting/suspense/reclassify').send({ counterpart: '462000', amount: 200_000, date });
    expect(part.body).toMatchObject({ amount: 200_000, remaining: 300_000 });
    expect(part.body.number).toMatch(/^OD-/);
    expect((await owner.agent.post('/company/accounting/suspense/reclassify').send({ counterpart: '121000', date })).body).toMatchObject({ amount: 300_000, remaining: 0 });
    expect(await solde('471000')).toBe(0);
    expect(await solde('462000')).toBe(-200_000);
    expect((await owner.agent.get('/company/accounting/suspense')).body).toMatchObject({ balance: 0, origins: [] });
    expect((await owner.agent.post('/company/accounting/suspense/reclassify').send({ counterpart: '121000', date })).body.error.code).toBe('suspense_settled');
  });
});
