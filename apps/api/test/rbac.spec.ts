import { Controller, Get, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Permission } from '../src/common/decorators';
import { createApp, resetDb, signup, uniqueEmail } from './helpers';

/** Route factice d'un module non inclus dans la formule d'essai (paie). */
@Controller('test-module')
class PayrollProbeController {
  @Permission('payroll.read') @Get('payroll') payroll() { return { ok: true }; }
  @Permission('sales.read') @Get('sales') sales() { return { ok: true }; }
}

async function invite(app: INestApplication, owner: any, roleKey: string) {
  const roles = await owner.agent.get('/company/roles');
  const role = roles.body.find((r: any) => r.key === roleKey);
  const email = uniqueEmail(roleKey);
  const inv = await owner.agent.post('/company/invitations').send({ email, roleIds: [role.id] });
  expect(inv.status).toBe(201);
  const token = new URL(inv.body.inviteUrl).searchParams.get('token');
  const agent = request.agent(app.getHttpServer());
  const acc = await agent.post('/invitations/accept').send({ token, fullName: `Invité ${roleKey}`, password: 'MotDePasse123' });
  expect(acc.status).toBe(201);
  return { agent, email, token };
}

describe('Rôles, permissions et quotas', () => {
  let app: INestApplication;
  beforeAll(async () => { await resetDb(); app = await createApp([PayrollProbeController]); });
  afterAll(async () => { await app.close(); });

  it("un caissier invité n'accède qu'à ses modules", async () => {
    const owner = await signup(app);
    const cashier = await invite(app, owner, 'cashier');
    expect((await cashier.agent.get('/test-module/sales')).status).toBe(200);
    expect((await cashier.agent.get('/company/members')).status).toBe(403);
    expect((await cashier.agent.patch('/company').send({ name: 'Piratage' })).status).toBe(403);
  });

  it("un module absent de la formule renvoie 402, même pour le propriétaire", async () => {
    const owner = await signup(app);
    const r = await owner.agent.get('/test-module/payroll');
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('module_not_in_plan');
  });

  it("une invitation ne peut être utilisée qu'une fois", async () => {
    const owner = await signup(app);
    const { token } = await invite(app, owner, 'sales_rep');
    const again = await request(app.getHttpServer()).post('/invitations/accept').send({ token, fullName: 'Autre', password: 'MotDePasse123' });
    expect(again.status).toBe(404);
  });

  it("le quota d'utilisateurs compte les invitations en attente et bloque la création, sans rien supprimer", async () => {
    const owner = await signup(app); // essai Business : 5 utilisateurs
    const roles = await owner.agent.get('/company/roles');
    const role = roles.body.find((r: any) => r.key === 'sales_rep');
    for (let i = 0; i < 4; i++) expect((await owner.agent.post('/company/invitations').send({ email: uniqueEmail('q'), roleIds: [role.id] })).status).toBe(201);
    const over = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('q'), roleIds: [role.id] });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('quota_users');
    expect((await owner.agent.get('/company/invitations')).body).toHaveLength(4);
  });

  it("seul un propriétaire attribue des permissions sensibles", async () => {
    const owner = await signup(app);
    const roles = await owner.agent.get('/company/roles');
    const adminRole = await owner.agent.post('/company/roles').send({ name: 'Administrateur délégué', permissions: ['users.read', 'users.admin'] });
    const admin = await invite(app, owner, 'cashier');
    const members = await owner.agent.get('/company/members');
    const adminMember = members.body.find((m: any) => m.email === admin.email);
    expect((await owner.agent.patch(`/company/members/${adminMember.id}`).send({ roleIds: [adminRole.body.id] })).status).toBe(200);

    const sensitive = await admin.agent.post('/company/roles').send({ name: 'Paie cachée', permissions: ['payroll.salaries'] });
    expect(sensitive.status).toBe(403);
    const payrollRole = roles.body.find((r: any) => r.key === 'payroll_manager');
    const self = members.body.find((m: any) => m.isOwner);
    expect((await admin.agent.patch(`/company/members/${self.id}`).send({ status: 'disabled' })).status).toBe(403);
    const ownerRoleAttempt = await admin.agent.post('/company/invitations').send({ email: uniqueEmail(), roleIds: [payrollRole.id] });
    expect(ownerRoleAttempt.status).toBe(403);
  });

  it("protège contre le verrouillage : pas d'auto-désactivation ni de suppression du dernier propriétaire", async () => {
    const owner = await signup(app);
    const members = await owner.agent.get('/company/members');
    const me = members.body[0];
    expect((await owner.agent.patch(`/company/members/${me.id}`).send({ status: 'disabled' })).status).toBe(403);
    const roles = await owner.agent.get('/company/roles');
    const ownerRole = roles.body.find((r: any) => r.key === 'owner');
    expect((await owner.agent.patch(`/company/roles/${ownerRole.id}`).send({ permissions: ['contacts.read'] })).status).toBe(403);
    expect((await owner.agent.delete(`/company/roles/${ownerRole.id}`)).status).toBe(403);
  });

  it("désactiver un membre lui retire immédiatement l'accès à l'entreprise", async () => {
    const owner = await signup(app);
    const rep = await invite(app, owner, 'sales_rep');
    expect((await rep.agent.get('/test-module/sales')).status).toBe(200);
    const members = await owner.agent.get('/company/members');
    const m = members.body.find((x: any) => x.email === rep.email);
    expect((await owner.agent.patch(`/company/members/${m.id}`).send({ status: 'disabled' })).status).toBe(200);
    expect((await rep.agent.get('/test-module/sales')).status).toBeGreaterThanOrEqual(400);
    const audit = await owner.agent.get('/company/audit');
    expect(audit.body.some((a: any) => a.action === 'member.updated' && a.entityId === m.id)).toBe(true);
  });

  it("un accès limité dans le temps expire", async () => {
    const owner = await signup(app);
    const aud = await invite(app, owner, 'auditor');
    const members = await owner.agent.get('/company/members');
    const m = members.body.find((x: any) => x.email === aud.email);
    await owner.agent.patch(`/company/members/${m.id}`).send({ validUntil: '2020-01-01' });
    expect((await aud.agent.get('/company/context')).status).toBe(403);
  });
});
