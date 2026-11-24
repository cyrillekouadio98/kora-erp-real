import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Rapprochement bancaire : relevé importé et pointé avec les mouvements de Kora (fonctionnalité activée à la demande). */
describe('Rapprochement bancaire', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  const acc: Record<string, string> = {};
  const move = (kind: 'expense' | 'income', amount: number, date: string, category: string, label: string) =>
    owner.agent.post('/company/treasury/movements').send({ kind, accountId: acc.bank, amount, date, category, label });
  const statement = [
    { date: day(-1), label: 'PRLV LOYER NOVEMBRE', amount: -150000 },
    { date: day(-5), label: 'VIR RECU APPORT', amount: 500000, reference: 'AP-01' },
    { date: day(-3), label: 'CHQ 0012', amount: -20000 },
    { date: day(-2), label: 'FRAIS TENUE DE COMPTE', amount: -3500 },
  ];
  const view = async () => (await owner.agent.get('/company/treasury/reconciliation').query({ accountId: acc.bank })).body;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    for (const a of (await owner.agent.get('/company/treasury/accounts')).body) acc[a.kind] = a.id;
    await owner.agent.patch(`/company/treasury/accounts/${acc.bank}`).send({ openingDate: day(-30) });
    await move('expense', 150000, day(-3), 'rent', 'Loyer novembre');
    await move('income', 500000, day(-5), 'capital', 'Apport des associés');
    await move('expense', 20000, day(-4), 'supplies', 'Fournitures');
    await move('expense', 20000, day(-2), 'maintenance', 'Réparation');
  });
  afterAll(async () => { await app.close(); });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.get('/company/treasury/reconciliation').query({ accountId: acc.bank })).body.error.code).toBe('feature_not_enabled');
  });

  it('importe le relevé, écarte les doublons et pointe ce qui est sans ambiguïté', async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/bank_reconciliation`).send({ enabled: true });
    expect((await owner.agent.get('/company/treasury/reconciliation').query({ accountId: acc.cash })).body.error.code).toBe('cash_account');
    expect((await owner.agent.post('/company/treasury/reconciliation/import').send({ accountId: acc.bank, lines: statement })).body).toEqual({ imported: 4, duplicates: 0, matched: 2 });
    expect((await owner.agent.post('/company/treasury/reconciliation/import').send({ accountId: acc.bank, lines: statement })).body).toEqual({ imported: 0, duplicates: 4, matched: 0 });
    const v = await view();
    expect(v.summary).toMatchObject({ pending: 2, matched: 2, ignored: 0, pendingAmount: -23500, unmatchedMovements: 2 });
    // Deux dépenses de 20 000 à un jour d'écart chacune : laissé au choix de l'utilisateur.
    expect(v.lines.find((l: any) => l.label === 'CHQ 0012').suggestions).toHaveLength(2);
  });

  it('pointe à la main, enregistre les frais absents de Kora, écarte et dépointe', async () => {
    const v = await view();
    const cheque = v.lines.find((l: any) => l.label === 'CHQ 0012');
    const fees = v.lines.find((l: any) => l.label === 'FRAIS TENUE DE COMPTE');
    const rent = v.lines.find((l: any) => l.label === 'PRLV LOYER NOVEMBRE');
    expect((await owner.agent.post(`/company/treasury/reconciliation/lines/${fees.id}/match`).send({ movementId: cheque.suggestions[0].id })).body.error.code).toBe('amount_mismatch');
    expect((await owner.agent.post(`/company/treasury/reconciliation/lines/${cheque.id}/match`).send({ movementId: rent.movement.id })).body.error.code).toBe('movement_unavailable');
    expect((await owner.agent.post(`/company/treasury/reconciliation/lines/${cheque.id}/match`).send({ movementId: cheque.suggestions[0].id })).body).toEqual({ ok: true });
    const before = v.account.balance;
    expect((await owner.agent.post(`/company/treasury/reconciliation/lines/${fees.id}/record`).send({ category: 'bank_fees' })).body.ok).toBe(true);
    const after = await view();
    expect(after.account.balance).toBe(before - 3500);
    expect(after.summary).toMatchObject({ pending: 0, matched: 4, unmatchedMovements: 1 });
    expect((await owner.agent.post(`/company/treasury/reconciliation/lines/${rent.id}/ignore`).send({ ignored: true })).body.error.code).toBe('already_matched');
    expect((await owner.agent.post(`/company/treasury/reconciliation/lines/${rent.id}/unmatch`)).body).toEqual({ ok: true });
    expect((await owner.agent.post(`/company/treasury/reconciliation/lines/${rent.id}/ignore`).send({ ignored: true })).body).toEqual({ ok: true });
    expect((await view()).summary).toMatchObject({ pending: 0, matched: 3, ignored: 1 });
    expect((await owner.agent.delete(`/company/treasury/reconciliation/lines/${rent.id}`)).body).toEqual({ ok: true });
  });

  it('ne se désactive plus une fois utilisée', async () => {
    expect((await sales.agent.put(`/platform/companies/${owner.companyId}/features/bank_reconciliation`).send({ enabled: false })).body.error.code).toBe('feature_in_use');
  });
});
