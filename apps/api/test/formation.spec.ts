import { INestApplication } from '@nestjs/common';
import { today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup } from './helpers';

/** Écritures de constitution (SYSCOHADA révisé) : exemple d'une SA au capital de 10 000 000 FCFA. */
describe('Constitution de la société', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let bank: string;
  const d = today();
  const balance = async () => {
    const tb = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(tb.balanced).toBe(true);
    return (code: string) => { const r = tb.accounts.find((a: any) => a.account === code); return r ? r.closingDebit - r.closingCredit : 0; };
  };
  const pass = (key: string, body: any = {}) => owner.agent.post(`/company/accounting/formation/steps/${key}`).send({ date: d, ...body });
  const step = async (key: string) => (await owner.agent.get('/company/accounting/formation')).body.steps.find((s: any) => s.key === key);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    bank = (await owner.agent.post('/company/treasury/accounts').send({ kind: 'bank', name: 'Banque Atlantique', openingDate: `${d.slice(0, 4)}-01-01` })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it('contrôle la fiche : quart du numéraire libéré en SA', async () => {
    const base = { legalForm: 'SA', date: d, capital: 10_000_000, nature: [{ account: '244000', label: 'Matériel informatique', amount: 4_000_000 }], deposit: 'bank', bankAccountId: bank };
    expect((await owner.agent.put('/company/accounting/formation').send({ ...base, cashPaid: 1_000_000 })).body.error.code).toBe('quarter_release');
    expect((await owner.agent.put('/company/accounting/formation').send({ ...base, nature: [{ account: '601000', label: 'x', amount: 1 }], cashPaid: 3_000_000 })).body.error.code).toBe('nature_account');
    expect((await owner.agent.put('/company/accounting/formation').send({ ...base, cashPaid: 3_000_000 })).status).toBe(200);
    expect((await pass('call')).body.error.code).toBe('step_unavailable');
  });

  it('passe toutes les étapes de l’exemple et les déverse dans les journaux OD et TR', async () => {
    const sub = await step('subscription');
    expect(sub.preview[0].lines.map((l: any) => [l.account, l.debit, l.credit])).toEqual([['461100', 4_000_000, 0], ['461200', 6_000_000, 0], ['101100', 0, 10_000_000]]);
    for (const k of ['subscription', 'call', 'contribution', 'uncalled']) expect((await pass(k)).status).toBe(200);
    expect((await owner.agent.put('/company/accounting/formation').send({ legalForm: 'SA', date: d, capital: 1, cashPaid: 1, bankAccountId: bank })).body.error.code).toBe('formation_started');
    expect((await pass('fees', { fees: [{ account: '632400', label: 'Honoraires du notaire', amount: 500_000 }, { account: '646000', label: 'Droits d’enregistrement', amount: 100_000 }] })).status).toBe(200);

    const b = await balance();
    expect(b('101100')).toBe(-3_000_000);
    expect(b('101300')).toBe(-7_000_000);
    expect(b('101200')).toBe(0);
    expect(b('109000')).toBe(3_000_000);
    for (const c of ['461100', '461200', '461300']) expect(b(c)).toBe(0);
    expect(b('244000')).toBe(4_000_000);
    expect(b('632400') + b('646000')).toBe(600_000);
    const acc = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === bank);
    expect(acc.balance).toBe(2_400_000);
    expect(b(acc.ledgerCode)).toBe(2_400_000);

    const tr = (await owner.agent.get('/company/accounting/entries').query({ journal: 'TR', q: 'Constitution' })).body;
    expect(tr.length).toBe(3);
    const contribution = await step('contribution');
    expect(contribution.done[0].entries.map((e: any) => e.journal).sort()).toEqual(['OD', 'OD', 'TR']);
  });

  it('appelle puis encaisse le solde, en soldant le 109', async () => {
    expect((await pass('balance_call', { amount: 4_000_000 })).body.error.code).toBe('invalid_amount');
    expect((await pass('balance_call')).status).toBe(200);
    expect((await pass('balance_payment', { amount: 1_000_000 })).status).toBe(200);
    expect((await pass('balance_payment')).status).toBe(200);
    const b = await balance();
    expect(b('109000')).toBe(0);
    expect(b('101300')).toBe(-10_000_000);
    expect(b('101100') + b('101200') + b('461300')).toBe(0);
  });

  it('annule la dernière étape par contre-passation, pas une étape antérieure', async () => {
    const s = (await owner.agent.get('/company/accounting/formation')).body.steps;
    const call = s.find((x: any) => x.key === 'call').done[0];
    expect((await owner.agent.post(`/company/accounting/formation/steps/${call.id}/cancel`)).body.error.code).toBe('not_last_step');
    const last = s.find((x: any) => x.key === 'balance_payment').done[1];
    expect(last.cancellable).toBe(true);
    expect((await owner.agent.post(`/company/accounting/formation/steps/${last.id}/cancel`)).status).toBe(200);
    const b = await balance();
    expect(b('101300')).toBe(-8_000_000);
    expect(b('461300')).toBe(2_000_000);
  });

  it('SARL : capital entièrement libéré, souscription au 1013, fonds chez le notaire puis débloqués', async () => {
    await resetDb();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    bank = (await owner.agent.post('/company/treasury/accounts').send({ kind: 'bank', name: 'Banque', openingDate: `${d.slice(0, 4)}-01-01` })).body.id;
    expect((await owner.agent.put('/company/accounting/formation').send({ legalForm: 'SARL', date: d, capital: 1_000_000, cashPaid: 0, deposit: 'notary', bankAccountId: bank })).status).toBe(200);
    expect((await step('call')).blocker).toMatch(/Sans objet/);
    for (const k of ['subscription', 'contribution']) expect((await pass(k)).status).toBe(200);
    let b = await balance();
    expect(b('471100')).toBe(1_000_000);
    expect((await pass('release')).status).toBe(200);
    b = await balance();
    expect(b('101300')).toBe(-1_000_000);
    expect(b('471100')).toBe(0);
    expect(b('461200')).toBe(0);
    expect((await step('uncalled')).blocker).toMatch(/Sans objet/);
  });
});
