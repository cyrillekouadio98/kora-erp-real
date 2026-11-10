import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, uniqueEmail } from './helpers';

async function invite(app: INestApplication, owner: any, roleKey: string) {
  const role = (await owner.agent.get('/company/roles')).body.find((r: any) => r.key === roleKey);
  const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail(roleKey), roleIds: [role.id] });
  const token = new URL(inv.body.inviteUrl).searchParams.get('token');
  const agent = request.agent(app.getHttpServer());
  expect((await agent.post('/invitations/accept').send({ token, fullName: `Caissière ${roleKey}`, password: 'MotDePasse123' })).status).toBe(201);
  return agent;
}

describe('Point de vente : caisses, sessions, tickets', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let register: string, rice: string, oil: string, delivery: string, cash: string;
  const year = today().slice(0, 4);
  const cashBalance = async () => (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === cash).balance;
  const product = async (id: string) => (await owner.agent.get(`/company/stock/${id}/movements`)).body.product;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    rice = (await owner.agent.post('/company/products').send({ name: 'Riz parfumé 5 kg', salePrice: 5000, purchasePrice: 4000, vatRate: 0, unit: 'sac', barcode: '6151100000017' })).body.id;
    oil = (await owner.agent.post('/company/products').send({ name: 'Huile 1 L', salePrice: 1500, purchasePrice: 1100, vatRate: 18, unit: 'bouteille', barcode: '6151100000024' })).body.id;
    delivery = (await owner.agent.post('/company/products').send({ kind: 'service', name: 'Livraison', salePrice: 1000, vatRate: 18 })).body.id;
    await owner.agent.post(`/company/stock/${rice}/opening`).send({ quantity: 20, unitCost: 4000 });
    await owner.agent.post(`/company/stock/${oil}/opening`).send({ quantity: 50, unitCost: 1100 });
    cash = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.kind === 'cash').id;
  });
  afterAll(async () => { await app.close(); });

  it('un code-barres désigne un seul article et retrouve l’article à la recherche', async () => {
    const dup = await owner.agent.post('/company/products').send({ name: 'Autre riz', salePrice: 4500, vatRate: 0, barcode: '6151100000017' });
    expect(dup.body.error.code).toBe('barcode_taken');
    expect((await owner.agent.get('/company/products').query({ q: '6151100000024' })).body.map((p: any) => p.id)).toEqual([oil]);
  });

  it('crée une caisse sur le site principal avec son entrepôt, sa caisse et un client comptoir', async () => {
    const res = await owner.agent.post('/company/pos/registers').send({ name: 'Caisse 1' });
    expect(res.status).toBe(201);
    register = res.body.id;
    const [r] = (await owner.agent.get('/company/pos/registers')).body;
    expect(r).toMatchObject({ name: 'Caisse 1', cashAccountId: cash, session: null });
    expect((await owner.agent.post('/company/pos/registers').send({ name: 'Caisse 1' })).body.error.code).toBe('register_exists');
    const catalog = (await owner.agent.get(`/company/pos/registers/${register}/catalog`)).body;
    expect(catalog.find((p: any) => p.id === rice)).toMatchObject({ barcode: '6151100000017', stock: 20, salePrice: 5000 });
    expect(catalog.find((p: any) => p.id === delivery)).toMatchObject({ stock: null });
  });

  it('vend un ticket payé en espèces avec rendu de monnaie : stock, caisse et comptabilité suivent', async () => {
    const before = await cashBalance();
    const session = (await owner.agent.post(`/company/pos/registers/${register}/open`).send({ openingFloat: 10000 })).body;
    expect(session.number).toBe(`SES-${year}-00001`);
    expect((await owner.agent.post(`/company/pos/registers/${register}/open`).send({})).body.error.code).toBe('session_open');

    const res = await owner.agent.post(`/company/pos/sessions/${session.id}/tickets`).send({
      lines: [{ productId: rice, description: 'Riz parfumé 5 kg', quantity: 2, unitPrice: 5000, vatRate: 0 }, { productId: oil, description: 'Huile 1 L', quantity: 3, unitPrice: 1500, vatRate: 18 }],
      payments: [{ method: 'cash', amount: 20000 }],
    });
    expect(res.status).toBe(201);
    // 10 000 + 4 500 HT + 810 TVA = 15 310 ; rendu 4 690.
    expect(res.body).toMatchObject({ number: `TK-${year}-00001`, status: 'paid', totalTtc: 15310, cashTendered: 20000, change: 4690, walkIn: true, cashier: expect.any(String), registerName: 'Caisse 1' });
    expect(res.body.payments).toEqual([expect.objectContaining({ method: 'cash', amount: 15310 })]);
    expect(res.body.vat).toEqual([{ rate: 18, ht: 4500, vat: 810 }, { rate: 0, ht: 10000, vat: 0 }]);
    expect(await cashBalance()).toBe(before + 15310);
    expect(await product(rice)).toMatchObject({ stock_qty: 18 });
    const tb = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(tb.balanced).toBe(true);
    expect(tb.accounts.find((a: any) => a.account === '411000')).toMatchObject({ closingDebit: 0 });

    // Les tickets ne chargent pas la liste des factures ; la recherche par numéro les retrouve.
    expect((await owner.agent.get('/company/sales/documents').query({ type: 'invoice' })).body).toHaveLength(0);
    expect((await owner.agent.get('/company/sales/documents').query({ type: 'invoice', q: 'TK-' })).body).toHaveLength(1);
  });

  it('accepte un paiement mixte espèces + mobile money et refuse un paiement insuffisant ou un rendu sur le mobile money', async () => {
    const session = (await owner.agent.get('/company/pos/sessions').query({ status: 'open' })).body[0];
    const lines = [{ productId: oil, description: 'Huile 1 L', quantity: 2, unitPrice: 1500, vatRate: 18 }, { productId: delivery, description: 'Livraison', quantity: 1, unitPrice: 1000, vatRate: 18 }];
    // 4 000 HT + 720 = 4 720
    const short = await owner.agent.post(`/company/pos/sessions/${session.id}/tickets`).send({ lines, payments: [{ method: 'cash', amount: 4000 }] });
    expect(short.body.error.code).toBe('underpaid');
    const over = await owner.agent.post(`/company/pos/sessions/${session.id}/tickets`).send({ lines, payments: [{ method: 'mobile_money', amount: 5000 }] });
    expect(over.body.error.code).toBe('overpaid_non_cash');
    const ok = await owner.agent.post(`/company/pos/sessions/${session.id}/tickets`).send({ lines, payments: [{ method: 'mobile_money', amount: 3000, reference: 'OM-123' }, { method: 'cash', amount: 2000 }] });
    expect(ok.body).toMatchObject({ number: `TK-${year}-00002`, totalTtc: 4720, change: 280 });
    expect(ok.body.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 1720], ['mobile_money', 3000]]);
    // Stock insuffisant : la vente est refusée et rien n'est enregistré.
    const tooMuch = await owner.agent.post(`/company/pos/sessions/${session.id}/tickets`).send({ lines: [{ productId: rice, description: 'Riz', quantity: 100, unitPrice: 5000, vatRate: 0 }], payments: [{ method: 'cash', amount: 500000 }] });
    expect(tooMuch.status).toBe(409);
    expect((await owner.agent.get('/company/pos/tickets').query({ sessionId: session.id })).body).toHaveLength(2);
  });

  it('une caissière vend sur sa session ; elle ne gère pas les caisses ; la clôture inscrit l’écart et produit le rapport Z', async () => {
    const cashier = await invite(app, owner, 'cashier');
    expect((await cashier.post('/company/pos/registers').send({ name: 'Caisse pirate' })).status).toBe(403);
    const open = (await owner.agent.get('/company/pos/sessions').query({ status: 'open' })).body[0];
    // La session du propriétaire ne se clôture pas par la caissière.
    expect((await cashier.post(`/company/pos/sessions/${open.id}/close`).send({ countedCash: 0 })).status).toBe(403);

    const report = (await owner.agent.get(`/company/pos/sessions/${open.id}/report`)).body;
    expect(report.totals).toMatchObject({ tickets: 2, ttc: 20030 });
    expect(report.session.expectedCash).toBe(10000 + 15310 + 1720);
    expect(report.byMethod).toEqual(expect.arrayContaining([{ method: 'cash', amount: 17030, count: 2 }, { method: 'mobile_money', amount: 3000, count: 1 }]));

    const before = await cashBalance();
    const closed = (await owner.agent.post(`/company/pos/sessions/${open.id}/close`).send({ countedCash: 27000, note: 'Pièce manquante' })).body;
    expect(closed).toMatchObject({ expectedCash: 27030, countedCash: 27000, difference: -30 });
    expect(await cashBalance()).toBe(before - 30);
    expect((await owner.agent.post(`/company/pos/sessions/${open.id}/tickets`).send({ lines: [{ description: 'x', quantity: 1, unitPrice: 1, vatRate: 0 }], payments: [{ method: 'cash', amount: 1 }] })).body.error.code).toBe('session_closed');

    const mine = (await cashier.post(`/company/pos/registers/${register}/open`).send({ openingFloat: 5000 })).body;
    const sold = await cashier.post(`/company/pos/sessions/${mine.id}/tickets`).send({ lines: [{ productId: rice, description: 'Riz', quantity: 1, unitPrice: 5000, vatRate: 0 }], payments: [{ method: 'cash', amount: 5000 }] });
    expect(sold.body).toMatchObject({ number: `TK-${year}-00003`, change: 0 });
    expect((await cashier.post(`/company/pos/sessions/${mine.id}/close`).send({ countedCash: 10000 })).body.difference).toBe(0);
    expect((await owner.agent.get('/company/accounting/trial-balance')).body.balanced).toBe(true);
  });
});
