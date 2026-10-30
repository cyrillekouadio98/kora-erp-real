import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import { conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { DatabaseService } from '../../db/database.service';
import { MailService } from './mail.service';

/** Suivi des e-mails envoyés par l'entreprise (invitations, documents, relances). */
@ApiTags('E-mails')
@Controller('company/emails')
export class EmailsController {
  constructor(private readonly db: DatabaseService, private readonly mail: MailService) {}

  @Permission('settings.read') @AllowWhenReadOnly()
  @Get()
  async list(@Tenant() t: TenantInfo) {
    const messages = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('email_message')
      .select(['id', 'to_address as to', 'subject', 'kind', 'status', 'attempts', 'last_error as lastError', 'sent_at as sentAt', 'created_at as createdAt', 'text_body as text'])
      .orderBy('created_at', 'desc').limit(200).execute());
    return { mode: this.mail.mode, messages };
  }

  /** Remet en file un message en échec (après correction de l'adresse du serveur, par exemple). */
  @Permission('settings.admin') @HttpCode(200)
  @Post(':id/retry')
  async retry(@Tenant() t: TenantInfo, @Param('id') id: string) {
    if (!isUuid(id)) throw notFound('E-mail');
    const m = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('email_message').select(['id', 'status']).where('id', '=', id).executeTakeFirst());
    if (!m) throw notFound('E-mail');
    if (m.status !== 'failed') throw conflict("Seul un e-mail en échec peut être renvoyé.", 'not_failed');
    // La file appartient à la plateforme : la remise en file passe par son rôle, sur ce seul message vérifié ci-dessus.
    await this.db.platform((trx) => trx.updateTable('email_message').set({ status: 'queued', attempts: 0, next_attempt_at: new Date(), last_error: null }).where('id', '=', id).where('company_id', '=', t.companyId).execute());
    return { ok: true };
  }
}
