import { Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { safeEqual } from '../../common/crypto';
import { notFound } from '../../common/errors';
import { config } from '../../config';
import { BillingService } from '../billing/billing.service';
import { CalendarService } from '../calendar/calendar.service';
import { MailService } from '../mail/mail.service';

/**
 * Tâches de fond déclenchées de l'extérieur, pour un hébergement qui éteint le serveur entre deux requêtes (Vercel) :
 * un planificateur (pg_cron de Supabase) appelle POST /jobs/tick chaque minute avec le secret CRON_SECRET.
 * Chaque appel envoie les e-mails en attente et les rappels du calendrier ; le cycle d'abonnements tourne toutes les 10 minutes.
 * Sans CRON_SECRET, la route n'existe pas (les minuteries internes suffisent quand le serveur reste allumé).
 */
@ApiExcludeController()
@Controller('jobs')
export class JobsController {
  private readonly logger = new Logger('Tâches');
  constructor(private readonly mail: MailService, private readonly calendar: CalendarService, private readonly billing: BillingService) {}

  @Public() @HttpCode(200)
  @Post('tick')
  async tick(@Headers('authorization') authorization?: string) {
    const secret = config.jobs.cronSecret;
    if (!secret || !authorization || !safeEqual(authorization, `Bearer ${secret}`)) throw notFound('Ressource');
    const done: Record<string, unknown> = {};
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try { done[name] = (await fn()) ?? 'ok'; } catch (e) { this.logger.error(e); done[name] = 'erreur'; }
    };
    await step('emails', () => this.mail.processQueue());
    await step('reminders', () => this.calendar.sendReminders());
    if (new Date().getUTCMinutes() % 10 === 0) await step('billing', () => this.billing.runCycle());
    return done;
  }
}
