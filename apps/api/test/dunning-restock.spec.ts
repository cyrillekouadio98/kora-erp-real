import { INestApplication } from '@nestjs/common';
import { createApp, ownerClient, platformUser, resetDb, signup, TIERS } from './helpers';
import { MailService } from '../src/modules/mail/mail.service';
import { DunningService } from '../src/modules/sales/dunning.service';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Relances automatiques et réapprovisionnement (fonctionnalités activées à la demande). */
describe('Relances automatiques et réapprovisionnement', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let sales: Awaited<ReturnType<typeof platformUser>>;
  let customer: string, noMail: string, supplier: string, rice: string, oil: string;
  const outbox: any[] = [];
  // Une facture validée prend la date du jour : l'échéance est reculée en base pour simuler le retard.
  const invoice = async (contactId: string, issue: number, terms: number, amount: number) => {
    const d = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId, lines: [{ description: 'Marchandise', quantity: 1, unitPrice: amount, vatRate: 0 }] });
    expect((await owner.agent.post(`/company/sales/documents/${d.body.id}/validate`)).status).toBe(200);
    const c = await ownerClient();
    await c.query('ALTER TABLE sales_document DISABLE TRIGGER sales_document_lock');
    await c.query('UPDATE sales_document SET issue_date = $2, due_date = $3 WHERE id = $1', [d.body.id, day(issue), day(issue + terms)]);
    await c.query('ALTER TABLE sales_document ENABLE TRIGGER sales_document_lock');
    await c.end();
    return d.body.id as string;
  };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    app.get(MailService).useTransport(async (m) => { outbox.push(m); });
    owner = await signup(app);
    sales = await platformUser(app, 'sales_admin');
    customer = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'customer', name: 'Supermarché Bon Prix', email: 'compta@bonprix.ci' })).body.id;
    noMail = (await owner.agent.post('/company/contacts').send({ kind: 'customer', legalType: 'individual', name: 'M. Yao', phone: '+225 07 00 00 00 01' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ ...TIERS, kind: 'supplier', name: 'Provenderie du Sud' })).body.id;
  });
  afterAll(async () => { await app.close(); });

  it('relance chaque facture à l’étape atteinte, une seule fois', async () => {
    expect((await owner.agent.get('/company/dunning')).body.error.code).toBe('feature_not_enabled');
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/auto_reminders`).send({ enabled: true });
    const late20 = await invoice(customer, -30, 10, 100_000);   // échue depuis 20 jours : étape 2 (15 j)
    const late5 = await invoice(customer, -10, 5, 50_000);      // échue depuis 5 jours : étape 1 (3 j)
    const recent = await invoice(customer, -2, 1, 10_000);      // 1 jour de retard : rien
    await invoice(noMail, -30, 10, 20_000);                     // pas d'e-mail : rien
    const promised = await invoice(customer, -30, 10, 30_000);
    await owner.agent.post(`/company/sales/documents/${promised}/reminders`).send({ channel: 'phone', note: 'Paiera vendredi', promisedOn: day(3) });

    const g = (await owner.agent.get('/company/dunning')).body;
    expect(g).toMatchObject({ enabled: false, configured: false });
    const by = Object.fromEntries(g.preview.map((p: any) => [p.id, p]));
    expect(by[late20]).toMatchObject({ step: 2, skip: null });
    expect(by[late5]).toMatchObject({ step: 1, skip: null });
    expect(by[recent].skip).toBe('pas encore au premier palier');
    expect(by[promised].skip).toMatch(/^paiement promis/);
    expect((await owner.agent.post('/company/dunning/run')).body.error.code).toBe('dunning_disabled');

    expect((await owner.agent.put('/company/dunning').send({ enabled: true, copyTo: 'gerant@exemple.ci', steps: g.defaults })).body).toEqual({ ok: true });
    expect((await owner.agent.post('/company/dunning/run')).body).toEqual({ sent: 2 });
    await app.get(MailService).processQueue();
    expect(outbox.map((m) => m.subject).sort()).toEqual(['Deuxième relance — facture ' + by[late20].number, 'Deuxième relance — facture ' + by[late20].number, 'Rappel — facture ' + by[late5].number, 'Rappel — facture ' + by[late5].number].sort());
    expect(outbox.find((m) => m.to === 'compta@bonprix.ci').text).toContain('Bonjour Supermarché Bon Prix');
    // Relances notées sur les factures, et pas renvoyées.
    expect((await owner.agent.get(`/company/sales/documents/${late20}`)).body.reminders[0].note).toMatch(/^Relance automatique n° 2/);
    expect((await owner.agent.post('/company/dunning/run')).body).toEqual({ sent: 0 });
    // La tournée planifiée ne repasse pas le même jour.
    expect(await app.get(DunningService).runAll()).toMatchObject({ sent: 0 });
  });

  it('regroupe les articles à commander par fournisseur habituel', async () => {
    rice = (await owner.agent.post('/company/products').send({ name: 'Riz 25 kg', salePrice: 18000, purchasePrice: 15000, vatRate: 9, unit: 'sac' })).body.id;
    oil = (await owner.agent.post('/company/products').send({ name: 'Huile 5 L', salePrice: 7000, purchasePrice: 6000, vatRate: 18, unit: 'bidon' })).body.id;
    await owner.agent.get('/company/stock/warehouses');
    const bill = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'PS-9', lines: [{ productId: rice, description: 'Riz', quantity: 4, unitPrice: 14500, vatRate: 9 }] });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
    await owner.agent.patch(`/company/stock/${rice}`).send({ minStock: 10 });
    await owner.agent.patch(`/company/stock/${oil}`).send({ minStock: 5 });
    expect((await owner.agent.get('/company/stock/restock')).body.error.code).toBe('feature_not_enabled');
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/restock`).send({ enabled: true });
    const r = (await owner.agent.get('/company/stock/restock')).body;
    const byId = Object.fromEntries(r.items.map((i: any) => [i.id, i]));
    expect(byId[rice]).toMatchObject({ supplierId: supplier, supplier: 'Provenderie du Sud', unitPrice: 14500, quantity: 4, suggested: 16 });
    expect(byId[oil]).toMatchObject({ supplierId: null, unitPrice: 6000 });
    expect(r.suppliers.map((s: any) => s.name)).toContain('Provenderie du Sud');
  });
});
