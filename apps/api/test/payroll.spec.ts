import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { computePayslip, DEFAULT_PAYROLL_PARAMS as P, familyParts, netToGross, progressiveTax } from '../src/modules/payroll/payroll.calc';
import { today } from '../src/modules/sales/sales.service';
import { createApp, ownerClient, resetDb, signup, uniqueEmail } from './helpers';

const input = (over: Partial<Parameters<typeof computePayslip>[0]> = {}) => ({
  baseSalary: 300_000, housingAllowance: 50_000, otherAllowances: 0, transportAllowance: 30_000, overtime: 0, bonus: 0,
  absenceDays: 0, advanceDeduction: 0, otherDeduction: 0, parts: 1, cmuBeneficiaries: 1, ...over,
});

describe('Calcul du bulletin de paie (paramètres par défaut)', () => {
  it('compte les parts du quotient familial', () => {
    expect(familyParts('single', 0)).toBe(1);
    expect(familyParts('single', 1)).toBe(2);
    expect(familyParts('married', 0)).toBe(2);
    expect(familyParts('married', 3)).toBe(3.5);
    expect(familyParts('widowed', 2)).toBe(3);
    expect(familyParts('married', 8)).toBe(5);
  });

  it("applique le barème progressif de l'ITS", () => {
    expect(progressiveTax(75_000, P.itsBrackets)).toBe(0);
    expect(progressiveTax(240_000, P.itsBrackets)).toBe(26_400);
    expect(progressiveTax(350_000, P.itsBrackets)).toBe(49_500);
  });

  it('calcule un bulletin complet : brut, cotisations, ITS, net et coût employeur', () => {
    const r = computePayslip(input(), P);
    expect(r).toMatchObject({ gross: 380_000, taxable: 350_000, net: 307_950 });
    expect(r.totals).toMatchObject({
      cnpsEmployee: 22_050, its: 49_500, cmuEmployee: 500,
      cnpsEmployer: 26_950, familyBenefits: 3_500, workAccident: 1_400, cmuEmployer: 500,
      employerTax: 4_200, apprenticeship: 1_400, training: 4_200, employerCost: 422_150,
    });
  });

  it('réduit l’ITS pour charges de famille et compte la CMU des ayants droit', () => {
    const r = computePayslip(input({ parts: 3, cmuBeneficiaries: 4 }), P);
    expect(r.totals).toMatchObject({ itsGross: 49_500, itsReduction: 22_000, its: 27_500, cmuEmployee: 3_500 });
  });

  it('impose le transport au-delà du plafond, proratise les absences et plafonne la CNPS', () => {
    expect(computePayslip(input({ transportAllowance: 50_000 }), P).taxable).toBe(370_000);
    const abs = computePayslip(input({ absenceDays: 3 }), P);
    expect(abs.taxable).toBe(320_000);
    expect(abs.lines.find((l) => l.code === 'ABS')?.gain).toBe(-30_000);
    expect(computePayslip(input({ baseSalary: 3_000_000 }), P).totals.cnpsEmployee).toBe(Math.round(1_647_315 * 0.063));
  });
  it('retrouve le brut à partir du net : salaire catégoriel, puis sursalaire jusqu’au net demandé', () => {
    const fixed = { housingAllowance: 50_000, otherAllowances: 0, transportAllowance: 30_000, parts: 1, cmuBeneficiaries: 1 };
    // Inverse exact du bulletin de référence ci-dessus (base 300 000 → net 307 950)
    expect(netToGross(307_950, 0, fixed, P)).toMatchObject({ ok: true, baseSalary: 300_000, extraSalary: 0, result: { net: 307_950 } });
    const cat = netToGross(307_950, 200_000, fixed, P);
    expect(cat).toMatchObject({ ok: true, baseSalary: 200_000, extraSalary: 100_000, result: { net: 307_950 } });
    expect(cat.ok && cat.result.lines.find((l) => l.code === 'SUR')?.gain).toBe(100_000);
    for (const target of [120_000, 151_337, 1_234_567]) {
      const r = netToGross(target, 75_000, { ...fixed, housingAllowance: 0, parts: 2.5, cmuBeneficiaries: 4 }, P);
      expect(r.ok && r.result.net).toBe(target);
    }
    expect(netToGross(100_000, 200_000, fixed, P)).toMatchObject({ ok: false, reason: 'below_category' });
    // Absences : le sursalaire est proratisé comme le salaire de base
    expect(computePayslip(input({ baseSalary: 200_000, extraSalary: 100_000, absenceDays: 3 }), P).taxable).toBe(320_000);
  });
});

describe('Paie : employés, campagne mensuelle, comptabilité, paiement', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let awa: string;
  let kouame: string;
  let runId: string;
  const period = today().slice(0, 7);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
  });
  afterAll(async () => { await app.close(); });

  it("n'est disponible qu'avec une formule qui inclut la paie", async () => {
    const r = await owner.agent.get('/company/employees');
    expect(r.status).toBe(402);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    expect((await owner.agent.get('/company/employees')).status).toBe(200);
  });

  it('crée les fiches des employés, avec un RIB chiffré et des parts calculées', async () => {
    const a = await owner.agent.post('/company/employees').send({ firstName: 'Awa', lastName: 'Traoré', jobTitle: 'Vendeuse', hireDate: '2025-01-15', cnpsNumber: '1234567',
      baseSalary: 300_000, housingAllowance: 50_000, transportAllowance: 30_000, bankDetails: 'CI008 01001 012345678901 23' });
    expect(a.body).toMatchObject({ number: 'EMP-00001', parts: 1, baseSalary: 300_000, bankDetails: 'CI008 01001 012345678901 23' });
    awa = a.body.id;
    const k = await owner.agent.post('/company/employees').send({ firstName: 'Kouamé', lastName: "N'Guessan", jobTitle: 'Magasinier', hireDate: '2024-06-01',
      maritalStatus: 'married', children: 2, baseSalary: 180_000, transportAllowance: 25_000, paymentMethod: 'cash' });
    expect(k.body).toMatchObject({ number: 'EMP-00002', parts: 3 });
    kouame = k.body.id;
    const c = await ownerClient();
    try {
      const raw = await c.query('SELECT bank_details_enc FROM employee WHERE id = $1', [awa]);
      expect(raw.rows[0].bank_details_enc).not.toContain('012345678901');
    } finally { await c.end(); }
  });

  it('cache les salaires et le RIB au responsable RH qui n’a pas les permissions sensibles', async () => {
    const roles = await owner.agent.get('/company/roles');
    const hr = roles.body.find((r: any) => r.key === 'hr_manager');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('rh'), roleIds: [hr.id] });
    const rh = request.agent(app.getHttpServer());
    await rh.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Responsable RH', password: 'MotDePasse123' });
    const list = (await rh.get('/company/employees')).body;
    expect(list).toHaveLength(2);
    expect(list[0].baseSalary).toBeUndefined();
    expect(list.find((e: any) => e.id === awa).bankDetails).toBe('••••');
    expect((await rh.patch(`/company/employees/${awa}`).send({ jobTitle: 'Cheffe de rayon' })).status).toBe(200);
    expect((await rh.patch(`/company/employees/${awa}`).send({ baseSalary: 1 })).body.error.code).toBe('salaries_forbidden');
    expect((await rh.get('/company/payroll/runs')).body.error.code).toBe('salaries_forbidden');
  });

  it('prépare la paie du mois, recalcule chaque bulletin et récapitule les déclarations', async () => {
    expect((await owner.agent.post('/company/payroll/runs').send({ period: '2099-01' })).body.error.code).toBe('future_period');
    const r = await owner.agent.post('/company/payroll/runs').send({ period });
    expect(r.status).toBe(201);
    runId = r.body.id;
    expect(r.body.payslips).toHaveLength(2);
    expect(r.body.payslips.find((p: any) => p.employeeId === awa)).toMatchObject({ net: 307_950, employerCost: 422_150 });
    expect((await owner.agent.post('/company/payroll/runs').send({ period })).body.error.code).toBe('run_exists');

    const slip = r.body.payslips.find((p: any) => p.employeeId === kouame);
    const upd = await owner.agent.patch(`/company/payroll/runs/${runId}/payslips/${slip.id}`).send({ overtime: 20_000, advanceDeduction: 15_000 });
    const k = upd.body.payslips.find((p: any) => p.employeeId === kouame);
    expect(k.inputs).toMatchObject({ overtime: 20_000, advanceDeduction: 15_000 });
    expect(k.taxable).toBe(200_000);
    const d = upd.body.declarations;
    expect(d.cnps.total).toBe(d.cnps.retirementEmployee + d.cnps.retirementEmployer + d.cnps.familyBenefits + d.cnps.workAccident);
    expect(d.its.withheld).toBe(49_500 + k.totals.its);
  });

  it('valide la paie : intangible, et comptabilisée en écriture équilibrée', async () => {
    const v = await owner.agent.post(`/company/payroll/runs/${runId}/validate`);
    expect(v.body.status).toBe('validated');
    const slip = v.body.payslips[0];
    expect((await owner.agent.patch(`/company/payroll/runs/${runId}/payslips/${slip.id}`).send({ bonus: 1 })).body.error.code).toBe('run_validated');
    expect((await owner.agent.delete(`/company/payroll/runs/${runId}`)).body.error.code).toBe('run_validated');

    const entry = (await owner.agent.get('/company/accounting/entries').query({ q: 'Paie de' })).body[0];
    const by = (acc: string) => entry.lines.filter((l: any) => l.account === acc).reduce((s: number, l: any) => s + l.debit - l.credit, 0);
    expect(by('661000')).toBe(v.body.totals.gross);
    expect(by('422000')).toBe(-v.body.totals.net);
    expect(by('431000')).toBe(-v.body.declarations.cnps.total);
    expect(by('421000')).toBe(-15_000);
    expect(entry.lines.reduce((s: number, l: any) => s + l.debit - l.credit, 0)).toBe(0);

    const c = await ownerClient();
    try { await expect(c.query('UPDATE payslip SET net = 0 WHERE run_id = $1', [runId])).rejects.toThrow(/bulletin non modifiable/); } finally { await c.end(); }
  });

  it('garde les paramètres de calcul figés une fois la paie validée', async () => {
    await owner.agent.patch('/company/payroll/settings').send({ cnpsEmployeeRate: 7 });
    const r = (await owner.agent.get(`/company/payroll/runs/${runId}`)).body;
    expect(r.params.cnpsEmployeeRate).toBe(6.3);
    expect(r.payslips.find((p: any) => p.employeeId === awa).net).toBe(307_950);
    await owner.agent.patch('/company/payroll/settings').send({ cnpsEmployeeRate: 6.3 });
  });

  it('paie les salaires depuis la trésorerie et solde le compte 422', async () => {
    const accounts = (await owner.agent.get('/company/treasury/accounts')).body;
    const cash = accounts.find((a: any) => a.kind === 'cash').id;
    const bank = accounts.find((a: any) => a.kind === 'bank').id;
    expect((await owner.agent.post(`/company/payroll/runs/${runId}/pay`).send({ accountId: cash })).body.error.code).toBe('insufficient_cash');
    await owner.agent.patch(`/company/treasury/accounts/${bank}`).send({ openingBalance: 2_000_000, openingDate: `${period}-01` });
    const paid = await owner.agent.post(`/company/payroll/runs/${runId}/pay`).send({ accountId: bank });
    expect(paid.body.totals.paid).toBe(2);
    expect((await owner.agent.post(`/company/payroll/runs/${runId}/pay`).send({ accountId: bank })).body.error.code).toBe('already_paid');
    const tb = (await owner.agent.get('/company/accounting/trial-balance')).body;
    const acc422 = tb.accounts.find((a: any) => a.account === '422000');
    expect(acc422.closingDebit + acc422.closingCredit).toBe(0);
    expect(tb.balanced).toBe(true);
    const bal = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === bank).balance;
    expect(bal).toBe(2_000_000 - paid.body.totals.net);
  });
  it('calcule la fiche à partir du net à payer et de la catégorie', async () => {
    const settings = (await owner.agent.get('/company/payroll/settings')).body.params;
    expect(settings.smig).toBe(75_000);
    const categories = settings.categories.map((c: any) => (c.code === '3' ? { ...c, minSalary: 120_000 } : c));
    expect((await owner.agent.patch('/company/payroll/settings').send({ categories })).status).toBe(200);
    const body = { targetNet: 250_000, category: '3', transportAllowance: 30_000, maritalStatus: 'married', children: 1 };
    const r = (await owner.agent.post('/company/payroll/net-to-gross').send(body)).body;
    expect(r).toMatchObject({ baseSalary: 120_000, parts: 2.5, warnings: [], payslip: { net: 250_000 } });
    expect(r.extraSalary).toBeGreaterThan(0);
    expect(r.payslip.lines.map((l: any) => l.code)).toEqual(expect.arrayContaining(['BASE', 'SUR', 'CNPS', 'CMU', 'ITS', 'TRA']));
    const saved = await owner.agent.patch(`/company/employees/${kouame}`).send({ category: '3', targetNet: 250_000, baseSalary: r.baseSalary, extraSalary: r.extraSalary, transportAllowance: 30_000, housingAllowance: 0, otherAllowances: 0 });
    expect(saved.body).toMatchObject({ category: '3', targetNet: 250_000, baseSalary: 120_000, extraSalary: r.extraSalary });

    const low = await owner.agent.post('/company/payroll/net-to-gross').send({ ...body, targetNet: 50_000 });
    expect(low.body.error.code).toBe('net_too_low');
    expect((await owner.agent.post('/company/payroll/net-to-gross').send({ ...body, category: 'Z9' })).body.error.code).toBe('unknown_category');
    const unset = (await owner.agent.post('/company/payroll/net-to-gross').send({ ...body, category: '5', targetNet: 60_000 })).body;
    expect(unset.extraSalary).toBe(0);
    expect(unset.warnings.join(' ')).toMatch(/pas renseigné.*SMIG/s);
  });
});
