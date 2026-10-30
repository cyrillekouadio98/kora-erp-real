/**
 * Tests d'isolation multi-entreprises (dossier de conception §7.2).
 * Un utilisateur de l'entreprise A ne doit jamais lire, modifier ni deviner les données de B,
 * même en remplaçant les identifiants dans l'URL ou le corps des requêtes.
 */
import { INestApplication } from '@nestjs/common';
import { MODULE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { buildOpenApi } from '../src/bootstrap';
import { META } from '../src/common/decorators';
import { config } from '../src/config';
import { createApp, ownerClient, platformUser, resetDb, signup } from './helpers';

/** Routes liées au seul compte utilisateur (sans entreprise), revues une par une. */
const ACCOUNT_ROUTES = new Set([
  'POST /auth/mfa/verify', 'POST /auth/mfa/setup', 'POST /auth/mfa/enable', 'POST /auth/logout', 'GET /auth/me',
  'POST /auth/switch-company', 'POST /auth/password', 'GET /auth/sessions', 'DELETE /auth/sessions/:id', 'POST /companies',
]);

describe('Isolation des données entre entreprises', () => {
  let app: INestApplication;
  let A: Awaited<ReturnType<typeof signup>>;
  let B: Awaited<ReturnType<typeof signup>>;
  const bIds: Record<string, string> = {};
  let bSecrets: string[] = [];

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    A = await signup(app, { companyName: 'Entreprise Alpha' });
    B = await signup(app, { companyName: 'Entreprise Bêta' });

    // Données de B
    const role = await B.agent.post('/company/roles').send({ name: 'Rôle secret Bêta', permissions: ['contacts.read'] });
    const inv = await B.agent.post('/company/invitations').send({ email: 'invite.beta@test.ci', roleIds: [role.body.id] });
    const members = await B.agent.get('/company/members');
    const contact = await B.agent.post('/company/contacts').send({ kind: 'customer', name: 'Client secret Bêta', email: 'client.beta@test.ci' });
    const product = await B.agent.post('/company/products').send({ name: 'Article secret Bêta', salePrice: 1000, vatRate: 18 });
    const quote = await B.agent.post('/company/sales/documents').send({ type: 'quote', contactId: contact.body.id, lines: [{ productId: product.body.id, description: 'Ligne secrète Bêta', quantity: 1, unitPrice: 1000, vatRate: 18 }] });
    const invoice = await B.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: contact.body.id, lines: [{ description: 'Ligne secrète Bêta', quantity: 1, unitPrice: 5000, vatRate: 18 }] });
    await B.agent.post(`/company/sales/documents/${invoice.body.id}/validate`);
    await B.agent.post(`/company/sales/documents/${invoice.body.id}/payments`).send({ amount: 1000, method: 'cash', reference: 'PAIEMENT-SECRET-BETA' });
    await B.agent.post(`/company/sales/documents/${invoice.body.id}/reminders`).send({ channel: 'phone', note: 'RELANCE-SECRETE-BETA' });
    const creditNote = await B.agent.post(`/company/sales/documents/${invoice.body.id}/credit-note`);
    const supplier = await B.agent.post('/company/contacts').send({ kind: 'supplier', name: 'Fournisseur secret Bêta' });
    const order = await B.agent.post('/company/purchases/documents').send({ type: 'order', contactId: supplier.body.id, lines: [{ description: 'Achat secret Bêta', quantity: 1, unitPrice: 1000, vatRate: 18 }] });
    const bill = await B.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier.body.id, supplierRef: 'REF-SECRETE-BETA', lines: [{ description: 'Achat secret Bêta', quantity: 1, unitPrice: 9000, vatRate: 18 }] });
    await B.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
    await B.agent.post(`/company/purchases/documents/${bill.body.id}/payments`).send({ amount: 500, method: 'cash', reference: 'DECAISSEMENT-SECRET-BETA' });
    const accounts = await B.agent.get('/company/treasury/accounts');
    const bCash = accounts.body.find((a: any) => a.kind === 'cash');
    await B.agent.patch(`/company/treasury/accounts/${bCash.id}`).send({ name: 'Caisse secrète Bêta' });
    const expense = await B.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: bCash.id, amount: 100, category: 'fuel', label: 'Dépense secrète Bêta' });
    const od = await B.agent.post('/company/accounting/entries').send({ date: new Date().toISOString().slice(0, 10), label: 'Écriture secrète Bêta', lines: [
      { account: '6222', label: 'Ligne comptable secrète Bêta', debit: 100 }, { account: '401', label: 'Ligne comptable secrète Bêta', credit: 100 }] });
    await B.agent.post('/company/accounting/accounts').send({ code: '6229', name: 'Compte secret Bêta' });
    const sessions = await B.agent.get('/auth/sessions');
    const support = await platformUser(app, 'support');
    const grant = await support.agent.post('/platform/support-access').send({ companyId: B.companyId, reason: 'Diagnostic de test isolation', scope: ['users'] });
    for (const r of [contact, product, quote, invoice, creditNote, supplier, order, bill, expense, od]) if (r.status >= 300) throw new Error(`données de B : ${r.status} ${JSON.stringify(r.body)}`);
    expect((await B.agent.get(`/company/sales/documents/${invoice.body.id}`)).body).toMatchObject({ status: 'partially_paid', paidAmount: 1000 });
    const c = await ownerClient();
    const sub = await c.query('SELECT id FROM subscription WHERE company_id = $1', [B.companyId]);
    const invB = await c.query(`INSERT INTO platform_invoice (number, company_id, subscription_id, kind, status, currency, amount, lines, due_at)
      VALUES ('TEST-B-1', $1, $2, 'invoice', 'open', 'XOF', 35000, '[]', now()) RETURNING id`, [B.companyId, sub.rows[0].id]);
    await c.end();
    Object.assign(bIds, {
      company: B.companyId, role: role.body.id, invitation: inv.body.id, membership: members.body[0].id,
      session: sessions.body[0].id, grant: grant.body.id, invoice: invB.rows[0].id, contact: contact.body.id, product: product.body.id, quote: quote.body.id, salesInvoice: invoice.body.id, creditNote: creditNote.body.id, purchaseOrder: order.body.id, purchaseInvoice: bill.body.id, treasuryAccount: bCash.id, treasuryMovement: expense.body.id, journalEntry: od.body.id,
    });
    bSecrets = [...Object.values(bIds), B.email, 'Entreprise Bêta', 'Rôle secret Bêta', 'invite.beta@test.ci', 'Client secret Bêta', 'client.beta@test.ci', 'Article secret Bêta', 'Ligne secrète Bêta', 'PAIEMENT-SECRET-BETA', 'RELANCE-SECRETE-BETA', 'Fournisseur secret Bêta', 'Achat secret Bêta', 'REF-SECRETE-BETA', 'DECAISSEMENT-SECRET-BETA', 'Caisse secrète Bêta', 'Dépense secrète Bêta', 'Écriture secrète Bêta', 'Ligne comptable secrète Bêta', 'Compte secret Bêta'];
  });

  afterAll(async () => { await app.close(); });

  it("chaque route déclare explicitement son niveau d'accès", () => {
    const missing: string[] = [];
    const controllers: any[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule);
    for (const ctrl of controllers) {
      const base = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        const path = handler && Reflect.getMetadata(PATH_METADATA, handler);
        if (name === 'constructor' || path === undefined) continue;
        const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][Reflect.getMetadata(METHOD_METADATA, handler)] ?? '?';
        const route = `${method} /${[base, path].filter((p: string) => p && p !== '/').join('/')}`.replace(/\/+/g, '/');
        const declared = [META.public, META.platformRoles, META.permission].some((k) => Reflect.getMetadata(k, handler) !== undefined || Reflect.getMetadata(k, ctrl) !== undefined);
        if (!declared && !ACCOUNT_ROUTES.has(route)) missing.push(route);
      }
    }
    expect(missing).toEqual([]);
  });

  it("aucune route ne renvoie de données de B à un utilisateur de A, quels que soient les identifiants fournis", async () => {
    const doc = buildOpenApi(app);
    const leaks: string[] = [];
    const successes: string[] = [];
    const unauthenticated: string[] = [];
    let tested = 0;
    for (const [rawPath, ops] of Object.entries(doc.paths)) {
      if (rawPath.startsWith('/webhooks') || rawPath.startsWith('/dev')) continue;
      for (const method of Object.keys(ops as object)) {
        if (`${method} ${rawPath}` === 'post /auth/logout') continue; // testé à part : fermerait la session de A
        // Chaque paramètre est remplacé par chacun des identifiants de B
        const params = rawPath.match(/\{[^}]+\}/g) ?? [];
        const candidates = params.length ? Object.values(bIds) : [null];
        for (const id of candidates) {
          const path = params.reduce((p, prm) => p.replace(prm, id!), rawPath);
          const body = { companyId: B.companyId, company_id: B.companyId, id, roleIds: [bIds.role], email: 'x@test.ci', name: 'Test', permissions: [], reason: 'tentative inter-entreprises', scope: ['users'] };
          const res = await (A.agent as any)[method](path).send(body);
          const text = JSON.stringify(res.body ?? '') + (res.text ?? '');
          for (const s of bSecrets) if (text.includes(s)) leaks.push(`${method.toUpperCase()} ${path} → contient ${s}`);
          if (params.length && res.status < 300) successes.push(`${method.toUpperCase()} ${path} → ${res.status}`);
          if (res.status === 401) unauthenticated.push(`${method.toUpperCase()} ${path}`);
          tested++;
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(successes).toEqual([]);
    // La session de A est restée valide pendant tout le test : chaque appel a bien été évalué avec ses droits.
    expect(unauthenticated).toEqual([]);
    expect(tested).toBeGreaterThan(60);
  }, 120_000);

  it("A ne peut pas sélectionner l'entreprise B comme entreprise active", async () => {
    const res = await A.agent.post('/auth/switch-company').send({ companyId: B.companyId });
    expect(res.status).toBe(404);
    const ctx = await A.agent.get('/company/context');
    expect(ctx.body.company.id).toBe(A.companyId);
  });

  it("les données de B sont intactes après les tentatives de A", async () => {
    const roles = await B.agent.get('/company/roles');
    expect(roles.body.some((r: any) => r.id === bIds.role)).toBe(true);
    const company = await B.agent.get('/company');
    expect(company.body.name).toBe('Entreprise Bêta');
  });

  describe('au niveau de la base de données (RLS)', () => {
    let db: Client;
    beforeAll(async () => { db = new Client({ connectionString: config.db.appUrl }); await db.connect(); });
    afterAll(async () => { await db.end(); });

    const tenantTables = async () => {
      const c = await ownerClient();
      const r = await c.query(`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'company_id'`);
      await c.end();
      return r.rows.map((x) => x.table_name as string);
    };

    it('toute table portant company_id a la RLS activée et forcée', async () => {
      const c = await ownerClient();
      const r = await c.query(`SELECT c.relname FROM pg_class c JOIN information_schema.columns col ON col.table_name = c.relname AND col.column_name = 'company_id'
        WHERE c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`);
      await c.end();
      expect(r.rows).toEqual([]);
    });

    it("le rôle applicatif ne contourne pas la RLS", async () => {
      const r = await db.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`);
      expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    });

    it('sans contexte, le rôle applicatif ne voit aucune ligne métier ni aucun compte', async () => {
      for (const t of [...(await tenantTables()), 'user_account', 'user_session']) {
        const r = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect({ t, n: r.rows[0].n }).toEqual({ t, n: 0 });
      }
    });

    it("avec le contexte de A, aucune ligne de B n'est visible", async () => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)`, [A.companyId, A.userId]);
      for (const t of await tenantTables()) {
        const r = await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`, [B.companyId]);
        expect({ t, n: r.rows[0].n }).toEqual({ t, n: 0 });
      }
      const u = await db.query(`SELECT count(*)::int AS n FROM user_account WHERE email = $1`, [B.email]);
      expect(u.rows[0].n).toBe(0);
      await db.query('ROLLBACK');
    });

    it("avec le contexte de A, écrire une ligne pour B est refusé par la base", async () => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)`, [A.companyId, A.userId]);
      await expect(db.query(`INSERT INTO role (company_id, key, name) VALUES ($1, 'intrus', 'Intrus')`, [B.companyId])).rejects.toThrow(/row-level security/);
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)`, [A.companyId, A.userId]);
      const upd = await db.query(`UPDATE company SET name = 'Piratée' WHERE id = $1`, [B.companyId]);
      expect(upd.rowCount).toBe(0);
      await db.query('ROLLBACK');
    });

    it("une clé étrangère composite empêche de relier une adhésion de A à un rôle de B", async () => {
      const c = await ownerClient();
      const m = await c.query('SELECT id FROM company_membership WHERE company_id = $1 LIMIT 1', [A.companyId]);
      await expect(c.query('INSERT INTO membership_role (company_id, membership_id, role_id) VALUES ($1,$2,$3)', [A.companyId, m.rows[0].id, bIds.role]))
        .rejects.toThrow(/foreign key/);
      await c.end();
    });

    it("le rôle plateforme n'a aucun droit sur les rôles et invitations des entreprises", async () => {
      const p = new Client({ connectionString: config.db.platformUrl });
      await p.connect();
      await expect(p.query('SELECT * FROM role')).rejects.toThrow(/permission denied/);
      await expect(p.query('SELECT * FROM invitation')).rejects.toThrow(/permission denied/);
      const audit = await p.query('SELECT count(*)::int AS n FROM audit_log WHERE company_id IS NOT NULL');
      expect(audit.rows[0].n).toBe(0);
      await p.end();
    });
  });
});
