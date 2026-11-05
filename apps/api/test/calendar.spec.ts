import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CalendarService } from '../src/modules/calendar/calendar.service';
import { createApp, ownerClient, resetDb, signup, uniqueEmail, TIERS } from './helpers';

describe('Calendrier : rendez-vous, participants, rappels', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let rep: ReturnType<typeof request.agent>;
  let repId: string, customer: string, apptId: string;
  const at = (days: number, hour: number, minute = 0) => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(hour, minute, 0, 0); return d.toISOString();
  };
  const mails = async (kind: string) => {
    const c = await ownerClient();
    try { return (await c.query('SELECT to_address, subject FROM email_message WHERE kind = $1 ORDER BY created_at', [kind])).rows; } finally { await c.end(); }
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Maquis Chez Tantie', phone: '+225 07 00 00 00 01' })).body.id;
    const roles = (await owner.agent.get('/company/roles')).body;
    const email = uniqueEmail('commercial');
    const inv = await owner.agent.post('/company/invitations').send({ email, roleIds: [roles.find((r: any) => r.key === 'sales_rep').id] });
    rep = request.agent(app.getHttpServer());
    await rep.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Yao Commercial', password: 'MotDePasse123' });
    repId = (await owner.agent.get('/company/calendar/people')).body.find((p: any) => p.email === email).id;
  });
  afterAll(async () => { await app.close(); });

  it('planifie un rendez-vous client et prévient les participants', async () => {
    const r = await owner.agent.post('/company/calendar/appointments').send({
      title: 'Présentation des nouveaux tarifs', kind: 'visit', start: at(1, 10), end: at(1, 11), location: 'Yopougon', contactId: customer,
      attendeeIds: [owner.userId, repId], reminderMinutes: 60,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'visit', status: 'planned', contact: { name: 'Maquis Chez Tantie' }, conflicts: [] });
    expect(r.body.attendees.map((a: any) => a.name).sort()).toEqual(['Utilisateur Test', 'Yao Commercial']);
    apptId = r.body.id;
    const sent = await mails('appointment');
    expect(sent).toHaveLength(1); // l'auteur ne se prévient pas lui-même
    expect(sent[0].subject).toBe('Nouveau rendez-vous — Présentation des nouveaux tarifs');

    // Le commercial le voit dans son agenda ; une plage sans rendez-vous est vide
    expect((await rep.get('/company/calendar/appointments').query({ from: at(1, 0), to: at(2, 0), userId: repId })).body.map((a: any) => a.id)).toEqual([apptId]);
    expect((await rep.get('/company/calendar/appointments').query({ from: at(3, 0), to: at(4, 0) })).body).toHaveLength(0);
    expect((await owner.agent.get('/company/calendar/appointments').query({ from: at(0, 0), to: at(9, 0), contactId: customer })).body).toHaveLength(1);
  });

  it('signale un chevauchement et refuse les horaires incohérents', async () => {
    const r = await rep.post('/company/calendar/appointments').send({ title: 'Appel fournisseur', kind: 'call', start: at(1, 10, 30), end: at(1, 10, 45) });
    expect(r.status).toBe(201);
    expect(r.body.attendees.map((a: any) => a.id)).toEqual([repId]); // sans participant : son auteur
    expect(r.body.conflicts).toEqual([expect.objectContaining({ appointmentId: apptId, person: 'Yao Commercial' })]);
    expect((await rep.post('/company/calendar/appointments').send({ title: 'X', start: at(1, 12), end: at(1, 11) })).body.error.code).toBe('end_before_start');
    expect((await rep.post('/company/calendar/appointments').send({ title: 'X', start: at(1, 12), end: at(1, 13), attendeeIds: ['11111111-1111-4111-8111-111111111111'] })).body.error.code).toBe('unknown_attendee');
    expect((await rep.delete(`/company/calendar/appointments/${r.body.id}`)).status).toBe(200);
  });

  it('déplace, annule et exporte le rendez-vous', async () => {
    const moved = await rep.patch(`/company/calendar/appointments/${apptId}`).send({ start: at(2, 15), end: at(2, 16) });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.start).toISOString()).toBe(at(2, 15));
    expect((await mails('appointment')).at(-1)).toMatchObject({ subject: 'Rendez-vous modifié — Présentation des nouveaux tarifs' });

    const ics = await owner.agent.get(`/company/calendar/appointments/${apptId}/ics`);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text).toContain('SUMMARY:Présentation des nouveaux tarifs');
    expect(ics.text).toContain('TRIGGER:-PT60M');

    expect((await owner.agent.post(`/company/calendar/appointments/${apptId}/status`).send({ status: 'cancelled' })).body.status).toBe('cancelled');
    expect((await mails('appointment')).at(-1)).toMatchObject({ subject: 'Rendez-vous annulé — Présentation des nouveaux tarifs' });
    expect((await owner.agent.get('/company/calendar/appointments').query({ from: at(0, 0), to: at(9, 0) })).body).toHaveLength(0);
    expect((await owner.agent.get('/company/calendar/appointments').query({ from: at(0, 0), to: at(9, 0), includeCancelled: 'true' })).body).toHaveLength(1);
    expect((await owner.agent.patch(`/company/calendar/appointments/${apptId}`).send({ title: 'Y' })).body.error.code).toBe('appointment_cancelled');
    expect((await owner.agent.post(`/company/calendar/appointments/${apptId}/status`).send({ status: 'planned' })).body.status).toBe('planned');
  });

  it('envoie le rappel une seule fois, à l’heure prévue', async () => {
    const soon = await owner.agent.post('/company/calendar/appointments').send({ title: 'Point caisse', start: new Date(Date.now() + 20 * 60_000).toISOString(),
      end: new Date(Date.now() + 50 * 60_000).toISOString(), attendeeIds: [owner.userId, repId], reminderMinutes: 30 });
    const calendar = app.get(CalendarService);
    expect((await calendar.sendReminders()).sent).toBe(2);
    expect((await calendar.sendReminders()).sent).toBe(0);
    expect((await mails('appointment_reminder')).map((m) => m.subject)).toEqual(['Rappel : Point caisse', 'Rappel : Point caisse']);
    // Le rendez-vous de demain (rappel 60 min avant) n'est pas encore dû
    expect((await owner.agent.get(`/company/calendar/appointments/${soon.body.id}`)).body.remindedAt).not.toBeNull();
    expect((await owner.agent.get(`/company/calendar/appointments/${apptId}`)).body.remindedAt).toBeNull();
  });

  it('réserve la création et la suppression aux droits du calendrier', async () => {
    const roles = (await owner.agent.get('/company/roles')).body;
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('caisse'), roleIds: [roles.find((r: any) => r.key === 'cashier').id] });
    const cashier = request.agent(app.getHttpServer());
    await cashier.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Caissière', password: 'MotDePasse123' });
    expect((await cashier.get('/company/calendar/appointments').query({ from: at(0, 0), to: at(9, 0) })).status).toBe(200);
    expect((await cashier.post('/company/calendar/appointments').send({ title: 'X', start: at(1, 9), end: at(1, 10) })).status).toBe(403);
    expect((await cashier.delete(`/company/calendar/appointments/${apptId}`)).status).toBe(403);
  });
});
