import { INestApplication } from '@nestjs/common';
import { createApp, platformUser, resetDb, signup } from './helpers';
import { computePayslip, DEFAULT_PAYROLL_PARAMS } from '../src/modules/payroll/payroll.calc';

/** Déclarations CNPS, ITS et DISA à partir des bulletins validés (fonctionnalité activée à la demande). */
describe('Déclarations sociales et fiscales', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  const decl = (from: string, to: string) => owner.agent.get('/company/payroll/declarations').query({ from, to });
  const pay = async (period: string) => {
    const r = await owner.agent.post('/company/payroll/runs').send({ period });
    expect(r.status).toBe(201);
    expect((await owner.agent.post(`/company/payroll/runs/${r.body.id}/validate`)).status).toBe(200);
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    await owner.agent.post('/company/employees').send({ firstName: 'Awa', lastName: 'Traoré', hireDate: '2025-01-15', cnpsNumber: '1234567', baseSalary: 300_000, housingAllowance: 50_000, transportAllowance: 30_000 });
    await owner.agent.post('/company/employees').send({ firstName: 'Kouamé', lastName: "N'Guessan", hireDate: '2024-06-01', maritalStatus: 'married', children: 2, baseSalary: 180_000, transportAllowance: 25_000, paymentMethod: 'cash' });
    await owner.agent.post('/company/employees').send({ firstName: 'Ali', lastName: 'Bamba', hireDate: '2024-06-01', contractType: 'stage', baseSalary: 60_000 });
  });
  afterAll(async () => { await app.close(); });

  it("reste invisible tant que la fonctionnalité n'est pas activée", async () => {
    expect((await decl('2026-09', '2026-09')).body.error.code).toBe('feature_not_enabled');
  });

  it('reprend les cotisations et l’impôt des bulletins validés, mois par mois ou en cumul', async () => {
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/social_declarations`).send({ enabled: true });
    await pay('2026-09');
    await pay('2026-10');
    const p = DEFAULT_PAYROLL_PARAMS;
    const awa = computePayslip({ baseSalary: 300_000, housingAllowance: 50_000, otherAllowances: 0, transportAllowance: 30_000, overtime: 0, bonus: 0, absenceDays: 0, advanceDeduction: 0, otherDeduction: 0, parts: 1, cmuBeneficiaries: 1 }, p);
    const kou = computePayslip({ baseSalary: 180_000, housingAllowance: 0, otherAllowances: 0, transportAllowance: 25_000, overtime: 0, bonus: 0, absenceDays: 0, advanceDeduction: 0, otherDeduction: 0, parts: 3, cmuBeneficiaries: 4 }, p);
    const sept = (await decl('2026-09', '2026-09')).body;
    expect(sept.employees.map((e: any) => e.name)).toEqual(['Awa Traoré', "Kouamé N'Guessan"]);
    expect(sept.excluded).toMatchObject([{ name: 'Ali Bamba', contractType: 'stage' }]);
    expect(sept.cnps.retirementEmployee).toBe(awa.totals.cnpsEmployee + kou.totals.cnpsEmployee);
    expect(sept.cnps.total).toBe(awa.totals.socialEmployee + awa.totals.socialEmployer + kou.totals.socialEmployee + kou.totals.socialEmployer);
    expect(sept.tax.its).toBe(awa.totals.its + kou.totals.its);
    expect(sept.tax.total).toBe(awa.totals.its + kou.totals.its + awa.totals.taxesEmployer + kou.totals.taxesEmployer);
    const quarter = (await decl('2026-09', '2026-10')).body;
    expect(quarter.cnps.total).toBe(2 * sept.cnps.total);
    expect(quarter.employees[0]).toMatchObject({ months: 2, firstPeriod: '2026-09', lastPeriod: '2026-10', cnpsNumber: '1234567' });
    expect(quarter.warnings).toEqual(expect.arrayContaining(["Le numéro d'employeur CNPS de l'entreprise n'est pas renseigné.", "Kouamé N'Guessan n'a pas de numéro CNPS sur sa fiche."]));
  });

  it("enregistre le numéro d'employeur CNPS et contrôle la période", async () => {
    expect((await owner.agent.put('/company/payroll/declarations/employer').send({ cnpsEmployerNumber: '0123456-A' })).body).toEqual({ ok: true });
    expect((await decl('2026-09', '2026-09')).body.company.cnpsEmployerNumber).toBe('0123456-A');
    expect((await decl('2026-10', '2026-09')).body.error.code).toBe('bad_period');
    expect((await decl('2025-01', '2026-06')).body.error.code).toBe('period_too_long');
    expect((await decl('2026-01', '2026-12')).body.warnings).toContain('Aucune paie pour 2026-01.');
  });
});
