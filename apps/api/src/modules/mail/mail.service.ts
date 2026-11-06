import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { config } from '../../config';
import { DatabaseService, Trx } from '../../db/database.service';

export interface OutgoingMail {
  companyId: string | null; to: string; subject: string; kind: string; entityId?: string | null; replyTo?: string | null; fromName?: string;
  /** Paragraphes du message (texte brut) et bouton d'action facultatif. */
  paragraphs: string[]; action?: { label: string; url: string }; createdBy?: string | null;
}
type Transport = (m: { from: string; to: string; replyTo?: string; subject: string; text: string; html: string }) => Promise<void>;

/** Attentes entre deux tentatives (minutes) : 5 tentatives au total, puis le message passe en échec. */
const RETRY_MINUTES = [1, 5, 30, 120];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Mise en forme commune : version texte et version HTML sobre (lisible aussi sur téléphone). */
export function renderMail(m: Pick<OutgoingMail, 'paragraphs' | 'action' | 'fromName'>) {
  const text = [...m.paragraphs, ...(m.action ? [`${m.action.label} : ${m.action.url}`] : []), '', `— ${m.fromName ?? 'Kora ERP'}`].join('\n\n');
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f5f2;font-family:Segoe UI,Arial,sans-serif;color:#16201b">
<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border:1px solid #d8ddd5;border-radius:10px;padding:24px">
${m.paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.5;white-space:pre-line">${esc(p)}</p>`).join('')}
${m.action ? `<p style="margin:20px 0"><a href="${esc(m.action.url)}" style="background:#1f6b4f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(m.action.label)}</a></p>
<p style="margin:0;font-size:12px;color:#5a665f;word-break:break-all">${esc(m.action.url)}</p>` : ''}
</div><p style="font-size:12px;color:#5a665f;text-align:center">${esc(m.fromName ?? 'Kora ERP')} · envoyé avec Kora ERP</p></div></body></html>`;
  return { text, html };
}

/**
 * File d'envoi : un e-mail est inscrit dans la transaction de l'opération qui le déclenche
 * (il ne part donc jamais pour une opération annulée), puis envoyé par une tâche de fond.
 */
@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('E-mails');
  private timer?: NodeJS.Timeout;
  private transport: Transport;
  readonly mode: 'smtp' | 'development' = config.mail.smtpUrl ? 'smtp' : 'development';

  constructor(private readonly db: DatabaseService) {
    if (config.mail.smtpUrl) {
      const smtp = nodemailer.createTransport(config.mail.smtpUrl);
      this.transport = async (m) => { await smtp.sendMail(m); };
    } else {
      // Mode développement : rien ne part ; le message reste consultable dans « E-mails envoyés ».
      // Le texte complet est écrit dans le terminal : il contient les liens (mot de passe oublié, invitation) utiles en développement.
      this.transport = async (m) => { this.logger.log(`(non envoyé, mode développement) à ${m.to} : ${m.subject}\n${m.text}`); };
    }
  }

  /** Remplace le transport (tests). */
  useTransport(t: Transport) { this.transport = t; }

  async enqueue(trx: Trx, m: OutgoingMail) {
    const { text, html } = renderMail(m);
    return trx.insertInto('email_message').values({
      company_id: m.companyId, to_address: m.to, reply_to: m.replyTo ?? null, from_name: m.fromName ?? 'Kora ERP', subject: m.subject,
      text_body: text, html_body: html, kind: m.kind, entity_id: m.entityId ?? null, created_by: m.createdBy ?? null, last_error: null, sent_at: null,
    }).returning('id').executeTakeFirstOrThrow();
  }

  /** Envoie les messages dus. Plusieurs instances peuvent tourner : chaque message n'est pris qu'une fois (SKIP LOCKED). */
  async processQueue(limit = 20) {
    const summary = { sent: 0, retried: 0, failed: 0 };
    await this.db.platform(async (trx) => {
      const due = await trx.selectFrom('email_message').selectAll().where('status', '=', 'queued').where('next_attempt_at', '<=', new Date())
        .orderBy('next_attempt_at').limit(limit).forUpdate().skipLocked().execute();
      for (const m of due) {
        const fromAddress = /<([^>]+)>/.exec(config.mail.from)?.[1] ?? config.mail.from;
        try {
          await this.transport({ from: `"${m.from_name.replace(/"/g, '')}" <${fromAddress}>`, to: m.to_address, replyTo: m.reply_to ?? undefined, subject: m.subject, text: m.text_body, html: m.html_body });
          await trx.updateTable('email_message').set({ status: 'sent', sent_at: new Date(), attempts: m.attempts + 1, last_error: null }).where('id', '=', m.id).execute();
          summary.sent++;
        } catch (e) {
          const attempts = m.attempts + 1;
          const wait = RETRY_MINUTES[attempts - 1];
          await trx.updateTable('email_message').set({
            attempts, last_error: String((e as Error)?.message ?? e).slice(0, 500),
            ...(wait ? { next_attempt_at: new Date(Date.now() + wait * 60_000) } : { status: 'failed' }),
          }).where('id', '=', m.id).execute();
          if (wait) summary.retried++; else summary.failed++;
        }
      }
    });
    return summary;
  }

  onApplicationBootstrap() {
    if (!config.jobs.enabled) return;
    this.timer = setInterval(() => { this.processQueue().catch((e) => this.logger.error(e)); }, config.mail.intervalMs);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
