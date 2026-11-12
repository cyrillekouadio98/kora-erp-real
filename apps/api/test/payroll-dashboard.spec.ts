import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, uniqueEmail } from './helpers';

describe('Pilotage de la paie : tableau de bord, contrats, prestations, fiches, solde de tout compte', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let senior: string, junior: string, temp: string, runId: string;
  const month = today().slice(0, 7);
  const dash = async () => (await owner.agent.get('/company/payroll/dashboard')).body;
  const warning = (d: any, key: string) => d.warnings.find((w: any) => w.key === key)?.count;
  const settle = (q: Record<string, unknown>) => owner.agent.get('/company/payroll/final-settlement').query(q);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    const add = async (body: Record<string, unknown>) => (await owner.agent.post('/company/employees').send(body)).body.id;
    // Dix ans et demi d'ancienneté, payé par virement sans RIB
    senior = await add({ firstName: 'Awa', lastName: 'Traoré', hireDate: addDays(today(), -Math.round(10.5 * 365.25)), cnpsNumber: '123', category: '3', baseSalary: 300_000, paymentMethod: 'bank_transfer' });
    // CDD sans date de fin, sans CNPS ni catégorie, sous le SMIG
    junior = await add({ firstName: 'Yao', lastName: 'Konan', hireDate: `${month}-01`, contractType: 'cdd', baseSalary: 60_000, paymentMethod: 'cash' });
    // CDD qui se termine dans 10 jours
    temp = await add({ firstName: 'Aya', lastName: 'Kouassi', hireDate: addDays(today(), -200), endDate: addDays(today(), 10), contractType: 'cdd', cnpsNumber: '456', category: '2', baseSalary: 150_000, paymentMethod: 'cash' });
  });
  afterAll(async () => { await app.close(); });

  it('signale les fiches incomplètes et les contrats à surveiller', async () => {
    const d = await dash();
    expect(Object.fromEntries(d.warnings.map((w: any) => [w.key, w.count]))).toEqual({
      ending_soon: 1, cdd_no_end: 1, below_smig: 1, no_category: 1, no_cnps: 1, no_payment_details: 1, unpaid: 0,
    });
    const contracts = (await owner.agent.get('/company/payroll/contracts')).body;
    expect(contracts.find((c: any) => c.id === temp)).toMatchObject({ status: 'ending', warnings: ['ending_soon'], monthlySalary: 150_000 });
    expect(contracts.find((c: any) => c.id === junior).warnings).toEqual(['cdd_no_end', 'below_smig', 'no_category', 'no_cnps']);
    expect(d.headcount.monthly.at(-1)).toEqual({ period: month, count: 3 });
    expect(d.moves.monthly.arrivals).toBe(1);
    expect(d.lots).toEqual([]);
  });

  it('présente les lots, le coût employeur et les salaires restant à payer', async () => {
    runId = (await owner.agent.post('/company/payroll/runs').send({ period: month })).body.id;
    let d = await dash();
    expect(d.lots).toEqual([expect.objectContaining({ id: runId, payslips: 3, state: 'draft' })]);
    expect(warning(d, 'missing_from_run')).toBe(0);
    const run = (await owner.agent.get(`/company/payroll/runs/${runId}`)).body;
    expect(d.cost.monthly.at(-1)).toEqual({ period: month, net: run.totals.net, charges: run.totals.employerCost - run.totals.net, employerCost: run.totals.employerCost, draft: true });
    expect(d.cost.yearly.at(-1).employerCost).toBe(run.totals.employerCost);

    await owner.agent.post(`/company/payroll/runs/${runId}/validate`);
    d = await dash();
    expect(d.lots[0].state).toBe('validated');
    expect(warning(d, 'unpaid')).toBe(3);

    const slips = (await owner.agent.get('/company/payroll/payslips').query({ from: month, to: month })).body;
    expect(slips).toHaveLength(3);
    expect(slips.reduce((s: number, p: any) => s + p.net, 0)).toBe(run.totals.net);
    expect(slips[0]).toMatchObject({ period: month, runStatus: 'validated', paidAt: null });
  });

  it('enregistre les notes de l’équipe paie', async () => {
    const r = await owner.agent.put('/company/payroll/notes').send({ notes: [{ title: 'Note', body: '[ ] Relancer la CNPS\n[x] Contrat de Yao' }] });
    expect(r.status).toBe(200);
    expect((await dash()).notes).toEqual([{ id: expect.any(String), title: 'Note', body: '[ ] Relancer la CNPS\n[x] Contrat de Yao' }]);
    expect((await owner.agent.put('/company/payroll/notes').send({ notes: [{ title: '', body: 'x' }] })).status).toBe(400);
  });

  it('détaille les prestations du mois avec les éléments de la paie', async () => {
    const w = (await owner.agent.get('/company/payroll/work-entries').query({ period: month })).body;
    expect(w.run).toMatchObject({ id: runId, status: 'validated' });
    expect(w.rows).toHaveLength(3);
    const y = w.rows.find((r: any) => r.employeeId === junior);
    expect(y).toMatchObject({ contractDays: w.workingDays, worked: w.workingDays, inPayroll: true, absenceDays: 0, overtime: 0 });
  });

  it('calcule le solde de tout compte selon le motif de départ', async () => {
    const s = (await settle({ employeeId: senior, endDate: today(), reason: 'dismissal' })).body;
    const avg = s.average;
    expect(s.averageBasis).toContain('1 dernier');
    expect(s.seniority.years).toBe(10);
    const factor = 0.3 * 5 + 0.35 * 5 + 0.4 * (s.seniority.decimal - 10);
    const lic = s.lines.find((l: any) => l.code === 'LIC');
    expect(Math.abs(lic.amount - avg * factor)).toBeLessThan(avg * 0.01);
    expect(s).toMatchObject({ suggestedNotice: 2, noticeMonths: 2 });
    expect(s.lines.find((l: any) => l.code === 'PRE').amount).toBe(avg * 2);
    expect(s.lines.find((l: any) => l.code === 'CP').amount).toBe(Math.round((avg / 26) * s.leave.available));
    // Jours de congés corrigés à la main (congés pris avant Kora)
    const fixed = (await settle({ employeeId: senior, endDate: today(), reason: 'dismissal', leaveDays: 12.5 })).body;
    expect(fixed).toMatchObject({ leaveDays: 12.5 });
    expect(fixed.lines.find((l: any) => l.code === 'CP').amount).toBe(Math.round((avg / 26) * 12.5));
    expect(s.total).toBe(s.lines.reduce((t: number, l: any) => t + l.amount, 0));

    const quit = (await settle({ employeeId: senior, endDate: today(), reason: 'resignation' })).body;
    expect(quit.lines.map((l: any) => l.code)).toEqual(['CP']);
    const cdd = (await settle({ employeeId: temp, endDate: addDays(today(), 10), reason: 'end_of_contract', noticeMonths: 0 })).body;
    const gross = (await owner.agent.get('/company/payroll/payslips').query({ employeeId: temp })).body[0].gross;
    expect(cdd.lines.find((l: any) => l.code === 'FCDD').amount).toBe(Math.round(gross * 0.03));
    expect(cdd.lines.some((l: any) => l.code === 'LIC')).toBe(false);
  });

  it('réserve les montants à qui voit les salaires', async () => {
    const hr = (await owner.agent.get('/company/roles')).body.find((r: any) => r.key === 'hr_manager');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('rh'), roleIds: [hr.id] });
    const rh = request.agent(app.getHttpServer());
    await rh.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Responsable RH', password: 'MotDePasse123' });
    expect((await rh.get('/company/payroll/dashboard')).body.error.code).toBe('salaries_forbidden');
    expect((await rh.get('/company/payroll/final-settlement').query({ employeeId: senior, endDate: today(), reason: 'dismissal' })).status).toBe(403);
    const contracts = (await rh.get('/company/payroll/contracts')).body;
    expect(contracts[0].monthlySalary).toBeUndefined();
    expect(contracts.find((c: any) => c.id === junior).warnings).not.toContain('below_smig');
  });
});
