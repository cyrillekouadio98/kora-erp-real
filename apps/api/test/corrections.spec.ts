import { INestApplication } from '@nestjs/common';
import { today } from '../src/modules/sales/sales.service';
import { createApp, resetDb, signup, TIERS } from './helpers';

describe('Correction des opérations validées : écritures d’OD, bons de stock, avoirs, dépenses de trésorerie', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let oil: string, customer: string, supplier: string, cash: string;
  const year = today().slice(0, 4);
  const product = async () => (await owner.agent.get(`/company/stock/${oil}/movements`)).body.product;
  const cashBalance = async () => (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.id === cash).balance;
  const balance = async () => (await owner.agent.get('/company/accounting/trial-balance')).body;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    oil = (await owner.agent.post('/company/products').send({ name: 'Huile végétale 5 L', salePrice: 6000, purchasePrice: 4000, vatRate: 18, unit: 'bidon' })).body.id;
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Maquis Chez Tantie' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Grossiste Adjamé' })).body.id;
    cash = (await owner.agent.get('/company/treasury/accounts')).body.find((a: any) => a.kind === 'cash').id;
    await owner.agent.post('/company/treasury/movements').send({ kind: 'income', accountId: cash, amount: 200_000, category: 'capital', label: 'Apport' });
    await owner.agent.post(`/company/stock/${oil}/opening`).send({ quantity: 10, unitCost: 4000 });
  });
  afterAll(async () => { await app.close(); });

  it('remet une écriture d’OD validée en brouillon : contre-passation à sa date et copie modifiable', async () => {
    const date = today();
    const created = (await owner.agent.post('/company/accounting/entries').send({ date, label: 'Loyer de mars', lines: [
      { account: '622200', label: 'Loyer', debit: 150000 }, { account: '571100', label: 'Loyer', credit: 150000 }] })).body;
    const posted = (await owner.agent.post(`/company/accounting/entries/${created.id}/post`)).body;
    const res = await owner.agent.post(`/company/accounting/entries/${created.id}/reset-to-draft`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'draft', number: null, date, label: 'Loyer de mars', sourceType: 'manual' });
    expect(res.body.lines.map((l: any) => [l.account, l.debit, l.credit])).toEqual([['622200', 150000, 0], ['571100', 0, 150000]]);
    const original = (await owner.agent.get(`/company/accounting/entries/${created.id}`)).body;
    expect(original.reversedBy).toBeTruthy();
    const reversal = (await owner.agent.get(`/company/accounting/entries/${original.reversedBy}`)).body;
    expect(reversal).toMatchObject({ date, status: 'posted', reference: posted.number });
    // Le brouillon se corrige puis se valide ; l'écriture d'origine ne peut plus être remise en brouillon.
    await owner.agent.patch(`/company/accounting/entries/${res.body.id}`).send({ lines: [{ account: '622200', label: 'Loyer', debit: 120000 }, { account: '571100', label: 'Loyer', credit: 120000 }] });
    expect((await owner.agent.post(`/company/accounting/entries/${res.body.id}/post`)).body.status).toBe('posted');
    expect((await owner.agent.post(`/company/accounting/entries/${created.id}/reset-to-draft`)).body.error.code).toBe('already_reversed');
    const tb = await balance();
    expect(tb.balanced).toBe(true);
    expect(tb.accounts.find((a: any) => a.account === '622200')).toMatchObject({ closingDebit: 120000 });
    // Une écriture issue d'un document se corrige depuis ce document.
    const auto = (await owner.agent.get('/company/accounting/entries').query({ q: 'Apport' })).body.find((e: any) => e.sourceType === 'treasury_movement');
    expect(auto.sourceId).toBeTruthy();
    expect((await owner.agent.post(`/company/accounting/entries/${auto.id}/reset-to-draft`)).body.error.code).toBe('from_document');
  });

  it('remet un bon d’entrée payé comptant en brouillon : stock, caisse et écriture annulés, numéro conservé', async () => {
    const d = (await owner.agent.post('/company/stock/documents').send({ type: 'receipt', reason: 'cash_purchase', treasuryAccountId: cash, contactId: supplier,
      lines: [{ productId: oil, quantity: 5, unitCost: 4400 }] })).body;
    const done = (await owner.agent.post(`/company/stock/documents/${d.id}/validate`)).body;
    expect(done.number).toBe(`BE-${year}-00001`);
    expect(await product()).toMatchObject({ stock_qty: 15 });
    const before = await cashBalance();

    const draft = await owner.agent.post(`/company/stock/documents/${d.id}/reset-to-draft`);
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ status: 'draft', number: `BE-${year}-00001` });
    expect(await product()).toMatchObject({ stock_qty: 10, stock_value: 40_000 });
    expect(await cashBalance()).toBe(before + 22_000);
    expect((await balance()).accounts.find((a: any) => a.account === '601000')).toMatchObject({ closingDebit: 0 });
    expect((await owner.agent.delete(`/company/stock/documents/${d.id}`)).body.error.code).toBe('document_numbered');

    await owner.agent.patch(`/company/stock/documents/${d.id}`).send({ lines: [{ productId: oil, quantity: 4, unitCost: 4400 }] });
    const again = (await owner.agent.post(`/company/stock/documents/${d.id}/validate`)).body;
    expect(again).toMatchObject({ status: 'done', number: `BE-${year}-00001`, totalValue: 17_600 });
    expect(await product()).toMatchObject({ stock_qty: 14 });
    expect(await cashBalance()).toBe(before + 22_000 - 17_600);
    expect((await balance()).balanced).toBe(true);
  });

  it('refuse de remettre en brouillon un bon dont la marchandise est déjà ressortie', async () => {
    const d = (await owner.agent.post('/company/stock/documents').send({ type: 'receipt', reason: 'found', lines: [{ productId: oil, quantity: 2 }] })).body;
    await owner.agent.post(`/company/stock/documents/${d.id}/validate`);
    const out = (await owner.agent.post('/company/stock/documents').send({ type: 'issue', reason: 'loss', lines: [{ productId: oil, quantity: 16 }] })).body;
    expect((await owner.agent.post(`/company/stock/documents/${out.id}/validate`)).status).toBe(200);
    expect((await owner.agent.post(`/company/stock/documents/${d.id}/reset-to-draft`)).body.error.code).toBe('insufficient_stock');
    // Le bon de sortie, lui, se remet en brouillon : la marchandise rentre.
    expect((await owner.agent.post(`/company/stock/documents/${out.id}/reset-to-draft`)).body.status).toBe('draft');
    expect(await product()).toMatchObject({ stock_qty: 16 });
  });

  it('remet un avoir en brouillon : la facture retrouve son reste à payer', async () => {
    const inv = (await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ description: 'Prestation', quantity: 1, unitPrice: 100000, vatRate: 0 }] })).body.id;
    await owner.agent.post(`/company/sales/documents/${inv}/validate`);
    const cn = (await owner.agent.post(`/company/sales/documents/${inv}/credit-note`)).body.id;
    await owner.agent.patch(`/company/sales/documents/${cn}`).send({ lines: [{ description: 'Remise', quantity: 1, unitPrice: 30000, vatRate: 0 }] });
    const issued = (await owner.agent.post(`/company/sales/documents/${cn}/validate`)).body;
    expect((await owner.agent.get(`/company/sales/documents/${inv}`)).body.creditedAmount).toBe(30000);

    const draft = await owner.agent.post(`/company/sales/documents/${cn}/reset-to-draft`);
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ status: 'draft', number: issued.number });
    expect((await owner.agent.get(`/company/sales/documents/${inv}`)).body.creditedAmount).toBe(0);
    await owner.agent.patch(`/company/sales/documents/${cn}`).send({ lines: [{ description: 'Remise', quantity: 1, unitPrice: 25000, vatRate: 0 }] });
    expect((await owner.agent.post(`/company/sales/documents/${cn}/validate`)).body).toMatchObject({ status: 'issued', number: issued.number });
    expect((await owner.agent.get(`/company/sales/documents/${inv}`)).body.creditedAmount).toBe(25000);
    expect((await balance()).accounts.find((a: any) => a.account === '411000')).toMatchObject({ closingDebit: 75000 });
  });

  it('modifie une dépense : l’ancienne est contre-passée et la nouvelle enregistrée', async () => {
    const before = await cashBalance();
    const m = (await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: cash, amount: 12000, category: 'electricity', label: 'Facture CIE' })).body;
    const fixed = await owner.agent.post(`/company/treasury/movements/${m.id}/correct`).send({ accountId: cash, amount: 15000, category: 'electricity', label: 'Facture CIE de mars' });
    expect(fixed.status).toBe(200);
    expect(await cashBalance()).toBe(before - 15000);
    expect((await owner.agent.post(`/company/treasury/movements/${m.id}/correct`).send({ accountId: cash, amount: 1, category: 'electricity', label: 'x x' })).body.error.code).toBe('already_reversed');
    const movements = (await owner.agent.get('/company/treasury/movements').query({ accountId: cash })).body.movements;
    expect(movements.filter((x: any) => x.label.includes('Facture CIE')).map((x: any) => [x.direction, x.amount])).toEqual(expect.arrayContaining([['out', 12000], ['in', 12000], ['out', 15000]]));
    expect((await balance()).accounts.find((a: any) => a.account === '605200')).toMatchObject({ closingDebit: 15000 });
  });
});
