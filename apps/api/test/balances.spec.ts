import { INestApplication } from '@nestjs/common';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, TIERS } from './helpers';

describe('Balances (comptes 4/6/8 colonnes, développée, tiers, âgée)', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let customer: string;
  let supplier: string;
  const year = Number(today().slice(0, 4));
  const yearStart = `${year}-01-01`;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Client Balance' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Fournisseur Balance' })).body.id;
    // Créances antérieures saisies en OD (échéance = date de l'écriture) : il y a 80 jours et il y a 40 jours.
    const od = async (date: string, label: string, lines: any[]) => {
      const e = await owner.agent.post('/company/accounting/entries').send({ date, label, lines });
      expect(e.status).toBe(201);
      expect((await owner.agent.post(`/company/accounting/entries/${e.body.id}/post`)).status).toBe(200);
    };
    await od(addDays(today(), -80), 'Créance ancienne', [{ account: '411000', contactId: customer, label: 'Créance', debit: 100000 }, { account: '706000', label: 'Créance', credit: 100000 }]);
    await od(addDays(today(), -40), 'Créance récente', [{ account: '411000', contactId: customer, label: 'Créance', debit: 60000 }, { account: '706000', label: 'Créance', credit: 60000 }]);
    // Facture de vente non échue : son échéance vient de la facture.
    const d = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, dueDate: addDays(today(), 25), lines: [{ description: 'Prestation', quantity: 1, unitPrice: 40000, vatRate: 0 }] });
    expect((await owner.agent.post(`/company/sales/documents/${d.body.id}/validate`)).status).toBe(200);
    // Un règlement de 70 000 solde d'abord la créance la plus ancienne (reste 30 000 à plus de 60 jours).
    await od(today(), 'Règlement client', [{ account: '571100', label: 'Règlement', debit: 70000 }, { account: '411000', contactId: customer, label: 'Règlement', credit: 70000 }]);
    const bill = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'FB-1', issueDate: addDays(today(), -20), dueDate: addDays(today(), -5),
      lines: [{ description: 'Fournitures', quantity: 1, unitPrice: 25000, vatRate: 0 }] });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
  });
  afterAll(async () => { await app.close(); });

  it('donne toutes les colonnes de la balance des comptes et les totaux bilan / gestion', async () => {
    const b = (await owner.agent.get('/company/accounting/account-balance').query({ to: today() })).body;
    expect(b.balanced).toBe(true);
    const row = (code: string) => b.accounts.find((a: any) => a.account === code);
    expect(row('411000')).toMatchObject({ debit: 200000, credit: 70000, periodDebit: 130000, closingDebit: 130000, priorDebit: 0, compare: null });
    expect(row('706000')).toMatchObject({ credit: 160000, closingCredit: 160000 });
    expect(b.groups.management).toMatchObject({ debit: 25000, credit: 200000, netClosingCredit: 175000 });
    expect(b.groups.balanceSheet.netClosingDebit).toBe(175000);
    expect(b.totals.debit).toBe(b.totals.credit);
    expect(b.classes.map((c: any) => c.class)).toEqual(expect.arrayContaining(['4', '5', '6', '7']));
  });

  it('sépare mouvements antérieurs et de la période, compare à une autre période et filtre une plage de comptes', async () => {
    const from = addDays(today(), -30);
    const b = (await owner.agent.get('/company/accounting/account-balance').query({ from, to: today(), compareFrom: addDays(from, -365), compareTo: addDays(today(), -31), accountFrom: '4', accountTo: '4' })).body;
    expect(b.accounts.every((a: any) => a.account.startsWith('4'))).toBe(true);
    const c411 = b.accounts.find((a: any) => a.account === '411000');
    // Antérieurs : les deux premières factures (160 000) ; période : la troisième facture et le règlement.
    expect(c411).toMatchObject({ priorDebit: 160000, priorCredit: 0, openingDebit: 160000, debit: 40000, credit: 70000, periodCredit: 30000, closingDebit: 130000, compare: 160000 });
    expect((await owner.agent.get('/company/accounting/account-balance').query({ accountFrom: 'x' })).status).toBe(400);
  });

  it('produit la balance des tiers par compte collectif', async () => {
    const b = (await owner.agent.get('/company/accounting/third-party-balance').query({ from: yearStart, to: today() })).body;
    const c = b.parties.find((p: any) => p.contactId === customer);
    const s = b.parties.find((p: any) => p.contactId === supplier);
    expect(c).toMatchObject({ account: '411000', name: 'Client Balance', closingDebit: 130000, balance: 130000 });
    expect(s).toMatchObject({ account: '401000', closingCredit: 25000, balance: -25000 });
    expect(b.totals.balance).toBe(105000);
    const only = (await owner.agent.get('/company/accounting/third-party-balance').query({ kind: 'supplier' })).body;
    expect(only.parties.map((p: any) => p.contactId)).toEqual([supplier]);
  });

  it('classe les créances par tranche de retard après imputation des règlements sur les plus anciennes', async () => {
    const a = (await owner.agent.get('/company/accounting/aged-balance').query({ kind: 'customer', date: today() })).body;
    expect(a.buckets.map((b: any) => b.key)).toEqual(['notDue', 'b0', 'b1', 'b2', 'b3']);
    const c = a.parties.find((p: any) => p.contactId === customer);
    expect(c).toMatchObject({ balance: 130000, amounts: { notDue: 40000, b0: 0, b1: 60000, b2: 0, b3: 30000 } });
    expect(a.totals.shares.notDue).toBeCloseTo(30.77, 1);
    const s = (await owner.agent.get('/company/accounting/aged-balance').query({ kind: 'supplier', steps: '30,60,90' })).body;
    expect(s.parties[0]).toMatchObject({ contactId: supplier, balance: 25000, amounts: { b0: 25000 } });
    expect(s.buckets[s.buckets.length - 1].label).toBe('Plus de 90 jours');
    expect((await owner.agent.get('/company/accounting/aged-balance').query({ steps: 'abc' })).status).toBe(400);
  });
});
