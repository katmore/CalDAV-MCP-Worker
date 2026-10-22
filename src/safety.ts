import ICAL from 'ical.js';
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
export function prepareCalendar(data: string) {
  const root = new ICAL.Component(ICAL.parse(data));
  for (const component of root.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(component);
    ICAL.TimezoneService.register(tz, tz.tzid);
  }
  return root;
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
