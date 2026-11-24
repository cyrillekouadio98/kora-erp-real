import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { RequireFeature } from '../../common/features';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService } from '../../db/database.service';
import { StockService } from './stock.service';

/**
 * Réapprovisionnement : articles à commander (prévisionnel sous le seuil), regroupés par fournisseur habituel
 * (le dernier qui les a facturés ou à qui ils ont été commandés), avec la quantité conseillée et le dernier prix.
 * Les bons de commande se créent ensuite en brouillon par la route habituelle des achats.
 */
@ApiTags('Stocks')
@Controller('company/stock/restock')
export class RestockController {
  constructor(private readonly db: DatabaseService, private readonly stock: StockService) {}

  @Permission('purchases.read') @RequireFeature('restock') @AllowWhenReadOnly()
  @Get()
  async get(@Tenant() t: TenantInfo, @Query('warehouseId') warehouseId?: string) {
    const overview = await this.stock.overview(t, warehouseId || undefined);
    const items = overview.items.filter((i: any) => i.toOrder);
    return this.db.tenant(t.ctx, async (trx) => {
      const ids = items.map((i: any) => i.id);
      const last = ids.length ? await trx.selectFrom('purchase_document_line as l').innerJoin('purchase_document as d', (j) => j.onRef('d.id', '=', 'l.document_id').onRef('d.company_id', '=', 'l.company_id'))
        .innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
        .select(['l.product_id', 'd.contact_id', 'c.name as supplier', 'l.unit_price', 'l.unit_factor', 'd.issue_date'])
        .distinctOn('l.product_id').where('l.product_id', 'in', ids).where('d.status', '!=', 'draft').where('c.archived_at', 'is', null)
        .orderBy('l.product_id').orderBy('d.issue_date', 'desc').orderBy(sql`d.created_at`, 'desc').execute() : [];
      const suppliers = await trx.selectFrom('contact').select(['id', 'code', 'name']).where('kind', '!=', 'customer').where('archived_at', 'is', null).orderBy('name').execute();
      return {
        warehouses: overview.warehouses, suppliers,
        items: items.map((i: any) => {
          const l = last.find((x) => x.product_id === i.id);
          // Dernier prix ramené à l'unité de stock (achat au sac : prix du sac ÷ coefficient).
          const lastPrice = l ? Math.round(Number(l.unit_price) / Number(l.unit_factor)) : null;
          return { id: i.id, code: i.code, name: i.name, unit: i.unit, vatRate: i.vatRate, quantity: i.quantity, reserved: i.reserved, incoming: i.incoming, forecast: i.forecast, minStock: i.minStock,
            suggested: i.suggested, supplierId: l?.contact_id ?? null, supplier: l?.supplier ?? null, lastPurchase: l?.issue_date ?? null, unitPrice: lastPrice ?? i.purchasePrice ?? i.avgCost ?? 0 };
        }),
      };
    });
  }
}
