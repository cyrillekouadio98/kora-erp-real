import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomToken, sha256 } from '../../common/crypto';
import { config } from '../../config';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import { MailService } from '../mail/mail.service';
import { balance, OPEN_INVOICE } from './sales.service';

export const AUTO_REMINDERS = 'auto_reminders';
export interface DunningStep { days: number; subject: string; message: string }

/** Étapes proposées : courtoise, ferme, dernière relance avant recouvrement. */
export const DEFAULT_STEPS: DunningStep[] = [
  { days: 3, subject: 'Rappel — facture {facture}', message: "Bonjour {client},\n\nSauf erreur de notre part, la facture {facture} d'un montant restant de {montant}, échue le {echeance}, n'a pas encore été réglée. Merci de procéder au paiement ou de nous indiquer la date prévue.\n\nSi le règlement est déjà parti, merci de ne pas tenir compte de ce message.\n\nCordialement,\n{entreprise}" },
  { days: 15, subject: 'Deuxième relance — facture {facture}', message: "Bonjour {client},\n\nMalgré notre précédent rappel, la facture {facture} reste impayée : {montant} sont dus depuis le {echeance} ({jours} jours de retard). Merci de régulariser la situation dans les meilleurs délais.\n\nCordialement,\n{entreprise}" },
  { days: 30, subject: 'Dernière relance — facture {facture}', message: "Bonjour {client},\n\nLa facture {facture} ({montant}) est impayée depuis {jours} jours. Sans règlement ou proposition de votre part sous huit jours, nous serons contraints d'engager une procédure de recouvrement.\n\nCordialement,\n{entreprise}" },
];
/** Heure (UTC, soit l'heure d'Abidjan) à partir de laquelle part la tournée du jour. */
const SEND_HOUR = 8;
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const today = () => new Date().toISOString().slice(0, 10);
const fr = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' });

export function fill(template: string, v: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
}

/**
 * Relances automatiques des factures en retard : chaque matin, pour chaque entreprise qui a activé la
 * fonctionnalité, la facture reçoit l'étape la plus avancée qu'elle a atteinte et pas encore reçue.
 * Pas de relance sans adresse e-mail du client, ni pendant une promesse de paiement.
 */
@Injectable()
export class DunningService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Relances');
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: DatabaseService, private readonly mail: MailService) {}

  async settings(trx: TenantTrx) {
    const s = await trx.selectFrom('dunning_settings').selectAll().executeTakeFirst();
    return { enabled: s ? s.enabled : false, configured: !!s, steps: (s?.steps as DunningStep[] | undefined) ?? DEFAULT_STEPS, copyTo: s?.copy_to ?? null, lastRunOn: s?.last_run_on ?? null };
  }

  /** Factures à relancer aujourd'hui, avec l'étape à envoyer, ou la raison pour laquelle elles ne partent pas. */
  async due(trx: TenantTrx, steps: DunningStep[], now = today()) {
    const rows = await trx.selectFrom('sales_document as d').innerJoin('contact as c', (j) => j.onRef('c.id', '=', 'd.contact_id').onRef('c.company_id', '=', 'd.company_id'))
      .select((eb) => ['d.id', 'd.number', 'd.due_date', 'd.total_ttc', 'd.paid_amount', 'd.credited_amount', 'd.refunded_amount', 'c.name as contact_name', 'c.email',
        eb.selectFrom('sales_reminder as r').whereRef('r.document_id', '=', 'd.id').select((e) => e.fn.max('r.auto_step').as('m')).as('sent_step'),
        eb.selectFrom('sales_reminder as r').whereRef('r.document_id', '=', 'd.id').where('r.promised_on', '>=', now).select((e) => e.fn.max('r.promised_on').as('p')).as('promised_on')])
      .where('d.type', '=', 'invoice').where('d.status', 'in', OPEN_INVOICE).where('d.due_date', '<', now).orderBy('d.due_date').execute();
    const sorted = steps.map((s, i) => ({ ...s, step: i + 1 })).sort((a, b) => a.days - b.days);
    return rows.map((r) => {
      const daysLate = Math.floor((Date.parse(now) - Date.parse(r.due_date!)) / 86_400_000);
      const remaining = balance(r).remaining;
      const reached = sorted.filter((s) => s.days <= daysLate).pop();
      const sent = Number(r.sent_step ?? 0);
      const skip = remaining <= 0 ? 'soldée' : !reached ? 'pas encore au premier palier' : reached.step <= sent ? `étape ${reached.step} déjà envoyée`
        : r.promised_on ? `paiement promis pour le ${fr(String(r.promised_on))}` : !r.email ? 'client sans adresse e-mail' : null;
      return { id: r.id, number: r.number!, customer: r.contact_name, email: r.email, dueDate: r.due_date!, daysLate, remaining, step: reached?.step ?? null, sentStep: sent, skip, template: reached ?? null };
    });
  }

  /** Tournée d'une entreprise : envoie les relances dues et note chacune sur sa facture. */
  async runCompany(companyId: string) {
    return this.db.tenant({ companyId, userId: SYSTEM_USER, actorType: 'platform' }, async (trx) => {
      const s = await this.settings(trx);
      const company = await trx.selectFrom('company').select(['name', 'email']).where('id', '=', companyId).executeTakeFirstOrThrow();
      let sent = 0;
      for (const inv of await this.due(trx, s.steps)) {
        if (inv.skip || !inv.template) continue;
        const secret = randomToken(24);
        const share = await trx.insertInto('document_share').values({ company_id: companyId, document_id: inv.id, token_hash: sha256(secret), expires_at: new Date(Date.now() + 90 * 86_400_000), created_by: null, last_viewed_at: null })
          .returning('id').executeTakeFirstOrThrow();
        const v = { client: inv.customer, facture: inv.number, montant: `${inv.remaining.toLocaleString('fr-FR')} FCFA`, echeance: fr(inv.dueDate), jours: String(inv.daysLate), entreprise: company.name };
        for (const to of [inv.email!, ...(s.copyTo ? [s.copyTo] : [])]) {
          await this.mail.enqueue(trx, {
            companyId, to, kind: 'reminder', entityId: inv.id, fromName: company.name, replyTo: company.email,
            subject: fill(inv.template.subject, v), paragraphs: fill(inv.template.message, v).split(/\n{2,}/),
            action: { label: 'Consulter la facture', url: `${config.webUrl}/document?token=${encodeURIComponent(`${companyId}.${share.id}.${secret}`)}` },
          });
        }
        await trx.insertInto('sales_reminder').values({ company_id: companyId, document_id: inv.id, channel: 'email', auto_step: inv.template.step, promised_on: null, created_by: null,
          note: `Relance automatique n° ${inv.template.step} envoyée à ${inv.email} (${inv.daysLate} jours de retard)` }).execute();
        sent++;
      }
      await trx.insertInto('dunning_settings').values({ company_id: companyId, steps: JSON.stringify(s.steps), enabled: s.enabled, copy_to: s.copyTo, last_run_on: today() })
        .onConflict((oc) => oc.column('company_id').doUpdateSet({ last_run_on: today() })).execute();
      return { sent };
    });
  }

  /** Tournée quotidienne de toutes les entreprises concernées (après 8 h, une fois par jour). */
  async runAll() {
    if (new Date().getUTCHours() < SEND_HOUR) return { companies: 0, sent: 0 };
    const companies = await this.db.platform((trx) => trx.selectFrom('dunning_settings as s').innerJoin('company_feature as f', (j) => j.onRef('f.company_id', '=', 's.company_id').on('f.feature', '=', AUTO_REMINDERS))
      .innerJoin('company as c', 'c.id', 's.company_id').select('s.company_id').where('s.enabled', '=', true).where('c.status', '=', 'active')
      .where((eb) => eb.or([eb('s.last_run_on', 'is', null), eb('s.last_run_on', '<', today())])).execute());
    let sent = 0;
    for (const c of companies) {
      try { sent += (await this.runCompany(c.company_id)).sent; } catch (e) { this.logger.error(e); }
    }
    return { companies: companies.length, sent };
  }

  onApplicationBootstrap() {
    if (!config.jobs.enabled) return;
    this.timer = setInterval(() => { this.runAll().catch((e) => this.logger.error(e)); }, 15 * 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
