import ICAL from 'ical.js';
// The single owner check used at sign-in, on every request and before tools are registered.
// An unset or empty allowlist denies everyone.
export function isAllowedLogin(login: string | undefined, allowed: string | undefined) {
  return !!login && !!allowed && login.toLowerCase() === allowed.toLowerCase();
}
export function assertResource(calendar: string, resource: string) {
  const c = new URL(calendar), r = new URL(resource);
  const prefix = c.pathname.endsWith('/') ? c.pathname : c.pathname + '/';
  if (r.protocol !== 'https:' || r.origin !== c.origin || r.username || r.password || r.search || r.hash || !r.pathname.startsWith(prefix) || r.pathname.slice(prefix.length).includes('/') || /%2f|%5c/i.test(r.pathname) || !r.pathname.endsWith('.ics')) throw new RangeError('Invalid resource');
}
export async function checkWrite(response: Response) {
  if (!response.ok) throw new RangeError(response.status === 412 ? 'Conflict' : 'Write rejected');
}
export function isSeries(events: ICAL.Component[]) {
  return events.length > 1 || events.some(e => ['rrule', 'rdate', 'exdate', 'recurrence-id'].some(p => e.hasProperty(p)));
}
// Timezones defined inside a resource are resolved from that resource alone. They are
// deliberately not registered globally, where one resource could redefine a zone for others.
export function prepareCalendar(data: string) {
  return new ICAL.Component(ICAL.parse(data));
}

// DAV servers may escape path characters such as @ when returning hrefs.
// The caller must still enforce the calendar boundary with assertResource.
export function sameResource(left: string, right: string) {
  const a = new URL(left), b = new URL(right);
  return a.origin === b.origin && decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname)
    && a.search === b.search && a.hash === b.hash;
}

export async function creationResult(uid: string, resourceId: string, readBack: () => Promise<Record<string, unknown>>) {
  try {
    return { created: true, uid, resourceId, ...await readBack(), verification: 'verified' };
  } catch {
    // A successful PUT is a write success even when the subsequent read fails.
    return { created: true, uid, resourceId, verification: 'pending',
      note: 'The server accepted creation, but immediate read-back failed. Locate this UID before retrying; do not create a duplicate.' };
  }
}

// Adds an EXDATE for one generated occurrence of a series and returns the new resource text.
// The date is written in the series' own start format (same zone, or DATE for all-day).
export function cancelOccurrence(root: ICAL.Component, occurrence: string) {
  const events = root.getAllSubcomponents('vevent');
  const masters = events.filter(e => !e.hasProperty('recurrence-id'));
  if (masters.length !== 1 || !masters[0].hasProperty('rrule')) throw new RangeError('Not a repeating series');
  const master = masters[0];
  const target = new Date(occurrence).getTime();
  const overridden = events.some(e => e.hasProperty('recurrence-id') && (e.getFirstPropertyValue('recurrence-id') as ICAL.Time).toJSDate().getTime() === target);
  if (overridden) throw new RangeError('That occurrence was edited separately; it cannot be cancelled here');
  const iterator = new ICAL.Event(master).iterator();
  let next: ICAL.Time | null;
  let count = 0;
  while ((next = iterator.next()) && count++ < 20000) {
    const at = next.toJSDate().getTime();
    if (at > target) break;
    if (at === target) {
      const exdate = master.addPropertyWithValue('exdate', next.clone());
      // ical.js writes the local time but not its zone; without TZID the date would read as floating.
      if (!next.isDate && next.zone.tzid !== 'UTC' && next.zone.tzid !== 'floating') exdate.setParameter('tzid', next.zone.tzid);
      master.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
      master.updatePropertyWithValue('sequence', Number(master.getFirstPropertyValue('sequence') || 0) + 1);
      return root.toString();
    }
  }
  throw new RangeError('No such occurrence in this series');
}
