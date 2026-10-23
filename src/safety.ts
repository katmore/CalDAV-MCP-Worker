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

const SERIES_PROPERTIES = ['rrule', 'rdate', 'exrule', 'exdate', 'recurrence-id'];
const startOf = (e: ICAL.Component) => (e.getFirstPropertyValue('recurrence-id') as ICAL.Time).toJSDate().getTime();

// Splits a resource into its one series master and the separately edited occurrences.
function splitSeries(root: ICAL.Component) {
  const events = root.getAllSubcomponents('vevent');
  const masters = events.filter(e => !e.hasProperty('recurrence-id'));
  if (masters.length !== 1 || !masters[0].hasProperty('rrule')) throw new RangeError('Not a repeating series');
  return { master: masters[0], overrides: events.filter(e => e.hasProperty('recurrence-id')) };
}

// The series' own start time (same zone as DTSTART) of the occurrence at this instant.
// Cancelled occurrences are not generated, so they are not found.
function findOccurrence(master: ICAL.Component, occurrence: string) {
  const target = new Date(occurrence).getTime();
  const iterator = new ICAL.Event(master).iterator();
  let next: ICAL.Time | null;
  let count = 0;
  while ((next = iterator.next()) && count++ < 20000) {
    const at = next.toJSDate().getTime();
    if (at > target) break;
    if (at === target) return next;
  }
  throw new RangeError('No such occurrence in this series');
}

// ical.js writes the local time but not its zone; without TZID the value would read as floating.
function setTime(component: ICAL.Component, name: string, time: ICAL.Time, add = false) {
  const property = add ? component.addPropertyWithValue(name, time.clone()) : component.updatePropertyWithValue(name, time.clone());
  if (!time.isDate && time.zone.tzid !== 'UTC' && time.zone.tzid !== 'floating') property.setParameter('tzid', time.zone.tzid);
}

const stamp = (e: ICAL.Component) => {
  e.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  e.updatePropertyWithValue('sequence', Number(e.getFirstPropertyValue('sequence') || 0) + 1);
};

// Adds an EXDATE for one generated occurrence of a series and returns the new resource text.
// The date is written in the series' own start format (same zone, or DATE for all-day).
export function cancelOccurrence(root: ICAL.Component, occurrence: string) {
  const { master, overrides } = splitSeries(root);
  const target = new Date(occurrence).getTime();
  if (overrides.some(e => startOf(e) === target)) throw new RangeError('That occurrence was edited separately; it cannot be cancelled here');
  setTime(master, 'exdate', findOccurrence(master, occurrence), true);
  stamp(master);
  return root.toString();
}

export type OccurrenceChanges = { title?: string; start?: string; end?: string; location?: string; description?: string };

// Edits one occurrence of a series through an override (a VEVENT with the same UID and a
// RECURRENCE-ID), creating it from the series when the occurrence has none yet. The series
// itself and the other overrides are not touched. Returns the new resource text.
export function editOccurrence(root: ICAL.Component, occurrence: string, changes: OccurrenceChanges) {
  const { master, overrides } = splitSeries(root);
  if ((master.getFirstPropertyValue('dtstart') as ICAL.Time).isDate) throw new RangeError('All-day edits refused');
  if ((changes.start !== undefined || changes.end !== undefined) && master.hasProperty('duration')) throw new RangeError('Duration-based time edits refused');
  if (Object.values(changes).every(v => v === undefined)) throw new RangeError('Nothing to change');
  const target = new Date(occurrence).getTime();
  let override = overrides.find(e => startOf(e) === target);
  if (!override) {
    const at = findOccurrence(master, occurrence);
    const length = new ICAL.Event(master).duration;
    override = new ICAL.Component(structuredClone(master.toJSON()));
    for (const name of [...SERIES_PROPERTIES, 'duration']) override.removeAllProperties(name);
    setTime(override, 'recurrence-id', at);
    setTime(override, 'dtstart', at);
    const end = at.clone();
    end.addDuration(length);
    setTime(override, 'dtend', end);
    root.addSubcomponent(override);
  }
  const { title, start, end, location, description } = changes;
  const length = new ICAL.Event(override).duration;
  if (title !== undefined) override.updatePropertyWithValue('summary', title);
  if (location !== undefined) override.updatePropertyWithValue('location', location);
  if (description !== undefined) override.updatePropertyWithValue('description', description);
  if (start !== undefined) {
    const moved = ICAL.Time.fromJSDate(new Date(start), true);
    override.updatePropertyWithValue('dtstart', moved);
    // Moving the start alone keeps the occurrence's length.
    if (end === undefined) { const e = moved.clone(); e.addDuration(length); override.updatePropertyWithValue('dtend', e); }
  }
  if (end !== undefined) override.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(end), true));
  if ((override.getFirstPropertyValue('dtend') as ICAL.Time).compare(override.getFirstPropertyValue('dtstart') as ICAL.Time) <= 0) throw new RangeError('End must be after start');
  stamp(override);
  return root.toString();
}
