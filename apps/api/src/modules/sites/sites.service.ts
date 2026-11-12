import { Injectable } from '@nestjs/common';
import { conflict } from '../../common/errors';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { StockService } from '../stock/stock.service';
import { TreasuryService } from '../treasury/treasury.service';

export interface NewSite { name: string; code?: string | null; address?: string | null; city?: string | null; phone?: string | null; withCash: boolean }

/** Création d'un site : partagée par l'écran Sites et la préparation d'une entreprise dans la console. */
@Injectable()
export class SitesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly stock: StockService, private readonly treasury: TreasuryService) {}

  /** Nouveau site, avec son entrepôt et (au choix) sa caisse. */
  async create(t: TenantInfo, input: NewSite) {
    const site = await this.db.tenant(t.ctx, async (trx) => {
      let code = input.code;
      if (code) {
        if (await trx.selectFrom('site').select('id').where('code', '=', code).executeTakeFirst()) throw conflict(`Le code ${code} est déjà utilisé par un autre site.`, 'duplicate_code');
      } else {
        const used = new Set((await trx.selectFrom('site').select('code').execute()).map((s) => s.code));
        for (let n = 1; !code; n++) if (!used.has(`S${String(n).padStart(2, '0')}`)) code = `S${String(n).padStart(2, '0')}`;
      }
      const s = await trx.insertInto('site').values({ company_id: t.companyId, code, name: input.name, address: input.address ?? null, city: input.city ?? null, phone: input.phone ?? null })
        .returningAll().executeTakeFirstOrThrow();
      await this.audit.tenant(trx, t.ctx, { action: 'site.created', entityType: 'site', entityId: s.id, data: { code, name: s.name } });
      return s;
    });
    const whCode = await this.db.tenant(t.ctx, async (trx) => {
      const used = new Set((await trx.selectFrom('warehouse').select('code').execute()).map((w) => w.code));
      const base = site.code.replace(/[^A-Z0-9-]/g, '').slice(0, 8) || 'SITE';
      let c = `${base}-DP`;
      for (let n = 2; used.has(c); n++) c = `${base}-DP${n}`;
      return c;
    });
    await this.stock.createWarehouse(t, { code: whCode, name: `Dépôt ${site.name}`, address: site.address, siteId: site.id });
    if (input.withCash) {
      const names = await this.db.tenant(t.ctx, async (trx) => new Set((await trx.selectFrom('treasury_account').select('name').execute()).map((a) => a.name)));
      let name = `Caisse ${site.name}`;
      for (let n = 2; names.has(name); n++) name = `Caisse ${site.name} ${n}`;
      await this.treasury.createAccount(t, { kind: 'cash', name, siteId: site.id });
    }
    return { id: site.id, code: site.code, name: site.name };
  }
}
