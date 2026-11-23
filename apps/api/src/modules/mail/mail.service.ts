import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { config } from '../../config';
import { badRequest, conflict } from '../../common/errors';
import { decrypt, encrypt } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';
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
  /** Transport de la variable SMTP_URL (ou du mode développement). */
  private readonly envTransport: Transport;
  /** Transport imposé par les tests. */
  private testTransport?: Transport;
  /** Transport des réglages de la console, reconstruit quand ils changent. */
  private console?: { key: string; transport: Transport };
  /** Mode constaté au dernier envoi : les réglages de la console priment sur SMTP_URL. */
  mode: 'smtp' | 'development' = config.mail.smtpUrl ? 'smtp' : 'development';

  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {
    if (config.mail.smtpUrl) {
      const smtp = nodemailer.createTransport(config.mail.smtpUrl);
      this.envTransport = async (m) => { await smtp.sendMail(m); };
    } else {
      // Mode développement : rien ne part ; le message reste consultable dans « E-mails envoyés ».
      // Le texte complet est écrit dans le terminal : il contient les liens (mot de passe oublié, invitation) utiles en développement.
      this.envTransport = async (m) => { this.logger.log(`(non envoyé, mode développement) à ${m.to} : ${m.subject}\n${m.text}`); };
    }
  }

  /** Remplace le transport (tests). */
  useTransport(t: Transport) { this.testTransport = t; }

  /** Transport et adresse d'expédition en vigueur : réglages de la console, sinon SMTP_URL, sinon mode développement. */
  private async resolve(trx: Trx): Promise<{ transport: Transport; fromAddress: string }> {
    const envFrom = /<([^>]+)>/.exec(config.mail.from)?.[1] ?? config.mail.from;
    if (this.testTransport) return { transport: this.testTransport, fromAddress: envFrom };
    const s = await trx.selectFrom('platform_mail_settings').selectAll().executeTakeFirst();
    if (!s) { this.mode = config.mail.smtpUrl ? 'smtp' : 'development'; return { transport: this.envTransport, fromAddress: envFrom }; }
    const key = new Date(s.updated_at).toISOString();
    if (this.console?.key !== key) {
      const smtp = nodemailer.createTransport(smtpOptions(s, decrypt(s.password_enc)));
      this.console = { key, transport: async (m) => { await smtp.sendMail(m); } };
    }
    this.mode = 'smtp';
    return { transport: this.console.transport, fromAddress: s.from_address };
  }

  // ------------------------------------------------------------------ réglages (console éditeur)
  /** Réglages en vigueur, sans le mot de passe. */
  async settings() {
    return this.db.platform(async (trx) => {
      const s = await trx.selectFrom('platform_mail_settings').selectAll().executeTakeFirst();
      const stats = await trx.selectFrom('email_message').select(['status', (eb) => eb.fn.countAll<string>().as('n')])
        .where('created_at', '>=', new Date(Date.now() - 7 * 86_400_000)).groupBy('status').execute();
      const lastError = await trx.selectFrom('email_message').select(['last_error', 'to_address', 'created_at']).where('last_error', 'is not', null).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
      return {
        source: s ? 'console' : config.mail.smtpUrl ? 'environment' : 'none',
        settings: s ? { host: s.host, port: s.port, secure: s.secure, username: s.username, fromAddress: s.from_address, updatedAt: s.updated_at } : null,
        lastWeek: Object.fromEntries(stats.map((r) => [r.status, Number(r.n)])),
        lastError: lastError ? { message: lastError.last_error, at: lastError.created_at } : null,
      };
    });
  }

  /** Vérifie la connexion au serveur (identifiants compris), puis enregistre ; le mot de passe peut être conservé. */
  async saveSettings(actorId: string, input: { host: string; port: number; secure: boolean; username: string; password?: string; fromAddress: string }) {
    return this.db.platform(async (trx) => {
      const prev = await trx.selectFrom('platform_mail_settings').select('password_enc').forUpdate().executeTakeFirst();
      const password = input.password ?? (prev ? decrypt(prev.password_enc) : null);
      if (!password) throw badRequest('Indiquez le mot de passe de la boîte d’envoi.', undefined, 'password_required');
      try {
        await nodemailer.createTransport(smtpOptions(input, password)).verify();
      } catch (e) {
        throw badRequest(`Le serveur ${input.host}:${input.port} refuse la connexion : ${String((e as Error)?.message ?? e).slice(0, 300)}`, undefined, 'smtp_verify_failed');
      }
      const row = { host: input.host, port: input.port, secure: input.secure, username: input.username, password_enc: encrypt(password), from_address: input.fromAddress, updated_by: actorId, updated_at: new Date() };
      await trx.insertInto('platform_mail_settings').values({ id: true, ...row }).onConflict((oc) => oc.column('id').doUpdateSet(row)).execute();
      await this.audit.platform(trx, actorId, { action: 'mail_settings.saved', entityType: 'platform_mail_settings', data: { host: input.host, port: input.port, secure: input.secure, username: input.username, fromAddress: input.fromAddress, passwordChanged: !!input.password } });
      this.console = undefined;
      return { ok: true };
    });
  }

  /** Revient à la variable SMTP_URL (ou au mode développement). */
  async deleteSettings(actorId: string) {
    return this.db.platform(async (trx) => {
      await trx.deleteFrom('platform_mail_settings').execute();
      await this.audit.platform(trx, actorId, { action: 'mail_settings.deleted', entityType: 'platform_mail_settings' });
      this.console = undefined;
      return { ok: true };
    });
  }

  /** Envoie tout de suite un e-mail de test avec les réglages en vigueur ; l'erreur du serveur est renvoyée telle quelle. */
  async sendTest(actorId: string, to: string) {
    return this.db.platform(async (trx) => {
      const { transport, fromAddress } = await this.resolve(trx);
      if (this.mode === 'development' && !this.testTransport) throw conflict('Aucun serveur d’envoi n’est réglé : les e-mails ne partent pas.', 'no_smtp');
      const { text, html } = renderMail({ paragraphs: ['Bonjour,', "Ceci est un e-mail de test envoyé depuis la console de Kora ERP. S'il vous parvient, l'envoi des e-mails fonctionne."] });
      try {
        await transport({ from: `"Kora ERP" <${fromAddress}>`, to, subject: 'Kora ERP — e-mail de test', text, html });
      } catch (e) {
        throw badRequest(`Échec de l'envoi : ${String((e as Error)?.message ?? e).slice(0, 300)}`, undefined, 'smtp_send_failed');
      }
      await this.audit.platform(trx, actorId, { action: 'mail_settings.tested', entityType: 'platform_mail_settings', data: { to } });
      return { ok: true, from: fromAddress };
    });
  }

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
      const { transport, fromAddress } = due.length ? await this.resolve(trx) : { transport: this.envTransport, fromAddress: '' };
      for (const m of due) {
        try {
          await transport({ from: `"${m.from_name.replace(/"/g, '')}" <${fromAddress}>`, to: m.to_address, replyTo: m.reply_to ?? undefined, subject: m.subject, text: m.text_body, html: m.html_body });
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

/** Options nodemailer : SSL direct (465) ou STARTTLS exigé (587), délais courts pour ne pas bloquer la file. */
export function smtpOptions(s: { host: string; port: number; secure: boolean; username: string }, password: string) {
  return { host: s.host, port: s.port, secure: s.secure, requireTLS: !s.secure, auth: { user: s.username, pass: password },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };
}
