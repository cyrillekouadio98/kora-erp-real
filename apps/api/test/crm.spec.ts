import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup, TIERS } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Suivi commercial : opportunités, étapes, actions et devis lié (fonctionnalité activée à la demande). */
describe('CRM', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let customer: string, other: string, quote: string, opp: string, prospect: string;
  const list = async () => (await owner.agent.get('/company/opportunities')).body;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Supermarché Bon Prix' })).body.id;
    other = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Ferme Koné' })).body.id;
    quote = (await owner.agent.post('/company/sales/documents').send({ type: 'quote', contactId: customer, lines: [{ description: 'Aliment ponte', quantity: 100, unitPrice: 17000, vatRate: 18 }] })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.get('/company/opportunities')).body.error.code).toBe('feature_not_enabled');
  });

  it('crée des opportunités pour un prospect ou un client', async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/crm`).send({ enabled: true });
    expect((await owner.agent.post('/company/opportunities').send({ title: 'Sans client' })).body.error.code).toBe('customer_required');
    prospect = (await owner.agent.post('/company/opportunities').send({ title: 'Ouverture boutique Yopougon', prospectName: 'Mme Diallo', prospectPhone: '+225 07 11 22 33 44', amount: 800_000, source: 'Salon' })).body.id;
    const r = await owner.agent.post('/company/opportunities').send({ title: 'Approvisionnement mensuel', contactId: customer, amount: 2_000_000, expectedClose: day(20) });
    expect(r.body.code).toBe('OPP-00002');
    opp = r.body.id;
    const l = await list();
    expect(l.summary).toMatchObject({ open: 2, pipeline: 2_800_000, weighted: 280_000 });
    expect(l.opportunities.find((o: any) => o.id === prospect)).toMatchObject({ customer: 'Mme Diallo', prospect: true, stage: 'new' });
  });

  it('lie un devis du client et fait avancer les étapes', async () => {
    const otherQuote = (await owner.agent.post('/company/sales/documents').send({ type: 'quote', contactId: other, lines: [{ description: 'Maïs', quantity: 1, unitPrice: 1000, vatRate: 18 }] })).body.id;
    expect((await owner.agent.patch(`/company/opportunities/${opp}`).send({ quoteId: otherQuote })).body.error.code).toBe('quote_other_contact');
    expect((await owner.agent.patch(`/company/opportunities/${opp}`).send({ quoteId: quote })).body).toEqual({ ok: true });
    let o = (await owner.agent.get(`/company/opportunities/${opp}`)).body;
    expect(o).toMatchObject({ stage: 'quote', quoteId: quote });
    expect(o.quotes.map((q: any) => q.id)).toContain(quote);
    expect((await owner.agent.patch(`/company/opportunities/${opp}`).send({ stage: 'won' })).body).toEqual({ ok: true });
    o = (await owner.agent.get(`/company/opportunities/${opp}`)).body;
    expect(o.closedAt).not.toBeNull();
    expect(o.activities[0].note).toBe('Étape : quote → won');
    expect((await list()).summary.wonThisMonth).toEqual({ count: 1, amount: 2_000_000 });
  });

  it('suit les actions à faire et exige un motif de perte', async () => {
    await owner.agent.post(`/company/opportunities/${prospect}/activities`).send({ kind: 'call', note: 'Premier appel, intéressée' });
    const todo = (await owner.agent.post(`/company/opportunities/${prospect}/activities`).send({ kind: 'task', note: 'Rappeler pour le devis', dueDate: day(-1) })).body.id;
    let p = (await list()).opportunities.find((o: any) => o.id === prospect);
    expect(p).toMatchObject({ nextAction: { kind: 'task', note: 'Rappeler pour le devis' }, overdue: true });
    expect((await list()).summary.overdue).toBe(1);
    expect((await owner.agent.post(`/company/opportunities/activities/${todo}/done`)).body).toEqual({ ok: true });
    p = (await list()).opportunities.find((o: any) => o.id === prospect);
    expect(p.nextAction).toBeNull();
    expect((await owner.agent.patch(`/company/opportunities/${prospect}`).send({ stage: 'lost' })).body.error.code).toBe('lost_reason_required');
    expect((await owner.agent.patch(`/company/opportunities/${prospect}`).send({ stage: 'lost', lostReason: 'Prix trop élevé' })).body).toEqual({ ok: true });
    expect((await list()).summary).toMatchObject({ open: 0, lostThisMonth: 1 });
  });

  it('liste les actions à faire de tous les commerciaux, ou les miennes', async () => {
    const third = (await owner.agent.post('/company/opportunities').send({ title: 'Contrat cantine', prospectName: 'École Les Lauriers', prospectPhone: '+225 05 00 11 22 33', source: 'Salon', amount: 500_000 })).body.id;
    await owner.agent.post(`/company/opportunities/${third}/activities`).send({ kind: 'meeting', note: 'Visite de la cantine', dueDate: day(2) });
    await owner.agent.post(`/company/opportunities/${third}/activities`).send({ kind: 'call', note: 'Appel fait' });
    const all = (await owner.agent.get('/company/opportunities/activities')).body;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ note: 'Visite de la cantine', customer: 'École Les Lauriers', phone: '+225 05 00 11 22 33', code: 'OPP-00003' });
    expect((await owner.agent.get('/company/opportunities/activities?mine=true')).body).toHaveLength(1);
  });

  it("analyse les affaires gagnées et perdues de la période", async () => {
    const s = (await owner.agent.get('/company/opportunities/stats')).body;
    expect(s).toMatchObject({ created: 3, won: { count: 1, amount: 2_000_000 }, lost: { count: 1, amount: 800_000 }, rate: 50, averageWon: 2_000_000, cycleDays: 0 });
    expect(s.months).toHaveLength(12);
    expect(s.months[11]).toMatchObject({ won: 1, wonAmount: 2_000_000, lost: 1 });
    expect(s.lostReasons).toEqual([{ reason: 'Prix trop élevé', count: 1 }]);
    expect(s.bySource.map((x: any) => x.name).sort()).toEqual(['Non précisée', 'Salon']);
    expect(s.byOwner[0]).toMatchObject({ won: 1, lost: 1, rate: 50 });
    expect((await owner.agent.get('/company/opportunities/stats?from=2020-01-01&to=2020-03-31')).body).toMatchObject({ won: { count: 0 }, rate: null, months: [{ month: '2020-01' }, { month: '2020-02' }, { month: '2020-03' }] });
  });

  it('ne se désactive plus une fois utilisée', async () => {
    expect((await sales.agent.put(`/platform/companies/${owner.companyId}/features/crm`).send({ enabled: false })).body.error.code).toBe('feature_in_use');
  });
});
