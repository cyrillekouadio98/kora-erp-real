import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { lastMonths } from '../src/modules/dashboard/dashboard.service';
import { today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, uniqueEmail } from './helpers';

describe('Tableau de bord', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  const month = today().slice(0, 7);

  it('liste les derniers mois dans l’ordre, à cheval sur deux années', () => {
    expect(lastMonths(3, '2026-01-15')).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(lastMonths(12)).toHaveLength(12);
  });

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    const customer = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Grand Client' })).body.id;
    const small = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Petit Client' })).body.id;
    const supplier = (await owner.agent.post('/company/contacts').send({ kind: 'supplier', name: 'Fournisseur' })).body.id;
    const svc = (await owner.agent.post('/company/products').send({ name: 'Maintenance', kind: 'service', salePrice: 50_000, vatRate: 18 })).body.id;
    await owner.agent.post('/company/products').send({ name: 'Article épuisé', salePrice: 1_000, vatRate: 18 });
    const sell = async (contactId: string, unitPrice: number, quantity = 1) => {
      const d = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId, lines: [{ productId: svc, description: 'Maintenance', quantity, unitPrice, vatRate: 18 }] });
      return (await owner.agent.post(`/company/sales/documents/${d.body.id}/validate`)).body;
    };
    const big = await sell(customer, 50_000, 2);
    await sell(small, 20_000);
    const cn = await owner.agent.post(`/company/sales/documents/${big.id}/credit-note`);
    await owner.agent.patch(`/company/sales/documents/${cn.body.id}`).send({ lines: [{ productId: svc, description: 'Remise', quantity: 1, unitPrice: 10_000, vatRate: 18 }] });
    await owner.agent.post(`/company/sales/documents/${cn.body.id}/validate`);
    await owner.agent.post(`/company/sales/documents/${big.id}/payments`).send({ amount: 50_000, method: 'cash' });
    const bill = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'F-1', lines: [{ description: 'Pièces', quantity: 1, unitPrice: 40_000, vatRate: 18 }] });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
  });
  afterAll(async () => { await app.close(); });

  it('agrège le mois : chiffre d’affaires net des avoirs, achats, encaissements, trésorerie', async () => {
    const d = (await owner.agent.get('/company/dashboard').query({ months: 6 })).body;
    expect(d.months).toHaveLength(6);
    const current = d.monthly.find((m: any) => m.month === month);
    expect(current).toMatchObject({ revenueHt: 100_000 + 20_000 - 10_000, purchasesHt: 40_000, collected: 50_000, cashEnd: 50_000 });
    expect(d.monthly[0]).toMatchObject({ revenueHt: 0, purchasesHt: 0 });
  });

  it('classe les meilleurs clients et articles de la période', async () => {
    const d = (await owner.agent.get('/company/dashboard')).body;
    expect(d.topCustomers).toEqual([{ name: 'Grand Client', amount: 90_000 }, { name: 'Petit Client', amount: 20_000 }]);
    expect(d.topProducts).toEqual([{ name: 'Maintenance', unit: 'unité', amount: 110_000, quantity: 2 }]);
  });

  it('regroupe les alertes, les plus urgentes en tête', async () => {
    const d = (await owner.agent.get('/company/dashboard')).body;
    const kinds = d.alerts.map((a: any) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['upcoming_bills', 'out_of_stock']));
    expect(d.alerts.find((a: any) => a.kind === 'upcoming_bills')).toMatchObject({ count: 1, amount: 47_200, href: '/app/achats/echeancier' });
    const sev = d.alerts.map((a: any) => a.severity);
    expect([...sev].sort((a: string, b: string) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b))).toEqual(sev);
  });

  it('ne montre à chacun que ce que ses droits permettent', async () => {
    const roles = await owner.agent.get('/company/roles');
    const role = roles.body.find((r: any) => r.key === 'sales_rep');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('commercial'), roleIds: [role.id] });
    const rep = request.agent(app.getHttpServer());
    await rep.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Commercial', password: 'MotDePasse123' });
    const d = (await rep.get('/company/dashboard')).body;
    expect(d.sections).toEqual({ sales: true, purchases: false, cash: false });
    const current = d.monthly.find((m: any) => m.month === month);
    expect(current).toMatchObject({ revenueHt: 110_000, purchasesHt: 0, cashEnd: null });
    expect(d.alerts.map((a: any) => a.kind)).not.toContain('upcoming_bills');
  });
});
