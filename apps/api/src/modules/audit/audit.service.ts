import { Injectable } from '@nestjs/common';
import type { TenantContext, TenantTrx, Trx } from '../../db/database.service';

export interface AuditEntry { action: string; entityType?: string; entityId?: string; data?: Record<string, unknown> }

/** Journal d'audit en ajout seul. Chaque écriture se fait dans la transaction de l'opération auditée. */
@Injectable()
export class AuditService {
  async tenant(trx: TenantTrx, ctx: TenantContext, e: AuditEntry) {
    await trx.insertInto('audit_log').values({
      company_id: ctx.companyId, actor_type: ctx.actorType, actor_id: ctx.userId, action: e.action,
      entity_type: e.entityType ?? null, entity_id: e.entityId ?? null, data: JSON.stringify(e.data ?? {}), ip: ctx.ip ?? null,
    }).execute();
  }

  /** Événement de la plateforme ; companyId renseigné quand il concerne un client (visible par lui). */
  async platform(trx: Trx, actorId: string | null, e: AuditEntry & { companyId?: string | null; actorType?: 'platform' | 'system' | 'user' }) {
    await trx.insertInto('audit_log').values({
      company_id: e.companyId ?? null, actor_type: e.actorType ?? 'platform', actor_id: actorId, action: e.action,
      entity_type: e.entityType ?? null, entity_id: e.entityId ?? null, data: JSON.stringify(e.data ?? {}), ip: null,
    }).execute();
  }
}
