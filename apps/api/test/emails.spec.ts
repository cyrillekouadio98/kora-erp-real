import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MailService } from '../src/modules/mail/mail.service';
import { createApp, ownerClient, resetDb, signup, uniqueEmail } from './helpers';

describe('E-mails : file d’envoi, invitations, mot de passe oublié, documents, relances', () => {
  let app: INestApplication;
  let mail: MailService;
  let owner: Awaited<ReturnType<typeof signup>>;
  let outbox: { to: string; subject: string; text: string; html: string; replyTo?: string }[] = [];
  let failing = false;
  const flush = async () => { outbox = []; await mail.processQueue(); return outbox; };
  const linkIn = (text: string, path: string) => new RegExp(`https?://[^\\s]+${path}\\?token=([^\\s]+)`).exec(text)?.[1];

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    mail = app.get(MailService);
    mail.useTransport(async (m) => { if (failing) throw new Error('serveur SMTP injoignable'); outbox.push(m); });
    owner = await signup(app, { companyName: 'Quincaillerie Moderne' });
  });
  afterAll(async () => { await app.close(); });

  it("envoie l'invitation par e-mail, au nom de l'entreprise", async () => {
    const roles = await owner.agent.get('/company/roles');
    const email = uniqueEmail('invite');
    const inv = await owner.agent.post('/company/invitations').send({ email, roleIds: [roles.body.find((r: any) => r.key === 'cashier').id] });
    expect(inv.body.emailQueued).toBe(true);
    const [m] = await flush();
    expect(m.to).toBe(email);
    expect(m.subject).toContain('Quincaillerie Moderne');
    expect(m.text).toContain('Caissier');
    expect(decodeURIComponent(linkIn(m.text, '/invitation')!)).toBe(decodeURIComponent(new URL(inv.body.inviteUrl).searchParams.get('token')!));
    expect(m.replyTo).toBe(owner.email);
    expect(m.html).toContain('Accepter l&#39;invitation');
    const list = (await owner.agent.get('/company/emails')).body;
    expect(list.mode).toBe('development');
    expect(list.messages[0]).toMatchObject({ to: email, status: 'sent', kind: 'invitation' });
  });

  it('réinitialise le mot de passe sans révéler si un compte existe', async () => {
    const unknown = await request(app.getHttpServer()).post('/auth/password-reset').send({ email: 'personne@test.ci' });
    expect(unknown.body).toEqual({ ok: true });
    expect(await flush()).toHaveLength(0);

    expect((await request(app.getHttpServer()).post('/auth/password-reset').send({ email: owner.email })).body).toEqual({ ok: true });
    const [m] = await flush();
    const token = linkIn(m.text, '/mot-de-passe')!;
    expect(token).toBeTruthy();
    const c = await ownerClient();
    try { expect((await c.query('SELECT token_hash FROM password_reset')).rows[0].token_hash).not.toBe(token); } finally { await c.end(); }

    expect((await request(app.getHttpServer()).post('/auth/password-reset/confirm').send({ token, password: 'court' })).status).toBe(400);
    expect((await request(app.getHttpServer()).post('/auth/password-reset/confirm').send({ token, password: 'NouveauMotDePasse2026' })).body).toEqual({ ok: true });
    expect((await owner.agent.get('/auth/me')).status).toBe(401); // toutes les sessions sont fermées
    expect((await request(app.getHttpServer()).post('/auth/password-reset/confirm').send({ token, password: 'EncoreUnAutre2026' })).body.error.code).toBe('invalid_reset_token');

    const agent = request.agent(app.getHttpServer());
    expect((await agent.post('/auth/login').send({ email: owner.email, password: 'NouveauMotDePasse2026' })).status).toBe(200);
    owner = { ...owner, agent };
  });

  it("envoie une facture au client avec un lien de consultation qui n'expose que le document", async () => {
    const customer = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Chantier Cocody', email: 'compta@chantier.ci' })).body.id;
    const inv = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: customer, lines: [{ description: 'Peinture 20 L', quantity: 2, unitPrice: 25000, vatRate: 18 }] });
    expect((await owner.agent.post(`/company/sales/documents/${inv.body.id}/send`).send({})).body.error.code).toBe('document_draft');
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/validate`);
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/reminders`).send({ channel: 'phone', note: 'Note interne confidentielle' });

    const sent = await owner.agent.post(`/company/sales/documents/${inv.body.id}/send`).send({ message: 'Merci pour votre confiance.' });
    expect(sent.body.sentTo).toBe('compta@chantier.ci');
    const [m] = await flush();
    expect(m.subject).toMatch(/^Facture FAC-\d{4}-00001 — Quincaillerie Moderne$/);
    expect(m.text).toMatch(/59\s000 FCFA TTC, à régler au plus tard le \d{2}\/\d{2}\/\d{4}\./);
    expect(m.text).toContain('Merci pour votre confiance.');

    const token = decodeURIComponent(linkIn(m.text, '/document')!);
    const pub = await request(app.getHttpServer()).get('/public/document').query({ token });
    expect(pub.body).toMatchObject({ type: 'invoice', totalTtc: 59000, company: { name: 'Quincaillerie Moderne' }, customer: { name: 'Chantier Cocody' } });
    expect(JSON.stringify(pub.body)).not.toContain('Note interne confidentielle');
    expect((await request(app.getHttpServer()).get('/public/document').query({ token: token.slice(0, -2) + 'xx' })).status).toBe(404);
    const c = await ownerClient();
    try { expect((await c.query('SELECT views FROM document_share')).rows[0].views).toBe(1); } finally { await c.end(); }
  });

  it('relance par e-mail et inscrit la relance dans l’historique', async () => {
    const noMail = (await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'Client sans e-mail' })).body.id;
    const inv = await owner.agent.post('/company/sales/documents').send({ type: 'invoice', contactId: noMail, lines: [{ description: 'Vis', quantity: 1, unitPrice: 1000, vatRate: 18 }] });
    await owner.agent.post(`/company/sales/documents/${inv.body.id}/validate`);
    const refused = await owner.agent.post(`/company/sales/documents/${inv.body.id}/reminders`).send({ channel: 'email', sendEmail: true, message: 'Bonjour' });
    expect(refused.body.error.code).toBe('no_email');
    const ok = await owner.agent.post(`/company/sales/documents/${inv.body.id}/reminders`).send({ channel: 'whatsapp', sendEmail: true, to: 'paiement@client.ci', message: 'Bonjour,\n\nMerci de régler la facture.' });
    expect(ok.body.reminders[0]).toMatchObject({ channel: 'email' });
    expect(ok.body.reminders[0].note).toContain('paiement@client.ci');
    const [m] = await flush();
    expect(m).toMatchObject({ to: 'paiement@client.ci' });
    expect(m.subject).toContain('Relance');
  });

  it('réessaie un envoi en échec, puis le marque en échec et permet de le renvoyer', async () => {
    failing = true;
    await owner.agent.post('/company/contacts').send({ kind: 'customer', name: 'x' });
    const roles = await owner.agent.get('/company/roles');
    await owner.agent.post('/company/invitations').send({ email: uniqueEmail('echec'), roleIds: [roles.body.find((r: any) => r.key === 'auditor').id] });
    const c = await ownerClient();
    try {
      for (let i = 0; i < 5; i++) {
        await mail.processQueue();
        // Avance l'horloge de la file (une seconde de marge : la base compte en microsecondes, Node en millisecondes).
        await c.query(`UPDATE email_message SET next_attempt_at = now() - interval '1 second' WHERE status = 'queued'`);
      }
    } finally { await c.end(); }
    const failed = (await owner.agent.get('/company/emails')).body.messages.find((x: any) => x.status === 'failed');
    expect(failed).toMatchObject({ attempts: 5, lastError: 'serveur SMTP injoignable' });
    failing = false;
    expect((await owner.agent.post(`/company/emails/${failed.id}/retry`)).status).toBe(200);
    expect((await flush())).toHaveLength(1);
    expect((await owner.agent.get('/company/emails')).body.messages.find((x: any) => x.id === failed.id).status).toBe('sent');
  });
});
