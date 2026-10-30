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
