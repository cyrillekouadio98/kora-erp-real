import { INestApplication } from '@nestjs/common';
import { today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup } from './helpers';

/**
 * Exercice 2025 d'une petite entreprise : apport de 1 000 000, véhicule de 600 000 amorti de 120 000,
 * marchandises achetées 500 000 HT, ventes 1 000 000 HT, salaires 200 000. Résultat attendu : 180 000.
 */
describe('Bilan, soldes de gestion et clôture d’exercice', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  const od = (date: string, label: string, lines: [string, number, number][]) =>
    owner.agent.post('/company/accounting/entries').send({ date, label, lines: lines.map(([account, debit, credit]) => ({ account, label, debit, credit })) })
      .then((r) => owner.agent.post(`/company/accounting/entries/${r.body.id}/post`));
  const row = (sheet: any, key: string) => [...sheet.assets, ...sheet.liabilities].flatMap((s: any) => s.rows).find((r: any) => r.key === key);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    const supplier = (await owner.agent.post('/company/contacts').send({ kind: 'supplier', name: 'Grossiste' })).body.id;
    await od('2025-01-10', 'Apport en capital', [['521000', 1_000_000, 0], ['101000', 0, 1_000_000]]);
    await od('2025-03-01', 'Achat véhicule de livraison', [['245000', 600_000, 0], ['521000', 0, 600_000]]);
    const bill = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'G-2025-01', issueDate: '2025-04-01',
      lines: [{ description: 'Marchandises', quantity: 50, unitPrice: 10_000, vatRate: 18 }] });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
    await od('2025-06-30', 'Ventes du semestre', [['411000', 1_180_000, 0], ['701000', 0, 1_000_000], ['443100', 0, 180_000]]);
    await od('2025-06-30', 'Salaires', [['661000', 200_000, 0], ['521000', 0, 200_000]]);
    await od('2025-12-31', 'Dotation aux amortissements', [['681000', 120_000, 0], ['284500', 0, 120_000]]);
  });
  afterAll(async () => { await app.close(); });

  it('produit les soldes significatifs de gestion SYSCOHADA', async () => {
    const sig = (await owner.agent.get('/company/accounting/management-balances').query({ from: '2025-01-01', to: '2025-12-31' })).body;
    const v = Object.fromEntries(sig.lines.map((l: any) => [l.key, l.value]));
    expect(v).toMatchObject({ commercialMargin: 500_000, revenue: 1_000_000, addedValue: 500_000, ebitda: 300_000, operatingResult: 180_000, financialResult: 0, netResult: 180_000 });
  });

  it('établit un bilan équilibré au 31 décembre, résultat compris', async () => {
    const b = (await owner.agent.get('/company/accounting/balance-sheet').query({ date: '2025-12-31' })).body;
    expect(row(b, 'tangible')).toMatchObject({ gross: 600_000, depreciation: 120_000, net: 480_000 });
    expect(row(b, 'customers').net).toBe(1_180_000);
    expect(row(b, 'other_receivables').net).toBe(90_000);   // TVA récupérable
    expect(row(b, 'cash').net).toBe(200_000);
    expect(row(b, 'capital').net).toBe(1_000_000);
    expect(row(b, 'current_result').net).toBe(180_000);
    expect(row(b, 'suppliers').net).toBe(590_000);
    expect(row(b, 'tax_social').net).toBe(180_000);         // TVA facturée
    expect(b).toMatchObject({ totalAssets: 1_950_000, totalLiabilities: 1_950_000, balanced: true });
  });

  it('bloque la clôture tant qu’il reste des brouillons, et signale les points à vérifier', async () => {
    const draft = await owner.agent.post('/company/accounting/entries').send({ date: '2025-11-02', label: 'Oubli', lines: [{ account: '622200', label: 'x', debit: 1 }, { account: '401000', label: 'x', credit: 1 }] });
    const c1 = (await owner.agent.get('/company/accounting/fiscal-years/2025/checklist')).body;
    expect(c1.blocking.join(' ')).toContain('brouillon');
    expect((await owner.agent.post('/company/accounting/fiscal-years/2025/close').send({})).body.error.code).toBe('closing_blocked');
    await owner.agent.delete(`/company/accounting/entries/${draft.body.id}`);

    await od('2025-12-20', 'Virement non terminé', [['585000', 10_000, 0], ['521000', 0, 10_000]]);
    const c2 = (await owner.agent.get('/company/accounting/fiscal-years/2025/checklist')).body;
    expect(c2).toMatchObject({ blocking: [], result: 180_000 });
    expect(c2.warnings.join(' ')).toContain('585000');
    expect((await owner.agent.post('/company/accounting/fiscal-years/2025/close').send({})).body.error.code).toBe('warnings_not_acknowledged');
  });

  it('clôture : résultat porté au 131, exercice verrouillé, comptes de gestion soldés', async () => {
    const r = await owner.agent.post('/company/accounting/fiscal-years/2025/close').send({ acknowledgeWarnings: true });
    expect(r.body).toEqual({ year: 2025, result: 180_000, lockedUntil: '2025-12-31' });
    const entry = (await owner.agent.get('/company/accounting/entries').query({ q: 'CLOTURE-2025' })).body[0];
    const by = (a: string) => entry.lines.filter((l: any) => l.account === a).reduce((s: number, l: any) => s + l.debit - l.credit, 0);
    expect({ c701: by('701000'), c601: by('601000'), c681: by('681000'), c661: by('661000'), c131: by('131000') }).toEqual({ c701: 1_000_000, c601: -500_000, c681: -120_000, c661: -200_000, c131: -180_000 });

    const b = (await owner.agent.get('/company/accounting/balance-sheet').query({ date: '2025-12-31' })).body;
    expect(row(b, 'pending_results').net).toBe(180_000);
    expect(row(b, 'current_result').net).toBe(0);
    expect(b.balanced).toBe(true);
    // L'exercice suivant part des soldes de clôture : aucun résultat 2025 ne pollue 2026.
    const b2026 = (await owner.agent.get('/company/accounting/balance-sheet').query({ date: today() })).body;
    expect(row(b2026, 'current_result').net).toBe(0);
    expect(b2026.balanced).toBe(true);

    expect((await owner.agent.post('/company/accounting/entries').send({ date: '2025-08-01', label: 'Trop tard', lines: [{ account: '622200', label: 'x', debit: 1 }, { account: '401000', label: 'x', credit: 1 }] })
      .then((x) => owner.agent.post(`/company/accounting/entries/${x.body.id}/post`))).body.error.code).toBe('period_locked');
    expect((await owner.agent.post('/company/accounting/fiscal-years/2025/close').send({ acknowledgeWarnings: true })).body.error.code).toBe('already_closed');
    expect((await owner.agent.get('/company/accounting/fiscal-years/2026/checklist')).body.blocking.join(' ')).toContain("n'est pas terminé");
    const years = (await owner.agent.get('/company/accounting/fiscal-years')).body;
    expect(years.find((y: any) => y.year === 2025)).toMatchObject({ closed: true, result: 180_000 });
  });

  it('impose de clôturer les exercices dans l’ordre', async () => {
    const other = await signup(app);
    await other.agent.post('/company/accounting/entries').send({ date: '2024-05-01', label: 'Activité 2024', lines: [{ account: '521000', label: 'x', debit: 5 }, { account: '101000', label: 'x', credit: 5 }] })
      .then((x) => other.agent.post(`/company/accounting/entries/${x.body.id}/post`));
    const c = (await other.agent.get('/company/accounting/fiscal-years/2025/checklist')).body;
    expect(c.blocking.join(' ')).toContain('2024');
  });
});
