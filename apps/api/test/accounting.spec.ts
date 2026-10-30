import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, today } from '../src/modules/sales/sales.service';
import { createApp, ownerClient, resetDb, signup, uniqueEmail } from './helpers';

/** Lignes d'une écriture réduites à « compte : débit/crédit » pour des comparaisons lisibles. */
const shape = (e: any) => e.lines.map((l: any) => `${l.account} ${l.debit ? `D ${l.debit}` : `C ${l.credit}`}`).sort();

describe('Comptabilité SYSCOHADA', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let customer: string;
  let supplier: string;
  let cash: string;
  let bank: string;
  const year = today().slice(0, 4);
  const entryOf = async (q: string) => (await owner.agent.get('/company/accounting/entries').query({ q })).body[0];

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    customer = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Client Comptable' })).body.id;
    supplier = (await owner.agent.post('/company/contacts').send({ kind: 'supplier', name: 'Fournisseur Comptable' })).body.id;
    const accounts = (await owner.agent.get('/company/treasury/accounts')).body;
    cash = accounts.find((a: any) => a.kind === 'cash').id;
    bank = accounts.find((a: any) => a.kind === 'bank').id;
  });
  afterAll(async () => { await app.close(); });

  it('installe le plan comptable SYSCOHADA et un sous-compte par compte de trésorerie', async () => {
    const accounts = (await owner.agent.get('/company/accounting/accounts')).body.map((a: any) => a.code);
    for (const c of ['101', '401', '411', '4431', '4452', '521', '552', '571', '585', '601', '6222', '701', '706', '5711', '5211', '5521']) expect(accounts).toContain(c);
    expect((await owner.agent.post('/company/accounting/accounts').send({ code: '6011', name: 'Achats de ciment' })).status).toBe(201);
    expect((await owner.agent.post('/company/accounting/accounts').send({ code: '999', name: 'Sans parent' })).body.error.code).toBe('no_parent_account');
  });

  it('comptabilise une facture de vente, son encaissement et un avoir', async () => {
    const svc = (await owner.agent.post('/company/products').send({ name: 'Installation', kind: 'service', salePrice: 50000, vatRate: 18 })).body.id;
    const inv = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [
      { description: 'Ciment', quantity: 10, unitPrice: 10000, vatRate: 18 }, { productId: svc, description: 'Installation', quantity: 1, unitPrice: 50000, vatRate: 18 },
    ] });
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/validate`);
    const vt = await entryOf(`FAC-${year}-00001`);
    expect(vt).toMatchObject({ journal: 'VT', number: `VT-${year}-00001`, status: 'posted', total: 177000 });
    expect(shape(vt)).toEqual(['411 D 177000', '4431 C 27000', '701 C 100000', '706 C 50000'].sort());

    await owner.agent.post(`/company/sales/documents/${inv.body.id}/payments`).send({ amount: 77000, method: 'cash' });
    expect(shape(await entryOf(`Encaissement FAC-${year}-00001`))).toEqual(['411 C 77000', '5711 D 77000']);

    const cn = await owner.agent.post(`/company/sales/documents/${inv.body.id}/credit-note`);
    await owner.agent.patch(`/company/sales/documents/${cn.body.id}`).send({ lines: [{ description: 'Retour ciment', quantity: 1, unitPrice: 10000, vatRate: 18 }] });
    await owner.agent.post(`/company/sales/documents/${cn.body.id}/validate`);
    expect(shape(await entryOf(`Avoir AV-${year}-00001`))).toEqual(['411 C 11800', '4431 D 1800', '701 D 10000'].sort());
  });

  it('comptabilise une facture fournisseur à la date du fournisseur et son règlement', async () => {
    const issued = addDays(today(), -3);
    const bill = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'FF-77', issueDate: issued,
      lines: [{ description: 'Marchandises', quantity: 2, unitPrice: 20000, vatRate: 18 }] });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/validate`);
    const ac = await entryOf('FF-77');
    expect(ac).toMatchObject({ journal: 'AC', date: issued });
    expect(shape(ac)).toEqual(['401 C 47200', '4452 D 7200', '601 D 40000'].sort());
    await owner.agent.patch(`/company/treasury/accounts/${bank}`).send({ openingBalance: 1_000_000, openingDate: addDays(today(), -30) });
    await owner.agent.post(`/company/purchases/documents/${bill.body.id}/payments`).send({ amount: 47200, method: 'bank_transfer' });
    expect(shape(await entryOf(`Règlement ACH-${year}-00001`))).toEqual(['401 D 47200', '5211 C 47200']);
  });

  it('comptabilise dépenses, virements internes (via 585) et écarts de caisse', async () => {
    await owner.agent.post('/company/treasury/movements').send({ kind: 'expense', accountId: cash, amount: 12000, category: 'electricity', label: 'Facture CIE' });
    expect(shape(await entryOf('Facture CIE'))).toEqual(['5711 C 12000', '6052 D 12000']);
    await owner.agent.post('/company/treasury/transfers').send({ fromAccountId: cash, toAccountId: bank, amount: 50000, label: 'Dépôt banque' });
    const legs = (await owner.agent.get('/company/accounting/entries').query({ q: 'Dépôt banque' })).body.map(shape).flat().sort();
    expect(legs).toEqual(['5211 D 50000', '5711 C 50000', '585 C 50000', '585 D 50000'].sort());
    await owner.agent.post(`/company/treasury/accounts/${cash}/count`).send({ counted: 14000 });
    expect(shape(await entryOf("Écart d'arrêté"))).toEqual(['5711 C 1000', '658 D 1000']);
  });

  it('produit une balance équilibrée, la TVA de la période et le résultat', async () => {
    const tb = (await owner.agent.get('/company/accounting/trial-balance')).body;
    expect(tb.balanced).toBe(true);
    const row = (code: string) => tb.accounts.find((a: any) => a.account === code);
    expect(row('411')).toMatchObject({ debit: 177000, credit: 88800, closingDebit: 88200 });
    expect(row('585')).toMatchObject({ closingDebit: 0, closingCredit: 0 });
    expect(row('5711')).toMatchObject({ closingDebit: 14000 });
    // Concordance : chaque compte de trésorerie a le même solde en trésorerie et en comptabilité (solde d'ouverture compris).
    for (const acc of (await owner.agent.get('/company/treasury/accounts')).body) {
      const r = row(acc.ledgerCode);
      expect({ name: acc.name, balance: r ? r.closingDebit - r.closingCredit : 0 }).toEqual({ name: acc.name, balance: acc.balance });
    }
    expect(row('471')).toMatchObject({ closingCredit: 1_000_000 }); // contrepartie du solde d'ouverture de la banque, à solder par le comptable

    const vat = (await owner.agent.get('/company/accounting/vat').query({ from: addDays(today(), -30), to: today() })).body;
    expect(vat).toMatchObject({ collected: 25200, deductible: 7200, due: 18000, credit: 0, revenueHt: 140000 });
    expect(vat.collectedByRate).toEqual([{ rate: 18, amount: 25200 }]);

    const is = (await owner.agent.get('/company/accounting/income-statement')).body;
    expect(is).toMatchObject({ income: 140000, charges: 40000 + 12000 + 1000, result: 87000 });
  });

  it("passe, valide et contre-passe une écriture d'OD ; refuse une écriture déséquilibrée", async () => {
    const unbalanced = await owner.agent.post('/company/accounting/entries').send({ date: today(), label: 'Essai', lines: [
      { account: '6222', label: 'Loyer', debit: 1000 }, { account: '401', label: 'Loyer', credit: 900 }] });
    expect((await owner.agent.post(`/company/accounting/entries/${unbalanced.body.id}/post`)).body.error.code).toBe('unbalanced_entry');
    await owner.agent.patch(`/company/accounting/entries/${unbalanced.body.id}`).send({ lines: [
      { account: '6011', label: 'Reclassement achats ciment', debit: 40000 }, { account: '601', label: 'Reclassement achats ciment', credit: 40000 }] });
    const posted = await owner.agent.post(`/company/accounting/entries/${unbalanced.body.id}/post`);
    expect(posted.body).toMatchObject({ status: 'posted', number: `OD-${year}-00001` });
    expect((await owner.agent.delete(`/company/accounting/entries/${posted.body.id}`)).body.error.code).toBe('entry_posted');

    const rev = await owner.agent.post(`/company/accounting/entries/${posted.body.id}/reverse`).send({ reason: 'reclassement inutile' });
    expect(rev.body).toMatchObject({ number: `OD-${year}-00002`, reversalOf: posted.body.id });
    expect(shape(rev.body)).toEqual(['601 D 40000', '6011 C 40000']);
    const auto = await entryOf('Facture CIE');
    expect((await owner.agent.post(`/company/accounting/entries/${auto.id}/reverse`).send({ reason: 'non' })).body.error.code).toBe('not_reversible');
  });

  it('la base garantit l’équilibre et l’intangibilité des écritures', async () => {
    const c = await ownerClient();
    const e = await c.query(`SELECT id, company_id FROM journal_entry WHERE status = 'posted' LIMIT 1`);
    await expect(c.query('UPDATE journal_line SET debit = debit + 1 WHERE entry_id = $1 AND debit > 0', [e.rows[0].id])).rejects.toThrow(/lignes non modifiables/);
    await expect(c.query('DELETE FROM journal_entry WHERE id = $1', [e.rows[0].id])).rejects.toThrow(/suppression interdite/);
    await c.query('BEGIN');
    await c.query(`INSERT INTO journal_entry (company_id, id, journal_code, number, date, label, status, source_type) VALUES ($1, gen_random_uuid(), 'OD', 'OD-TEST-1', current_date, 'Bancale', 'posted', 'manual')`, [e.rows[0].company_id]);
    await expect(c.query('COMMIT')).rejects.toThrow(/déséquilibrée/);
    await c.end();
  });

  it('clôture une période : plus aucune écriture avant la date de clôture', async () => {
    const yesterday = addDays(today(), -1);
    const draft = await owner.agent.post('/company/accounting/entries').send({ date: addDays(today(), -2), label: 'Brouillon oublié', lines: [
      { account: '6222', label: 'x', debit: 10 }, { account: '401', label: 'x', credit: 10 }] });
    expect((await owner.agent.post('/company/accounting/lock').send({ until: yesterday })).body.error.code).toBe('drafts_in_period');
    await owner.agent.delete(`/company/accounting/entries/${draft.body.id}`);
    expect((await owner.agent.post('/company/accounting/lock').send({ until: today() })).body.error.code).toBe('lock_in_future');
    expect((await owner.agent.post('/company/accounting/lock').send({ until: yesterday })).body).toEqual({ lockedUntil: yesterday });

    const late = await owner.agent.post('/company/purchases/documents').send({ type: 'invoice', contactId: supplier, supplierRef: 'FF-OLD', issueDate: addDays(today(), -5),
      lines: [{ description: 'Ancienne facture', quantity: 1, unitPrice: 1000, vatRate: 18 }] });
    const refused = await owner.agent.post(`/company/purchases/documents/${late.body.id}/validate`);
    expect(refused.body.error.code).toBe('period_locked');
    expect((await owner.agent.get(`/company/purchases/documents/${late.body.id}`)).body.status).toBe('draft'); // rien n'a été validé à moitié
    expect((await owner.agent.post('/company/accounting/lock').send({ until: addDays(today(), -10) })).body.error.code).toBe('already_locked');
  });

  it("comptabilise l'historique saisi avant la comptabilité, une seule fois", async () => {
    const c = await ownerClient();
    await c.query(`ALTER TABLE journal_entry DISABLE TRIGGER journal_entry_lock`);
    await c.query(`ALTER TABLE journal_line DISABLE TRIGGER journal_line_lock`);
    await c.query(`DELETE FROM journal_entry WHERE company_id = $1 AND source_type = 'treasury_movement' AND label = 'Facture CIE'`, [owner.companyId]);
    await c.query(`ALTER TABLE journal_entry ENABLE TRIGGER journal_entry_lock`);
    await c.query(`ALTER TABLE journal_line ENABLE TRIGGER journal_line_lock`);
    await c.query(`UPDATE company SET accounting_locked_until = NULL WHERE id = $1`, [owner.companyId]);
    await c.end();
    expect((await owner.agent.get('/company/accounting/status')).body.pending).toBe(1);
    expect((await owner.agent.post('/company/accounting/sync')).body).toEqual({ posted: 1 });
    expect((await owner.agent.post('/company/accounting/sync')).body).toEqual({ posted: 0 });
    expect((await owner.agent.get('/company/accounting/trial-balance')).body.balanced).toBe(true);
    const csv = await owner.agent.get('/company/accounting/entries/export');
    expect(csv.text.split('\r\n')[0]).toContain('JournalCode;JournalLib;EcritureNum;EcritureDate;CompteNum');
  });

  it('réserve la clôture et la contre-passation au propriétaire (permissions sensibles)', async () => {
    const roles = await owner.agent.get('/company/roles');
    const director = roles.body.find((r: any) => r.key === 'director');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('dg'), roleIds: [director.id] });
    const dg = request.agent(app.getHttpServer());
    await dg.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Directeur', password: 'MotDePasse123' });
    expect((await dg.get('/company/accounting/trial-balance')).status).toBe(200);
    expect((await dg.post('/company/accounting/lock').send({ until: addDays(today(), -1) })).status).toBe(403);
    expect((await dg.post('/company/accounting/entries').send({ date: today(), label: 'x', lines: [] })).status).toBe(403);
  });
});
