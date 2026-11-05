import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse, uuidParam } from '../../common/validation';
import { isoDate } from '../sales/sales.controller';
import { StockService } from './stock.service';

const quantity = z.coerce.number().min(0, { message: 'La quantité ne peut pas être négative' }).max(1e9).transform((v) => Math.round(v * 1000) / 1000);
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const TYPES = ['receipt', 'issue', 'transfer', 'inventory'] as const;

const line = z.object({
  productId: uuidParam, quantity: quantity.nullable().optional(),
  unitCost: z.coerce.number().min(0, { message: 'Le coût ne peut pas être négatif' }).max(1e13).nullable().optional(), note: text(200),
}).strict();
const docBody = {
  warehouseId: uuidParam.nullable().optional(), destWarehouseId: uuidParam.nullable().optional(), reason: z.string().max(30).optional(), date: isoDate.optional(),
  contactId: uuidParam.nullable().optional(), treasuryAccountId: uuidParam.nullable().optional(), reference: text(60), notes: text(1000), lines: z.array(line).max(2000).optional(),
};

@ApiTags('Stocks')
@Controller('company/stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Permission('stock.read') @AllowWhenReadOnly()
  @Get()
  overview(@Tenant() t: TenantInfo, @Query('warehouseId') warehouseId?: string) { return this.stock.overview(t, warehouseId ? parse(uuidParam, warehouseId) : undefined); }

  /** Journal de tous les mouvements de stock. */
  @Permission('stock.read') @AllowWhenReadOnly()
  @Get('movements')
  journal(@Tenant() t: TenantInfo, @Query() query: unknown) {
    return this.stock.journal(t, parse(z.object({
      from: isoDate.optional(), to: isoDate.optional(), warehouseId: uuidParam.optional(), productId: uuidParam.optional(), q: z.string().max(100).optional(),
      reason: z.enum(['opening', 'purchase', 'sale', 'sale_return', 'adjustment', 'receipt', 'issue', 'transfer']).optional(),
    }), query));
  }

  /** Valorisation au CMUP à une date et rapprochement avec le compte 311. */
  @Permission('stock.read') @AllowWhenReadOnly()
  @Get('valuation')
  valuation(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(z.object({ date: isoDate, warehouseId: uuidParam.optional() }), query);
    return this.stock.valuation(t, q.date, q.warehouseId);
  }

  // ------------------------------------------------------------------ entrepôts
  @Permission('stock.read') @AllowWhenReadOnly()
  @Get('warehouses')
  warehouses(@Tenant() t: TenantInfo) { return this.stock.warehouses(t); }

  @Permission('stock.admin')
  @Post('warehouses')
  createWarehouse(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.stock.createWarehouse(t, parse(z.object({
      code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,12}$/, { message: 'Code : 1 à 12 lettres, chiffres ou tirets' }),
      name: z.string().trim().min(2, { message: "Indiquez le nom de l'entrepôt" }).max(80), address: text(200), siteId: z.string().uuid().nullable().optional(),
    }).strict(), body));
  }

  @Permission('stock.admin')
  @Patch('warehouses/:id')
  updateWarehouse(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.stock.updateWarehouse(t, id, parse(z.object({
      name: z.string().trim().min(2, { message: "Indiquez le nom de l'entrepôt" }).max(80).optional(), address: text(200),
      isDefault: z.literal(true).optional(), archived: z.boolean().optional(), siteId: z.string().uuid().optional(),
    }).strict(), body));
  }

  // ------------------------------------------------------------------ bons de stock
  @Permission('stock.read') @AllowWhenReadOnly()
  @Get('documents')
  documents(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(z.object({
      type: z.string().transform((v) => v.split(',')).pipe(z.array(z.enum(TYPES)).min(1)), status: z.enum(['draft', 'done']).optional(),
    }), query);
    return this.stock.listDocuments(t, { types: q.type, status: q.status });
  }

  @Permission('stock.read') @AllowWhenReadOnly()
  @Get('documents/:id')
  document(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.stock.getDocument(t, id); }

  @Permission('stock.create')
  @Post('documents')
  createDocument(@Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.stock.createDocument(t, parse(z.object({ type: z.enum(TYPES), ...docBody }).strict(), body));
  }

  @Permission('stock.update')
  @Patch('documents/:id')
  updateDocument(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.stock.updateDocument(t, id, parse(z.object(docBody).strict(), body));
  }

  @Permission('stock.cancel')
  @Delete('documents/:id')
  removeDocument(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.stock.removeDocument(t, id); }

  /** Validation : numéro, mouvements de stock et, pour un achat comptant, sortie de trésorerie et écriture. */
  @Permission('stock.validate') @HttpCode(200)
  @Post('documents/:id/validate')
  validateDocument(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.stock.validateDocument(t, id); }

  // ------------------------------------------------------------------ article
  @Permission('stock.read') @AllowWhenReadOnly()
  @Get(':productId/movements')
  movements(@Tenant() t: TenantInfo, @Param('productId') productId: string) { return this.stock.movements(t, productId); }

  @Permission('stock.admin')
  @Patch(':productId')
  settings(@Tenant() t: TenantInfo, @Param('productId') productId: string, @Body() body: unknown) {
    return this.stock.setSettings(t, productId, parse(z.object({ minStock: quantity.nullable().optional(), trackStock: z.boolean().optional() }).strict(), body));
  }

  /** Stock initial (avant l'utilisation de N'Ora) d'un article sans mouvement. */
  @Permission('stock.admin') @HttpCode(200)
  @Post(':productId/opening')
  opening(@Tenant() t: TenantInfo, @Param('productId') productId: string, @Body() body: unknown) {
    return this.stock.opening(t, productId, parse(z.object({
      quantity: z.coerce.number().positive({ message: 'La quantité doit être positive' }).max(1e9),
      unitCost: z.coerce.number().min(0, { message: 'Le coût ne peut pas être négatif' }).max(1e13), date: isoDate.optional(), warehouseId: uuidParam.nullable().optional(),
    }).strict(), body));
  }

  /** Inventaire rapide d'un article : la quantité comptée remplace la quantité théorique de l'entrepôt. */
  @Permission('stock.validate') @HttpCode(200)
  @Post(':productId/count')
  count(@Tenant() t: TenantInfo, @Param('productId') productId: string, @Body() body: unknown) {
    return this.stock.count(t, productId, parse(z.object({
      counted: quantity, reason: z.string().trim().min(3, { message: "Indiquez la raison de l'écart" }).max(200), warehouseId: uuidParam.nullable().optional(),
    }).strict(), body));
  }

  /** Écriture de variation de stock à une date (311 / 6031). */
  @Permission('accounting.validate') @HttpCode(200)
  @Post('variation')
  variation(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.stock.postVariation(t, parse(z.object({ date: isoDate }).strict(), body).date); }
}
