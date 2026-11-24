import { Controller, Get, INestApplication } from '@nestjs/common';
import { Permission } from '../src/common/decorators';
import { RequireFeature } from '../src/common/features';
import { createApp, platformUser, resetDb, signup } from './helpers';

/** Route d'essai réservée à une nouveauté. */
@Controller('company/essai-nouveaute')
class TrialController {
  @Permission(null) @RequireFeature('stock_lots')
  @Get()
  get() { return { ok: true }; }
}

/** Nouveautés désactivées par défaut, activées entreprise par entreprise depuis la console. */
describe('Fonctionnalités activées à la demande', () => {
  let app: INestApplication;
  let client: Awaited<ReturnType<typeof signup>>;
  let other: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let support: Awaited<ReturnType<typeof platformUser>>;

  beforeAll(async () => {
    await resetDb();
    app = await createApp([TrialController]);
    client = await signup(app);
    other = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    support = await platformUser(app, 'support');
  });
  afterAll(async () => { await app.close(); });

  it('désactive toute nouveauté par défaut', async () => {
    expect((await client.agent.get('/company/context')).body.features).toEqual([]);
    const r = await client.agent.get('/company/essai-nouveaute');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('feature_not_enabled');
    const list = (await sales.agent.get(`/platform/companies/${client.companyId}/features`)).body;
    expect(list.features.find((f: any) => f.key === 'stock_lots')).toMatchObject({ enabled: false, version: '1.2' });
  });

  it("l'active pour une seule entreprise, avec trace", async () => {
    expect((await support.agent.put(`/platform/companies/${client.companyId}/features/stock_lots`).send({ enabled: true })).status).toBe(403);
    expect((await sales.agent.put(`/platform/companies/${client.companyId}/features/inconnue`).send({ enabled: true })).status).toBe(404);
    expect((await sales.agent.put(`/platform/companies/${client.companyId}/features/stock_lots`).send({ enabled: true })).body).toEqual({ ok: true });
    expect((await client.agent.get('/company/context')).body.features).toEqual(['stock_lots']);
    expect((await client.agent.get('/company/essai-nouveaute')).body).toEqual({ ok: true });
    // L'autre entreprise n'est pas concernée.
    expect((await other.agent.get('/company/context')).body.features).toEqual([]);
    expect((await other.agent.get('/company/essai-nouveaute')).status).toBe(403);
    const list = (await support.agent.get(`/platform/companies/${client.companyId}/features`)).body;
    expect(list.features.find((f: any) => f.key === 'stock_lots')).toMatchObject({ enabled: true, enabledBy: 'Plateforme sales_admin' });
    const ov = (await support.agent.get('/platform/features')).body;
    expect(ov.features.find((f: any) => f.key === 'stock_lots').companies).toBe(1);
    expect(ov.companies.find((c: any) => c.id === client.companyId).enabled).toEqual(['stock_lots']);
    const companies = (await sales.agent.get('/platform/companies')).body;
    expect(Number(companies.find((c: any) => c.id === client.companyId).features)).toBe(1);
  });

  it('la désactive tant qu’elle n’a pas servi', async () => {
    expect((await sales.agent.put(`/platform/companies/${client.companyId}/features/stock_lots`).send({ enabled: false })).body).toEqual({ ok: true });
    expect((await client.agent.get('/company/essai-nouveaute')).status).toBe(403);
  });
});
