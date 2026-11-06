import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MailService } from '../src/modules/mail/mail.service';
import { createApp, resetDb, signup, uniqueEmail } from './helpers';

describe('Tâches de fond déclenchées par un planificateur (Supabase pg_cron → POST /jobs/tick)', () => {
  let app: INestApplication;
  let mail: MailService;
  const sent: string[] = [];
  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    mail = app.get(MailService);
    mail.useTransport(async (m) => { sent.push(m.to); });
  });
  afterAll(async () => { await app.close(); });

  it('envoie les e-mails en attente quand le planificateur appelle avec le bon secret', async () => {
    const owner = await signup(app);
    const roles = (await owner.agent.get('/company/roles')).body;
    const email = uniqueEmail('invite');
    await owner.agent.post('/company/invitations').send({ email, roleIds: [roles.find((r: any) => r.key === 'cashier').id] });
    expect((await owner.agent.get('/company/emails')).body.messages[0].status).toBe('queued');

    const http = request(app.getHttpServer());
    expect((await http.post('/jobs/tick')).status).toBe(404);
    expect((await http.post('/jobs/tick').set('authorization', 'Bearer mauvais')).status).toBe(404);
    const tick = await http.post('/jobs/tick').set('authorization', 'Bearer secret-de-test');
    expect(tick.status).toBe(200);
    expect(tick.body.emails).toMatchObject({ sent: 1 });
    expect(sent).toEqual([email]);
    expect((await owner.agent.get('/company/emails')).body.messages[0].status).toBe('sent');
  });
});
