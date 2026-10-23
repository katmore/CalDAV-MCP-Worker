import { McpServer } from '@modelcontextprotocol/server';
import { createDAVClient } from 'tsdav';
import ICAL from 'ical.js';
import { z } from 'zod';
import { ConfigurationError, caldavUrl, guardedFetch, trustedHosts } from './transport';
import { assertResource, checkWrite, isAllowedLogin, isSeries, prepareCalendar, sameResource, creationResult } from './checks';
import { cancelOccurrence, editOccurrence, editOneOff, editSeries, endSeriesBefore, isDateOnly, parseRule, setTime, splitSeriesAt } from './recurrence';
import { isKnownZone, localTime, vtimezone } from './timezone';

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

    const resourceUrl = (calendarUrl: string, id: string) => new URL(`${id}.ics`, calendarUrl.endsWith('/') ? calendarUrl : calendarUrl + '/').href;
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

    // A start or end: a date-time with an offset, or a YYYY-MM-DD date for an all-day event.
    const when = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
    const SCOPES = z.enum(['occurrence', 'thisAndFollowing', 'entireSeries']).default('occurrence');
    const rrule = z.string().min(1).max(500).regex(/^[A-Za-z0-9=;,:+\-]+$/);
    // Changing or deleting an event that has guests can send each of them an email, so it takes a deliberate extra confirmation.
    const confirmGuests = z.literal('NOTIFY GUESTS').optional();
    const guestsNeedConfirmation = (events: ICAL.Component[], confirmed: unknown) => {
      if (!confirmed && events.some(e => e.hasProperty('attendee') || e.hasProperty('organizer'))) {
        throw new RangeError('This event has guests and the change may email them; ask the user, then pass confirmGuests: "NOTIFY GUESTS"');
      }
    };

    this.server.registerTool('create_event', { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, description: 'Create an event. Timed: start and end as date-times with an offset. All-day: start (and optionally end, the last day, inclusive) as YYYY-MM-DD dates. To make it repeat pass rrule, such as FREQ=WEEKLY;BYDAY=MO or FREQ=MONTHLY;BYDAY=1SA;COUNT=12. For a repeating timed event also pass timezone (an IANA name such as America/Los_Angeles) so it stays at the same local time across daylight saving. Never create without the user explicitly asking for it.', inputSchema: z.object({
      calendarId: z.string(),
      title: z.string().min(1).max(500),
      start: when,
      end: when.optional(),
      timezone: z.string().min(1).max(100).optional(),
      rrule: rrule.optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }) }, async ({ calendarId, title, start, end, timezone, rrule, location, description }) => {
      try {
        const allDay = isDateOnly(start);
        if (isDateOnly(end ?? start) !== allDay) throw new RangeError('Give both start and end as dates, or both as date-times');
        if (!allDay && end === undefined) throw new RangeError('A timed event needs an end');
        if (timezone !== undefined && !isKnownZone(timezone)) throw new RangeError('Unknown timezone');
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
        let first: ICAL.Time, last: ICAL.Time;
        if (allDay) {
          first = ICAL.Time.fromDateString(start);
          last = ICAL.Time.fromDateString(end ?? start);
          last.adjust(1, 0, 0, 0);
          if (last.compare(first) <= 0) throw new RangeError('Invalid event interval');
        } else {
          if (new Date(end!).getTime() <= new Date(start).getTime()) throw new RangeError('Invalid event interval');
          if (timezone && timezone !== 'UTC') {
            const vt = vtimezone(timezone, new Date(start).getTime());
            const zone = new ICAL.Timezone(vt);
            root.addSubcomponent(vt);
            first = localTime(timezone, new Date(start).getTime(), zone);
            last = localTime(timezone, new Date(end!).getTime(), zone);
          } else {
            first = ICAL.Time.fromJSDate(new Date(start), true);
            last = ICAL.Time.fromJSDate(new Date(end!), true);
          }
        }
        setTime(ev, 'dtstart', first);
        setTime(ev, 'dtend', last);
        ev.addPropertyWithValue('summary', title);
        if (location) ev.addPropertyWithValue('location', location);
        if (description) ev.addPropertyWithValue('description', description);
        if (rrule) ev.addPropertyWithValue('rrule', parseRule(rrule));
        root.addSubcomponent(ev);
        const resourceId = resourceUrl(calendar.url, id);
        await checkWrite(await client.createCalendarObject({ calendar, filename: `${id}.ics`, iCalString: root.toString(), headers: { 'If-None-Match': '*' } }));
        const created = await creationResult(uid, resourceId, async () => {
          const { object } = await getObject(client, calendarId, resourceId);
          return summarize(object);
        });
        const drifts = rrule && !allDay && !timezone;
        return result(drifts ? { ...created, note: 'No timezone was given, so this repeats in UTC and will shift by an hour across daylight saving.' } : created);
      } catch (e) { return failure(e); }
    });

    this.server.registerTool('update_event', { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, description: 'Update an event: title, start, end, location, description, and rrule (to change how it repeats, or to make a one-off repeat). Dates for all-day events are YYYY-MM-DD, and end is the last day. For a repeating event choose scope: occurrence (just the one in occurrence, its start as listed by list_events), thisAndFollowing (that occurrence and every later one), or entireSeries (the whole series; do not pass occurrence). Moving only start keeps the length. Changing an event that has guests can email them an update: ask the user first, then pass confirmGuests: "NOTIFY GUESTS".', inputSchema: z.object({
      calendarId: z.string(), resourceId: z.string(), etag: z.string().min(1),
      confirmGuests,
      occurrence: z.string().datetime({ offset: true }).optional(),
      scope: SCOPES,
      title: z.string().min(1).max(500).optional(),
      start: when.optional(),
      end: when.optional(),
      rrule: rrule.optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }) }, async ({ calendarId, resourceId, etag, confirmGuests, occurrence, scope, title, start, end, rrule, location, description }) => {
      try {
        const client = await dav();
        const { object } = await getObject(client, calendarId, resourceId);
        const root = prepareCalendar(object.data);
        const events = root.getAllSubcomponents('vevent');
        if (!object.etag || object.etag !== etag) throw new RangeError('Event changed; read again');
        guestsNeedConfirmation(events, confirmGuests);
        const changes = { title, start, end, rrule, location, description };
        const save = async (data: string) => { await checkWrite(await client.updateCalendarObject({ calendarObject: { ...object, data } })); };
        if (!isSeries(events)) {
          if (events.length !== 1 || occurrence !== undefined) throw new RangeError('Not a repeating event');
          await save(editOneOff(root, changes));
          return result({ updated: true, resourceId });
        }
        if (scope === 'entireSeries') {
          if (occurrence !== undefined) throw new RangeError('entireSeries takes no occurrence');
          await save(editSeries(root, changes));
          return result({ updated: true, resourceId, scope });
        }
        if (occurrence === undefined) throw new RangeError('occurrence is required for this scope');
        if (scope === 'occurrence') {
          await save(editOccurrence(root, occurrence, changes));
          return result({ updated: true, resourceId, occurrence });
        }
        const calendar = await lookupCalendar(client, calendarId);
        const id = crypto.randomUUID();
        const split = splitSeriesAt(root, occurrence, changes, id + '@private-caldav-mcp');
        if (!split.created) {
          await save(split.current);
          return result({ updated: true, resourceId, occurrence, scope });
        }
        const newResourceId = resourceUrl(calendar.url, id);
        // The new series is created first: if the old one then cannot be shortened, the new one is
        // removed again, and at worst the later occurrences exist twice rather than not at all.
        await checkWrite(await client.createCalendarObject({ calendar, filename: `${id}.ics`, iCalString: split.created, headers: { 'If-None-Match': '*' } }));
        try {
          await save(split.current);
        } catch (e) {
          await client.deleteCalendarObject({ calendarObject: { url: newResourceId } as typeof object }).catch(() => undefined);
          throw e;
        }
        return result({ updated: true, resourceId, newResourceId, occurrence, scope });
      } catch (e) { return failure(e); }
    });

    this.server.registerTool('delete_event', { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, description: 'Delete a calendar event resource. This operation is irreversible and must be explicitly requested by the user. Recurring series require explicit acknowledgement. To cancel one occurrence of a series, pass occurrence (its start, as listed by list_events) instead; the rest of the series is kept. With scope thisAndFollowing, that occurrence and every later one are removed by ending the series before it. Deleting an event that has guests can email them a cancellation: ask the user first, then pass confirmGuests: "NOTIFY GUESTS".', inputSchema: z.object({
      calendarId: z.string(), resourceId: z.string(),
      etag: z.string().min(1),
      confirmGuests,
      confirm: z.literal('DELETE'),
      confirmEntireSeries: z.boolean().default(false),
      occurrence: z.string().datetime({ offset: true }).optional(),
      scope: z.enum(['occurrence', 'thisAndFollowing']).default('occurrence'),
    }) }, async ({ calendarId, resourceId, etag, confirmGuests, confirmEntireSeries, occurrence, scope }) => {
      try {
        const client = await dav();
        const { object } = await getObject(client, calendarId, resourceId);
        const root = prepareCalendar(object.data);
        const events = root.getAllSubcomponents('vevent');
        if (!object.etag || object.etag !== etag) throw new RangeError('Event changed; read again');
        guestsNeedConfirmation(events, confirmGuests);
        if (occurrence !== undefined) {
          if (confirmEntireSeries) throw new RangeError('Choose either one occurrence or the entire series');
          if (scope === 'thisAndFollowing') {
            const ended = endSeriesBefore(root, occurrence);
            if (ended === null) {
              await checkWrite(await client.deleteCalendarObject({ calendarObject: object }));
              return result({ deleted: true, resourceId, occurrence, scope });
            }
            await checkWrite(await client.updateCalendarObject({ calendarObject: { ...object, data: ended } }));
            return result({ cancelled: true, resourceId, occurrence, scope });
          }
          await checkWrite(await client.updateCalendarObject({ calendarObject: { ...object, data: cancelOccurrence(root, occurrence) } }));
          return result({ cancelled: true, resourceId, occurrence });
        }
        if (scope === 'thisAndFollowing') throw new RangeError('occurrence is required for scope thisAndFollowing');
        if (isSeries(events) && !confirmEntireSeries) {
          throw new RangeError('This is a recurrence; entire-series deletion requires confirmation');
        }
        await checkWrite(await client.deleteCalendarObject({ calendarObject: object }));
        return result({ deleted: true, resourceId });
      } catch (e) { return failure(e); }
    });
  }
}
