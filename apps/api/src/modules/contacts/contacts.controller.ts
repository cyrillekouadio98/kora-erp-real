import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { nextNumber } from '../../common/numbering';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { toCsv } from '../exports/export.controller';

const opt = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const ContactSchema = z.object({
  kind: z.enum(['customer', 'supplier', 'both'], { message: 'Choisissez client, fournisseur ou les deux' }),
  legalType: z.enum(['company', 'individual']).optional(),
  name: z.string().trim().min(2, { message: 'Le nom doit contenir au moins 2 caractères' }).max(160),
  code: z.string().trim().max(30).regex(/^[A-Za-z0-9._-]*$/, { message: 'Le code ne contient que lettres, chiffres, points, tirets' }).transform((v) => v.toUpperCase() || null).nullable().optional(),
  taxId: opt(40), rccm: opt(60), phone: opt(40), address: opt(300), city: opt(80), notes: opt(2000),
  email: z.string().trim().toLowerCase().email({ message: 'Adresse e-mail invalide' }).nullable().optional().or(z.literal('').transform(() => null)),
  countryCode: z.string().trim().length(2).transform((v) => v.toUpperCase()).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
}).strict();

const COLUMNS = {
  kind: 'kind', legalType: 'legal_type', name: 'name', code: 'code', taxId: 'tax_id', rccm: 'rccm', email: 'email', phone: 'phone',
  address: 'address', city: 'city', notes: 'notes', countryCode: 'country_code', paymentTermsDays: 'payment_terms_days',
} as const;

/** Préfixe de numérotation automatique selon le type de tiers. */
const PREFIX = { customer: 'CLI', supplier: 'FRS', both: 'TIE' } as const;

const SELECT = [
  'id', 'code', 'kind', 'legal_type as legalType', 'name', 'tax_id as taxId', 'rccm', 'email', 'phone', 'address', 'city',
  'country_code as countryCode', 'payment_terms_days as paymentTermsDays', 'notes', 'archived_at as archivedAt', 'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['customer', 'supplier']).optional(),
  archived: z.enum(['false', 'true', 'all']).default('false'),
});

function toColumns(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(COLUMNS)) if (input[k] !== undefined) out[col] = input[k];
  return out;
}

@ApiTags('Contacts')
@Controller('company/contacts')
export class ContactsController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private list(trx: TenantTrx, query: z.infer<typeof ListQuery>) {
    let q = trx.selectFrom('contact').select(SELECT).orderBy('name').limit(1000);
    if (query.archived === 'false') q = q.where('archived_at', 'is', null);
    if (query.archived === 'true') q = q.where('archived_at', 'is not', null);
    if (query.kind) q = q.where('kind', 'in', [query.kind, 'both']);
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) => eb.or(['name', 'code', 'email', 'phone', 'tax_id', 'city'].map((c) => eb(c as 'name', 'ilike', like))));
    }
    return q.execute();
  }

  /** Code saisi (vérifié unique) ou prochain numéro de la séquence CLI-00001, FRS-00001… */
  private async resolveCode(trx: TenantTrx, t: TenantInfo, kind: keyof typeof PREFIX, code: string | null | undefined, exceptId?: string) {
    const taken = async (c: string) => !!(await trx.selectFrom('contact').select('id').where('code', '=', c)
      .$if(!!exceptId, (qb) => qb.where('id', '!=', exceptId!)).executeTakeFirst());
    if (code) {
      if (await taken(code)) throw conflict(`Le code ${code} est déjà utilisé par un autre contact.`, 'contact_code_taken');
      return code;
    }
    for (;;) {
      const next = await nextNumber(trx, t.companyId, `contact_${kind}`, PREFIX[kind]);
      if (!(await taken(next))) return next;
    }
  }

  @Permission('contacts.read') @AllowWhenReadOnly()
  @Get()
  index(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(ListQuery, query);
    return this.db.tenant(t.ctx, (trx) => this.list(trx, q));
  }

  /** Fichier CSV (séparateur point-virgule, UTF-8) ouvrable directement dans Excel. */
  @Permission('contacts.export') @AllowWhenReadOnly()
  @Get('export')
  async export(@Tenant() t: TenantInfo, @Query() query: unknown, @Res() res: Response) {
    const q = parse(ListQuery, query);
    const rows = await this.db.tenant(t.ctx, async (trx) => {
      const r = await this.list(trx, q);
      await this.audit.tenant(trx, t.ctx, { action: 'contact.exported', data: { count: r.length } });
      return r;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows as Record<string, unknown>[]));
  }

  @Permission('contacts.read') @AllowWhenReadOnly()
  @Get(':id')
  async get(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Contact');
    const c = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('contact').select(SELECT).where('id', '=', id).executeTakeFirst());
    if (!c) throw notFound('Contact');
    return c;
  }

  @Permission('contacts.create')
  @Post()
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(ContactSchema, body);
    return this.db.tenant(t.ctx, async (trx) => {
      const code = await this.resolveCode(trx, t, input.kind, input.code);
      const created = await trx.insertInto('contact').values({
        ...toColumns(input), code, company_id: t.companyId, created_by: t.ctx.userId,
      } as any).returning(SELECT).executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'contact.created', entityType: 'contact', entityId: created.id, data: { code, name: created.name, kind: created.kind } });
      return created;
    });
  }

  @Permission('contacts.update')
  @Patch(':id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Contact');
    const input = parse(ContactSchema.partial(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await trx.selectFrom('contact').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Contact');
      if (before.archived_at) throw conflict('Ce contact est archivé : restaurez-le avant de le modifier.', 'contact_archived');
      const patch = toColumns(input);
      if (input.code !== undefined) patch.code = await this.resolveCode(trx, t, (input.kind ?? before.kind), input.code, id);
      if (!Object.keys(patch).length) return trx.selectFrom('contact').select(SELECT).where('id', '=', id).executeTakeFirstOrThrow();
      const after = await trx.updateTable('contact').set(patch).where('id', '=', id).returning(SELECT).executeTakeFirstOrThrow();
      const changes = Object.fromEntries(Object.keys(patch).filter((c) => (before as any)[c] !== patch[c]).map((c) => [c, { from: (before as any)[c], to: patch[c] }]));
      await this.audit.tenant(trx, t.ctx, { action: 'contact.updated', entityType: 'contact', entityId: id, data: { code: after.code, changes } });
      return after;
    });
  }

  /** Archive (au lieu de supprimer) : le tiers disparaît des listes mais reste dans l'historique. */
  @Permission('contacts.cancel') @HttpCode(200)
  @Post(':id/archive')
  archive(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.setArchived(t, id, true); }

  @Permission('contacts.cancel') @HttpCode(200)
  @Post(':id/restore')
  restore(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.setArchived(t, id, false); }

  private setArchived(t: TenantInfo, id: string, archived: boolean) {
    if (!isUuid(id)) throw notFound('Contact');
    return this.db.tenant(t.ctx, async (trx) => {
      const c = await trx.updateTable('contact').set({ archived_at: archived ? new Date() : null })
        .where('id', '=', id).where('archived_at', archived ? 'is' : 'is not', null).returning(SELECT).executeTakeFirst();
      if (!c) throw notFound('Contact');
      await this.audit.tenant(trx, t.ctx, { action: archived ? 'contact.archived' : 'contact.restored', entityType: 'contact', entityId: id, data: { code: c.code, name: c.name } });
      return c;
    });
  }
}
