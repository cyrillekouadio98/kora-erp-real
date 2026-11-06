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

  it('rapports stocks, clients et fournisseurs sur les mêmes opérations', async () => {
    const q = { from: today(), to: today() };
    const stock = (await owner.agent.get('/company/reports/stock').query(q)).body;
    // 100 sacs à 10 000, 10 vendus puis 2 repris par avoir
    expect(stock.totals).toMatchObject({ valueStart: 0, valueEnd: 920000, cogs: 80000, valueIn: 1020000, valueOut: 100000, out: 0 });
    expect(stock.products[0]).toMatchObject({ name: 'Riz 25 kg', qtyStart: 0, qtyIn: 102, qtyOut: 10, qtyEnd: 92, sold: 8, valueEnd: 920000, status: 'ok' });
    expect(stock.flows).toEqual(expect.arrayContaining([{ key: 'opening', in: 1000000, out: 0 }, { key: 'sale', in: 0, out: 100000 }]));
    expect(stock.trend).toEqual([{ key: today(), value: 920000 }]);

    const customers = (await owner.agent.get('/company/reports/customers').query(q)).body;
    expect(customers.totals).toMatchObject({ salesHt: 120000, active: 1, newCustomers: 1, invoices: 1, averageBasket: 120000, collected: 163500, due: 0, topShare: 100 });
    expect(customers.customers[0]).toMatchObject({ name: 'Supérette Yopougon', salesHt: 120000, collected: 163500, isNew: true });

    const suppliers = (await owner.agent.get('/company/reports/suppliers').query(q)).body;
    expect(suppliers.totals).toMatchObject({ purchasesHt: 50000, active: 1, due: 59000, overdue: 0, dueSoon: 59000, paid: 0 });
    expect(suppliers.schedule.find((x: any) => x.key === 'week').amount).toBe(59000);
  });

  it('rapport de trésorerie : vue d’ensemble et par type de compte, virements internes neutres', async () => {
    const q = { from: today(), to: today() };
    const acc: Record<string, string> = {};
    for (const a of (await owner.agent.get('/company/treasury/accounts')).body) acc[a.kind] = a.id;
    await owner.agent.post('/company/treasury/transfers').send({ fromAccountId: acc.cash, toAccountId: acc.bank, amount: 50000, label: 'Dépôt des espèces' });

    const all = (await owner.agent.get('/company/reports/treasury').query(q)).body;
    // Caisse ouverte à 500 000 ; 163 500 encaissés (100 000 en mobile money) ; 30 000 de carburant, 20 000 retirés, 10 000 de recette
    expect(all.totals).toMatchObject({ start: 0, end: 623500, in: 673500, out: 50000 });
    expect(all.inflows).toEqual([{ key: 'opening', amount: 500000 }, { key: 'customer_payment', amount: 163500 }, { key: 'other_income', amount: 10000 }]);
    expect(all.outflows).toEqual([{ key: 'fuel', amount: 30000 }, { key: 'owner_withdrawal', amount: 20000 }]); // le dépôt en banque n'y figure pas
    expect(all.byKind).toEqual(expect.arrayContaining([{ kind: 'cash', balance: 473500 }, { kind: 'bank', balance: 50000 }, { kind: 'mobile_money', balance: 100000 }]));

    const cash = (await owner.agent.get('/company/reports/treasury').query({ ...q, kind: 'cash' })).body;
    expect(cash.totals).toMatchObject({ end: 473500, out: 100000 });
    expect(cash.outflows).toContainEqual({ key: 'transfer_out', amount: 50000 });
    expect(cash.accounts.map((a: any) => a.kind)).toEqual(['cash']);
    const row = cash.accounts[0];
    expect(row.start + row.in - row.out).toBe(row.end);
    expect((await owner.agent.get('/company/reports/treasury').query({ ...q, kind: 'bank' })).body.inflows).toEqual([{ key: 'transfer_in', amount: 50000 }]);
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
