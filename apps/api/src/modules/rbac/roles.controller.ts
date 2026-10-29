import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Permission, Tenant } from '../../common/decorators';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors';
import { isUuid, uuidv7 } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { ACTIONS, BUSINESS_MODULES, CORE_PERMISSIONS, isSensitive, PERMISSION_KEYS, SELF_PERMISSIONS, SENSITIVE_PERMISSIONS } from './permissions';

const RoleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  permissions: z.array(z.string()).max(500),
});

function checkPermissions(t: TenantInfo, perms: string[], previous: string[] = []) {
  const unknown = perms.filter((p) => !PERMISSION_KEYS.has(p));
  if (unknown.length) throw badRequest('Permissions inconnues.', unknown);
  const addedSensitive = perms.filter((p) => isSensitive(p) && !previous.includes(p));
  if (addedSensitive.length && !t.isOwner) {
    throw forbidden('Seul un propriétaire peut attribuer des permissions sensibles.', 'sensitive_permission');
  }
}

@ApiTags('Rôles et permissions')
@Controller()
export class RolesController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Permission(null)
  @Get('permissions')
  catalog() {
    return {
      actions: ACTIONS,
      modules: Object.entries(BUSINESS_MODULES).map(([key, m]) => ({ key, label: m.label, entitlement: m.entitlement })),
      core: CORE_PERMISSIONS, sensitive: SENSITIVE_PERMISSIONS, self: SELF_PERMISSIONS,
    };
  }

  @Permission('users.read')
  @Get('company/roles')
  list(@Tenant() t: TenantInfo) {
    return this.db.tenant(t.ctx, (trx) => trx.selectFrom('role as r')
      .select((eb) => ['r.id', 'r.key', 'r.name', 'r.description', 'r.is_system as isSystem', 'r.permissions',
        eb.selectFrom('membership_role as mr').whereRef('mr.role_id', '=', 'r.id').select(eb.fn.countAll<string>().as('c')).as('memberCount')])
      .orderBy('r.is_system', 'desc').orderBy('r.name').execute());
  }

  @Permission('users.admin')
  @Post('company/roles')
  create(@Tenant() t: TenantInfo, @Body() body: unknown) {
    const input = parse(RoleSchema, body);
    checkPermissions(t, input.permissions);
    return this.db.tenant(t.ctx, async (trx) => {
      const role = await trx.insertInto('role').values({
        company_id: t.companyId, key: `custom_${uuidv7().slice(-12)}`, name: input.name, description: input.description ?? null,
        permissions: Array.from(new Set(input.permissions)).sort(),
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'role.created', entityType: 'role', entityId: role.id, data: { name: role.name, permissions: role.permissions } });
      return role;
    });
  }

  @Permission('users.admin')
  @Patch('company/roles/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    if (!isUuid(id)) throw notFound('Rôle');
    const input = parse(RoleSchema.partial(), body);
    return this.db.tenant(t.ctx, async (trx) => {
      const role = await trx.selectFrom('role').selectAll().where('id', '=', id).executeTakeFirst();
      if (!role) throw notFound('Rôle');
      if (role.key === 'owner' && input.permissions) throw forbidden('Les permissions du rôle Propriétaire ne sont pas modifiables.');
      if (input.permissions) checkPermissions(t, input.permissions, role.permissions);
      const updated = await trx.updateTable('role').set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.permissions ? { permissions: Array.from(new Set(input.permissions)).sort() } : {}),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'role.updated', entityType: 'role', entityId: id, data: {
        name: updated.name,
        added: updated.permissions.filter((p) => !role.permissions.includes(p)),
        removed: role.permissions.filter((p) => !updated.permissions.includes(p)),
      } });
      return updated;
    });
  }

  @Permission('users.admin')
  @Delete('company/roles/:id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('Rôle');
    return this.db.tenant(t.ctx, async (trx) => {
      const role = await trx.selectFrom('role').select(['id', 'is_system', 'name']).where('id', '=', id).executeTakeFirst();
      if (!role) throw notFound('Rôle');
      if (role.is_system) throw forbidden('Les rôles standard ne peuvent pas être supprimés (vous pouvez les modifier).');
      const used = await trx.selectFrom('membership_role').select('role_id').where('role_id', '=', id).executeTakeFirst();
      if (used) throw conflict('Ce rôle est encore attribué à des utilisateurs.', 'role_in_use');
      await trx.deleteFrom('role').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'role.deleted', entityType: 'role', entityId: id, data: { name: role.name } });
      return { ok: true };
    });
  }
}
