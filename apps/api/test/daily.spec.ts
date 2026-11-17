import { INestApplication } from '@nestjs/common';
import { today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, TIERS } from './helpers';

describe('Point journalier par site', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
  });
  afterAll(async () => { await app.close(); });

  it('donne, site par site et jour par jour, ventes, coût des produits vendus, marge, dépenses de caisse et résultat', async () => {
    const s2 = (await owner.agent.post('/company/sites').send({ name: 'Magasin Cocody', city: 'Abidjan' })).body.id;
    const sites = (await owner.agent.get('/company/sites')).body;
    const main = sites.find((x: any) => x.id !== s2).id;
    const rice = (await owner.agent.post('/company/products').send({ name: 'Riz 25 kg', salePrice: 15000, purchasePrice: 12000, vatRate: 0, openingStock: { quantity: 10 } })).body.id;
    const customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Maquis Chez Tantie', siteId: null })).body.id;

    // Vente du site principal : 3 sacs à 15 000 (coût 12 000 chacun).
    const inv = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ productId: rice, description: 'Riz 25 kg', quantity: 3, unitPrice: 15000, vatRate: 0 }] })).body;
    expect((await owner.agent.post(`/company/sales/documents/${inv.id}/validate`)).status).toBe(200);
    // Le client paie 20 000 sur 45 000 : 25 000 restent non encaissés.
    expect((await owner.agent.post(`/company/sales/documents/${inv.id}/payments`).send({ amount: 20000, method: 'cash' })).status).toBeLessThan(300);

    // Dépenses : une sur la caisse du site principal (comptée), une retrait de l'exploitant (non comptée), une sur la caisse de Cocody.
    const accounts = (await owner.agent.get('/company/treasury/accounts')).body;
    const cashMain = accounts.find((a: any) => a.kind === 'cash' && a.siteId === main) ?? accounts.find((a: any) => a.kind === 'cash' && a.siteId !== s2);
    const cashS2 = accounts.find((a: any) => a.kind === 'cash' && a.siteId === s2);
    for (const a of [cashMain, cashS2]) await owner.agent.post('/company/treasury/movements').send({ kind: 'income', accountId: a.id, amount: 50000, category: 'capital', label: 'Fonds de caisse' });
    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: cashMain.id, amount: 2500, category: 'fuel', label: 'Carburant moto' });
    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: cashMain.id, amount: 5000, category: 'owner_withdrawal', label: 'Retrait gérant' });
    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: cashS2.id, amount: 1000, category: 'fuel', label: 'Taxi' });

    const d = today();
    const r = await owner.agent.get('/company/reports/daily').query({ from: d, to: d });
    expect(r.status).toBe(200);
    const m = r.body.sites.find((x: any) => x.siteId === main), c = r.body.sites.find((x: any) => x.siteId === s2);
    expect(m.days).toHaveLength(1);
    expect(m.days[0]).toMatchObject({ date: d, salesTtc: 45000, cashed: 20000, uncashed: 25000, salesHt: 45000, invoices: 1, cogs: 36000, margin: 9000, expenses: 2500, expenseCount: 1, result: 6500 });
    expect(m.days[0].expenseLabels).toContain('Carburant moto');
    expect(c.days[0]).toMatchObject({ salesTtc: 0, cashed: 0, uncashed: 0, cogs: 0, margin: 0, expenses: 1000, result: -1000 });
    expect(m.totals).toMatchObject({ salesTtc: 45000, cashed: 20000, uncashed: 25000, cogs: 36000, margin: 9000, expenses: 2500, result: 6500 });

    // Site affiché : seul ce site est présenté.
    await owner.agent.post('/company/sites/active').send({ siteId: s2 });
    const only = (await owner.agent.get('/company/reports/daily').query({ from: d, to: d })).body;
    expect(only.sites.map((x: any) => x.siteId)).toEqual([s2]);
    await owner.agent.post('/company/sites/active').send({ siteId: null });
    expect((await owner.agent.get('/company/reports/daily').query({ from: '2026-01-01', to: '2026-12-31' })).body.error.code).toBe('period_too_long');
  });
});
