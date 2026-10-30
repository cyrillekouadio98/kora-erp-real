import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { isoDate } from '../sales/sales.controller';
import { StockService } from './stock.service';

const quantity = z.coerce.number().min(0, { message: 'La quantité ne peut pas être négative' }).max(1e9).transform((v) => Math.round(v * 1000) / 1000);

@ApiTags('Stocks')
@Controller('company/stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Permission('products.read') @AllowWhenReadOnly()
  @Get()
  overview(@Tenant() t: TenantInfo) { return this.stock.overview(t); }

  @Permission('products.read') @AllowWhenReadOnly()
  @Get(':productId/movements')
  movements(@Tenant() t: TenantInfo, @Param('productId') productId: string) { return this.stock.movements(t, productId); }

  @Permission('products.admin')
  @Patch(':productId')
  settings(@Tenant() t: TenantInfo, @Param('productId') productId: string, @Body() body: unknown) {
    return this.stock.setSettings(t, productId, parse(z.object({ minStock: quantity.nullable().optional(), trackStock: z.boolean().optional() }).strict(), body));
  }

  /** Stock initial (avant l'utilisation de Kora) d'un article sans mouvement. */
  @Permission('products.admin') @HttpCode(200)
  @Post(':productId/opening')
  opening(@Tenant() t: TenantInfo, @Param('productId') productId: string, @Body() body: unknown) {
    return this.stock.opening(t, productId, parse(z.object({
      quantity: z.coerce.number().positive({ message: 'La quantité doit être positive' }).max(1e9),
      unitCost: z.coerce.number().min(0, { message: 'Le coût ne peut pas être négatif' }).max(1e13), date: isoDate.optional(),
    }).strict(), body));
  }

  /** Inventaire physique : la quantité comptée remplace la quantité théorique. */
  @Permission('products.admin') @HttpCode(200)
  @Post(':productId/count')
  count(@Tenant() t: TenantInfo, @Param('productId') productId: string, @Body() body: unknown) {
    return this.stock.count(t, productId, parse(z.object({ counted: quantity, reason: z.string().trim().min(3, { message: "Indiquez la raison de l'écart" }).max(200) }).strict(), body));
  }

  /** Écriture de variation de stock à une date (311 / 6031). */
  @Permission('accounting.validate') @HttpCode(200)
  @Post('variation')
  variation(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.stock.postVariation(t, parse(z.object({ date: isoDate }).strict(), body).date); }
}
