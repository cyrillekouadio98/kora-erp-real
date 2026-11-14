import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { easter, fullMonths, workingDays } from '../src/modules/leave/workdays';
import { today } from '../src/modules/sales/sales.service';
import { createApp, ownerClient, resetDb, signup } from './helpers';

describe('Jours ouvrables ivoiriens', () => {
  it('calcule Pâques et exclut dimanches et jours fériés', () => {
    expect(easter(2025).toISOString().slice(0, 10)).toBe('2025-04-20');
    expect(workingDays('2025-04-21', '2025-04-27')).toBe(5);  // lundi de Pâques férié, dimanche exclu
    expect(workingDays('2026-12-21', '2026-12-27')).toBe(5);  // Noël tombe un vendredi
    expect(workingDays('2025-08-04', '2025-08-09')).toBe(5);  // 7 août, fête de l'indépendance
  });
  it('compte les mois de service complets', () => {
    expect(fullMonths('2025-01-15', '2025-07-14')).toBe(5);
    expect(fullMonths('2025-01-15', '2025-07-15')).toBe(6);
  });
});

describe('Espace employé et congés', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let staff: ReturnType<typeof request.agent>;
  let ayaId: string;
  let otherId: string;
  const period = today().slice(0, 7);
  const nextMonday = (() => { const d = new Date(Date.UTC(+today().slice(0, 4), +today().slice(5, 7), 1)); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const plus = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    ayaId = (await owner.agent.post('/company/employees').send({ firstName: 'Aya', lastName: 'Kouassi', hireDate: '2025-01-15', email: 'aya.kouassi@test.ci', baseSalary: 300_000 })).body.id;
    otherId = (await owner.agent.post('/company/employees').send({ firstName: 'Koffi', lastName: 'Yao', hireDate: '2025-03-01', baseSalary: 250_000 })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it("invite l'employé dans son espace et rattache sa fiche à son compte", async () => {
    expect((await owner.agent.post(`/company/employees/${otherId}/invite`)).body.error.code).toBe('no_email');
    const inv = await owner.agent.post(`/company/employees/${ayaId}/invite`);
    expect(inv.status).toBe(201);
    expect((await owner.agent.post(`/company/employees/${ayaId}/invite`)).body.error.code).toBe('invitation_pending');
    staff = request.agent(app.getHttpServer());
    await staff.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Aya Kouassi', password: 'MotDePasse123' });
    const me = (await staff.get('/company/me')).body;
    expect(me.employee).toMatchObject({ name: 'Aya Kouassi', number: 'EMP-00001' });
    const months = fullMonths('2025-01-15', today());
    expect(me.balance).toMatchObject({ months, accrued: Math.round(months * 2.2 * 10) / 10, taken: 0 });
    expect((await owner.agent.get(`/company/employees/${ayaId}`)).body.linked).toBe(true);
  });

  it("rattache tout de suite la fiche d'une personne qui a déjà un accès (caissière invitée avant sa fiche)", async () => {
    const roles = (await owner.agent.get('/company/roles')).body;
    const cashier = roles.find((r: any) => r.key === 'cashier').id;
    const inv = await owner.agent.post('/company/invitations').send({ email: 'christine.konan@test.ci', roleIds: [cashier] });
    const christine = request.agent(app.getHttpServer());
    await christine.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Christine Konan', password: 'MotDePasse123' });
    expect((await christine.get('/company/me')).status).toBe(403); // pas encore d'espace employé
    const id = (await owner.agent.post('/company/employees').send({ firstName: 'Christine', lastName: 'Konan', hireDate: '2025-06-01', email: 'Christine.Konan@test.ci', baseSalary: 150_000 })).body.id;
    const r = await owner.agent.post(`/company/employees/${id}/invite`);
    expect(r.body).toEqual({ linked: true, email: 'christine.konan@test.ci' });
    expect((await christine.get('/company/me')).body.employee).toMatchObject({ name: 'Christine Konan' });
    const member = (await owner.agent.get('/company/members')).body.find((m: any) => m.email === 'christine.konan@test.ci');
    expect(member.roles.map((x: any) => x.key ?? x.name)).toEqual(expect.arrayContaining([expect.stringMatching(/employee|Employé/)]));
    expect((await owner.agent.post(`/company/employees/${id}/invite`)).body.error.code).toBe('already_linked');
    // Un même compte ne peut pas être rattaché à deux fiches
    const twin = (await owner.agent.post('/company/employees').send({ firstName: 'C.', lastName: 'Konan', hireDate: '2025-06-01', email: 'christine.konan@test.ci', baseSalary: 150_000 })).body.id;
    expect((await owner.agent.post(`/company/employees/${twin}/invite`)).body.error.code).toBe('user_already_linked');
  });

  it("ne donne à l'employé accès qu'à ses propres données", async () => {
    expect((await staff.get('/company/employees')).status).toBe(403);
    expect((await staff.get('/company/leave')).status).toBe(403);
    expect((await staff.get('/company/payroll/runs')).status).toBe(403);
    expect((await owner.agent.get('/company/me')).status).toBe(403); // le propriétaire n'a pas de fiche employé
  });

  it('demande un congé payé, refuse les chevauchements et les dépassements de solde', async () => {
    const r = await staff.post('/company/me/leave').send({ type: 'annual', startDate: nextMonday, endDate: plus(nextMonday, 4), reason: 'Congés annuels' });
    expect(r.body.days).toBe(workingDays(nextMonday, plus(nextMonday, 4)));
    expect((await staff.post('/company/me/leave').send({ type: 'sick', startDate: plus(nextMonday, 2), endDate: plus(nextMonday, 3) })).body.error.code).toBe('leave_overlap');
    expect((await staff.post('/company/me/leave').send({ type: 'annual', startDate: plus(nextMonday, 30), endDate: plus(nextMonday, 200) })).body.error.code).toBe('insufficient_leave');
    const sunday = plus(nextMonday, -1);
    expect((await staff.post('/company/me/leave').send({ type: 'other', startDate: sunday, endDate: sunday })).body.error.code).toBe('no_working_day');

    const c = await ownerClient();
    try {
      const mails = await c.query(`SELECT to_address, subject FROM email_message WHERE kind = 'leave_request'`);
      expect(mails.rows).toEqual([{ to_address: owner.email, subject: 'Demande de congé — Aya Kouassi' }]);
    } finally { await c.end(); }
  });

  it("valide la demande, prévient l'employé et met à jour son solde", async () => {
    const pending = (await owner.agent.get('/company/leave').query({ status: 'pending' })).body;
    expect(pending).toHaveLength(1);
    expect((await owner.agent.post(`/company/leave/${pending[0].id}/approve`).send({ note: 'Bonnes vacances' })).status).toBe(200);
    expect((await owner.agent.post(`/company/leave/${pending[0].id}/refuse`).send({})).body.error.code).toBe('already_decided');
    const me = (await staff.get('/company/me')).body;
    expect(me.balance.taken).toBe(pending[0].days);
    expect(me.requests[0]).toMatchObject({ status: 'approved', decisionNote: 'Bonnes vacances' });
    expect((await staff.post(`/company/me/leave/${pending[0].id}/cancel`)).body.error.code).toBe('not_pending');
    const c = await ownerClient();
    try { expect((await c.query(`SELECT subject FROM email_message WHERE kind = 'leave_decision'`)).rows[0].subject).toBe('Votre demande de congé a été acceptée'); } finally { await c.end(); }
    const balances = (await owner.agent.get('/company/leave/balances')).body;
    expect(balances.find((b: any) => b.employeeId === ayaId)).toMatchObject({ linked: true, taken: pending[0].days });
  });

  it("donne les congés d'une année et les jours fériés nommés (tableau de bord annuel)", async () => {
    const year = Number(nextMonday.slice(0, 4));
    expect((await owner.agent.get('/company/leave').query({ year })).body.map((l: any) => l.status)).toContain('approved');
    expect((await owner.agent.get('/company/leave').query({ year: year + 3 })).body).toHaveLength(0);
    const holidays = (await owner.agent.get('/company/leave/holidays').query({ year: 2026 })).body;
    expect(holidays).toHaveLength(10);
    expect(holidays[0]).toEqual({ date: '2026-01-01', label: 'Nouvel An' });
    expect(holidays).toContainEqual({ date: '2026-04-06', label: 'Lundi de Pâques' });
    expect(holidays).toContainEqual({ date: '2026-05-14', label: 'Ascension' });
    expect((await owner.agent.get('/company/leave/holidays')).status).toBe(400);
  });

  it('reprend un congé sans solde validé comme absence dans la paie du mois', async () => {
    const start = `${period}-01`, end = `${period}-03`;
    const r = await owner.agent.post('/company/leave').send({ employeeId: otherId, type: 'unpaid', startDate: start, endDate: end });
    await owner.agent.post(`/company/leave/${r.body.id}/approve`).send({});
    const run = (await owner.agent.post('/company/payroll/runs').send({ period })).body;
    const slip = run.payslips.find((p: any) => p.employeeId === otherId);
    expect(slip.inputs.absenceDays).toBe(workingDays(start, end));
    expect(run.payslips.find((p: any) => p.employeeId === ayaId).inputs.absenceDays).toBe(0);
    await owner.agent.post(`/company/payroll/runs/${run.id}/validate`);
  });

  it("affecte l'employé à un autre site sans lui couper son espace", async () => {
    const site = await owner.agent.post('/company/sites').send({ name: 'Boutique Bonon' });
    expect(site.status).toBe(201);
    const moved = await owner.agent.patch(`/company/employees/${ayaId}`).send({ siteId: site.body.id });
    expect(moved.body.siteId).toBe(site.body.id);
    expect((await staff.get('/company/me')).body.employee).toMatchObject({ name: 'Aya Kouassi' }); // espace toujours accessible
    const c = await ownerClient();
    try {
      const m = await c.query(`SELECT m.site_ids FROM company_membership m JOIN employee e ON e.user_id = m.user_id AND e.company_id = m.company_id WHERE e.id = $1`, [ayaId]);
      expect(m.rows[0].site_ids).toContain(site.body.id);
    } finally { await c.end(); }
  });

  it("réserve les congés payés aux CDI et CDD : stagiaire et journalier n'ont que des permissions sans retenue", async () => {
    const stagiaire = (await owner.agent.post('/company/employees').send({ firstName: 'Awa', lastName: 'Stagiaire', hireDate: '2025-01-15', contractType: 'stage', email: 'awa.stage@test.ci', baseSalary: 75_000 })).body.id;
    const journalier = (await owner.agent.post('/company/employees').send({ firstName: 'Yao', lastName: 'Journalier', hireDate: '2025-01-15', contractType: 'journalier', baseSalary: 75_000 })).body.id;
    const balances = (await owner.agent.get('/company/leave/balances')).body;
    for (const id of [stagiaire, journalier]) {
      expect(balances.find((b: any) => b.employeeId === id)).toMatchObject({ entitled: false, accrued: 0, available: 0 });
    }
    expect(balances.find((b: any) => b.employeeId === ayaId)).toMatchObject({ entitled: true, contract: 'cdi' }); // CDI : droits inchangés
    const day = plus(nextMonday, 60);
    const annual = await owner.agent.post('/company/leave').send({ employeeId: stagiaire, type: 'annual', startDate: day, endDate: day });
    expect(annual.body.error.code).toBe('no_paid_leave');
    expect(annual.body.error.message).toMatch(/stagiaire/);
    expect((await owner.agent.post('/company/leave').send({ employeeId: journalier, type: 'annual', startDate: day, endDate: day })).body.error.code).toBe('no_paid_leave');
    // Permission exceptionnelle acceptée et validée : aucune absence retenue en paie
    const perm = await owner.agent.post('/company/leave').send({ employeeId: stagiaire, type: 'family_event', startDate: day, endDate: plus(day, 1), reason: 'Mariage' });
    expect(perm.status).toBe(201);
    expect((await owner.agent.post(`/company/leave/${perm.body.id}/approve`).send({})).status).toBeLessThan(300);
    const c = await ownerClient();
    try {
      const rows = await c.query(`SELECT status FROM leave_request WHERE id = $1`, [perm.body.id]);
      expect(rows.rows[0].status).toBe('approved');
    } finally { await c.end(); }
    expect((await owner.agent.get('/company/leave/balances')).body.find((b: any) => b.employeeId === stagiaire)).toMatchObject({ entitled: false, available: 0 });
  });

  it("montre à l'employé ses seuls bulletins validés", async () => {
    const mine = (await staff.get('/company/me/payslips')).body;
    expect(mine).toHaveLength(1);
    expect((await staff.get(`/company/me/payslips/${mine[0].id}`)).body.slip.employee.name).toBe('Aya Kouassi');
    const run = (await owner.agent.get('/company/payroll/runs')).body[0];
    const other = (await owner.agent.get(`/company/payroll/runs/${run.id}`)).body.payslips.find((p: any) => p.employeeId === otherId);
    expect((await staff.get(`/company/me/payslips/${other.id}`)).status).toBe(404);
  });
});
