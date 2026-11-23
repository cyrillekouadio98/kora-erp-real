import { INestApplication } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodemailer = require('nodemailer'); // objet CommonJS : sa méthode peut être remplacée
import { createApp, ownerClient, platformUser, resetDb } from './helpers';
import { MailService } from '../src/modules/mail/mail.service';

/** Serveur d'envoi des e-mails réglé depuis la console éditeur. */
describe('Console éditeur : paramètres SMTP', () => {
  let app: INestApplication;
  let admin: Awaited<ReturnType<typeof platformUser>>;
  let support: Awaited<ReturnType<typeof platformUser>>;
  const sent: any[] = [];
  let verifyError: Error | null = null;
  const settings = { host: 'mail.systalink.com', port: 465, secure: true, username: 'no-reply@koraerp.ci', password: 'Secret#42', fromAddress: 'no-reply@koraerp.ci' };

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    admin = await platformUser(app, 'super_admin');
    support = await platformUser(app, 'support');
    // Aucun vrai serveur : nodemailer est remplacé (vérification de connexion et envoi).
    jest.spyOn(nodemailer, 'createTransport').mockImplementation(((opts: any) => ({
      verify: async () => { if (verifyError) throw verifyError; return true; },
      sendMail: async (m: any) => { sent.push({ opts, m }); return {}; },
    })) as any);
  });
  afterAll(async () => { jest.restoreAllMocks(); await app.close(); });

  it('est réservé au super administrateur', async () => {
    expect((await support.agent.get('/platform/mail-settings')).status).toBe(403);
    expect((await support.agent.put('/platform/mail-settings').send(settings)).status).toBe(403);
  });

  it("sans réglage, rien ne part et le test l'explique", async () => {
    expect((await admin.agent.get('/platform/mail-settings')).body).toMatchObject({ source: 'none', settings: null });
    expect((await admin.agent.post('/platform/mail-settings/test').send({ to: 'moi@exemple.ci' })).body.error.code).toBe('no_smtp');
  });

  it('refuse un serveur qui rejette la connexion, sans rien enregistrer', async () => {
    verifyError = new Error('Invalid login: 535 Authentication failed');
    const r = await admin.agent.put('/platform/mail-settings').send(settings);
    expect(r.body.error.code).toBe('smtp_verify_failed');
    expect(r.body.error.message).toContain('535 Authentication failed');
    expect((await admin.agent.get('/platform/mail-settings')).body.source).toBe('none');
    verifyError = null;
  });

  it('enregistre le mot de passe chiffré et ne le renvoie jamais', async () => {
    expect((await admin.agent.put('/platform/mail-settings').send(settings)).body).toEqual({ ok: true });
    const g = (await admin.agent.get('/platform/mail-settings')).body;
    expect(g).toMatchObject({ source: 'console', settings: { host: 'mail.systalink.com', port: 465, secure: true, username: 'no-reply@koraerp.ci', fromAddress: 'no-reply@koraerp.ci' } });
    expect(JSON.stringify(g)).not.toContain('Secret#42');
    const c = await ownerClient();
    const row = (await c.query('SELECT password_enc FROM platform_mail_settings')).rows[0];
    await c.end();
    expect(row.password_enc).not.toContain('Secret');
    // Modification sans retaper le mot de passe : l'ancien est conservé.
    const { password, ...rest } = settings;
    expect((await admin.agent.put('/platform/mail-settings').send({ ...rest, port: 587, secure: false })).body).toEqual({ ok: true });
  });

  it("envoie le test et la file avec ces réglages", async () => {
    sent.length = 0;
    expect((await admin.agent.post('/platform/mail-settings/test').send({ to: 'moi@exemple.ci' })).body).toMatchObject({ ok: true, from: 'no-reply@koraerp.ci' });
    expect(sent[0].opts).toMatchObject({ host: 'mail.systalink.com', port: 587, secure: false, requireTLS: true, auth: { user: 'no-reply@koraerp.ci', pass: 'Secret#42' } });
    expect(sent[0].m).toMatchObject({ to: 'moi@exemple.ci', from: '"Kora ERP" <no-reply@koraerp.ci>' });

    const c = await ownerClient();
    await c.query(`INSERT INTO email_message (to_address, from_name, subject, text_body, html_body, kind) VALUES ('client@exemple.ci', 'Société X', 'Facture', 't', 'h', 'document')`);
    await c.end();
    sent.length = 0;
    expect(await app.get(MailService).processQueue()).toMatchObject({ sent: 1 });
    expect(sent[0].m).toMatchObject({ to: 'client@exemple.ci', from: '"Société X" <no-reply@koraerp.ci>' });
    expect(app.get(MailService).mode).toBe('smtp');
  });

  it('revient au mode sans envoi après suppression', async () => {
    expect((await admin.agent.delete('/platform/mail-settings')).body).toEqual({ ok: true });
    expect((await admin.agent.get('/platform/mail-settings')).body.source).toBe('none');
  });
});
