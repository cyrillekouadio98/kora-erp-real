import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, today } from '../src/modules/sales/sales.service';
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

describe('Achats : commandes, factures et règlements fournisseurs', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let supplierId: string;
  let invoiceId: string;
  const year = today().slice(0, 4);
  const lines = [{ description: 'Sacs de ciment CPJ 45', quantity: 200, unitPrice: 4200, vatRate: 18 }, { description: 'Transport', quantity: 1, unitPrice: 30000, vatRate: 18 }];

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    supplierId = (await owner.agent.post('/company/contacts').send({ kind: 'supplier', name: 'Cimenterie du Sud', paymentTermsDays: 45 })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it("n'accepte qu'un fournisseur et refuse une date future", async () => {
    const client = await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Client seulement' });
    const r = await owner.agent.post('/company/purchases/documents').send({ type: 'order', contactId: client.body.id, lines });
    expect(r.body.error.code).toBe('not_a_supplier');
    const f = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplierId, issueDate: addDays(today(), 2), lines });
    expect(f.body.error.code).toBe('future_date');
  });

  it('mène un bon de commande jusqu’à la facture fournisseur', async () => {
    const o = await owner.agent.post('/company/purchases/documents').send({ type: 'order', contactId: supplierId, expectedDate: addDays(today(), 10), lines });
    expect(o.body).toMatchObject({ status: 'draft', totalHt: 870000, totalVat: 156600, totalTtc: 1026600 });
    const sent = await owner.agent.post(`/company/purchases/documents/${o.body.id}/validate`);
    expect(sent.body).toMatchObject({ status: 'sent', number: `BC-${year}-00001` });

    const other = await owner.agent.post('/company/purchases/documents').send({ type: 'order', contactId: supplierId, lines });
    await owner.agent.post(`/company/purchases/documents/${other.body.id}/validate`);
    expect((await owner.agent.post(`/company/purchases/documents/${other.body.id}/cancel`)).body.status).toBe('cancelled');
    expect((await owner.agent.post(`/company/purchases/documents/${other.body.id}/convert`)).status).toBe(409);

    const inv = await owner.agent.post(`/company/purchases/documents/${o.body.id}/convert`);
    expect(inv.body).toMatchObject({ type: 'invoice', status: 'draft', totalTtc: 1026600, sourceOrderId: o.body.id });
    expect((await owner.agent.get(`/company/purchases/documents/${o.body.id}`)).body.status).toBe('invoiced');
    invoiceId = inv.body.id;
  });

  it('exige la référence du fournisseur, garde sa date et refuse les doublons', async () => {
    const noRef = await owner.agent.post(`/company/purchases/documents/${invoiceId}/validate`);
    expect(noRef.body.error.code).toBe('supplier_ref_required');
    const issued = addDays(today(), -5);
    await owner.agent.patch(`/company/purchases/documents/${invoiceId}`).send({ supplierRef: 'FV-2026/118', issueDate: issued });
    const v = await owner.agent.post(`/company/purchases/documents/${invoiceId}/validate`);
    expect(v.body).toMatchObject({ status: 'to_pay', number: `ACH-${year}-00001`, supplierRef: 'FV-2026/118', issueDate: issued, dueDate: addDays(issued, 45), remaining: 1026600 });

    const dup = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplierId, supplierRef: ' fv-2026/118 ', lines });
    const refused = await owner.agent.post(`/company/purchases/documents/${dup.body.id}/validate`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain(`ACH-${year}-00001`);

    const otherSupplier = await owner.agent.post('/company/contacts').send({ kind: 'both', name: 'Quincaillerie Treichville' });
    const same = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: otherSupplier.body.id, supplierRef: 'FV-2026/118', lines: [lines[1]] });
    expect((await owner.agent.post(`/company/purchases/documents/${same.body.id}/validate`)).body.number).toBe(`ACH-${year}-00002`);
  });

  it("règle partiellement puis entièrement et tient l'échéancier", async () => {
    const part = await owner.agent.post(`/company/purchases/documents/${invoiceId}/payments`).send({ amount: 500000, method: 'bank_transfer', reference: 'VIR-0042' });
    expect(part.body).toMatchObject({ status: 'partially_paid', remaining: 526600 });
    expect((await owner.agent.post(`/company/purchases/documents/${invoiceId}/payments`).send({ amount: 600000, method: 'cash' })).status).toBe(400);

    const p = await owner.agent.get('/company/purchases/payables');
    const row = p.body.invoices.find((i: any) => i.id === invoiceId);
    expect(row).toMatchObject({ bucket: 'not_due', remaining: 526600, supplierRef: 'FV-2026/118' });
    expect(p.body.dueIn30Days).toBe(35400); // seule la facture Quincaillerie (payable comptant, échue aujourd’hui) tombe dans les 30 prochains jours
    expect(p.body.total).toBe(526600 + 35400);

    await owner.agent.post(`/company/purchases/documents/${invoiceId}/payments`).send({ amount: 526600, method: 'cheque' });
    const s = await owner.agent.get('/company/purchases/summary');
    expect(s.body).toMatchObject({ purchasesMonthHt: expect.any(Number), paidMonth: 1026600, payable: 35400, overdueCount: 0, openOrders: 0 });
    expect((await owner.agent.get('/company/purchases/documents/export').query({ type: 'invoice' })).text).toContain('FV-2026/118');
  });

  it('la base refuse de modifier une facture fournisseur validée', async () => {
    const c = await ownerClient();
    await expect(c.query(`UPDATE purchase_document SET total_ttc = 1 WHERE id = $1`, [invoiceId])).rejects.toThrow(/non modifiable/);
    await expect(c.query(`UPDATE purchase_document_line SET unit_price = 1 WHERE document_id = $1`, [invoiceId])).rejects.toThrow(/lignes non modifiables/);
    await c.end();
  });

  it('sépare les rôles : le comptable enregistre, le caissier règle, le commercial ne voit pas les achats', async () => {
    const accountant = await invite(app, owner, 'accountant');
    const d = await accountant.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplierId, supplierRef: 'FV-2026/200', lines: [lines[1]] });
    expect(d.status).toBe(201);
    expect((await accountant.post(`/company/purchases/documents/${d.body.id}/validate`)).status).toBe(200);
    expect((await accountant.post(`/company/purchases/documents/${d.body.id}/payments`).send({ amount: 1000, method: 'cash' })).status).toBe(403);
    const cashier = await invite(app, owner, 'cashier');
    expect((await cashier.post(`/company/purchases/documents/${d.body.id}/payments`).send({ amount: 1000, method: 'cash' })).status).toBe(201);
    const rep = await invite(app, owner, 'sales_rep');
    expect((await rep.get('/company/purchases/documents').query({ type: 'invoice' })).status).toBe(403);
  });

  it("n'est pas disponible avec la formule Starter", async () => {
    const small = await signup(app);
    await small.agent.post('/company/subscription/change').send({ planCode: 'starter', billingCycle: 'monthly' });
    const r = await small.agent.get('/company/purchases/documents').query({ type: 'invoice' });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('module_not_in_plan');
  });
});
