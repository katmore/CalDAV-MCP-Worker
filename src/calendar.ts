import { McpServer } from '@modelcontextprotocol/server';
import { createDAVClient } from 'tsdav';
import ICAL from 'ical.js';
import { z } from 'zod';
import { ConfigurationError, caldavUrl, guardedFetch, trustedHosts } from './transport';
import { assertResource, checkWrite, isAllowedLogin, isSeries, prepareCalendar, sameResource, creationResult } from './safety';

export type Props = { login: string; name: string; email: string };
export type CalendarEnv = { CALDAV_USERNAME: string; CALDAV_PASSWORD: string; ALLOWED_GITHUB_LOGIN: string; CALDAV_URL: string; CALDAV_TRUSTED_HOSTS?: string };
// Tests pass a fake CalDAV client in place of tsdav's.
export type ConnectDAV = typeof createDAVClient;


// A deliberately small, single-owner calendar MCP server.
// Access is enforced by GitHub OAuth callback AND before tool registration.
export class CalendarServer {
  constructor(readonly env: CalendarEnv, readonly props: Props, readonly connect: ConnectDAV = createDAVClient) {}
  server = new McpServer({ name: 'Private CalDAV Calendar', version: '0.1.1' });

  async init() {
    if (!isAllowedLogin(this.props?.login, this.env.ALLOWED_GITHUB_LOGIN)) {
      // Do not expose any calendar tool to accounts outside the allowlist.
      return;
    }

    const result = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    });
    const failure = (error: unknown) => ({ isError: true, ...result({
      error: error instanceof ConfigurationError ? error.message : 'CalDAV operation failed',
      reason: error instanceof Error ? error.name : 'unknown',
      // Do not expose exceptions or credentials.
    }) });

    const dav = async () => {
      const serverUrl = caldavUrl(this.env.CALDAV_URL);
      const client = await this.connect({
        serverUrl: serverUrl.href,
        credentials: {
          username: this.env.CALDAV_USERNAME,
          password: this.env.CALDAV_PASSWORD,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
        fetch: guardedFetch(trustedHosts(serverUrl, this.env.CALDAV_TRUSTED_HOSTS)),
      });
      return client;
    };

    const lookupCalendar = async (client: Awaited<ReturnType<typeof dav>>, calendarId: string) => {
      const calendars = await client.fetchCalendars();
      const calendar = calendars.find(c => c.url === calendarId);
      if (!calendar) throw new RangeError('Invalid calendar identifier');
      return calendar;
    };

    const getObject = async (client: Awaited<ReturnType<typeof dav>>, calendarId: string, resourceId: string) => {
      const calendar = await lookupCalendar(client, calendarId);
      // Restrict user-supplied resources to a calendar freshly discovered from the CalDAV server.
      assertResource(calendar.url, resourceId);
      const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [resourceId] });
      if (objects.length !== 1 || !sameResource(objects[0].url, resourceId)) throw new RangeError('Resource not found');
      assertResource(calendar.url, objects[0].url);
      return { calendar, object: objects[0] };
    };

    const summarize = (obj: { url: string; data?: string; etag?: string }) => {
      const c = prepareCalendar(obj.data || '');
      const entries = c.getAllSubcomponents('vevent');
      return {
        resourceId: obj.url,
        etag: obj.etag,
        events: entries.map(ev => ({
          uid: String(ev.getFirstPropertyValue('uid') || ''),
          title: String(ev.getFirstPropertyValue('summary') || ''),
          start: String(ev.getFirstPropertyValue('dtstart') || ''),
          end: String(ev.getFirstPropertyValue('dtend') || ''),
          rrule: String(ev.getFirstPropertyValue('rrule') || ''),
          recurrenceId: String(ev.getFirstPropertyValue('recurrence-id') || ''),
          location: String(ev.getFirstPropertyValue('location') || ''),
        })),
      };
    };

    this.server.registerTool('list_calendars', { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, description: 'Read calendars accessible to the connected CalDAV account.', inputSchema: z.object({}) }, async () => {
      try {
        const client = await dav();
        const calendars = await client.fetchCalendars();
        return result(calendars.map(c => ({ id: c.url, name: c.displayName || '(untitled)' })));
      } catch (e) { return failure(e); }
    });

    this.server.registerTool('list_events', { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, description: 'Read events from one calendar in a date interval. Recurring series are expanded with exception handling; a capped=true result is incomplete and must not be used to judge availability.', inputSchema: z.object({
      calendarId: z.string(),
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    }) }, async ({ calendarId, start, end }) => {
      try {
        if (new Date(end).getTime() <= new Date(start).getTime()) throw new RangeError('Invalid interval');
        if (new Date(end).getTime() - new Date(start).getTime() > 90 * 86400000) throw new RangeError('Limit search to 90 days');
        const client = await dav();
        const calendar = await lookupCalendar(client, calendarId);
        const objects = await client.fetchCalendarObjects({ calendar, timeRange: { start, end } });
        if (objects.length > 250) throw new RangeError('Too many resources; narrow the interval');
        const afterMs = new Date(start).getTime();
        const beforeMs = new Date(end).getTime();
        const occurrences: unknown[] = [];
        let capped = false;
        for (const obj of objects) {
          const root = prepareCalendar(obj.data);
          const components = root.getAllSubcomponents('vevent');
          const master = components.find(e => !e.hasProperty('recurrence-id'));
          // Resources holding only overridden occurrences need manual review; skip them and flag the result.
          if (!master) { capped = true; continue; }
          const event = new ICAL.Event(master);
          if (event.startDate.zone.tzid === 'floating' && !event.startDate.isDate) capped = true;
          for (const exception of components.filter(e => e.hasProperty('recurrence-id'))) {
            event.relateException(new ICAL.Event(exception));
          }
          const iterator = event.iterator();
          let count = 0;
          let next;
          while ((next = iterator.next()) && count++ < 20000) {
            const details = event.getOccurrenceDetails(next);
            const begins = details.startDate.toJSDate().getTime();
            const finishes = details.endDate.toJSDate().getTime();
            if (next.toJSDate().getTime() >= beforeMs) { capped = capped || event.isRecurring(); break; }
            if (begins < beforeMs && finishes > afterMs && details.item.component.getFirstPropertyValue('status') !== 'CANCELLED') {
              occurrences.push({
                calendarId, resourceId: obj.url,
                title: details.item.summary,
                start: new Date(begins).toISOString(),
                end: new Date(finishes).toISOString(),
                allDay: details.startDate.isDate,
                recurring: event.isRecurring(),
                recurrenceId: next.toString(),
                etag: obj.etag,
              });
            }
            if (occurrences.length > 500) throw new RangeError('Too many occurrences; narrow interval');
          }
          if (count >= 20000) capped = true;
        }
        occurrences.sort((a: any, b: any) => a.start.localeCompare(b.start));
        return result({ occurrences, capped, note: capped ? 'Recurring, floating-time, or iteration-limited data may be incomplete; do not infer availability. Inspect the full resource.' : undefined });
      } catch (e) { return failure(e); }
    });

    this.server.registerTool('get_event', { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, description: 'Read one full iCalendar resource (includes recurrence exceptions and alarms).', inputSchema: z.object({
      calendarId: z.string(), resourceId: z.string(),
    }) }, async ({ calendarId, resourceId }) => {
      try {
        const client = await dav();
        const { object } = await getObject(client, calendarId, resourceId);
        return result({ ...summarize(object), ical: object.data });
      } catch (e) { return failure(e); }
    });

    this.server.registerTool('create_event', { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, description: 'Create a single, nonrecurring timed appointment. Never create without the user explicitly asking for it.', inputSchema: z.object({
      calendarId: z.string(),
      title: z.string().min(1).max(500),
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
      location: z.string().optional(),
      description: z.string().optional(),
    }) }, async ({ calendarId, title, start, end, location, description }) => {
      try {
        if (new Date(end).getTime() <= new Date(start).getTime()) throw new RangeError('Invalid event interval');
        const client = await dav();
        const calendar = await lookupCalendar(client, calendarId);
        const root = new ICAL.Component(['vcalendar', [], []]);
        root.addPropertyWithValue('version', '2.0');
        root.addPropertyWithValue('prodid', '-//Private CalDAV MCP//EN');
        const ev = new ICAL.Component('vevent');
        const id = crypto.randomUUID();
        const uid = id + '@private-caldav-mcp';
        ev.addPropertyWithValue('uid', uid);
        ev.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
        ev.addPropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(start), true));
        ev.addPropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(end), true));
        ev.addPropertyWithValue('summary', title);
        if (location) ev.addPropertyWithValue('location', location);
        if (description) ev.addPropertyWithValue('description', description);
        root.addSubcomponent(ev);
        const resourceId = new URL(`${id}.ics`, calendar.url.endsWith('/') ? calendar.url : calendar.url + '/').href;
        await checkWrite(await client.createCalendarObject({ calendar, filename: `${id}.ics`, iCalString: root.toString(), headers: { 'If-None-Match': '*' } }));
        return result(await creationResult(uid, resourceId, async () => {
          const { object } = await getObject(client, calendarId, resourceId);
          return summarize(object);
        }));
      } catch (e) { return failure(e); }
    });

    this.server.registerTool('update_event', { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, description: 'Update a nonrecurring VEVENT resource. Refuses any recurring series or recurrence exception to prevent accidental edits.', inputSchema: z.object({
      calendarId: z.string(), resourceId: z.string(), etag: z.string().min(1),
      title: z.string().min(1).max(500).optional(),
      start: z.string().datetime({ offset: true }).optional(),
      end: z.string().datetime({ offset: true }).optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }) }, async ({ calendarId, resourceId, etag, title, start, end, location, description }) => {
      try {
        const client = await dav();
        const { object } = await getObject(client, calendarId, resourceId);
        const root = prepareCalendar(object.data);
        const events = root.getAllSubcomponents('vevent');
        if (events.length !== 1 || isSeries(events)) throw new RangeError('Recurring event edit refused');
        const ev = events[0];
        if (!object.etag || object.etag !== etag) throw new RangeError('Event changed; read again');
        if (ev.hasProperty('attendee') || ev.hasProperty('organizer') || (ev.getFirstPropertyValue('dtstart') as ICAL.Time)?.isDate) throw new RangeError('Invitation or all-day edits refused');
        if ((start !== undefined || end !== undefined) && ev.hasProperty('duration')) throw new RangeError('Duration-based time edits refused');
        ev.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
        ev.updatePropertyWithValue('sequence', Number(ev.getFirstPropertyValue('sequence') || 0) + 1);
        if (title !== undefined) ev.updatePropertyWithValue('summary', title);
        if (start !== undefined) ev.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(start), true));
        if (end !== undefined) ev.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(end), true));
        if (location !== undefined) ev.updatePropertyWithValue('location', location);
        if (description !== undefined) ev.updatePropertyWithValue('description', description);
        const st = ev.getFirstPropertyValue('dtstart') as ICAL.Time;
        const en = ev.getFirstPropertyValue('dtend') as ICAL.Time;
        if (st && en && en.compare(st) <= 0) throw new RangeError('End must be after start');
        await checkWrite(await client.updateCalendarObject({ calendarObject: { ...object, data: root.toString() } }));
        return result({ updated: true, resourceId });
      } catch (e) { return failure(e); }
    });

    this.server.registerTool('delete_event', { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, description: 'Delete a calendar event resource. This operation is irreversible and must be explicitly requested by the user. Recurring series require explicit acknowledgement.', inputSchema: z.object({
      calendarId: z.string(), resourceId: z.string(),
      etag: z.string().min(1),
      confirm: z.literal('DELETE'),
      confirmEntireSeries: z.boolean().default(false),
    }) }, async ({ calendarId, resourceId, etag, confirmEntireSeries }) => {
      try {
        const client = await dav();
        const { object } = await getObject(client, calendarId, resourceId);
        const root = prepareCalendar(object.data);
        const events = root.getAllSubcomponents('vevent');
        if (!object.etag || object.etag !== etag) throw new RangeError('Event changed; read again');
        if (events.some(e => e.hasProperty('attendee') || e.hasProperty('organizer'))) throw new RangeError('Invitation deletion refused');
        if (isSeries(events) && !confirmEntireSeries) {
          throw new RangeError('This is a recurrence; entire-series deletion requires confirmation');
        }
        await checkWrite(await client.deleteCalendarObject({ calendarObject: object }));
        return result({ deleted: true, resourceId });
      } catch (e) { return failure(e); }
    });
  }
}
