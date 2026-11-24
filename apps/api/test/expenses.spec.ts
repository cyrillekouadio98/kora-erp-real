import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, platformUser, resetDb, signup, uniqueEmail } from './helpers';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Notes de frais : déclaration, validation, refus et remboursement (fonctionnalité activée à la demande). */
describe('Notes de frais', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let staff: ReturnType<typeof request.agent>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  const acc: Record<string, string> = {};
  let taxi: string, phone: string;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    for (const a of (await owner.agent.get('/company/treasury/accounts')).body) acc[a.kind] = a.id;
    await owner.agent.patch(`/company/treasury/accounts/${acc.cash}`).send({ openingBalance: 200_000, openingDate: day(-30) });
    const role = await owner.agent.post('/company/roles').send({ name: 'Livreur', permissions: ['sales.read'] });
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('livreur'), roleIds: [role.body.id] });
    staff = request.agent(app.getHttpServer());
    await staff.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Moussa Koné', password: 'MotDePasse123' });
  });
  afterAll(async () => { await app.close(); });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await staff.get('/company/expenses')).body.error.code).toBe('feature_not_enabled');
  });

  it('chacun déclare ses frais avec un justificatif et ne voit que les siens', async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/expenses`).send({ enabled: true });
    expect((await staff.post('/company/expenses').send({ date: day(1), category: 'transport', label: 'Taxi', amount: 1000 })).body.error.code).toBe('future_date');
    expect((await staff.post('/company/expenses').send({ date: day(-1), category: 'transport', label: 'Taxi', amount: 1000, receipt: 'data:text/plain;base64,QUJD' })).body.error.code).toBe('invalid_receipt');
    const a = await staff.post('/company/expenses').send({ date: day(-1), category: 'transport', label: 'Taxi livraison Cocody', amount: 3500, receipt: PNG });
    expect(a.body.code).toBe('NDF-00001');
    taxi = a.body.id;
    phone = (await staff.post('/company/expenses').send({ date: day(-2), category: 'telecom', label: 'Crédit téléphone', amount: 2000 })).body.id;
    const extra = (await staff.post('/company/expenses').send({ date: day(-2), category: 'other_expense', label: 'Doublon', amount: 500 })).body.id;
    expect((await staff.delete(`/company/expenses/${extra}`)).body).toEqual({ ok: true });
    const mine = (await staff.get('/company/expenses')).body;
    expect(mine).toMatchObject({ manager: false, totals: { submitted: 5500 } });
    expect(mine.claims.find((c: any) => c.id === taxi).receipt).toBe(`/company/expenses/${taxi}/receipt`);
    expect((await staff.get('/company/expenses').query({ scope: 'all' })).status).toBe(403);
    expect((await owner.agent.get('/company/expenses')).body.claims).toHaveLength(0);
    const r = await owner.agent.get(`/company/expenses/${taxi}/receipt`);
    expect(r.headers['content-type']).toBe('image/png');
  });

  it('le responsable valide, refuse avec un motif et rembourse depuis la caisse', async () => {
    expect((await staff.post(`/company/expenses/${taxi}/approve`)).status).toBe(403);
    const all = (await owner.agent.get('/company/expenses').query({ scope: 'all' })).body;
    expect(all.claims.map((c: any) => c.user)).toEqual(['Moussa Koné', 'Moussa Koné']);
    expect((await owner.agent.post(`/company/expenses/${phone}/reject`).send({ reason: 'x' })).body.error.code).toBe('invalid_request');
    expect((await owner.agent.post(`/company/expenses/${phone}/reject`).send({ reason: 'Usage personnel' })).body).toEqual({ ok: true });
    expect((await owner.agent.post(`/company/expenses/${taxi}/pay`).send({ accountId: acc.cash })).body.error.code).toBe('claim_not_approved');
    expect((await owner.agent.post(`/company/expenses/${taxi}/approve`)).body).toEqual({ ok: true });
    expect((await staff.delete(`/company/expenses/${taxi}`)).body.error.code).toBe('claim_decided');
    const before = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === acc.cash).balance;
    expect((await owner.agent.post(`/company/expenses/${taxi}/pay`).send({ accountId: acc.cash })).body.ok).toBe(true);
    const after = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === acc.cash).balance;
    expect(after).toBe(before - 3500);
    const mv = (await owner.agent.get('/company/treasury/movements').query({ accountId: acc.cash })).body.movements[0];
    expect(mv).toMatchObject({ label: 'Note de frais NDF-00001 — Moussa Koné : Taxi livraison Cocody', reference: 'NDF-00001' });
    expect((await staff.get('/company/expenses')).body.claims.map((c: any) => [c.code, c.status, c.rejectReason])).toEqual([['NDF-00002', 'rejected', 'Usage personnel'], ['NDF-00001', 'paid', null]]);
  });

  it('ne se désactive plus une fois utilisée', async () => {
    expect((await sales.agent.put(`/platform/companies/${owner.companyId}/features/expenses`).send({ enabled: false })).body.error.code).toBe('feature_in_use');
  });
});
