import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, ownerClient, resetDb, signup, uniqueEmail } from './helpers';

describe('Trésorerie : caisse, banque, mobile money', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  const acc: Record<string, string> = {};
  const balances = async () => Object.fromEntries((await owner.agent.get('/company/treasury/accounts')).body.map((a: any) => [a.name, a.balance]));

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    for (const a of (await owner.agent.get('/company/treasury/accounts')).body) acc[a.kind] = a.id;
  });
  afterAll(async () => { await app.close(); });

  it('crée une caisse, une banque et un compte mobile money pour chaque nouvelle entreprise', async () => {
    expect(await balances()).toEqual({ 'Caisse principale': 0, 'Banque principale': 0, 'Mobile money': 0 });
    await owner.agent.patch(`/company/treasury/accounts/${acc.bank}`).send({ name: 'SGCI', bankName: 'Société Générale Côte d’Ivoire', openingBalance: 2_000_000 });
    expect((await balances()).SGCI).toBe(2_000_000);
    expect((await owner.agent.post('/company/treasury/accounts').send({ kind: 'cash', name: 'Caisse boutique', openingBalance: -5 })).body.error.code).toBe('negative_cash');
  });

  it('inscrit chaque encaissement et règlement sur le compte du mode de paiement', async () => {
    const customer = (await owner.agent.post('/company/contacts').send({ kind: 'both', name: 'Partenaire' })).body.id;
    const inv = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ description: 'Vente', quantity: 1, unitPrice: 100000, vatRate: 18 }] });
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/validate`);
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/payments`).send({ amount: 50000, method: 'cash' });
    const paid = await owner.agent.post(`/company/sales/documents/${inv.body.id}/payments`).send({ amount: 68000, method: 'mobile_money', reference: 'OM-1' });
    expect(paid.body.payments.map((p: any) => p.accountName)).toEqual(['Caisse principale', 'Mobile money']);

    const bill = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: customer, supplierRef: 'F-1', lines: [{ description: 'Achat', quantity: 1, unitPrice: 20000, vatRate: 18 }] });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/payments`).send({ amount: 23600, method: 'cash', accountId: acc.cash });
    expect(await balances()).toEqual({ 'Caisse principale': 26400, SGCI: 2_000_000, 'Mobile money': 68000 });
  });

  it('refuse toute sortie qui rendrait la caisse négative', async () => {
    const r = await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.cash, amount: 30000, category: 'fuel', label: 'Carburant' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('insufficient_cash');
    expect(r.body.error.message).toContain('26');
  });

  it('enregistre dépenses, recettes et virements, avec solde progressif', async () => {
    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.bank, amount: 350000, category: 'rent', label: 'Loyer d’octobre' });
    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.cash, amount: 6400, category: 'electricity', label: 'Facture CIE', reference: 'CIE-0925' });
    await owner.agent.post('/company/treasury/movements').send({ kind: 'income', accountId: acc.cash, amount: 100000, category: 'capital', label: "Apport de l'exploitant" });
    const tr = await owner.agent.post('/company/treasury/transfers').send({ fromAccountId: acc.cash, toAccountId: acc.bank, amount: 100000, label: 'Dépôt des espèces' });
    expect(tr.status).toBe(201);
    expect(await balances()).toEqual({ 'Caisse principale': 20000, SGCI: 1_750_000, 'Mobile money': 68000 });

    const journal = await owner.agent.get('/company/treasury/movements').query({ accountId: acc.cash });
    expect(journal.body.opening).toBe(0);
    expect(journal.body.closing).toBe(20000);
    expect(journal.body.movements[0]).toMatchObject({ label: 'Dépôt des espèces', direction: 'out', balanceAfter: 20000 });
    expect((await owner.agent.get('/company/treasury/movements').query({ category: 'electricity' })).body.movements).toHaveLength(1);
    expect((await owner.agent.get('/company/treasury/summary')).body).toMatchObject({ total: 1_838_000, cash: 20000, bank: 1_750_000, mobileMoney: 68000 });
  });

  it('sépare le journal de la caisse, de la banque et du mobile money', async () => {
    const kinds = async (kind: string) => new Set((await owner.agent.get('/company/treasury/movements').query({ kind })).body.movements.map((m: any) => m.accountKind));
    expect([...await kinds('cash')]).toEqual(['cash']);
    expect([...await kinds('bank')]).toEqual(['bank']);
    const mobile = (await owner.agent.get('/company/treasury/movements').query({ kind: 'mobile_money' })).body.movements;
    expect(mobile.map((m: any) => [m.accountName, m.amount])).toEqual([['Mobile money', 68000]]);
    const csv = await owner.agent.get('/company/treasury/movements/export').query({ kind: 'bank' });
    expect(csv.text).toContain('Loyer');
    expect(csv.text).not.toContain('Facture CIE');
    expect((await owner.agent.get('/company/treasury/movements').query({ kind: 'coffre' })).status).toBe(400);
  });

  it('contre-passe au lieu de supprimer, et un virement en entier', async () => {
    const rent = (await owner.agent.get('/company/treasury/movements').query({ category: 'rent' })).body.movements[0];
    expect((await owner.agent.post(`/company/treasury/movements/${rent.id}/reverse`).send({ reason: 'saisi sur le mauvais compte' })).status).toBe(200);
    expect((await owner.agent.post(`/company/treasury/movements/${rent.id}/reverse`).send({ reason: 'encore' })).body.error.code).toBe('already_reversed');
    const transfer = (await owner.agent.get('/company/treasury/movements').query({ category: 'transfer' })).body.movements[0];
    await owner.agent.post(`/company/treasury/movements/${transfer.id}/reverse`).send({ reason: 'dépôt non effectué' });
    expect(await balances()).toEqual({ 'Caisse principale': 120000, SGCI: 2_000_000, 'Mobile money': 68000 });
    const payment = (await owner.agent.get('/company/treasury/movements').query({ category: 'customer_payment' })).body.movements[0];
    expect((await owner.agent.post(`/company/treasury/movements/${payment.id}/reverse`).send({ reason: 'test' })).body.error.code).toBe('not_reversible');

    const c = await ownerClient();
    await expect(c.query('DELETE FROM treasury_movement WHERE id = $1', [rent.id])).rejects.toThrow(/suppression interdite/);
    await expect(c.query('UPDATE treasury_movement SET amount = 1 WHERE id = $1', [payment.id])).rejects.toThrow(/modification interdite/);
    await c.end();
  });

  it("inscrit l'écart d'un arrêté de caisse", async () => {
    const r = await owner.agent.post(`/company/treasury/accounts/${acc.cash}/count`).send({ counted: 118500, note: 'billet de 1 000 manquant' });
    expect(r.body).toEqual({ expected: 120000, counted: 118500, difference: -1500 });
    expect((await balances())['Caisse principale']).toBe(118500);
    expect((await owner.agent.post(`/company/treasury/accounts/${acc.bank}/count`).send({ counted: 1 })).body.error.code).toBe('not_cash');
  });

  it("rembourse le trop-perçu d'un client après avoir", async () => {
    const customer = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Client remboursé' })).body.id;
    const inv = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ description: 'Vente', quantity: 1, unitPrice: 50000, vatRate: 18 }] });
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/validate`);
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/payments`).send({ amount: 59000, method: 'bank_transfer' });
    const cn = await owner.agent.post(`/company/sales/documents/${inv.body.id}/credit-note`);
    await owner.agent.post(`/company/sales/documents/${cn.body.id}/validate`);
    expect((await owner.agent.get(`/company/sales/documents/${inv.body.id}`)).body.refundDue).toBe(59000);

    expect((await owner.agent.post(`/company/sales/documents/${inv.body.id}/refunds`).send({ amount: 60000, method: 'bank_transfer' })).body.error.code).toBe('amount_too_high');
    const r = await owner.agent.post(`/company/sales/documents/${inv.body.id}/refunds`).send({ amount: 59000, method: 'bank_transfer', reference: 'VIR-REMB-1' });
    expect(r.body).toMatchObject({ refundDue: 0, refundedAmount: 59000 });
    expect(r.body.refunds[0]).toMatchObject({ amount: 59000, accountName: 'SGCI' });
    expect((await owner.agent.post(`/company/sales/documents/${inv.body.id}/refunds`).send({ amount: 1, method: 'cash' })).body.error.code).toBe('nothing_to_refund');
    expect((await balances()).SGCI).toBe(2_000_000);
  });

  it('applique les droits : le caissier saisit, seul le responsable arrête la caisse et gère les comptes', async () => {
    const roles = await owner.agent.get('/company/roles');
    const role = roles.body.find((r: any) => r.key === 'cashier');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('caisse'), roleIds: [role.id] });
    const cashier = request.agent(app.getHttpServer());
    await cashier.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Caissière', password: 'MotDePasse123' });
    expect((await cashier.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.cash, amount: 500, category: 'transport', label: 'Taxi' })).status).toBe(201);
    expect((await cashier.post(`/company/treasury/accounts/${acc.cash}/count`).send({ counted: 0 })).status).toBe(403);
    expect((await cashier.post('/company/treasury/accounts').send({ kind: 'cash', name: 'Caisse 2' })).status).toBe(403);
    expect((await cashier.get('/company/treasury/movements').query({ from: addDays(today(), -1) })).status).toBe(200);
  });
});
