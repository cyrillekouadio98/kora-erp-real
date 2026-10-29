import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService } from '../../db/database.service';

@ApiTags("Journal d'audit")
@Controller('company/audit')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @Permission('audit.read') @AllowWhenReadOnly()
  @Get()
  list(@Tenant() t: TenantInfo, @Query('before') before?: string, @Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.db.tenant(t.ctx, async (trx) => {
      let q = trx.selectFrom('audit_log as a').leftJoin('user_account as u', 'u.id', 'a.actor_id')
        .select(['a.id', 'a.actor_type as actorType', 'a.actor_id as actorId', 'u.full_name as actorName', 'a.action', 'a.entity_type as entityType', 'a.entity_id as entityId', 'a.data', 'a.ip', 'a.created_at as createdAt'])
        .orderBy('a.id', 'desc').limit(n);
      if (before && /^\d+$/.test(before)) q = q.where('a.id', '<', before);
      return q.execute();
    });
  }
}
