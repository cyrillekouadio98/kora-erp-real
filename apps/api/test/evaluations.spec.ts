import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { today } from '../src/modules/sales/sales.service';
import { createApp, ownerClient, resetDb, signup, uniqueEmail } from './helpers';

describe('Évaluations : notes, primes et augmentations', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let hr: ReturnType<typeof request.agent>;
  let staff: ReturnType<typeof request.agent>;
  let hrId: string, ayaId: string, koffiId: string, campaignId: string, ayaEval: string, koffiEval: string, runId: string;
  const period = today().slice(0, 7);
  const next = (() => { const d = new Date(`${period}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); })();
  const all = (n: number) => Object.fromEntries(['quality', 'productivity', 'attendance', 'teamwork', 'initiative', 'customer'].map((k) => [k, { score: n }]));
  const mails = async (kind: string) => {
    const c = await ownerClient();
    try { return (await c.query('SELECT to_address, subject FROM email_message WHERE kind = $1 ORDER BY created_at', [kind])).rows; } finally { await c.end(); }
  };
  const join = async (inviteUrl: string, fullName: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/invitations/accept').send({ token: new URL(inviteUrl).searchParams.get('token'), fullName, password: 'MotDePasse123' });
    return agent;
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    ayaId = (await owner.agent.post('/company/employees').send({ firstName: 'Aya', lastName: 'Kouassi', hireDate: '2024-01-15', email: 'aya.kouassi@test.ci', baseSalary: 300_000 })).body.id;
    koffiId = (await owner.agent.post('/company/employees').send({ firstName: 'Koffi', lastName: 'Yao', hireDate: '2024-03-01', baseSalary: 250_000 })).body.id;
    staff = await join((await owner.agent.post(`/company/employees/${ayaId}/invite`)).body.inviteUrl, 'Aya Kouassi');
    const roles = (await owner.agent.get('/company/roles')).body;
    const email = uniqueEmail('rh');
    hr = await join((await owner.agent.post('/company/invitations').send({ email, roleIds: [roles.find((r: any) => r.key === 'hr_manager').id] })).body.inviteUrl, 'Responsable RH');
    hrId = (await owner.agent.get('/company/evaluations/people')).body.find((p: any) => p.email === email).id;
  });
  afterAll(async () => { await app.close(); });

  it('lance une campagne pour tous les employés et prévient l’évaluateur', async () => {
    const r = await owner.agent.post('/company/evaluations/campaigns').send({ name: 'Évaluation annuelle', periodStart: '2026-01-01', periodEnd: '2026-12-31', dueDate: '2026-12-15', evaluatorId: hrId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ total: 2, draft: 2, status: 'open', average: null });
    expect(r.body.criteria).toHaveLength(6);
    campaignId = r.body.id;
    ayaEval = r.body.evaluations.find((v: any) => v.employee.id === ayaId).id;
    koffiEval = r.body.evaluations.find((v: any) => v.employee.id === koffiId).id;
    expect(await mails('evaluation')).toEqual([expect.objectContaining({ subject: 'Évaluations à remplir — Évaluation annuelle' })]);
    expect((await hr.get('/company/dashboard')).body.alerts.find((a: any) => a.kind === 'evaluations_to_fill')).toMatchObject({ count: 2 });
    // L'employé ne voit ni la campagne ni sa propre évaluation en cours
    expect((await staff.get('/company/evaluations/campaigns')).status).toBe(403);
    expect((await staff.get('/company/me/evaluations')).body).toEqual([]);
  });

  it('note les critères, calcule la note pondérée et soumet', async () => {
    const partial = await hr.patch(`/company/evaluations/${ayaEval}`).send({ scores: { quality: { score: 5, comment: 'Travail soigné' }, attendance: { score: 2 } } });
    expect(partial.body).toMatchObject({ score: 4, rating: 'very_good', canEdit: true }); // (5×2 + 2×1) / 3
    expect(partial.body.employee.baseSalary).toBeUndefined(); // la RH ne voit pas les salaires
    expect((await hr.post(`/company/evaluations/${ayaEval}/submit`)).body.error.code).toBe('criteria_missing');
    expect((await hr.patch(`/company/evaluations/${ayaEval}`).send({ bonusAmount: 50_000, bonusPeriod: period })).body.error.code).toBe('salaries_forbidden');
    await hr.patch(`/company/evaluations/${ayaEval}`).send({ scores: { ...all(4), quality: { score: 5 } }, strengths: 'Rigueur', goals: 'Former un collègue' });
    const s = await hr.post(`/company/evaluations/${ayaEval}/submit`);
    expect(s.body).toMatchObject({ status: 'submitted', score: 4.25, rating: 'excellent', canDecide: true }); // la RH approuve aussi
    expect((await hr.post(`/company/evaluations/${ayaEval}/submit`)).body.error.code).toBe('evaluation_submitted');
    // L'employé évalué ne remplit ni ne décide de sa propre évaluation
    expect((await staff.patch(`/company/evaluations/${ayaEval}`).send({ comment: 'x' })).status).toBe(403);
  });

  it('approuve une prime et une augmentation : la fiche et la paie suivent', async () => {
    expect((await owner.agent.post(`/company/evaluations/${ayaEval}/decide`).send({ approve: true, newBaseSalary: 290_000, raisePeriod: period })).body.error.code).toBe('raise_not_higher');
    const d = await owner.agent.post(`/company/evaluations/${ayaEval}/decide`).send({ approve: true, bonusAmount: 50_000, bonusPeriod: period, newBaseSalary: 330_000, raisePeriod: period, note: 'Bravo' });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: 'approved', bonusAmount: 50_000, newBaseSalary: 330_000, raisePercent: 10, raiseApplied: true });
    expect((await owner.agent.get(`/company/employees/${ayaId}`)).body.baseSalary).toBe(330_000);
    expect((await mails('evaluation')).at(-1)).toMatchObject({ to_address: 'aya.kouassi@test.ci', subject: 'Votre évaluation — Évaluation annuelle' });

    const run = (await owner.agent.post('/company/payroll/runs').send({ period })).body;
    runId = run.id;
    const slip = run.payslips.find((p: any) => p.employeeId === ayaId);
    expect(slip.inputs.bonus).toBe(50_000);
    expect(slip.lines.find((l: any) => l.code === 'PRI')).toMatchObject({ gain: 50_000 });
    expect(run.payslips.find((p: any) => p.employeeId === koffiId).inputs.bonus).toBe(0);

    const mine = (await staff.get('/company/me/evaluations')).body;
    expect(mine).toEqual([expect.objectContaining({ campaignName: 'Évaluation annuelle', score: 4.25, bonusAmount: 50_000, newBaseSalary: 330_000, goals: 'Former un collègue' })]);
    expect((await owner.agent.post(`/company/evaluations/${ayaEval}/reopen`)).body.error.code).toBe('raise_applied');
  });

  it('ajoute la prime à la paie en brouillon, la retire à la réouverture, et diffère une augmentation future', async () => {
    await hr.patch(`/company/evaluations/${koffiEval}`).send({ scores: all(3) });
    await hr.post(`/company/evaluations/${koffiEval}/submit`);
    expect((await owner.agent.get('/company/dashboard')).body.alerts.find((a: any) => a.kind === 'evaluations_to_decide')).toMatchObject({ count: 1 });
    await owner.agent.post(`/company/evaluations/${koffiEval}/decide`).send({ approve: true, bonusAmount: 20_000, bonusPeriod: period, newBaseSalary: 270_000, raisePeriod: next });
    const bonus = async () => (await owner.agent.get(`/company/payroll/runs/${runId}`)).body.payslips.find((p: any) => p.employeeId === koffiId).inputs.bonus;
    expect(await bonus()).toBe(20_000);
    expect((await owner.agent.get(`/company/employees/${koffiId}`)).body.baseSalary).toBe(250_000); // effet le mois prochain

    expect((await owner.agent.post(`/company/evaluations/${koffiEval}/reopen`)).body.status).toBe('submitted');
    expect(await bonus()).toBe(0);
    await owner.agent.post(`/company/evaluations/${koffiEval}/decide`).send({ approve: true, bonusAmount: 20_000, bonusPeriod: period });
    expect(await bonus()).toBe(20_000);

    const c = (await owner.agent.get(`/company/evaluations/campaigns/${campaignId}`)).body;
    expect(c).toMatchObject({ approved: 2, average: 3.63, bonusTotal: 70_000, raiseTotal: 50_000 });
    expect((await hr.get(`/company/evaluations/campaigns/${campaignId}`)).body.bonusTotal).toBeUndefined();

    expect((await owner.agent.post(`/company/payroll/runs/${runId}/validate`)).status).toBe(200);
    expect((await owner.agent.post(`/company/evaluations/${koffiEval}/reopen`)).body.error.code).toBe('run_validated');
  });

  it('la RH propose sans voir les salaires ; aucun montant sur un mois de paie validé', async () => {
    const amaId = (await owner.agent.post('/company/employees').send({ firstName: 'Ama', lastName: 'Diallo', hireDate: '2025-02-01', baseSalary: 200_000 })).body.id;
    const added = await owner.agent.post(`/company/evaluations/campaigns/${campaignId}/employees`).send({ employeeIds: [amaId], evaluatorId: hrId });
    const amaEval = added.body.evaluations.find((v: any) => v.employee.id === amaId).id;
    const p = await hr.patch(`/company/evaluations/${amaEval}`).send({ scores: all(5), proposedBonus: 40_000, proposedRaisePercent: 5 });
    expect(p.body).toMatchObject({ proposedBonus: 40_000, proposedRaisePercent: 5, firstOpenPeriod: next });
    await hr.post(`/company/evaluations/${amaEval}/submit`);
    expect((await hr.post(`/company/evaluations/${amaEval}/decide`).send({ approve: true })).body.error.code).toBe('proposal_needs_salaries');

    // La paie du mois est validée (test précédent) : ni prime ni augmentation sur ce mois
    expect((await owner.agent.post(`/company/evaluations/${amaEval}/decide`).send({ approve: true, newBaseSalary: 210_000, raisePeriod: period })).body.error.code).toBe('raise_period_closed');
    expect((await owner.agent.post(`/company/evaluations/${amaEval}/decide`).send({ approve: true, bonusAmount: 40_000, bonusPeriod: period })).body.error.code).toBe('run_validated');
    const d = await owner.agent.post(`/company/evaluations/${amaEval}/decide`).send({ approve: true, bonusAmount: 40_000, bonusPeriod: next, newBaseSalary: 210_000, raisePeriod: next });
    expect(d.body).toMatchObject({ status: 'approved', raiseApplied: false });
    // La fiche annonce l'augmentation à venir, à qui voit les salaires
    expect((await owner.agent.get(`/company/employees/${amaId}`)).body).toMatchObject({ baseSalary: 200_000, plannedRaises: [{ newBaseSalary: 210_000, period: next }] });
    expect((await hr.get(`/company/employees/${amaId}`)).body.plannedRaises).toBeUndefined();
  });

  it('exporte la campagne et protège les décisions prises', async () => {
    const csv = await owner.agent.get(`/company/evaluations/campaigns/${campaignId}/export`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Aya Kouassi');
    expect((await owner.agent.delete(`/company/evaluations/campaigns/${campaignId}`)).body.error.code).toBe('campaign_has_decisions');
    expect((await owner.agent.delete(`/company/evaluations/${ayaEval}`)).body.error.code).toBe('evaluation_approved');
    expect((await owner.agent.patch(`/company/evaluations/campaigns/${campaignId}`).send({ status: 'closed' })).body.status).toBe('closed');
  });
});
