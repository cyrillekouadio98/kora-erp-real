import { INestApplication } from '@nestjs/common';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup } from './helpers';

// PNG 1×1 transparent
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('Photo des employés', () => {
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
});
