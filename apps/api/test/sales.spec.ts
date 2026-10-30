import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, computeTotals, today } from '../src/modules/sales/sales.service';
import { createApp, ownerClient, resetDb, signup, uniqueEmail } from './helpers';

async function invite(app: INestApplication, owner: Awaited<ReturnType<typeof signup>>, roleKey: string) {
  const roles = await owner.agent.get('/company/roles');
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail(roleKey), roleIds: [role.id] });
  const token = new URL(inv.body.inviteUrl).searchParams.get('token');
  const agent = request.agent(app.getHttpServer());
  await agent.post('/invitations/accept').send({ token, fullName: `Invité ${roleKey}`, password: 'MotDePasse123' });
  return agent;
}

describe('Calcul des montants', () => {
  it('arrondit chaque ligne au franc CFA puis additionne', () => {
    const t = computeTotals([
      { description: 'Ciment', quantity: 3, unitPrice: 15000, discountPct: 10, vatRate: 18 },
      { description: 'Riz 25 kg', quantity: 2.5, unitPrice: 333.33, vatRate: 9 },
      { description: 'Formation', quantity: 1, unitPrice: 100000, vatRate: 0 },
    ]);
    expect(t.lines).toEqual([{ ht: 40500, vat: 7290 }, { ht: 833, vat: 75 }, { ht: 100000, vat: 0 }]);
    expect(t).toMatchObject({ ht: 141333, vat: 7365, ttc: 148698 });
  });
});

describe('Ventes : articles, devis, factures, encaissements', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let customerId: string;
  let productId: string;
  let invoiceId: string;
  const year = today().slice(0, 4);

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    customerId = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Société Ivoirienne de Négoce', paymentTermsDays: 30, taxId: '1234567A' })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it('gère le catalogue des articles avec un code automatique et un taux de TVA ivoirien', async () => {
    const p = await owner.agent.post('/company/products').send({ name: 'Sac de ciment 50 kg', salePrice: 15000, vatRate: 18, unit: 'sac' });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ code: 'ART-00001', salePrice: 15000, vatRate: 18, kind: 'good', unit: 'sac' });
    productId = p.body.id;
    expect((await owner.agent.post('/company/products').send({ name: 'Taux exotique', salePrice: 10, vatRate: 5 })).status).toBe(400);
    expect((await owner.agent.get('/company/products').query({ q: 'ciment' })).body).toHaveLength(1);
  });

  it('refuse un contact qui est uniquement fournisseur', async () => {
    const supplier = await owner.agent.post('/company/contacts').send({ kind: 'supplier', name: 'Grossiste' });
    const r = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: supplier.body.id, lines: [{ description: 'X', quantity: 1, unitPrice: 1, vatRate: 18 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('not_a_customer');
  });

  it('mène un devis du brouillon à la facture', async () => {
    const draft = await owner.agent.post('/company/sales/documents').send({
      type: 'quote', contactId: customerId,
      lines: [{ productId, description: 'Sac de ciment 50 kg', quantity: 3, unitPrice: 15000, discountPct: 10, vatRate: 18 }, { description: 'Livraison', quantity: 1, unitPrice: 5000, vatRate: 18 }],
    });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'draft', number: null, totalHt: 45500, totalVat: 8190, totalTtc: 53690 });

    const sent = await owner.agent.post(`/company/sales/documents/${draft.body.id}/validate`);
    expect(sent.body).toMatchObject({ status: 'sent', number: `DEV-${year}-00001`, validUntil: addDays(today(), 30) });
    expect((await owner.agent.patch(`/company/sales/documents/${draft.body.id}`).send({ notes: 'trop tard' })).status).toBe(409);
    expect((await owner.agent.delete(`/company/sales/documents/${draft.body.id}`)).status).toBe(409);

    expect((await owner.agent.post(`/company/sales/documents/${draft.body.id}/accept`)).body.status).toBe('accepted');
    const inv = await owner.agent.post(`/company/sales/documents/${draft.body.id}/convert`);
    expect(inv.body).toMatchObject({ type: 'invoice', status: 'draft', totalTtc: 53690, sourceQuoteId: draft.body.id });
    expect(inv.body.lines).toHaveLength(2);
    expect((await owner.agent.get(`/company/sales/documents/${draft.body.id}`)).body.status).toBe('invoiced');
    invoiceId = inv.body.id;
  });

  it("numérote les factures sans trou à la validation et calcule l'échéance", async () => {
    const throwaway = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customerId, lines: [{ description: 'Brouillon jeté', quantity: 1, unitPrice: 1000, vatRate: 18 }] });
    expect((await owner.agent.delete(`/company/sales/documents/${throwaway.body.id}`)).status).toBe(200);

    const issued = await owner.agent.post(`/company/sales/documents/${invoiceId}/validate`);
    expect(issued.body).toMatchObject({ status: 'issued', number: `FAC-${year}-00001`, issueDate: today(), dueDate: addDays(today(), 30), remaining: 53690 });
    expect(issued.body.customer).toMatchObject({ name: 'Société Ivoirienne de Négoce', taxId: '1234567A' });
    expect(issued.body.vatBreakdown).toEqual([{ rate: 18, base: 45500, vat: 8190 }]);
  });

  it('enregistre les encaissements partiels puis le solde', async () => {
    const part = await owner.agent.post(`/company/sales/documents/${invoiceId}/payments`).send({ amount: 20000, method: 'mobile_money', reference: 'OM-123' });
    expect(part.body).toMatchObject({ status: 'partially_paid', paidAmount: 20000, remaining: 33690 });
    expect((await owner.agent.post(`/company/sales/documents/${invoiceId}/payments`).send({ amount: 40000, method: 'cash' })).status).toBe(400);
    const rest = await owner.agent.post(`/company/sales/documents/${invoiceId}/payments`).send({ amount: 33690, method: 'cash' });
    expect(rest.body).toMatchObject({ status: 'paid', remaining: 0 });
    expect(rest.body.payments).toHaveLength(2);
    expect((await owner.agent.post(`/company/sales/documents/${invoiceId}/payments`).send({ amount: 1, method: 'cash' })).status).toBe(409);

    const s = await owner.agent.get('/company/sales/summary');
    expect(s.body).toMatchObject({ revenueMonthHt: 45500, collectedMonth: 53690, outstanding: 0, overdueCount: 0, openQuotes: 0 });
    const csv = await owner.agent.get('/company/sales/documents/export').query({ type: 'invoice' });
    expect(csv.text).toContain(`FAC-${year}-00001`);
  });

  it('la base de données refuse de modifier une facture émise, même hors API', async () => {
    const c = await ownerClient();
    await expect(c.query(`UPDATE sales_document SET total_ttc = 1 WHERE id = $1`, [invoiceId])).rejects.toThrow(/non modifiable/);
    await expect(c.query(`DELETE FROM sales_document WHERE id = $1`, [invoiceId])).rejects.toThrow(/suppression interdite/);
    await expect(c.query(`UPDATE sales_document_line SET unit_price = 1 WHERE document_id = $1`, [invoiceId])).rejects.toThrow(/lignes non modifiables/);
    await c.end();
  });

  it('applique les rôles : le commercial prépare, le caissier encaisse, aucun ne valide', async () => {
    const rep = await invite(app, owner, 'sales_rep');
    const d = await rep.post('/company/sales/documents').send({ type: 'invoice', contactId: customerId, lines: [{ description: 'Prestation', quantity: 1, unitPrice: 10000, vatRate: 18 }] });
    expect(d.status).toBe(201);
    expect((await rep.post(`/company/sales/documents/${d.body.id}/validate`)).status).toBe(403);
    expect((await rep.post(`/company/sales/documents/${d.body.id}/payments`).send({ amount: 1, method: 'cash' })).status).toBe(403);
    await owner.agent.post(`/company/sales/documents/${d.body.id}/validate`);

    const cashier = await invite(app, owner, 'cashier');
    expect((await cashier.post('/company/sales/documents').send({ type: 'invoice', contactId: customerId, lines: [] })).status).toBe(403);
    const paid = await cashier.post(`/company/sales/documents/${d.body.id}/payments`).send({ amount: 11800, method: 'cash' });
    expect(paid.body.status).toBe('paid');
  });
});

describe('Avoirs et relances clients', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let customerId: string;
  const year = today().slice(0, 4);
  const line = (unitPrice: number) => [{ description: 'Prestation de maintenance', quantity: 1, unitPrice, vatRate: 18 }];
  const issueInvoice = async (unitPrice: number) => {
    const d = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customerId, lines: line(unitPrice) });
    return (await owner.agent.post(`/company/sales/documents/${d.body.id}/validate`)).body;
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    customerId = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Hôtel du Plateau', phone: '+225 07 00 00 00 01', paymentTermsDays: 15 })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it("un avoir partiel puis total annule la facture et fait apparaître le trop-perçu", async () => {
    const inv = await issueInvoice(100000);
    await owner.agent.post(`/company/sales/documents/${inv.id}/payments`).send({ amount: 50000, method: 'bank_transfer' });

    const cn1 = await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`);
    expect(cn1.body).toMatchObject({ type: 'credit_note', status: 'draft', totalTtc: 118000, sourceInvoiceId: inv.id });
    expect((await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`)).body.id).toBe(cn1.body.id); // un seul brouillon à la fois
    await owner.agent.patch(`/company/sales/documents/${cn1.body.id}`).send({ lines: line(20000) });
    const v1 = await owner.agent.post(`/company/sales/documents/${cn1.body.id}/validate`);
    expect(v1.body).toMatchObject({ status: 'issued', number: `AV-${year}-00001`, totalTtc: 23600 });
    expect((await owner.agent.get(`/company/sales/documents/${inv.id}`)).body).toMatchObject({ status: 'partially_paid', creditedAmount: 23600, remaining: 44400, refundDue: 0 });

    const cn2 = await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`);
    const tooHigh = await owner.agent.post(`/company/sales/documents/${cn2.body.id}/validate`);
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error.code).toBe('credit_too_high');
    await owner.agent.patch(`/company/sales/documents/${cn2.body.id}`).send({ lines: line(80000) });
    await owner.agent.post(`/company/sales/documents/${cn2.body.id}/validate`);
    const after = await owner.agent.get(`/company/sales/documents/${inv.id}`);
    expect(after.body).toMatchObject({ status: 'credited', creditedAmount: 118000, remaining: 0, refundDue: 50000 });
    expect(after.body.related.map((r: any) => r.number)).toEqual([`AV-${year}-00001`, `AV-${year}-00002`]);
    expect((await owner.agent.post(`/company/sales/documents/${inv.id}/payments`).send({ amount: 1, method: 'cash' })).status).toBe(409);
    expect((await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`)).status).toBe(409);

    const summary = await owner.agent.get('/company/sales/summary');
    expect(summary.body).toMatchObject({ revenueMonthHt: 0, collectedMonth: 50000, outstanding: 0 });
  });

  it("refuse un avoir sur un brouillon et un changement de client sur l'avoir", async () => {
    const draft = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customerId, lines: line(1000) });
    expect((await owner.agent.post(`/company/sales/documents/${draft.body.id}/credit-note`)).status).toBe(409);
    const other = await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Autre client' });
    const inv = await issueInvoice(1000);
    const cn = await owner.agent.post(`/company/sales/documents/${inv.id}/credit-note`);
    expect((await owner.agent.patch(`/company/sales/documents/${cn.body.id}`).send({ contactId: other.body.id })).status).toBe(400);
  });

  it('classe les créances par ancienneté et trace les relances', async () => {
    const late = await issueInvoice(50000);
    const c = await ownerClient();
    await c.query('ALTER TABLE sales_document DISABLE TRIGGER sales_document_lock');
    await c.query(`UPDATE sales_document SET due_date = current_date - 10 WHERE id = $1`, [late.id]);
    await c.query('ALTER TABLE sales_document ENABLE TRIGGER sales_document_lock');
    await c.end();

    const promised = addDays(today(), 5);
    const r = await owner.agent.post(`/company/sales/documents/${late.id}/reminders`).send({ channel: 'whatsapp', note: 'Paiement promis par la comptable', promisedOn: promised });
    expect(r.status).toBe(201);
    expect(r.body.reminders[0]).toMatchObject({ channel: 'whatsapp', promisedOn: promised });
    expect((await owner.agent.post(`/company/sales/documents/${late.id}/reminders`).send({ channel: 'pigeon' })).status).toBe(400);

    const rec = await owner.agent.get('/company/sales/receivables');
    const row = rec.body.invoices.find((i: any) => i.id === late.id);
    expect(row).toMatchObject({ daysLate: 10, bucket: 'd30', remaining: 59000, reminderCount: 1, promisedOn: promised });
    expect(row.contact.phone).toBe('+225 07 00 00 00 01');
    expect(rec.body.totals.d30).toBe(59000);
    expect(rec.body.total).toBe(rec.body.invoices.reduce((s: number, i: any) => s + i.remaining, 0));
    expect((await owner.agent.get('/company/sales/summary')).body).toMatchObject({ overdueCount: 1, overdueAmount: 59000 });
  });
});
