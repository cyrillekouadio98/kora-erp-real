import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'kysely';
import { config } from '../../config';
import { badRequest, conflict, notFound } from '../../common/errors';
import { isUuid } from '../../common/ids';
import type { TenantInfo } from '../../common/request-context';
import { assertSiteAccess, siteScope, workingSite } from '../../common/sites';
import { DatabaseService, TenantTrx } from '../../db/database.service';
import type { AppointmentKind } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';

export const APPOINTMENT_KINDS: Record<AppointmentKind, string> = { meeting: 'Réunion', call: 'Appel', visit: 'Visite client', delivery: 'Livraison', other: 'Autre' };
export type AppointmentStatus = 'planned' | 'done' | 'cancelled';

export interface AppointmentInput {
  title: string; kind?: AppointmentKind; start: string; end: string; allDay?: boolean; location?: string | null; notes?: string | null;
  contactId?: string | null; attendeeIds?: string[]; reminderMinutes?: number | null;
}

/** Heure locale ivoirienne (GMT) pour les e-mails : « mardi 4 novembre 2026 à 10:00 ». */
const TZ = 'Africa/Abidjan';
const when = (start: Date, end: Date, allDay: boolean) => {
  const day = (d: Date) => d.toLocaleDateString('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hour = (d: Date) => d.toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  if (allDay) return day(start) === day(end) ? `${day(start)} (toute la journée)` : `du ${day(start)} au ${day(end)}`;
  return day(start) === day(end) ? `${day(start)} de ${hour(start)} à ${hour(end)}` : `du ${day(start)} à ${hour(start)} au ${day(end)} à ${hour(end)}`;
};
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/**
 * Calendrier : rendez-vous de l'entreprise, avec leurs participants (utilisateurs Kora) et, au besoin, le client
 * ou le fournisseur concerné. Les participants sont prévenus par e-mail ; un rappel part avant le rendez-vous.
 */
@Injectable()
export class CalendarService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly logger = new Logger('Rappels');
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly mail: MailService) {}

  onApplicationBootstrap() {
    if (!config.jobs.enabled) return;
    this.timer = setInterval(() => { this.sendReminders().catch((e) => this.logger.error(e)); }, 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private base(trx: TenantTrx) {
    return trx.selectFrom('appointment as a')
      .leftJoin('contact as c', (j) => j.onRef('c.id', '=', 'a.contact_id').onRef('c.company_id', '=', 'a.company_id'))
      .innerJoin('site as s', (j) => j.onRef('s.id', '=', 'a.site_id').onRef('s.company_id', '=', 'a.company_id'))
      .leftJoin('user_account as u', 'u.id', 'a.created_by')
      .selectAll('a').select(['c.name as contact_name', 'c.code as contact_code', 'c.phone as contact_phone', 's.name as site_name', 'u.full_name as created_by_name']);
  }

  /** Visible : les rendez-vous des sites affichés, et toujours ceux où l'on est participant. */
  private visible<Q extends { where: (...a: any[]) => Q }>(q: Q, t: TenantInfo): Q {
    const scope = siteScope(t);
    if (!scope) return q;
    return q.where((eb: any) => eb.or([
      eb('a.site_id', 'in', scope.length ? scope : ['00000000-0000-0000-0000-000000000000']),
      eb.exists(eb.selectFrom('appointment_attendee as x').select('x.user_id').whereRef('x.appointment_id', '=', 'a.id').where('x.user_id', '=', t.ctx.userId)),
    ]));
  }

  private async present(trx: TenantTrx, rows: Awaited<ReturnType<ReturnType<CalendarService['base']>['execute']>>) {
    const ids = rows.map((r) => r.id);
    const people = ids.length ? await trx.selectFrom('appointment_attendee as x').innerJoin('user_account as u', 'u.id', 'x.user_id')
      .select(['x.appointment_id', 'u.id', 'u.full_name', 'u.email']).where('x.appointment_id', 'in', ids).orderBy('u.full_name').execute() : [];
    return rows.map((a) => ({
      id: a.id, title: a.title, kind: a.kind, start: a.start_at, end: a.end_at, allDay: a.all_day, location: a.location, notes: a.notes, status: a.status,
      reminderMinutes: a.reminder_minutes, remindedAt: a.reminded_at, siteId: a.site_id, siteName: a.site_name,
      contact: a.contact_id ? { id: a.contact_id, name: a.contact_name, code: a.contact_code, phone: a.contact_phone } : null,
      attendees: people.filter((p) => p.appointment_id === a.id).map((p) => ({ id: p.id, name: p.full_name, email: p.email })),
      createdBy: a.created_by, createdByName: a.created_by_name, createdAt: a.created_at,
    }));
  }

  async list(t: TenantInfo, f: { from: string; to: string; userId?: string; contactId?: string; includeCancelled?: boolean }) {
    return this.db.tenant(t.ctx, async (trx) => {
      let q = this.visible(this.base(trx), t).where('a.start_at', '<', new Date(f.to)).where('a.end_at', '>=', new Date(f.from)).orderBy('a.start_at').limit(2000);
      if (f.userId) q = q.where((eb) => eb.exists(eb.selectFrom('appointment_attendee as x').select('x.user_id').whereRef('x.appointment_id', '=', 'a.id').where('x.user_id', '=', f.userId!)));
      if (f.contactId) q = q.where('a.contact_id', '=', f.contactId);
      if (!f.includeCancelled) q = q.where('a.status', '!=', 'cancelled');
      return this.present(trx, await q.execute());
    });
  }

  private async row(trx: TenantTrx, t: TenantInfo, id: string) {
    if (!isUuid(id)) throw notFound('Rendez-vous');
    const a = await this.visible(this.base(trx), t).where('a.id', '=', id).executeTakeFirst();
    if (!a) throw notFound('Rendez-vous');
    return a;
  }

  async get(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => (await this.present(trx, [await this.row(trx, t, id)]))[0]);
  }

  /** Personnes qu'on peut inviter : les utilisateurs actifs de l'entreprise. */
  async people(t: TenantInfo) {
    return this.db.tenant(t.ctx, (trx) => trx.selectFrom('company_membership as m').innerJoin('user_account as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.full_name as name', 'u.email']).where('m.status', '=', 'active').orderBy('u.full_name').execute());
  }

  /** Contrôles communs ; renvoie les participants retenus (l'auteur à défaut). */
  private async check(trx: TenantTrx, t: TenantInfo, input: Partial<AppointmentInput>, start: Date, end: Date) {
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest('Date ou heure invalide.', undefined, 'invalid_date');
    if (end < start) throw badRequest('La fin du rendez-vous précède son début.', undefined, 'end_before_start');
    if (end.getTime() - start.getTime() > 31 * 86400_000) throw badRequest('Un rendez-vous dure au plus 31 jours.', undefined, 'too_long');
    if (input.contactId && !(await trx.selectFrom('contact').select('id').where('id', '=', input.contactId).executeTakeFirst())) {
      throw badRequest('Client ou fournisseur introuvable.', undefined, 'unknown_contact');
    }
    if (input.attendeeIds === undefined) return undefined;
    const ids = [...new Set(input.attendeeIds)];
    if (ids.length) {
      const members = await trx.selectFrom('company_membership').select('user_id').where('status', '=', 'active').where('user_id', 'in', ids).execute();
      if (members.length !== ids.length) throw badRequest("Un participant n'est pas (ou plus) utilisateur de l'entreprise.", undefined, 'unknown_attendee');
    }
    return ids.length ? ids : [t.ctx.userId];
  }

  /** Rendez-vous déjà prévus pour les mêmes participants sur le même créneau (avertissement, pas un refus). */
  private async conflicts(trx: TenantTrx, id: string, userIds: string[], start: Date, end: Date) {
    if (!userIds.length) return [];
    const rows = await trx.selectFrom('appointment as a').innerJoin('appointment_attendee as x', (j) => j.onRef('x.appointment_id', '=', 'a.id').onRef('x.company_id', '=', 'a.company_id'))
      .innerJoin('user_account as u', 'u.id', 'x.user_id')
      .select(['a.id', 'a.title', 'a.start_at', 'a.end_at', 'u.full_name']).where('a.id', '!=', id).where('a.status', '=', 'planned').where('a.all_day', '=', false)
      .where('x.user_id', 'in', userIds).where('a.start_at', '<', end).where('a.end_at', '>', start).orderBy('a.start_at').execute();
    return rows.map((r) => ({ appointmentId: r.id, title: r.title, start: r.start_at, end: r.end_at, person: r.full_name }));
  }

  /** Prévient les participants (sauf l'auteur de la modification). */
  private async notify(trx: TenantTrx, t: TenantInfo, appointmentId: string, userIds: string[], subject: string, lead: string) {
    const others = userIds.filter((u) => u !== t.ctx.userId);
    if (!others.length) return;
    const a = await this.base(trx).where('a.id', '=', appointmentId).executeTakeFirstOrThrow();
    const company = await trx.selectFrom('company').select('name').where('id', '=', t.companyId).executeTakeFirstOrThrow();
    const by = await trx.selectFrom('user_account').select('full_name').where('id', '=', t.ctx.userId).executeTakeFirstOrThrow();
    const users = await trx.selectFrom('user_account').select(['email']).where('id', 'in', others).execute();
    for (const u of users) {
      await this.mail.enqueue(trx, {
        companyId: t.companyId, to: u.email, kind: 'appointment', entityId: appointmentId, fromName: company.name, createdBy: t.ctx.userId,
        subject: `${subject} — ${a.title}`,
        paragraphs: [`${lead} par ${by.full_name} :`, `${APPOINTMENT_KINDS[a.kind]} « ${a.title} », ${when(a.start_at, a.end_at, a.all_day)}.`,
          ...(a.location ? [`Lieu : ${a.location}`] : []), ...(a.contact_name ? [`Avec : ${a.contact_name}${a.contact_phone ? ` (${a.contact_phone})` : ''}`] : []), ...(a.notes ? [a.notes] : [])],
        action: { label: 'Ouvrir le calendrier', url: `${config.webUrl}/app/calendrier?rdv=${appointmentId}` },
      });
    }
  }

  async create(t: TenantInfo, input: AppointmentInput) {
    const siteId = workingSite(t);
    assertSiteAccess(t, siteId);
    return this.db.tenant(t.ctx, async (trx) => {
      const start = new Date(input.start), end = new Date(input.end);
      const attendees = (await this.check(trx, t, { ...input, attendeeIds: input.attendeeIds ?? [] }, start, end))!;
      const a = await trx.insertInto('appointment').values({
        company_id: t.companyId, title: input.title, kind: input.kind ?? 'meeting', start_at: start, end_at: end, all_day: input.allDay ?? false,
        location: input.location ?? null, notes: input.notes ?? null, contact_id: input.contactId ?? null, reminder_minutes: input.reminderMinutes ?? null,
        created_by: t.ctx.userId, ...(siteId ? { site_id: siteId } : {}),
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('appointment_attendee').values(attendees.map((user_id) => ({ company_id: t.companyId, appointment_id: a.id, user_id }))).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'appointment.created', entityType: 'appointment', entityId: a.id, data: { title: input.title, start: input.start } });
      await this.notify(trx, t, a.id, attendees, 'Nouveau rendez-vous', 'Vous êtes invité(e) à un rendez-vous');
      const conflicts = await this.conflicts(trx, a.id, attendees, start, end);
      return { ...(await this.present(trx, [await this.row(trx, t, a.id)]))[0], conflicts };
    });
  }

  async update(t: TenantInfo, id: string, input: Partial<AppointmentInput>) {
    return this.db.tenant(t.ctx, async (trx) => {
      const before = await this.row(trx, t, id);
      if (before.status === 'cancelled') throw conflict('Ce rendez-vous est annulé : reprogrammez-le avant de le modifier.', 'appointment_cancelled');
      const start = input.start ? new Date(input.start) : before.start_at, end = input.end ? new Date(input.end) : before.end_at;
      const attendees = await this.check(trx, t, input, start, end);
      const patch: Record<string, unknown> = {};
      const cols = { title: 'title', kind: 'kind', allDay: 'all_day', location: 'location', notes: 'notes', contactId: 'contact_id', reminderMinutes: 'reminder_minutes' } as const;
      for (const [k, col] of Object.entries(cols)) if ((input as any)[k] !== undefined) patch[col] = (input as any)[k];
      const moved = start.getTime() !== new Date(before.start_at).getTime() || end.getTime() !== new Date(before.end_at).getTime();
      if (moved) Object.assign(patch, { start_at: start, end_at: end });
      if (moved || input.reminderMinutes !== undefined) patch.reminded_at = null; // le rappel repart pour le nouvel horaire
      if (Object.keys(patch).length) await trx.updateTable('appointment').set(patch).where('id', '=', id).execute();
      const old = (await trx.selectFrom('appointment_attendee').select('user_id').where('appointment_id', '=', id).execute()).map((r) => r.user_id);
      if (attendees) {
        await trx.deleteFrom('appointment_attendee').where('appointment_id', '=', id).execute();
        await trx.insertInto('appointment_attendee').values(attendees.map((user_id) => ({ company_id: t.companyId, appointment_id: id, user_id }))).execute();
      }
      const now = attendees ?? old;
      const added = now.filter((u) => !old.includes(u)), kept = now.filter((u) => old.includes(u));
      await this.audit.tenant(trx, t.ctx, { action: 'appointment.updated', entityType: 'appointment', entityId: id, data: { title: before.title, fields: Object.keys(input) } });
      await this.notify(trx, t, id, added, 'Nouveau rendez-vous', 'Vous êtes invité(e) à un rendez-vous');
      if (moved || input.location !== undefined) await this.notify(trx, t, id, kept, 'Rendez-vous modifié', 'Ce rendez-vous a été modifié');
      const conflicts = await this.conflicts(trx, id, now, start, end);
      return { ...(await this.present(trx, [await this.row(trx, t, id)]))[0], conflicts };
    });
  }

  /** Fait, annulé ou de nouveau prévu ; l'annulation prévient les participants. */
  async setStatus(t: TenantInfo, id: string, status: AppointmentStatus) {
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.row(trx, t, id);
      if (a.status === status) return (await this.present(trx, [a]))[0];
      await trx.updateTable('appointment').set({ status, ...(status === 'planned' ? { reminded_at: null } : {}) }).where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: `appointment.${status}`, entityType: 'appointment', entityId: id, data: { title: a.title } });
      const users = (await trx.selectFrom('appointment_attendee').select('user_id').where('appointment_id', '=', id).execute()).map((r) => r.user_id);
      if (status === 'cancelled') await this.notify(trx, t, id, users, 'Rendez-vous annulé', 'Ce rendez-vous a été annulé');
      if (status === 'planned' && a.status === 'cancelled') await this.notify(trx, t, id, users, 'Rendez-vous reprogrammé', 'Ce rendez-vous est de nouveau prévu');
      return (await this.present(trx, [await this.row(trx, t, id)]))[0];
    });
  }

  async remove(t: TenantInfo, id: string) {
    return this.db.tenant(t.ctx, async (trx) => {
      const a = await this.row(trx, t, id);
      await trx.deleteFrom('appointment').where('id', '=', id).execute();
      await this.audit.tenant(trx, t.ctx, { action: 'appointment.deleted', entityType: 'appointment', entityId: id, data: { title: a.title, start: a.start_at } });
      return { ok: true };
    });
  }

  /** Fichier iCalendar : ajoute le rendez-vous à l'agenda du téléphone ou de la messagerie. */
  async ics(t: TenantInfo, id: string) {
    const a = await this.get(t, id);
    const company = await this.db.tenant(t.ctx, (trx) => trx.selectFrom('company').select('name').where('id', '=', t.companyId).executeTakeFirstOrThrow());
    const start = new Date(a.start), end = new Date(a.end);
    const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kora ERP//Calendrier//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      `UID:${a.id}@kora-erp`, `DTSTAMP:${icsDate(new Date())}`,
      ...(a.allDay ? [`DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(new Date(end.getTime() + 86400_000))}`] : [`DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`]),
      `SUMMARY:${icsText(a.title)}`, ...(a.location ? [`LOCATION:${icsText(a.location)}`] : []),
      `DESCRIPTION:${icsText([APPOINTMENT_KINDS[a.kind as AppointmentKind], a.contact ? `Avec ${a.contact.name}` : '', a.notes ?? ''].filter(Boolean).join('\n'))}`,
      `ORGANIZER;CN=${icsText(company.name)}:mailto:no-reply@kora.local`, `STATUS:${a.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      ...(a.reminderMinutes !== null ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(a.title)}`, `TRIGGER:-PT${a.reminderMinutes}M`, 'END:VALARM'] : []),
      'END:VEVENT', 'END:VCALENDAR',
    ];
    return { filename: `rendez-vous-${start.toISOString().slice(0, 10)}.ics`, body: `${lines.join('\r\n')}\r\n` };
  }

  /** Rappels dus : un e-mail à chaque participant, une seule fois par horaire. */
  async sendReminders() {
    let sent = 0;
    await this.db.platform(async (trx) => {
      const due = await trx.selectFrom('appointment as a').innerJoin('company as c', 'c.id', 'a.company_id')
        .select(['a.id', 'a.company_id', 'a.title', 'a.kind', 'a.start_at', 'a.end_at', 'a.all_day', 'a.location', 'c.name as company'])
        .where('a.status', '=', 'planned').where('a.reminder_minutes', 'is not', null).where('a.reminded_at', 'is', null)
        .where(sql<boolean>`a.start_at - make_interval(mins => a.reminder_minutes) <= now()`).where('a.start_at', '>', sql<Date>`now() - interval '1 hour'`)
        .forUpdate('a').skipLocked().limit(100).execute();
      for (const a of due) {
        const people = await trx.selectFrom('appointment_attendee as x').innerJoin('user_account as u', 'u.id', 'x.user_id')
          .select('u.email').where('x.company_id', '=', a.company_id).where('x.appointment_id', '=', a.id).execute();
        for (const p of people) {
          await this.mail.enqueue(trx as any, {
            companyId: a.company_id, to: p.email, kind: 'appointment_reminder', entityId: a.id, fromName: a.company,
            subject: `Rappel : ${a.title}`,
            paragraphs: [`Rappel de votre rendez-vous : ${APPOINTMENT_KINDS[a.kind]} « ${a.title} », ${when(a.start_at, a.end_at, a.all_day)}.`, ...(a.location ? [`Lieu : ${a.location}`] : [])],
            action: { label: 'Ouvrir le calendrier', url: `${config.webUrl}/app/calendrier?rdv=${a.id}` },
          });
          sent++;
        }
        await trx.updateTable('appointment').set({ reminded_at: new Date() }).where('company_id', '=', a.company_id).where('id', '=', a.id).execute();
      }
    });
    return { sent };
  }
}
