import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, PlatformRoles } from '../../common/decorators';
import type { AuthInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { MailService } from '../mail/mail.service';

const email = z.string().trim().toLowerCase().email({ message: 'Adresse e-mail invalide' }).max(254);
const SettingsSchema = z.object({
  host: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, { message: 'Nom de serveur invalide (ex. mail.systalink.com)' }).max(253),
  port: z.coerce.number().int().min(1).max(65535, { message: 'Port invalide' }),
  secure: z.boolean(),
  username: z.string().trim().min(1, { message: "Indiquez l'identifiant" }).max(254),
  /** Absent : le mot de passe déjà enregistré est conservé. */
  password: z.string().min(1).max(200).optional(),
  fromAddress: email,
}).strict();

/** Serveur d'envoi des e-mails de toute la plateforme : réservé au super administrateur. */
@ApiTags('Console éditeur')
@Controller('platform/mail-settings')
export class MailSettingsController {
  constructor(private readonly mail: MailService) {}

  @PlatformRoles('super_admin')
  @Get()
  get() { return this.mail.settings(); }

  @PlatformRoles('super_admin')
  @Put()
  save(@Auth() auth: AuthInfo, @Body() body: unknown) { return this.mail.saveSettings(auth.userId, parse(SettingsSchema, body)); }

  @PlatformRoles('super_admin')
  @Delete()
  remove(@Auth() auth: AuthInfo) { return this.mail.deleteSettings(auth.userId); }

  @PlatformRoles('super_admin') @HttpCode(200)
  @Post('test')
  test(@Auth() auth: AuthInfo, @Body() body: unknown) { return this.mail.sendTest(auth.userId, parse(z.object({ to: email }).strict(), body).to); }
}
