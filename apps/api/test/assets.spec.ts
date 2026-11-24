import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup } from './helpers';
import { cumulative, endOfLife, schedule } from '../src/modules/assets/depreciation';

/** Immobilisations et amortissements (fonctionnalité activée à la demande). */
describe('Immobilisations et amortissements', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let truck: string;
  const tb = async () => {
    const r = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(r.balanced).toBe(true);
    return (code: string) => { const x = r.accounts.find((a: any) => a.account === code); return x ? x.closingDebit - x.closingCredit : 0; };
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
  });
  afterAll(async () => { await app.close(); });

  it('calcule un plan linéaire au prorata temporis qui solde le coût', () => {
    const a = { cost: 12_000_000, inServiceDate: '2025-07-01', durationMonths: 48 };
    expect(endOfLife(a)).toBe('2029-06-30');
    const plan = schedule(a);
    expect(plan.map((r) => r.year)).toEqual([2025, 2026, 2027, 2028, 2029]);
    expect(plan[0].dotation).toBe(1_512_329); // 3 000 000 × 184 / 365
    expect(plan[1].dotation).toBe(3_000_000);
    expect(plan.reduce((s, r) => s + r.dotation, 0)).toBe(12_000_000);
    expect(cumulative(a, '2025-06-30')).toBe(0);
  });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.get('/company/assets')).body.error.code).toBe('feature_not_enabled');
  });

  it("enregistre l'achat et la reprise d'un bien existant en comptabilité", async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/fixed_assets`).send({ enabled: true });
    const t = await owner.agent.post('/company/assets').send({ name: 'Camion Isuzu NPR', category: 'vehicles', acquisitionDate: '2025-07-01', cost: 12_000_000, durationMonths: 48, posting: 'supplier' });
    expect(t.body).toMatchObject({ code: 'IMMO-00001' });
    expect(t.body.entry).toMatch(/^OD-/);
    truck = t.body.id;
    const pc = await owner.agent.post('/company/assets').send({ name: 'Ordinateurs du bureau', category: 'computers', acquisitionDate: '2024-01-01', cost: 900_000, durationMonths: 36, priorDepreciation: 600_000, posting: 'opening', postingDate: '2025-01-01' });
    expect(pc.body.entry).toMatch(/^AN-/);
    const b = await tb();
    expect([b('245000'), b('481000'), b('244000'), b('284400'), b('121000')]).toEqual([12_000_000, -12_000_000, 900_000, -600_000, -300_000]);
    const list = (await owner.agent.get('/company/assets')).body;
    expect(list.totals).toMatchObject({ cost: 12_900_000, booked: 600_000, netBookValue: 12_300_000 });
  });

  it('passe les dotations de chaque exercice une seule fois', async () => {
    expect((await owner.agent.get('/company/assets/depreciation/preview').query({ year: 2025 })).body).toMatchObject({ total: 1_512_329, lines: [{ code: 'IMMO-00001', amount: 1_512_329 }] });
    expect((await owner.agent.post('/company/assets/depreciation').send({ year: 2025 })).body).toMatchObject({ total: 1_512_329, assets: 1 });
    expect((await owner.agent.post('/company/assets/depreciation').send({ year: 2025 })).body.error.code).toBe('nothing_to_post');
    expect((await owner.agent.get('/company/assets/depreciation/preview').query({ year: 2026 })).body.total).toBe(3_300_000);
    const b = await tb();
    expect([b('681300'), b('284500')]).toEqual([1_512_329, -1_512_329]);
    const plan = (await owner.agent.get(`/company/assets/${truck}`)).body.schedule;
    expect(plan.slice(0, 2).map((r: any) => r.status)).toEqual(['posted', 'pending']);
  });

  it("sort un bien de l'actif avec sa dotation complémentaire", async () => {
    const r = await owner.agent.post(`/company/assets/${truck}/dispose`).send({ date: '2026-06-30', reason: 'Accident, épave vendue' });
    expect(r.body).toMatchObject({ complementary: 1_487_671, netBookValue: 9_000_000 });
    expect((await owner.agent.post(`/company/assets/${truck}/dispose`).send({ date: '2026-07-01', reason: 'Encore' })).body.error.code).toBe('already_disposed');
    const b = await tb();
    expect([b('245000'), b('284500'), b('812000'), b('681300')]).toEqual([0, 0, 9_000_000, 3_000_000]);
    expect((await owner.agent.get('/company/assets/depreciation/preview').query({ year: 2026 })).body.total).toBe(300_000);
    const check = (await owner.agent.get('/company/accounting/fiscal-years/2026/checklist')).body;
    expect(check.warnings.join(' ')).toContain('dotations aux amortissements 2026 ne sont pas passées (300');
  });

  it('ne se désactive plus une fois utilisée', async () => {
    expect((await sales.agent.put(`/platform/companies/${owner.companyId}/features/fixed_assets`).send({ enabled: false })).body.error.code).toBe('feature_in_use');
  });
});
