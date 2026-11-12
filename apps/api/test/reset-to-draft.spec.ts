import { INestApplication } from '@nestjs/common';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, TIERS } from './helpers';

describe('Remise en brouillon après validation : factures clients, factures fournisseurs, paie', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let oil: string, customer: string, supplier: string;
  const stock = async (id = oil) => (await owner.agent.get(`/company/stock/${id}/movements`)).body.product;
  const entries = async (journal: string) => (await owner.agent.get('/company/accounting/entries').query({ journal })).body;
  const line = (quantity: number, unitPrice = 6000) => ({ productId: oil, description: 'Huile 5 L', quantity, unitPrice, vatRate: 18 });

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    oil = (await owner.agent.post('/company/products').send({ name: 'Huile végétale 5 L', salePrice: 6000, purchasePrice: 4000, vatRate: 18, unit: 'bidon' })).body.id;
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Maquis Chez Tantie' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Grossiste Adjamé' })).body.id;
    await owner.agent.post(`/company/stock/${oil}/opening`).send({ quantity: 10, unitCost: 4000 });
  });
  afterAll(async () => { await app.close(); });

  it('remet une facture client en brouillon : écriture contre-passée, stock réintégré, numéro conservé', async () => {
    const id = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [line(4)] })).body.id;
    const issued = (await owner.agent.post(`/company/sales/documents/${id}/validate`)).body;
    expect(await stock()).toMatchObject({ stock_qty: 6, stock_value: 24_000 });

    const draft = await owner.agent.post(`/company/sales/documents/${id}/reset-to-draft`);
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ status: 'draft', number: issued.number });
    expect(await stock()).toMatchObject({ stock_qty: 10, stock_value: 40_000 });
    const vt = await entries('VT');
    expect(vt).toHaveLength(2);
    expect(vt.find((e: any) => e.sourceType === 'sales_document').reversedBy).toBe(vt.find((e: any) => e.sourceType === 'reversal').id);
    expect((await owner.agent.get('/company/accounting/status')).body.pending).toBe(0);

    // Corrigée puis réémise : même numéro, nouvelle écriture
    expect((await owner.agent.patch(`/company/sales/documents/${id}`).send({ lines: [line(3)] })).status).toBe(200);
    expect((await owner.agent.delete(`/company/sales/documents/${id}`)).body.error.code).toBe('document_numbered');
    const again = (await owner.agent.post(`/company/sales/documents/${id}/validate`)).body;
    expect(again).toMatchObject({ status: 'issued', number: issued.number, issueDate: issued.issueDate, totalTtc: 21_240 });
    expect(await stock()).toMatchObject({ stock_qty: 7 });
    expect(await entries('VT')).toHaveLength(3);

    // Encaissée : elle ne se remet plus en brouillon
    await owner.agent.post(`/company/sales/documents/${id}/payments`).send({ amount: 1000, method: 'cash' });
    expect((await owner.agent.post(`/company/sales/documents/${id}/reset-to-draft`)).body.error.code).toBe('invoice_settled');
    const quote = (await owner.agent.post('/company/sales/documents').send({ type: 'quote', contactId: customer, lines: [line(1)] })).body.id;
    await owner.agent.post(`/company/sales/documents/${quote}/validate`);
    expect((await owner.agent.post(`/company/sales/documents/${quote}/reset-to-draft`)).body.error.code).toBe('invalid_state');
  });

  it('remet une facture fournisseur en brouillon, sauf si la marchandise est déjà sortie', async () => {
    const buy = async (quantity: number) => {
      const id = (await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: `F-${quantity}`, issueDate: today(), lines: [line(quantity, 5000)] })).body.id;
      return (await owner.agent.post(`/company/purchases/documents/${id}/validate`)).body;
    };
    const inv = await buy(5);
    expect(await stock()).toMatchObject({ stock_qty: 12, stock_value: 53_000 });
    const draft = (await owner.agent.post(`/company/purchases/documents/${inv.id}/reset-to-draft`)).body;
    expect(draft).toMatchObject({ status: 'draft', number: inv.number });
    expect(await stock()).toMatchObject({ stock_qty: 7, stock_value: 28_000 });
    expect((await entries('AC')).filter((e: any) => !e.reversedBy && e.sourceType === 'purchase_document')).toHaveLength(0);
    expect((await owner.agent.post(`/company/purchases/documents/${inv.id}/validate`)).body).toMatchObject({ status: 'to_pay', number: inv.number });

    // La marchandise achetée a été vendue : on ne peut plus annuler l'entrée en stock
    const sold = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [line(12)] })).body.id;
    await owner.agent.post(`/company/sales/documents/${sold}/validate`);
    const r = await owner.agent.post(`/company/purchases/documents/${inv.id}/reset-to-draft`);
    expect(r.body.error.code).toBe('insufficient_stock');
    expect((await owner.agent.get(`/company/purchases/documents/${inv.id}`)).body.status).toBe('to_pay');
  });

  it('remet une paie validée en brouillon tant qu’aucun salaire n’est payé', async () => {
    const period = today().slice(0, 7);
    await owner.agent.post('/company/employees').send({ firstName: 'Awa', lastName: 'Traoré', hireDate: addDays(today(), -400), cnpsNumber: '1', category: '3', baseSalary: 300_000, paymentMethod: 'cash' });
    const runId = (await owner.agent.post('/company/payroll/runs').send({ period })).body.id;
    await owner.agent.post(`/company/payroll/runs/${runId}/validate`);
    expect((await owner.agent.post(`/company/payroll/runs/${runId}/reset-to-draft`)).body).toMatchObject({ status: 'draft', validatedAt: null });
    expect((await entries('OD')).filter((e: any) => e.label.startsWith('Paie de'))[0].reversedBy).toBeTruthy();

    const slip = (await owner.agent.get(`/company/payroll/runs/${runId}`)).body.payslips[0];
    expect((await owner.agent.patch(`/company/payroll/runs/${runId}/payslips/${slip.id}`).send({ bonus: 10_000 })).status).toBe(200);
    expect((await owner.agent.post(`/company/payroll/runs/${runId}/validate`)).body.status).toBe('validated');
    expect((await entries('OD')).filter((e: any) => e.label.startsWith('Paie de') && !e.reversedBy)).toHaveLength(1);

    const bank = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.kind === 'bank').id;
    await owner.agent.patch(`/company/treasury/accounts/${bank}`).send({ openingBalance: 2_000_000, openingDate: `${period}-01` });
    await owner.agent.post(`/company/payroll/runs/${runId}/pay`).send({ accountId: bank });
    expect((await owner.agent.post(`/company/payroll/runs/${runId}/reset-to-draft`)).body.error.code).toBe('run_paid');
  });

  it('refuse la remise en brouillon dans une période clôturée', async () => {
    const id = (await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'ANCIEN', issueDate: addDays(today(), -40), lines: [{ description: 'Loyer', quantity: 1, unitPrice: 50_000, vatRate: 0 }] })).body.id;
    await owner.agent.post(`/company/purchases/documents/${id}/validate`);
    await owner.agent.post('/company/accounting/lock').send({ until: addDays(today(), -35) });
    expect((await owner.agent.post(`/company/purchases/documents/${id}/reset-to-draft`)).body.error.code).toBe('period_locked');
  });
});
