import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWhenReadOnly, Permission, Tenant } from '../../common/decorators';
import type { TenantInfo } from '../../common/request-context';
import { parse } from '../../common/validation';
import { CalendarService } from './calendar.service';

const text = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable().optional();
const instant = z.string().datetime({ offset: true, message: 'Date et heure invalides' });
const AppointmentSchema = z.object({
  title: z.string().trim().min(1, { message: 'Donnez un titre au rendez-vous' }).max(160),
  kind: z.enum(['meeting', 'call', 'visit', 'delivery', 'other']).optional(),
  start: instant, end: instant, allDay: z.boolean().optional(),
  location: text(200), notes: text(2000),
  contactId: z.string().uuid().nullable().optional(),
  attendeeIds: z.array(z.string().uuid()).max(50).optional(),
  reminderMinutes: z.number().int().min(0).max(10080).nullable().optional(),
}).strict();

@ApiTags('Calendrier')
@Controller('company/calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Permission('calendar.read') @AllowWhenReadOnly()
  @Get('appointments')
  list(@Tenant() t: TenantInfo, @Query() query: unknown) {
    const q = parse(z.object({
      from: instant, to: instant, userId: z.string().uuid().optional(), contactId: z.string().uuid().optional(), includeCancelled: z.enum(['true', 'false']).optional(),
    }), query);
    return this.calendar.list(t, { ...q, includeCancelled: q.includeCancelled === 'true' });
  }

  @Permission('calendar.read') @AllowWhenReadOnly()
  @Get('people')
  people(@Tenant() t: TenantInfo) { return this.calendar.people(t); }

  @Permission('calendar.read') @AllowWhenReadOnly()
  @Get('appointments/:id')
  get(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.calendar.get(t, id); }

  /** Fichier .ics à ajouter à l'agenda du téléphone ou de la messagerie. */
  @Permission('calendar.read') @AllowWhenReadOnly()
  @Get('appointments/:id/ics')
  async ics(@Tenant() t: TenantInfo, @Param('id') id: string, @Res() res: Response) {
    const f = await this.calendar.ics(t, id);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.send(f.body);
  }

  @Permission('calendar.create')
  @Post('appointments')
  create(@Tenant() t: TenantInfo, @Body() body: unknown) { return this.calendar.create(t, parse(AppointmentSchema, body)); }

  @Permission('calendar.update')
  @Patch('appointments/:id')
  update(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) { return this.calendar.update(t, id, parse(AppointmentSchema.partial(), body)); }

  @Permission('calendar.update') @HttpCode(200)
  @Post('appointments/:id/status')
  status(@Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.calendar.setStatus(t, id, parse(z.object({ status: z.enum(['planned', 'done', 'cancelled']) }).strict(), body).status);
  }

  @Permission('calendar.cancel')
  @Delete('appointments/:id')
  remove(@Tenant() t: TenantInfo, @Param('id') id: string) { return this.calendar.remove(t, id); }
}
