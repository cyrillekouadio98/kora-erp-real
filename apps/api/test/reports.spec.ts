import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, uniqueEmail, TIERS } from './helpers';

describe('Rapport de gestion', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  const report = (from = today(), to = today()) => owner.agent.get('/company/reports/management').query({ from, to });

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'business', billingCycle: 'monthly' });
  });
  afterAll(async () => { await app.close(); });

  it('calcule chiffre d’affaires, marge, dépenses et résultat de la période', async () => {
    const acc: Record<string, string> = {};
    for (const a of (await owner.agent.get('/company/treasury/accounts')).body) acc[a.kind] = a.id;
    await owner.agent.patch(`/company/treasury/accounts/${acc.cash}`).send({ openingBalance: 500_000 });

    const rice = (await owner.agent.post('/company/products').send({ name: 'Riz 25 kg', salePrice: 15000, vatRate: 9, unit: 'sac' })).body.id;
    await owner.agent.post(`/company/stock/${rice}/opening`).send({ quantity: 100, unitCost: 10000 });
    const customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Supérette Yopougon' })).body.id;
    const inv = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ productId: rice, description: 'Riz 25 kg', quantity: 10, unitPrice: 15000, vatRate: 9 }] })).body;
    await owner.agent.post(`/company/sales/documents/${inv.id}/validate`);
    await owner.agent.post(`/company/sales/documents/${inv.id}/payments`).send({ amount: 100000, method: 'mobile_money' });
    await owner.agent.post(`/company/sales/documents/${inv.id}/payments`).send({ amount: 63500, method: 'cash' });

    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.cash, amount: 30000, category: 'fuel', label: 'Carburant' });
    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.cash, amount: 20000, category: 'owner_withdrawal', label: 'Retrait' });
    await owner.agent.post('/company/treasury/movements').send({ kind: 'income', accountId: acc.cash, amount: 10000, category: 'other_income', label: 'Location de bâche' });
    const supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Froid Service' })).body.id;
    const bill = (await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'FS-12', lines: [{ description: 'Maintenance chambre froide', quantity: 1, unitPrice: 50000, vatRate: 18 }] })).body;
    await owner.agent.post(`/company/purchases/documents/${bill.id}/validate`);

    const r = await report();
    expect(r.status).toBe(200);
    expect(r.body.totals).toEqual({ salesTtc: 163500, salesHt: 150000, invoices: 1, cogs: 100000, grossMargin: 50000, expenses: 80000, otherIncome: 10000, result: -20000 });
    expect(r.body.expensesByCategory).toEqual([{ key: 'purchases', amount: 50000 }, { key: 'fuel', amount: 30000 }]); // retrait de l'exploitant exclu
    expect(r.body.collections).toEqual([{ method: 'mobile_money', amount: 100000 }, { method: 'cash', amount: 63500 }]);
    expect(r.body.previous).toEqual({ from: addDays(today(), -1), to: addDays(today(), -1) });
    expect(r.body.previousTotals.salesTtc).toBe(0);
    expect(r.body.trend).toEqual({ unit: 'day', points: [{ key: today(), salesTtc: 163500 }] });
    expect(r.body.topProducts[0]).toMatchObject({ name: 'Riz 25 kg', salesHt: 150000, quantity: 10 });
    expect(r.body.payrollIncluded).toBe(false); // formule sans paie

    // Avoir de 2 sacs : chiffre d'affaires et coût des marchandises diminuent d'autant
    const cn = (await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`)).body;
    await owner.agent.patch(`/company/sales/documents/${cn.id}`).send({ lines: [{ productId: rice, description: 'Riz 25 kg', quantity: 2, unitPrice: 15000, vatRate: 9 }] });
    await owner.agent.post(`/company/sales/documents/${cn.id}/validate`);
    expect((await report()).body.totals).toMatchObject({ salesHt: 120000, cogs: 80000, grossMargin: 40000 });
  });

  it('compare à la période précédente, refuse une période invalide, et suit les droits', async () => {
    const week = await report(addDays(today(), -6), today());
    expect(week.body.previous).toEqual({ from: addDays(today(), -13), to: addDays(today(), -7) });
    expect(week.body.trend.points).toHaveLength(7);
    expect((await report(today(), addDays(today(), -1))).body.error.code).toBe('bad_period');
    expect((await report(addDays(today(), -400), today())).body.error.code).toBe('period_too_long');
    expect((await owner.agent.get('/company/reports/management').query({ from: addDays(today(), -100), to: today() })).body.trend.unit).toBe('month');

    const roles = (await owner.agent.get('/company/roles')).body;
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('caissier'), roleIds: [roles.find((r: any) => r.key === 'cashier').id] });
    const cashier = request.agent(app.getHttpServer());
    await cashier.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Caissier', password: 'MotDePasse123' });
    expect((await cashier.get('/company/reports/management').query({ from: today(), to: today() })).status).toBe(403);
    expect(roles.find((r: any) => r.key === 'director').permissions).toEqual(expect.arrayContaining(['reports.read', 'reports.export']));
  });
});
