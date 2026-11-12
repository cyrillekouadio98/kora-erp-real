import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../common/decorators';
import { SalesService } from './sales.service';

/** Consultation d'un document par son destinataire, sans compte, grâce au lien reçu par e-mail. */
@ApiTags('Consultation publique')
@Controller('public')
export class PublicDocumentsController {
  constructor(private readonly sales: SalesService) {}

  @Public() @UseGuards(ThrottlerGuard)
  @Get('document')
  document(@Query('token') token: string) { return this.sales.publicView(String(token ?? '').slice(0, 300)); }
}
