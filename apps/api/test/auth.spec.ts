import { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';
import { createApp, ownerClient, resetDb, signup, uniqueEmail } from './helpers';

/** Code TOTP d'un pas de temps décalé (0 = actuel, 1 = suivant, accepté grâce à la fenêtre de ±1 pas). */
const codeAt = (secret: string, offsetSteps: number) => authenticator.clone({ epoch: Date.now() + offsetSteps * 30_000 }).generate(secret);

describe('Authentification et sessions', () => {
  let app: INestApplication;
  beforeAll(async () => { await resetDb(); app = await createApp(); });
  afterAll(async () => { await app.close(); });

  /** Compte avec double authentification activée (le code d'activation consomme le pas actuel). */
  async function withMfa() {
    const u = await signup(app);
    const setup = await u.agent.post('/auth/mfa/setup');
    expect((await u.agent.post('/auth/mfa/enable').send({ code: codeAt(setup.body.secret, 0) })).status).toBe(200);
    return { u, secret: setup.body.secret as string };
  }

  it("l'inscription crée l'entreprise, le propriétaire et un essai gratuit", async () => {
    const u = await signup(app, { companyName: 'Pharmacie du Plateau' });
    const me = await u.agent.get('/auth/me');
    expect(me.body.companies).toEqual([expect.objectContaining({ name: 'Pharmacie du Plateau', isOwner: true })]);
    const sub = await u.agent.get('/company/subscription');
    expect(sub.body.status).toBe('trialing');
    const audit = await u.agent.get('/company/audit');
    expect(audit.body.map((a: any) => a.action)).toContain('company.created');
  });

  it("le journal n'inscrit que les champs réellement modifiés de la fiche entreprise", async () => {
    const u = await signup(app, { companyName: 'Quincaillerie Test' });
    const updated = async () => (await u.agent.get('/company/audit')).body.filter((a: any) => a.action === 'company.updated');
    expect((await u.agent.patch('/company').send({ name: 'Quincaillerie Test', legalForm: 'SARL', city: null })).status).toBe(200);
    const first = await updated();
    expect(first).toHaveLength(1);
    expect(Object.keys(first[0].data.changes)).toEqual(['legal_form']);
    // Un enregistrement sans changement n'ajoute rien au journal.
    await u.agent.patch('/company').send({ name: 'Quincaillerie Test', legalForm: 'SARL' });
    expect(await updated()).toHaveLength(1);
  });

  it("l'activité choisie à l'inscription (commerce, services) se retrouve dans le contexte et se modifie dans la fiche", async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/auth/signup').send({ fullName: 'Awa Koné', email: uniqueEmail('services'), password: 'MotDePasse123', companyName: 'Cabinet Conseil Awa', activity: 'services' });
    expect(res.status).toBe(201);
    expect((await agent.get('/company/context')).body.company.activity).toBe('services');
    expect((await agent.patch('/company').send({ activity: 'trade' })).body.activity).toBe('trade');
    expect((await agent.patch('/company').send({ activity: 'industrie' })).status).toBe(400);
    // Sans choix, l'entreprise fait les deux.
    const other = await signup(app);
    expect((await other.agent.get('/company/context')).body.company.activity).toBe('mixed');
  });

  it("refuse une adresse déjà utilisée et un mot de passe trop court", async () => {
    const u = await signup(app);
    const dup = await request(app.getHttpServer()).post('/auth/signup').send({ fullName: 'X Y', email: u.email, password: 'MotDePasse123', companyName: 'Autre' });
    expect(dup.status).toBe(409);
    const short = await request(app.getHttpServer()).post('/auth/signup').send({ fullName: 'X Y', email: uniqueEmail(), password: 'court', companyName: 'Autre' });
    expect(short.status).toBe(400);
    expect(short.body.error.details[0].field).toBe('password');
  });

  it("verrouille le compte après 5 échecs, avec un message identique pour un e-mail inconnu", async () => {
    const u = await signup(app);
    const http = request(app.getHttpServer());
    const unknown = await http.post('/auth/login').send({ email: 'inconnu@test.ci', password: 'xxxxxxxxxx' });
    const wrong = await http.post('/auth/login').send({ email: u.email, password: 'mauvais-mdp' });
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    for (let i = 0; i < 4; i++) await http.post('/auth/login').send({ email: u.email, password: 'mauvais-mdp' });
    const lockedRes = await http.post('/auth/login').send({ email: u.email, password: 'MotDePasse123' });
    expect(lockedRes.status).toBe(423);
  });

  it("la double authentification est exigée une fois activée", async () => {
    const u = await signup(app);
    const setup = await u.agent.post('/auth/mfa/setup');
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\//);
    // QR code généré localement, en SVG, prêt à être affiché.
    expect(setup.body.qrCode).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(setup.body.qrCode.split(',')[1], 'base64').toString()).toContain('<svg');
    expect((await u.agent.post('/auth/mfa/enable').send({ code: '000000' })).status).toBe(401);
    const enableCode = authenticator.generate(setup.body.secret);
    expect((await u.agent.post('/auth/mfa/enable').send({ code: enableCode })).status).toBe(200);

    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/auth/login').send({ email: u.email, password: 'MotDePasse123' });
    expect(login.body.mfaRequired).toBe(true);
    expect((await agent.get('/company/context')).body.error.code).toBe('mfa_required');
    // Le code déjà utilisé pour l'activation ne peut pas être rejoué ; le suivant est accepté.
    expect((await agent.post('/auth/mfa/verify').send({ code: enableCode })).status).toBe(401);
    expect((await agent.post('/auth/mfa/verify').send({ code: codeAt(setup.body.secret, 1) })).status).toBe(200);
    expect((await agent.get('/company/context')).status).toBe(200);
  });

  it("les codes de double authentification erronés comptent dans le verrouillage, même en se reconnectant", async () => {
    const { u, secret } = await withMfa();
    const agent = request.agent(app.getHttpServer());
    await agent.post('/auth/login').send({ email: u.email, password: 'MotDePasse123' });
    for (let i = 0; i < 3; i++) expect((await agent.post('/auth/mfa/verify').send({ code: '000000' })).status).toBe(401);
    // Se reconnecter avec le bon mot de passe ne remet pas le compteur à zéro.
    await agent.post('/auth/login').send({ email: u.email, password: 'MotDePasse123' });
    for (let i = 0; i < 2; i++) expect((await agent.post('/auth/mfa/verify').send({ code: '000000' })).status).toBe(401);
    expect((await agent.post('/auth/mfa/verify').send({ code: codeAt(secret, 1) })).status).toBe(423);
    expect((await agent.get('/company/context')).body.error.code).toBe('mfa_required');
  });

  it("un code erroné saisi à la connexion compte aussi comme un échec", async () => {
    const { u, secret } = await withMfa();
    const http = request(app.getHttpServer());
    for (let i = 0; i < 5; i++) expect((await http.post('/auth/login').send({ email: u.email, password: 'MotDePasse123', code: '000000' })).status).toBe(401);
    expect((await http.post('/auth/login').send({ email: u.email, password: 'MotDePasse123', code: codeAt(secret, 1) })).status).toBe(423);
  });

  it("un code accepté à la connexion ne peut pas être réutilisé", async () => {
    const { u, secret } = await withMfa();
    const http = request(app.getHttpServer());
    const code = codeAt(secret, 1);
    expect((await http.post('/auth/login').send({ email: u.email, password: 'MotDePasse123', code })).body.mfaRequired).toBe(false);
    expect((await http.post('/auth/login').send({ email: u.email, password: 'MotDePasse123', code })).status).toBe(401);
  });

  it("une session révoquée ou déconnectée ne donne plus accès", async () => {
    const u = await signup(app);
    const second = request.agent(app.getHttpServer());
    await second.post('/auth/login').send({ email: u.email, password: 'MotDePasse123' });
    const sessions = await u.agent.get('/auth/sessions');
    expect(sessions.body).toHaveLength(2);
    const other = sessions.body.find((s: any) => !s.current);
    expect((await u.agent.delete(`/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await second.get('/auth/me')).status).toBe(401);
    await u.agent.post('/auth/logout');
    expect((await u.agent.get('/auth/me')).status).toBe(401);
  });

  it("changer de mot de passe ferme les autres sessions", async () => {
    const u = await signup(app);
    const second = request.agent(app.getHttpServer());
    await second.post('/auth/login').send({ email: u.email, password: 'MotDePasse123' });
    expect((await u.agent.post('/auth/password').send({ currentPassword: 'MotDePasse123', newPassword: 'NouveauMotDePasse1' })).status).toBe(200);
    expect((await second.get('/auth/me')).status).toBe(401);
    expect((await u.agent.get('/auth/me')).status).toBe(200);
  });

  it("un utilisateur peut changer d'entreprise active sans se reconnecter", async () => {
    const u = await signup(app, { companyName: 'Première' });
    const created = await u.agent.post('/companies').send({ name: 'Seconde' });
    expect(created.status).toBe(201);
    await u.agent.post('/auth/switch-company').send({ companyId: created.body.companyId });
    expect((await u.agent.get('/company/context')).body.company.name).toBe('Seconde');
    await u.agent.post('/auth/switch-company').send({ companyId: u.companyId });
    expect((await u.agent.get('/company/context')).body.company.name).toBe('Première');
  });

  it("les mots de passe sont hachés avec Argon2id et le secret TOTP chiffré", async () => {
    const u = await signup(app);
    await u.agent.post('/auth/mfa/setup');
    const c = await ownerClient();
    const r = await c.query('SELECT password_hash, totp_secret_enc FROM user_account WHERE email = $1', [u.email]);
    await c.end();
    expect(r.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(r.rows[0].totp_secret_enc.split('.')).toHaveLength(3);
  });
});
