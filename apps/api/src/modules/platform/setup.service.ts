import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { config } from '../../config';
import { randomToken, sha256 } from '../../common/crypto';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { AuthInfo, TenantInfo } from '../../common/request-context';
import { DatabaseService, setTenantContext, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../billing/entitlement.service';
import { logoDataUrl, saveLogo } from '../companies/company-logo';
import { NewCompany, ProvisioningService } from '../companies/provisioning.service';
import { MailService } from '../mail/mail.service';
import { DEFAULT_ROLES } from '../rbac/permissions';
import { NewSite, SitesService } from '../sites/sites.service';
import { TreasuryService } from '../treasury/treasury.service';

/** Validité des invitations envoyées à la remise : le client a le temps de s'organiser. */
const HANDOVER_INVITE_DAYS = 30;
const COMPANY_COLUMNS = { name: 'name', legalForm: 'legal_form', rccm: 'rccm', taxId: 'tax_id', taxRegime: 'tax_regime', address: 'address', city: 'city', phone: 'phone', email: 'email' } as const;

export interface PlannedUser { name: string; email: string; roleKey: string; siteIds: string[] | null }
export interface PeopleInput { owner: { name: string; email: string } | null; users: PlannedUser[]; notes?: string | null }
export type CompanyInput = Partial<Record<keyof typeof COMPANY_COLUMNS, string | null>>;

/**
 * Préparation d'une entreprise par l'équipe de l'éditeur : fiche, formule, sites, comptes de trésorerie
 * et utilisateurs prévus, puis remise au client (invitations). L'équipe n'est jamais membre de l'entreprise :
 * elle agit en son nom (journal d'audit « plateforme ») tant que l'entreprise n'est pas remise, puis perd la main.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly db: DatabaseService, private readonly audit: AuditService, private readonly provisioning: ProvisioningService,
    private readonly entitlements: EntitlementService, private readonly sites: SitesService, private readonly treasury: TreasuryService, private readonly mail: MailService,
  ) {}

  private async setupRow(id: string) {
    if (!isUuid(id)) throw notFound('Entreprise en préparation');
    const s = await this.db.platform((trx) => trx.selectFrom('company_setup').selectAll().where('company_id', '=', id).executeTakeFirst());
    if (!s) throw notFound('Entreprise en préparation');
    return s;
  }

  /** Contexte d'action sur l'entreprise préparée : droits du propriétaire, refusé une fois l'entreprise remise. */
  private async tenantFor(auth: AuthInfo, id: string, ip?: string | null): Promise<TenantInfo> {
    const s = await this.setupRow(id);
    if (s.handed_over_at) throw conflict("L'entreprise a été remise au client : seul lui peut désormais la modifier.", 'setup_handed_over');
    return this.actingAs(auth, id, ip, DEFAULT_ROLES.find((r) => r.key === 'owner')!.permissions);
  }

  private async actingAs(auth: AuthInfo, id: string, ip: string | null | undefined, permissions: string[]): Promise<TenantInfo> {
    const { entitlements } = await this.db.platform((trx) => this.entitlements.forCompany(trx, id));
    return {
      ctx: { companyId: id, userId: auth.userId, actorType: 'platform', ip }, companyId: id, membershipId: '', isOwner: permissions.length > 0, permissions: new Set(permissions),
      entitlements, companyStatus: 'active', subscriptionStatus: 'trialing', readOnly: false, siteId: null, allowedSiteIds: null,
    };
  }

  /** Entreprises préparées par l'éditeur : en cours, ou remises en attendant que le propriétaire accepte. */
  list() {
    return this.db.platform(async (trx) => {
      const rows = await trx.selectFrom('company_setup as s').innerJoin('company as c', 'c.id', 's.company_id')
        .leftJoin('subscription as sub', 'sub.company_id', 'c.id').leftJoin('plan_version as v', 'v.id', 'sub.plan_version_id').leftJoin('plan as p', 'p.id', 'v.plan_id')
        .leftJoin('user_account as u', 'u.id', 's.prepared_by')
        .select((eb) => ['c.id', 'c.name', 'c.city', 'p.name as planName', 's.owner_name', 's.owner_email', 's.handed_over_at', 's.created_at', 'u.full_name as preparedBy',
          eb.exists(eb.selectFrom('company_membership as m').select('m.id').whereRef('m.company_id', '=', 'c.id').where('m.is_owner', '=', true).where('m.status', '=', 'active')).as('ownerJoined')])
        .orderBy('s.created_at', 'desc').limit(200).execute();
      return rows.map((r) => ({
        id: r.id, name: r.name, city: r.city, planName: r.planName, ownerName: r.owner_name, ownerEmail: r.owner_email, preparedBy: r.preparedBy, createdAt: r.created_at,
        handedOverAt: r.handed_over_at, status: r.ownerJoined ? 'active' : r.handed_over_at ? 'handed_over' : 'preparing',
      }));
    });
  }

  async create(auth: AuthInfo, input: NewCompany & { planCode: string; billingCycle: 'monthly' | 'yearly' }, ip?: string | null) {
    const { planCode, billingCycle, ...company } = input;
    const { companyId } = await this.db.asUser(auth.userId, async (trx) => {
      const r = await this.provisioning.provision(trx, auth.userId, company, ip, { owner: false, planCode, billingCycle, actorType: 'platform' });
      const t = await setTenantContext(trx, r.companyId, auth.userId);
      await t.insertInto('company_setup').values({ company_id: r.companyId, prepared_by: auth.userId, owner_name: null, owner_email: null, trial_days: null, notes: null, handed_over_by: null }).execute();
      await sql`select set_config('app.company_id', '', true)`.execute(trx);
      return r;
    });
    await this.db.platform((trx) => this.audit.platform(trx, auth.userId, { companyId, action: 'company.preparation_started', entityType: 'company', entityId: companyId, data: { name: input.name, plan: planCode } }));
    return this.get(companyId);
  }

  async get(id: string) {
    const s = await this.setupRow(id);
    const sub = await this.db.platform((trx) => trx.selectFrom('subscription as s').innerJoin('plan_version as v', 'v.id', 's.plan_version_id').innerJoin('plan as p', 'p.id', 'v.plan_id')
      .select(['p.code', 'p.name', 's.billing_cycle', 's.status', 's.current_period_end', 'v.trial_days', 'v.price_monthly', 'v.price_yearly', 'v.entitlements'])
      .where('s.company_id', '=', id).executeTakeFirstOrThrow());
    const ownerJoined = await this.db.platform(async (trx) => !!(await trx.selectFrom('company_membership').select('id').where('company_id', '=', id).where('is_owner', '=', true).where('status', '=', 'active').executeTakeFirst()));
    const users = s.users as PlannedUser[];
    const base = {
      id, handedOverAt: s.handed_over_at, status: ownerJoined ? 'active' : s.handed_over_at ? 'handed_over' : 'preparing',
      owner: s.owner_email ? { name: s.owner_name, email: s.owner_email } : null, users, notes: s.notes,
      subscription: { planCode: sub.code, planName: sub.name, billingCycle: sub.billing_cycle, trialDays: s.trial_days ?? sub.trial_days, trialEnd: sub.current_period_end,
        priceMonthly: Number(sub.price_monthly), priceYearly: Number(sub.price_yearly), userQuota: (sub.entitlements as any)?.quotas?.users ?? null, modules: (sub.entitlements as any)?.modules ?? [] },
    };
    // Une fois remise, l'entreprise appartient au client : la console n'en voit plus le contenu.
    if (s.handed_over_at) {
      const name = await this.db.platform(async (trx) => (await trx.selectFrom('company').select('name').where('id', '=', id).executeTakeFirstOrThrow()).name);
      return { ...base, company: { name } };
    }
    return this.db.tenant({ companyId: id, userId: s.prepared_by, actorType: 'platform' }, async (trx) => {
      const c = await trx.selectFrom('company').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      const sites = await trx.selectFrom('site').select(['id', 'code', 'name', 'city', 'address', 'phone', 'is_default']).where('archived_at', 'is', null).orderBy('is_default', 'desc').orderBy('code').execute();
      const accounts = await trx.selectFrom('treasury_account').select(['id', 'kind', 'name', 'bank_name', 'account_number', 'site_id']).where('archived_at', 'is', null).orderBy('kind').orderBy('name').execute();
      const roles = await trx.selectFrom('role').select(['key', 'name', 'description']).where('key', '!=', 'owner').orderBy('name').execute();
      const company = Object.fromEntries(Object.entries(COMPANY_COLUMNS).map(([k, col]) => [k, (c as any)[col] as string | null])) as Record<keyof typeof COMPANY_COLUMNS, string | null>;
      const banks = accounts.filter((a) => a.kind === 'bank');
      const seats = (s.owner_email ? 1 : 0) + users.length;
      const quota = base.subscription.userQuota as number | null;
      // Ce qui reste à faire avant la remise : seul le propriétaire est indispensable.
      const checklist = [
        { key: 'company', label: 'Fiche de l’entreprise', done: !!(company.legalForm && company.city && (company.rccm || company.taxId)), hint: 'Forme juridique, ville, RCCM ou NCC : ils figurent sur les factures.' },
        { key: 'subscription', label: 'Formule', done: true, hint: `${sub.name}, ${sub.billing_cycle === 'yearly' ? 'annuelle' : 'mensuelle'}` },
        { key: 'sites', label: 'Sites', done: true, hint: `${sites.length} site(s)` },
        base.subscription.modules.includes('bank')
          ? { key: 'treasury', label: 'Comptes bancaires', done: banks.length > 0 && banks.every((b) => b.bank_name && b.account_number), hint: 'Banque et numéro de compte de chaque compte bancaire.' }
          : { key: 'treasury', label: 'Trésorerie', done: true, hint: 'Formule sans banque : caisses et mobile money.' },
        { key: 'owner', label: 'Propriétaire', done: !!s.owner_email, required: true, hint: 'La personne qui recevra l’entreprise et en aura tous les droits.' },
        { key: 'users', label: 'Collaborateurs', done: quota === null || seats <= quota, hint: quota === null ? `${users.length} prévu(s)` : `${seats} / ${quota} utilisateurs de la formule` },
      ];
      return {
        ...base, company, logo: await logoDataUrl(trx), roles,
        sites: sites.map((x) => ({ id: x.id, code: x.code, name: x.name, city: x.city, address: x.address, phone: x.phone, isDefault: x.is_default })),
        accounts: accounts.map((a) => ({ id: a.id, kind: a.kind, name: a.name, bankName: a.bank_name, accountNumber: a.account_number, siteId: a.site_id })),
        checklist, canHandOver: checklist.every((i) => !i.required || i.done) && (quota === null || seats <= quota),
      };
    });
  }

  async updateCompany(auth: AuthInfo, id: string, input: CompanyInput, ip?: string | null) {
    const t = await this.tenantFor(auth, id, ip);
    await this.db.tenant(t.ctx, async (trx) => {
      const patch: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(COMPANY_COLUMNS)) if ((input as any)[k] !== undefined) patch[col] = (input as any)[k];
      if (!Object.keys(patch).length) return;
      await trx.updateTable('company').set(patch).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'company.updated', entityType: 'company', entityId: id, data: { fields: Object.keys(patch) } });
    });
    return this.get(id);
  }

  /** Logo de l'entreprise préparée ; null le retire. */
  async updateLogo(auth: AuthInfo, id: string, logo: string | null, ip?: string | null) {
    const t = await this.tenantFor(auth, id, ip);
    await this.db.tenant(t.ctx, (trx) => saveLogo(trx, this.audit, t.ctx, logo));
    return this.get(id);
  }

  /** Formule et durée d'essai : l'essai repart du jour de la remise au client. */
  async updateSubscription(auth: AuthInfo, id: string, input: { planCode?: string; billingCycle?: 'monthly' | 'yearly'; trialDays?: number }) {
    await this.tenantFor(auth, id);
    await this.db.platform(async (trx) => {
      const sub = await trx.selectFrom('subscription').select(['id', 'current_period_start']).where('company_id', '=', id).forUpdate().executeTakeFirstOrThrow();
      const patch: Record<string, unknown> = {};
      if (input.planCode) {
        const v = await trx.selectFrom('plan_version as v').innerJoin('plan as p', 'p.id', 'v.plan_id').select(['v.id', 'v.trial_days'])
          .where('p.code', '=', input.planCode).where('v.published_at', 'is not', null).orderBy('v.version', 'desc').limit(1).executeTakeFirst();
        if (!v) throw badRequest(`La formule ${input.planCode} n'est pas publiée.`, undefined, 'unknown_plan');
        patch.plan_version_id = v.id;
      }
      if (input.billingCycle) patch.billing_cycle = input.billingCycle;
      if (input.trialDays !== undefined) {
        patch.current_period_end = new Date(new Date(sub.current_period_start).getTime() + Math.max(input.trialDays, 1) * 86400_000);
        await trx.updateTable('company_setup').set({ trial_days: input.trialDays }).where('company_id', '=', id).execute();
      }
      if (Object.keys(patch).length) await trx.updateTable('subscription').set(patch).where('id', '=', sub.id).execute();
      await this.audit.platform(trx, auth.userId, { companyId: id, action: 'subscription.prepared', entityType: 'subscription', entityId: sub.id, data: input });
    });
    return this.get(id);
  }

  async addSite(auth: AuthInfo, id: string, input: NewSite, ip?: string | null) {
    await this.sites.create(await this.tenantFor(auth, id, ip), input);
    return this.get(id);
  }

  async updateSite(auth: AuthInfo, id: string, siteId: string, input: { name?: string; city?: string | null; address?: string | null; phone?: string | null }, ip?: string | null) {
    const t = await this.tenantFor(auth, id, ip);
    if (!isUuid(siteId)) throw notFound('Site');
    await this.db.tenant(t.ctx, async (trx) => {
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      const r = await trx.updateTable('site').set(patch).where('id', '=', siteId).returning('code').executeTakeFirst();
      if (!r) throw notFound('Site');
      await this.audit.tenant(trx, t.ctx, { action: 'site.updated', entityType: 'site', entityId: siteId, data: { code: r.code, fields: Object.keys(patch) } });
    });
    return this.get(id);
  }

  async addAccount(auth: AuthInfo, id: string, input: { kind: 'cash' | 'bank' | 'mobile_money'; name: string; bankName?: string | null; accountNumber?: string | null; siteId?: string | null }, ip?: string | null) {
    await this.treasury.createAccount(await this.tenantFor(auth, id, ip), input);
    return this.get(id);
  }

  async updateAccount(auth: AuthInfo, id: string, accountId: string, input: { name?: string; bankName?: string | null; accountNumber?: string | null }, ip?: string | null) {
    await this.treasury.updateAccount(await this.tenantFor(auth, id, ip), accountId, input);
    return this.get(id);
  }

  /** Propriétaire et collaborateurs prévus : rien n'est envoyé avant la remise. */
  async setPeople(auth: AuthInfo, id: string, input: PeopleInput) {
    const t = await this.tenantFor(auth, id);
    const emails = [input.owner?.email, ...input.users.map((u) => u.email)].filter(Boolean) as string[];
    const twice = emails.find((e, i) => emails.indexOf(e) !== i);
    if (twice) throw badRequest(`L'adresse ${twice} figure deux fois.`, undefined, 'duplicate_email');
    const quota = t.entitlements.quotas.users;
    if (quota !== null && emails.length > quota) throw conflict(`La formule permet ${quota} utilisateur(s), propriétaire compris : changez de formule ou retirez des collaborateurs.`, 'quota_users');
    await this.db.tenant(t.ctx, async (trx) => {
      const roles = new Set((await trx.selectFrom('role').select('key').where('key', '!=', 'owner').execute()).map((r) => r.key));
      const unknownRole = input.users.find((u) => !roles.has(u.roleKey));
      if (unknownRole) throw badRequest(`Rôle inconnu pour ${unknownRole.email}.`, undefined, 'unknown_role');
      const siteIds = [...new Set(input.users.flatMap((u) => u.siteIds ?? []))];
      if (siteIds.length) {
        const found = await trx.selectFrom('site').select('id').where('id', 'in', siteIds).where('archived_at', 'is', null).execute();
        if (found.length !== siteIds.length) throw badRequest('Un ou plusieurs sites sont introuvables.', undefined, 'unknown_site');
      }
      await trx.updateTable('company_setup').set({
        owner_name: input.owner?.name ?? null, owner_email: input.owner?.email ?? null, users: JSON.stringify(input.users),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      }).where('company_id', '=', id).execute();
    });
    return this.get(id);
  }

  private async invite(trx: TenantTrx, t: TenantInfo, p: { email: string; roleIds: string[]; siteIds: string[] | null; isOwner: boolean }) {
    const secret = randomToken(24);
    const inv = await trx.insertInto('invitation').values({
      company_id: t.companyId, email: p.email, role_ids: p.roleIds, token_hash: sha256(secret), invited_by: t.ctx.userId,
      expires_at: new Date(Date.now() + HANDOVER_INVITE_DAYS * 86400_000), site_ids: p.siteIds, is_owner: p.isOwner,
    }).returning('id').executeTakeFirstOrThrow();
    return { id: inv.id, inviteUrl: `${config.webUrl}/invitation?token=${encodeURIComponent(`${t.companyId}.${inv.id}.${secret}`)}` };
  }

  private async inviteOwner(trx: TenantTrx, t: TenantInfo, owner: { name: string | null; email: string }, company: { name: string; email: string | null }, planName: string) {
    const ownerRole = await trx.selectFrom('role').select('id').where('key', '=', 'owner').executeTakeFirstOrThrow();
    const inv = await this.invite(trx, t, { email: owner.email, roleIds: [ownerRole.id], siteIds: null, isOwner: true });
    await this.mail.enqueue(trx, {
      companyId: t.companyId, to: owner.email, kind: 'invitation', entityId: inv.id, fromName: "N'Ora ERP", createdBy: t.ctx.userId,
      subject: `Votre espace ${company.name} est prêt sur N'Ora ERP`,
      paragraphs: [
        `Bonjour ${owner.name ?? ''},`.replace(' ,', ','),
        `Notre équipe a préparé l'espace de ${company.name} sur N'Ora ERP (formule ${planName}) : fiche de l'entreprise, sites, comptes de trésorerie et accès de vos collaborateurs.`,
        "Vous en êtes le propriétaire : acceptez l'invitation pour choisir votre mot de passe et prendre la main. Vous pourrez tout modifier ensuite.",
        `Cette invitation est valable ${HANDOVER_INVITE_DAYS} jours.`,
      ],
      action: { label: 'Prendre possession de mon espace', url: inv.inviteUrl },
    });
    return inv;
  }

  /** Remise au client : invitations du propriétaire et des collaborateurs, essai qui démarre aujourd'hui, console verrouillée. */
  async handOver(auth: AuthInfo, id: string, ip?: string | null) {
    const t = await this.tenantFor(auth, id, ip);
    const state = await this.get(id) as Awaited<ReturnType<SetupService['get']>> & { canHandOver?: boolean };
    if (!state.owner) throw badRequest("Indiquez le propriétaire qui recevra l'entreprise.", undefined, 'owner_required');
    if (!state.canHandOver) throw conflict('La formule ne couvre pas tous les utilisateurs prévus.', 'quota_users');
    const links = await this.db.tenant(t.ctx, async (trx) => {
      const s = await trx.selectFrom('company_setup').selectAll().where('company_id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (s.handed_over_at) throw conflict("L'entreprise a déjà été remise au client.", 'setup_handed_over');
      const company = await trx.selectFrom('company').select(['name', 'email']).where('id', '=', id).executeTakeFirstOrThrow();
      const owner = await this.inviteOwner(trx, t, { name: s.owner_name, email: s.owner_email! }, company, state.subscription.planName);
      const roles = new Map((await trx.selectFrom('role').select(['id', 'key', 'name']).execute()).map((r) => [r.key, r]));
      const users = [];
      for (const u of s.users as PlannedUser[]) {
        const role = roles.get(u.roleKey)!;
        const inv = await this.invite(trx, t, { email: u.email, roleIds: [role.id], siteIds: u.siteIds?.length ? u.siteIds : null, isOwner: false });
        await this.mail.enqueue(trx, {
          companyId: id, to: u.email, kind: 'invitation', entityId: inv.id, fromName: company.name, replyTo: company.email, createdBy: auth.userId,
          subject: `${company.name} vous invite sur N'Ora ERP`,
          paragraphs: [`Bonjour ${u.name},`, `${company.name} vous invite à rejoindre son espace sur N'Ora ERP, avec le rôle : ${role.name}.`, `Cette invitation est valable ${HANDOVER_INVITE_DAYS} jours.`],
          action: { label: "Accepter l'invitation", url: inv.inviteUrl },
        });
        users.push({ email: u.email, inviteUrl: inv.inviteUrl });
      }
      await trx.updateTable('company_setup').set({ handed_over_at: new Date(), handed_over_by: auth.userId }).where('company_id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'company.handed_over', entityType: 'company', entityId: id, data: { owner: s.owner_email, users: users.length } });
      return { owner: { email: s.owner_email!, inviteUrl: owner.inviteUrl }, users };
    });
    // L'essai commence le jour où le client reçoit son espace.
    await this.db.platform(async (trx) => {
      const days = state.subscription.trialDays;
      await trx.updateTable('subscription').set({ current_period_start: new Date(), current_period_end: new Date(Date.now() + Math.max(days, 1) * 86400_000) }).where('company_id', '=', id).execute();
      await this.audit.platform(trx, auth.userId, { companyId: id, action: 'company.handed_over', entityType: 'company', entityId: id, data: { owner: links.owner.email } });
    });
    return { ...(await this.get(id)), links };
  }

  /** Nouvelle invitation du propriétaire (lien perdu ou expiré), tant qu'il n'a pas rejoint l'entreprise. */
  async resendOwner(auth: AuthInfo, id: string, ip?: string | null) {
    const s = await this.setupRow(id);
    if (!s.handed_over_at) throw conflict("L'entreprise n'a pas encore été remise au client.", 'setup_not_handed_over');
    const state = await this.get(id);
    if (state.status === 'active') throw conflict("Le propriétaire a déjà rejoint l'entreprise.", 'owner_joined');
    // Après la remise, seule l'invitation du propriétaire peut encore être refaite (aucun droit sur les données).
    const t = await this.actingAs(auth, id, ip, []);
    const link = await this.db.tenant(t.ctx, async (trx) => {
      await trx.updateTable('invitation').set({ revoked_at: new Date() }).where('is_owner', '=', true).where('accepted_at', 'is', null).where('revoked_at', 'is', null).execute();
      const company = await trx.selectFrom('company').select(['name', 'email']).where('id', '=', id).executeTakeFirstOrThrow();
      const inv = await this.inviteOwner(trx, t, { name: s.owner_name, email: s.owner_email! }, company, state.subscription.planName);
      await this.audit.tenant(trx, t.ctx, { action: 'invitation.created', entityType: 'invitation', entityId: inv.id, data: { email: s.owner_email, owner: true } });
      return inv.inviteUrl;
    });
    return { email: s.owner_email, inviteUrl: link };
  }
}
