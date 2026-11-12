import { INestApplication } from '@nestjs/common';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, TIERS } from './helpers';

// PNG 1×1 transparent
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('Photos des employés et logos des contacts', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let other: Awaited<ReturnType<typeof signup>>;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    other = await signup(app, { companyName: 'Autre SARL' });
    for (const u of [owner, other]) await u.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
  });
  afterAll(async () => { await app.close(); });

  it('enregistre, sert et retire la photo ; la liste ne donne que son adresse', async () => {
    const id = (await owner.agent.post('/company/employees').send({ firstName: 'Awa', lastName: 'Traoré', hireDate: addDays(today(), -10), department: 'Administration' })).body.id;
    expect((await owner.agent.get('/company/employees')).body[0].photo).toBeNull();

    const bad = await owner.agent.put(`/company/employees/${id}/photo`).send({ photo: 'data:text/html;base64,PGgxPg==' });
    expect(bad.body.error.code).toBe('invalid_photo');

    const put = await owner.agent.put(`/company/employees/${id}/photo`).send({ photo: `data:image/png;base64,${PNG}` });
    expect(put.status).toBe(200);
    expect(put.body.photo).toMatch(new RegExp(`^/company/employees/${id}/photo\\?v=\\d+$`));
    const list = (await owner.agent.get('/company/employees')).body;
    expect(list[0].photo).toBe(put.body.photo);

    const img = await owner.agent.get(put.body.photo).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.from(img.body).equals(Buffer.from(PNG, 'base64'))).toBe(true);

    // Une autre entreprise ne voit pas la photo
    expect((await other.agent.get(`/company/employees/${id}/photo`)).status).toBe(404);

    expect((await owner.agent.put(`/company/employees/${id}/photo`).send({ photo: null })).body.photo).toBeNull();
    expect((await owner.agent.get(`/company/employees/${id}/photo`)).status).toBe(404);
  });

  it('enregistre le logo d’un contact et compte ses factures et ce qu’il doit', async () => {
    const c = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'both', name: 'Grossiste Adjamé' })).body;
    const product = (await owner.agent.post('/company/products').send({ name: 'Service', salePrice: 10_000, vatRate: 0, type: 'service' })).body.id;
    const inv = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: c.id, lines: [{ productId: product, description: 'Service', quantity: 1, unitPrice: 10_000, vatRate: 0 }] })).body.id;
    await owner.agent.post(`/company/sales/documents/${inv}/validate`);
    await owner.agent.post(`/company/sales/documents/${inv}/payments`).send({ amount: 4_000, method: 'cash' });
    const buy = (await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: c.id, supplierRef: 'F1', issueDate: today(), lines: [{ description: 'Loyer', quantity: 1, unitPrice: 50_000, vatRate: 0 }] })).body.id;
    await owner.agent.post(`/company/purchases/documents/${buy}/validate`);
    await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: c.id, lines: [{ description: 'Brouillon', quantity: 1, unitPrice: 99_000, vatRate: 0 }] });

    let row = (await owner.agent.get('/company/contacts')).body.find((r: any) => r.id === c.id);
    expect(row).toMatchObject({ logo: null, salesInvoices: 1, receivable: 6_000, purchaseInvoices: 1, payable: 50_000 });

    const put = await owner.agent.put(`/company/contacts/${c.id}/logo`).send({ logo: `data:image/png;base64,${PNG}` });
    expect(put.body.logo).toMatch(new RegExp(`^/company/contacts/${c.id}/logo\\?v=\\d+$`));
    row = (await owner.agent.get('/company/contacts')).body.find((r: any) => r.id === c.id);
    expect(row.logo).toBe(put.body.logo);
    expect((await owner.agent.get(put.body.logo)).headers['content-type']).toBe('image/png');
    expect((await other.agent.get(`/company/contacts/${c.id}/logo`)).status).toBe(404);
    expect((await owner.agent.put(`/company/contacts/${c.id}/logo`).send({ logo: 'data:image/gif;base64,R0lGOD==' })).body.error.code).toBe('invalid_photo');
    expect((await owner.agent.put(`/company/contacts/${c.id}/logo`).send({ logo: null })).body.logo).toBeNull();
  });

  it("enregistre le logo de l'entreprise, visible de ses seuls membres et tracé au journal", async () => {
    expect((await owner.agent.get('/company/context')).body.company.logo).toBeNull();
    const put = await owner.agent.put('/company/logo').send({ logo: `data:image/png;base64,${PNG}` });
    expect(put.body.logo).toMatch(/^\/company\/logo\?v=\d+$/);
    expect((await owner.agent.get('/company/context')).body.company.logo).toBe(put.body.logo);
    expect((await owner.agent.get('/company')).body.logo).toBe(put.body.logo);
    const img = await owner.agent.get('/company/logo');
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.from(img.body).toString('base64')).toBe(PNG);
    expect((await other.agent.get('/company/logo')).status).toBe(404); // l'autre entreprise n'en a pas et ne voit pas celui-ci
    expect((await owner.agent.put('/company/logo').send({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' })).body.error.code).toBe('invalid_photo');
    const audit = (await owner.agent.get('/company/audit')).body;
    expect((audit.items ?? audit).map((e: any) => e.action)).toContain('company.logo_updated');
    expect((await owner.agent.put('/company/logo').send({ logo: null })).body.logo).toBeNull();
    expect((await owner.agent.get('/company/logo')).status).toBe(404);
  });
});
