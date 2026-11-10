import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, resetDb, signup, uniqueEmail, TIERS } from './helpers';

/** Journaux de caisse, banque et mobile money : brouillon, modification sur place, suppression par l'administrateur. */
describe('Trésorerie : brouillon, modification et suppression des mouvements', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let editor: ReturnType<typeof request.agent>;
  const acc: Record<string, string> = {};
  const bal = async () => Object.fromEntries((await owner.agent.get('/company/treasury/accounts')).body.map((a: any) => [a.kind, a.balance]));
  const tb = async () => {
    const r = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(r.balanced).toBe(true);
    return (code: string) => { const x = r.accounts.find((a: any) => a.account === code); return x ? x.closingDebit - x.closingCredit : 0; };
  };
  const journal = async (kind: string) => (await owner.agent.get('/company/treasury/movements').query({ kind })).body.movements;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    for (const a of (await owner.agent.get('/company/treasury/accounts')).body) acc[a.kind] = a.id;
    // Un rôle qui modifie les mouvements sans pouvoir les supprimer.
    const role = await owner.agent.post('/company/roles').send({ name: 'Trésorier', permissions: ['cash.read', 'cash.create', 'cash.update'] });
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('tresorier'), roleIds: [role.body.id] });
    editor = request.agent(app.getHttpServer());
    await editor.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Trésorier', password: 'MotDePasse123' });
  });
  afterAll(async () => { await app.close(); });

  it('remet une dépense en brouillon : elle sort du solde et de la comptabilité, puis se revalide', async () => {
    await owner.agent.post('/company/treasury/movements').send({ kind: 'income', accountId: acc.cash, amount: 100000, category: 'capital', label: 'Apport' });
    const exp = (await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.cash, amount: 20000, category: 'electricity', label: 'CIE' })).body;
    expect((await bal()).cash).toBe(80000);
    expect((await editor.post(`/company/treasury/movements/${exp.id}/draft`)).status).toBe(200);
    expect((await bal()).cash).toBe(100000);
    expect((await tb())('605200')).toBe(0);
    expect((await journal('cash')).find((m: any) => m.id === exp.id).status).toBe('draft');
    expect((await editor.post(`/company/treasury/movements/${exp.id}/reverse`).send({ reason: 'test' })).status).toBe(403);
    expect((await owner.agent.post(`/company/treasury/movements/${exp.id}/reverse`).send({ reason: 'test' })).body.error.code).toBe('is_draft');

    expect((await editor.patch(`/company/treasury/movements/${exp.id}`).send({ accountId: acc.cash, amount: 25000, category: 'electricity', label: 'CIE de mars' })).status).toBe(200);
    expect((await bal()).cash).toBe(100000);
    expect((await editor.post(`/company/treasury/movements/${exp.id}/post`)).status).toBe(200);
    expect((await bal()).cash).toBe(75000);
    const b = await tb();
    expect(b('605200')).toBe(25000);
    expect(b('571100')).toBe(75000);
    // Aucune contre-passation dans le journal de caisse : la ligne a été modifiée sur place.
    expect((await journal('cash')).filter((m: any) => m.sourceType === 'reversal')).toHaveLength(0);
  });

  it('modifie directement un mouvement validé, refuse une sortie de caisse sans espèces', async () => {
    const exp = (await journal('cash')).find((m: any) => m.label === 'CIE de mars');
    expect((await editor.patch(`/company/treasury/movements/${exp.id}`).send({ accountId: acc.cash, amount: 500000, category: 'electricity', label: 'CIE' })).body.error.code).toBe('insufficient_cash');
    expect((await editor.patch(`/company/treasury/movements/${exp.id}`).send({ accountId: acc.cash, amount: 30000, category: 'electricity', label: 'CIE de mars' })).status).toBe(200);
    expect((await bal()).cash).toBe(70000);
    expect((await tb())('605200')).toBe(30000);
  });

  it('modifie un virement sur ses deux jambes', async () => {
    const tr = (await owner.agent.post('/company/treasury/transfers').send({ fromAccountId: acc.cash, toAccountId: acc.bank, amount: 10000 })).body;
    const leg = (await journal('bank')).find((m: any) => m.transferId === tr.transferId);
    expect((await editor.patch(`/company/treasury/movements/${leg.id}`).send({ fromAccountId: acc.cash, toAccountId: acc.mobile_money, amount: 15000 })).status).toBe(200);
    expect(await bal()).toMatchObject({ cash: 55000, bank: 0, mobile_money: 15000 });
    expect((await tb())('585000')).toBe(0);
  });

  it('seul l’administrateur supprime, y compris une paire déjà contre-passée', async () => {
    const exp = (await journal('cash')).find((m: any) => m.label === 'CIE de mars');
    expect((await editor.delete(`/company/treasury/movements/${exp.id}`)).status).toBe(403);
    expect((await owner.agent.delete(`/company/treasury/movements/${exp.id}`)).status).toBe(200);
    expect((await bal()).cash).toBe(85000);
    expect((await tb())('605200')).toBe(0);
    expect((await journal('cash')).some((m: any) => m.id === exp.id)).toBe(false);

    const old = (await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: acc.cash, amount: 5000, category: 'fuel', label: 'Carburant' })).body;
    await owner.agent.post(`/company/treasury/movements/${old.id}/reverse`).send({ reason: 'saisi en double' });
    const reversal = (await journal('cash')).find((m: any) => m.reversalOf === old.id);
    expect((await owner.agent.delete(`/company/treasury/movements/${reversal.id}`)).status).toBe(200);
    expect((await journal('cash')).some((m: any) => [old.id, reversal.id].includes(m.id))).toBe(false);
    expect((await bal()).cash).toBe(85000);
    await tb();
  });

  it('les mouvements issus d’un document ne se modifient pas ici', async () => {
    const customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Client' })).body.id;
    const inv = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ description: 'Vente', quantity: 1, unitPrice: 1000, vatRate: 0 }] })).body;
    await owner.agent.post(`/company/sales/documents/${inv.id}/validate`);
    await owner.agent.post(`/company/sales/documents/${inv.id}/payments`).send({ amount: 1000, method: 'cash' });
    const pay = (await journal('cash')).find((m: any) => m.category === 'customer_payment');
    expect((await owner.agent.post(`/company/treasury/movements/${pay.id}/draft`)).body.error.code).toBe('not_editable');
    expect((await owner.agent.delete(`/company/treasury/movements/${pay.id}`)).body.error.code).toBe('not_editable');
  });
});
