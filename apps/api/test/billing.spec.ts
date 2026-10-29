import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingService } from '../src/modules/billing/billing.service';
import { SandboxProvider } from '../src/modules/billing/payment-provider';
import { createApp, ownerClient, platformUser, resetDb, signup } from './helpers';

const DAY = 86400_000;

function webhook(app: INestApplication, payload: Record<string, unknown>, signature?: string) {
  const raw = JSON.stringify(payload);
  return request(app.getHttpServer()).post('/webhooks/payments/sandbox')
    .set('content-type', 'application/json').set('x-kora-signature', signature ?? SandboxProvider.sign(raw)).send(raw);
}

async function periodEnd(companyId: string): Promise<Date> {
  const c = await ownerClient();
  const r = await c.query('SELECT current_period_end FROM subscription WHERE company_id = $1', [companyId]);
  await c.end();
  return new Date(r.rows[0].current_period_end);
}

describe('Abonnements, facturation et paiements', () => {
  let app: INestApplication;
  let billing: BillingService;
  beforeAll(async () => { await resetDb(); app = await createApp(); billing = app.get(BillingService); });
  afterAll(async () => { await app.close(); });

  it("cycle complet : fin d'essai → grâce → paiement → actif, notification traitée une seule fois", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    let sub = await u.agent.get('/company/subscription');
    expect(sub.body.status).toBe('grace');
    expect(sub.body.openInvoices).toHaveLength(1);
    const inv = sub.body.openInvoices[0];
    expect(inv.amount).toBe(35000);

    // Le cycle est idempotent : pas de seconde facture
    await billing.runCycle(new Date(end.getTime() + 2000));
    expect((await u.agent.get('/company/invoices')).body).toHaveLength(1);

    const payload = { event_id: 'evt-1', invoice_id: inv.id, reference: 'ref-1', amount: 35000, currency: 'XOF', status: 'succeeded' };
    expect((await webhook(app, payload, 'signature-invalide')).status).toBe(400);
    expect((await webhook(app, payload)).body.status).toBe('paid');
    expect((await webhook(app, payload)).body.status).toBe('duplicate');
    expect((await webhook(app, { ...payload, event_id: 'evt-2' })).body.status).toBe('duplicate_payment');

    sub = await u.agent.get('/company/subscription');
    expect(sub.body.status).toBe('active');
    expect(new Date(sub.body.currentPeriodStart).getTime()).toBe(end.getTime());
  });

  it("refuse un paiement dont le montant ne correspond pas à la facture", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    const inv = (await u.agent.get('/company/subscription')).body.openInvoices[0];
    const r = await webhook(app, { event_id: 'evt-low', invoice_id: inv.id, reference: 'ref-low', amount: 100, currency: 'XOF' });
    expect(r.body.status).toBe('amount_mismatch');
    expect((await u.agent.get('/company/subscription')).body.status).toBe('grace');
  });

  it("après la période de grâce : lecture seule, mais consultation, export et paiement restent possibles", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    await billing.runCycle(new Date(end.getTime() + 16 * DAY));
    const sub = await u.agent.get('/company/subscription');
    expect(sub.body.status).toBe('suspended');
    expect(sub.body.readOnly).toBe(true);

    const write = await u.agent.post('/company/roles').send({ name: 'Nouveau', permissions: [] });
    expect(write.status).toBe(423);
    expect(write.body.error.code).toBe('read_only');
    expect((await u.agent.get('/company/members')).status).toBe(200);
    const exp = await u.agent.get('/company/export');
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toBe('application/zip');

    const checkout = await u.agent.post(`/company/invoices/${sub.body.openInvoices[0].id}/checkout`).send({});
    expect(checkout.status).toBe(200);
    expect(checkout.body.checkoutUrl).toContain('paiement-test');
    await u.agent.post(`/dev/sandbox/pay/${sub.body.openInvoices[0].id}`);
    expect((await u.agent.get('/company/subscription')).body.status).toBe('active');
    expect((await u.agent.post('/company/roles').send({ name: 'Nouveau', permissions: [] })).status).toBe(201);
  });

  it("montée de gamme au prorata, appliquée au paiement", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    const first = (await u.agent.get('/company/subscription')).body.openInvoices[0];
    await u.agent.post(`/dev/sandbox/pay/${first.id}`);

    const change = await u.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    expect(change.body.applied).toBe('on_payment');
    expect(change.body.invoice.amount).toBeGreaterThan(0);
    expect(change.body.invoice.amount).toBeLessThanOrEqual(75000 - 35000);
    expect((await u.agent.get('/company/subscription')).body.plan.code).toBe('business');
    await u.agent.post(`/dev/sandbox/pay/${change.body.invoice.id}`);
    const after = await u.agent.get('/company/subscription');
    expect(after.body.plan.code).toBe('premium');
    expect(after.body.entitlements.modules).toContain('payroll');
  });

  it("descente de gamme programmée à l'échéance, sans suppression de données", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    await u.agent.post(`/dev/sandbox/pay/${(await u.agent.get('/company/subscription')).body.openInvoices[0].id}`);
    const change = await u.agent.post('/company/subscription/change').send({ planCode: 'starter', billingCycle: 'monthly' });
    expect(change.body.applied).toBe('at_period_end');
    const sub = await u.agent.get('/company/subscription');
    expect(sub.body.plan.code).toBe('business');
    expect(sub.body.pendingChange.plan_code).toBe('starter');

    // Facture de renouvellement à J-7 au prix de Starter, puis paiement : la formule change.
    const newEnd = new Date(sub.body.currentPeriodEnd);
    await billing.runCycle(new Date(newEnd.getTime() - 6 * DAY));
    const renewal = (await u.agent.get('/company/subscription')).body.openInvoices[0];
    expect(renewal.amount).toBe(15000);
    await u.agent.post(`/dev/sandbox/pay/${renewal.id}`);
    expect((await u.agent.get('/company/subscription')).body.plan.code).toBe('starter');
  });

  it("résiliation à l'échéance, puis archivage après 90 jours", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    await u.agent.post(`/dev/sandbox/pay/${(await u.agent.get('/company/subscription')).body.openInvoices[0].id}`);
    expect((await u.agent.post('/company/subscription/cancel')).status).toBe(200);
    const sub = await u.agent.get('/company/subscription');
    expect(sub.body.cancelAtPeriodEnd).toBe(true);
    const newEnd = new Date(sub.body.currentPeriodEnd);
    await billing.runCycle(new Date(newEnd.getTime() + 1000));
    expect((await u.agent.get('/company/subscription')).body.status).toBe('cancelled');
    await billing.runCycle(new Date(newEnd.getTime() + 91 * DAY));
    const c = await ownerClient();
    const r = await c.query('SELECT status FROM subscription WHERE company_id = $1', [u.companyId]);
    await c.end();
    expect(r.rows[0].status).toBe('archived');
  });

  it("rappels d'échéance envoyés une seule fois par jour concerné", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    const at = new Date(end.getTime() - 7 * DAY + 3600_000);
    await billing.runCycle(at);
    await billing.runCycle(at);
    const c = await ownerClient();
    const r = await c.query(`SELECT count(*)::int AS n FROM notification WHERE company_id = $1 AND type = 'billing_reminder'`, [u.companyId]);
    await c.end();
    expect(r.rows[0].n).toBe(1);
  });

  it("le gestionnaire de facturation enregistre un virement, la console sépare facturé, encaissé et récurrent", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    const inv = (await u.agent.get('/company/subscription')).body.openInvoices[0];
    const billingUser = await platformUser(app, 'billing');
    expect((await billingUser.agent.post(`/platform/invoices/${inv.id}/mark-paid`).send({ reference: 'VIR-2026-001' })).status).toBe(200);
    expect((await billingUser.agent.post(`/platform/invoices/${inv.id}/mark-paid`).send({ reference: 'VIR-2026-001' })).status).toBe(409);
    const m = await billingUser.agent.get('/platform/metrics');
    expect(m.body).toEqual(expect.objectContaining({ mrrEstimated: expect.any(Number), invoicedThisMonth: expect.any(Number), collectedThisMonth: expect.any(Number) }));
    expect(m.body.mrrEstimated).toBeGreaterThanOrEqual(35000);
    // Le client voit le paiement dans son propre journal
    const audit = await u.agent.get('/company/audit');
    expect(audit.body.some((a: any) => a.action === 'subscription.payment_received')).toBe(true);
  });
});
