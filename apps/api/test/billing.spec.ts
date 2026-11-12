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

    // L'argent reçu est conservé comme « non affecté », signalé, et jamais compté comme encaissé.
    const c = await ownerClient();
    const pay = await c.query(`SELECT status, unapplied_reason FROM platform_payment WHERE provider_ref = 'ref-low'`);
    const notif = await c.query(`SELECT count(*)::int AS n FROM notification WHERE company_id = $1 AND type = 'payment_unapplied'`, [u.companyId]);
    await c.end();
    expect(pay.rows[0]).toEqual({ status: 'unapplied', unapplied_reason: 'amount_mismatch' });
    expect(notif.rows[0].n).toBe(1);
    const billingUser = await platformUser(app, 'billing');
    const list = await billingUser.agent.get('/platform/payments/unapplied');
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ providerRef: 'ref-low', amount: 100, reason: 'amount_mismatch', invoiceAmount: 35000 })]));
    const m = await billingUser.agent.get('/platform/metrics');
    expect(m.body.unappliedPayments.count).toBeGreaterThanOrEqual(1);

    // Le bon montant règle ensuite la facture normalement.
    expect((await webhook(app, { event_id: 'evt-ok', invoice_id: inv.id, reference: 'ref-ok', amount: 35000, currency: 'XOF' })).body.status).toBe('paid');
    // Un second paiement sur une facture déjà réglée est lui aussi conservé et signalé.
    expect((await webhook(app, { event_id: 'evt-twice', invoice_id: inv.id, reference: 'ref-twice', amount: 35000, currency: 'XOF' })).body.status).toBe('invoice_not_open');
    const c2 = await ownerClient();
    const twice = await c2.query(`SELECT status, unapplied_reason FROM platform_payment WHERE provider_ref = 'ref-twice'`);
    await c2.end();
    expect(twice.rows[0]).toEqual({ status: 'unapplied', unapplied_reason: 'invoice_not_open' });
  });

  it("descente programmée après l'émission du renouvellement : la facture est réémise au prix de la nouvelle formule", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    await u.agent.post(`/dev/sandbox/pay/${(await u.agent.get('/company/subscription')).body.openInvoices[0].id}`);
    const newEnd = await periodEnd(u.companyId);

    // Renouvellement émis à J-7 au prix de Business…
    await billing.runCycle(new Date(newEnd.getTime() - 6 * DAY));
    const old = (await u.agent.get('/company/subscription')).body.openInvoices;
    expect(old.map((i: any) => i.amount)).toEqual([35000]);

    // …puis descente vers Starter : l'ancienne facture est annulée et remplacée.
    expect((await u.agent.post('/company/subscription/change').send({ planCode: 'starter', billingCycle: 'monthly' })).body.applied).toBe('at_period_end');
    await billing.runCycle(new Date(newEnd.getTime() - 6 * DAY + 1000));
    const sub = (await u.agent.get('/company/subscription')).body;
    expect(sub.openInvoices.map((i: any) => i.amount)).toEqual([15000]);
    const invoices = (await u.agent.get('/company/invoices')).body;
    expect(invoices.find((i: any) => i.id === old[0].id).status).toBe('void');

    await u.agent.post(`/dev/sandbox/pay/${sub.openInvoices[0].id}`);
    const after = (await u.agent.get('/company/subscription')).body;
    expect(after.plan.code).toBe('starter');
    expect(after.pendingChange).toBeNull();
  });

  it("une montée de gamme réglée annule la descente programmée auparavant", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    await u.agent.post(`/dev/sandbox/pay/${(await u.agent.get('/company/subscription')).body.openInvoices[0].id}`);

    await u.agent.post('/company/subscription/change').send({ planCode: 'starter', billingCycle: 'monthly' });
    expect((await u.agent.get('/company/subscription')).body.pendingChange.plan_code).toBe('starter');
    const up = await u.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    expect(up.body.applied).toBe('on_payment');
    await u.agent.post(`/dev/sandbox/pay/${up.body.invoice.id}`);
    let sub = (await u.agent.get('/company/subscription')).body;
    expect(sub.plan.code).toBe('premium');
    expect(sub.pendingChange).toBeNull();

    // Le renouvellement suivant est facturé, puis appliqué, en Premium.
    await billing.runCycle(new Date(new Date(sub.currentPeriodEnd).getTime() - 6 * DAY));
    sub = (await u.agent.get('/company/subscription')).body;
    expect(sub.openInvoices.map((i: any) => i.amount)).toEqual([75000]);
    await u.agent.post(`/dev/sandbox/pay/${sub.openInvoices[0].id}`);
    expect((await u.agent.get('/company/subscription')).body.plan.code).toBe('premium');
  });

  it("revenir à la formule actuelle annule la descente programmée et réémet le renouvellement", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    await u.agent.post(`/dev/sandbox/pay/${(await u.agent.get('/company/subscription')).body.openInvoices[0].id}`);
    const newEnd = await periodEnd(u.companyId);
    await u.agent.post('/company/subscription/change').send({ planCode: 'starter', billingCycle: 'monthly' });
    await billing.runCycle(new Date(newEnd.getTime() - 6 * DAY));
    expect((await u.agent.get('/company/subscription')).body.openInvoices.map((i: any) => i.amount)).toEqual([15000]);

    const keep = await u.agent.post('/company/subscription/change').send({ planCode: 'business', billingCycle: 'monthly' });
    expect(keep.body.applied).toBe('immediately');
    await billing.runCycle(new Date(newEnd.getTime() - 6 * DAY + 1000));
    const sub = (await u.agent.get('/company/subscription')).body;
    expect(sub.pendingChange).toBeNull();
    expect(sub.openInvoices.map((i: any) => i.amount)).toEqual([35000]);
    // Sans descente en attente, choisir la formule actuelle reste refusé.
    expect((await u.agent.post('/company/subscription/change').send({ planCode: 'business', billingCycle: 'monthly' })).body.error.code).toBe('same_plan');
  });

  it("une résiliation programmée annule la facture de renouvellement déjà émise", async () => {
    const u = await signup(app);
    const end = await periodEnd(u.companyId);
    await billing.runCycle(new Date(end.getTime() + 1000));
    await u.agent.post(`/dev/sandbox/pay/${(await u.agent.get('/company/subscription')).body.openInvoices[0].id}`);
    const newEnd = await periodEnd(u.companyId);
    await billing.runCycle(new Date(newEnd.getTime() - 6 * DAY));
    expect((await u.agent.get('/company/subscription')).body.openInvoices).toHaveLength(1);
    await u.agent.post('/company/subscription/cancel');
    expect((await u.agent.get('/company/subscription')).body.openInvoices).toHaveLength(0);
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

  it("un seul cycle de facturation à la fois, même avec plusieurs instances", async () => {
    // Une autre instance tient le verrou : le cycle est sauté sans rien faire.
    const other = await ownerClient();
    await other.query(`SELECT pg_advisory_lock(hashtext('kora:billing-cycle'))`);
    try {
      expect(await billing.runCycle()).toEqual({ skipped: true });
    } finally {
      await other.query(`SELECT pg_advisory_unlock(hashtext('kora:billing-cycle'))`);
      await other.end();
    }
    // Verrou libéré (y compris après un cycle) : les suivants s'exécutent.
    expect((await billing.runCycle()).skipped).toBe(false);
    expect((await billing.runCycle()).skipped).toBe(false);
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
