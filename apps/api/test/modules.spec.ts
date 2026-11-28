import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup } from './helpers';

/** Modules activables entreprise par entreprise : la formule par défaut, la console pour retirer ou ajouter. */
describe('Modules activables par entreprise', () => {
  let app: INestApplication;
  let client: Awaited<ReturnType<typeof signup>>;
  let other: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let support: Awaited<ReturnType<typeof platformUser>>;
  const set = (key: string, enabled: boolean | null, who = sales, id = client.companyId) => who.agent.put(`/platform/companies/${id}/modules/${key}`).send({ enabled });
  const ctx = async () => (await client.agent.get('/company/context')).body;
  const mod = async (key: string) => (await sales.agent.get(`/platform/companies/${client.companyId}/modules`)).body.modules.find((m: any) => m.key === key);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    client = await signup(app);
    other = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    support = await platformUser(app, 'support');
  });
  afterAll(async () => { await app.close(); });

  it("suit la formule tant que la console n'a rien changé", async () => {
    const c = await ctx();
    expect(c.disabledModules).toEqual([]);
    expect(c.permissions).toContain('stock.read');
    const list = (await support.agent.get(`/platform/companies/${client.companyId}/modules`)).body;
    expect(list.core.map((m: any) => m.key)).toEqual(['contacts', 'products', 'sales', 'cash']);
    expect(await mod('stock')).toMatchObject({ inPlan: true, enabled: true, choice: null });
    expect(await mod('payroll')).toMatchObject({ inPlan: false, enabled: false, requires: ['employees'] });
    expect((await client.agent.get('/company/stock')).status).toBe(200);
  });

  it('retire un module : permissions, menus et accès disparaissent, les données restent', async () => {
    expect((await set('stock', false, support)).status).toBe(403);
    expect((await set('contacts', false)).body.error.code).toBe('core_module');
    expect((await set('stock', false)).body.error.code).toBe('module_required_by'); // le point de vente en dépend
    expect((await set('pos', false)).body).toEqual({ ok: true });
    expect((await set('stock', false)).body).toEqual({ ok: true });
    const c = await ctx();
    expect(c.disabledModules).toEqual(['pos', 'stock']);
    expect(c.permissions.some((p: string) => p.startsWith('stock.') || p.startsWith('pos.'))).toBe(false);
    const r = await client.agent.get('/company/stock');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('module_disabled');
    expect((await client.agent.get('/company/products')).status).toBe(200);
    // Les autres entreprises ne sont pas touchées.
    expect((await other.agent.get('/company/stock')).status).toBe(200);
    expect((await set('pos', true)).body.error.code).toBe('module_requires');
    const ov = (await sales.agent.get('/platform/features')).body.companies.find((x: any) => x.id === client.companyId);
    expect(ov.modulesOff.sort()).toEqual(['pos', 'stock']);
  });

  it('rend un module à sa formule', async () => {
    expect((await set('stock', null)).body).toEqual({ ok: true });
    expect((await set('pos', null)).body).toEqual({ ok: true });
    expect((await ctx()).disabledModules).toEqual([]);
    expect((await client.agent.get('/company/stock')).status).toBe(200);
  });

  it('ferme la banque seule, en gardant la caisse', async () => {
    expect((await set('cash', false)).body.error.code).toBe('core_module');
    expect((await set('bank', false)).body).toEqual({ ok: true });
    const r = await client.agent.post('/company/treasury/accounts').send({ kind: 'bank', name: 'Banque refusée' });
    expect(r.body.error.code).toBe('module_disabled');
    expect((await client.agent.get('/company/treasury/accounts')).status).toBe(200);
    await set('bank', null);
  });

  it('ajoute un module hors formule, sans ouvrir ses voisins', async () => {
    expect((await set('payroll', true)).body.error.code).toBe('module_requires');
    expect((await client.agent.get('/company/employees')).body.error.code).toBe('module_not_in_plan');
    expect((await set('employees', true)).body).toEqual({ ok: true });
    const c = await ctx();
    expect(c.entitlements.modules).toContain('hr');
    expect(c.disabledModules).toEqual(['evaluations', 'leave']);
    expect((await client.agent.get('/company/employees')).status).toBe(200);
    expect((await client.agent.get('/company/leave')).body.error.code).toBe('module_disabled');
    expect((await set('payroll', true)).body).toEqual({ ok: true });
    expect((await ctx()).entitlements.modules).toContain('payroll');
    expect(await mod('payroll')).toMatchObject({ inPlan: false, enabled: true, choice: true });
    expect((await set('employees', false)).body.error.code).toBe('module_required_by');
  });

  it("applique le profil Boutique à une entreprise en service, sans toucher à ses caisses", async () => {
    await set('payroll', null); await set('employees', null);
    expect((await support.agent.post(`/platform/companies/${client.companyId}/profiles/boutique`).send({ registers: 2, purchases: true, accounting: false })).status).toBe(403);
    const r = (await sales.agent.post(`/platform/companies/${client.companyId}/profiles/boutique`).send({ registers: 2, purchases: true, accounting: false })).body;
    expect(r).toMatchObject({ preparing: false, registers: null });
    const res = Object.fromEntries(r.modules.map((m: any) => [m.key, m.result]));
    expect(res).toMatchObject({ accounting: 'removed', calendar: 'removed', payroll: 'unchanged', employees: 'unchanged', stock: 'unchanged', pos: 'unchanged', purchases: 'unchanged' });
    expect((await ctx()).disabledModules.sort()).toEqual(['accounting', 'calendar']);
    expect((await client.agent.get('/company/pos/registers')).body).toHaveLength(0);
    // Rejouable : rien ne change la deuxième fois.
    const again = (await sales.agent.post(`/platform/companies/${client.companyId}/profiles/boutique`).send({ registers: 2, purchases: true, accounting: false })).body;
    expect(again.modules.every((m: any) => m.result === 'unchanged')).toBe(true);
  });

  it("crée les caisses d'une boutique en préparation, sans donner un module hors formule", async () => {
    const p = (await sales.agent.post('/platform/setup').send({ name: 'Boutique Awa', city: 'Abidjan', planCode: 'starter', billingCycle: 'monthly' })).body.id;
    const r = (await sales.agent.post(`/platform/companies/${p}/profiles/boutique`).send({ registers: 3, purchases: true, accounting: true })).body;
    expect(r).toMatchObject({ preparing: true, registers: { created: ['Caisse 1', 'Caisse 2', 'Caisse 3'], existing: [] } });
    const res = Object.fromEntries(r.modules.map((m: any) => [m.key, m.result]));
    expect(res).toMatchObject({ purchases: 'not_in_plan', accounting: 'not_in_plan', pos: 'unchanged', calendar: 'removed' });
    const setup = (await sales.agent.get(`/platform/setup/${p}`)).body;
    expect(setup.accounts.filter((a: any) => a.kind === 'cash').map((a: any) => a.name).sort()).toEqual(['Caisse 2', 'Caisse 3', 'Caisse principale']);
    const again = (await sales.agent.post(`/platform/companies/${p}/profiles/boutique`).send({ registers: 3, purchases: true, accounting: true })).body;
    expect(again.registers).toEqual({ created: [], existing: ['Caisse 1', 'Caisse 2', 'Caisse 3'] });
  });
});
