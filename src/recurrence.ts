import ICAL from 'ical.js';

// Pure edits of iCalendar text: one-off events, whole series, single occurrences and
// "this and following". Each function changes the component it is given and the caller
// writes root.toString() back to the server.

export type Changes = { title?: string; start?: string; end?: string; location?: string; description?: string; rrule?: string };

const SERIES_PROPERTIES = ['rrule', 'rdate', 'exrule', 'exdate', 'recurrence-id'];
const DAY_PARTS = ['BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SERIES_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export const isDateOnly = (value: string) => DATE_ONLY.test(value);
const startOf = (e: ICAL.Component) => (e.getFirstPropertyValue('recurrence-id') as ICAL.Time).toJSDate().getTime();
const nothingToChange = (changes: Changes) => Object.values(changes).every(v => v === undefined);
// Wall-clock seconds, ignoring the zone: what a time reads as on a clock or calendar page.
const wall = (t: ICAL.Time) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) / 1000;

// Reads an RRULE such as FREQ=WEEKLY;BYDAY=MO (a leading "RRULE:" is accepted).
export function parseRule(text: string) {
  let rule: ICAL.Recur;
  try { rule = ICAL.Recur.fromString(text.replace(/^RRULE:/i, '').trim()); } catch { throw new RangeError('Invalid repeat rule'); }
  if (!SERIES_FREQUENCIES.includes(rule.freq)) throw new RangeError('Repeat rule must be DAILY, WEEKLY, MONTHLY or YEARLY');
  if (rule.count && rule.until) throw new RangeError('Repeat rule cannot have both COUNT and UNTIL');
  return rule;
}

// Sets a date-time property, keeping TZID in step with the value. ical.js writes the local
// time but not its zone, and leaves an old TZID on a value that is now UTC; either way the
// result would be read in the wrong zone or be invalid.
export function setTime(component: ICAL.Component, name: string, time: ICAL.Time, add = false) {
  const property = add ? component.addPropertyWithValue(name, time.clone()) : component.updatePropertyWithValue(name, time.clone());
  if (!time.isDate && time.zone.tzid !== 'UTC' && time.zone.tzid !== 'floating') property.setParameter('tzid', time.zone.tzid);
  else property.removeParameter('tzid');
}

export const stamp = (e: ICAL.Component) => {
  e.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  e.updatePropertyWithValue('sequence', Number(e.getFirstPropertyValue('sequence') || 0) + 1);
};

// A start or end given by the caller, in the form the event uses: a date for all-day events
// (an end date is the last day, so the stored end is the day after) and a date-time otherwise.
// A series keeps its own zone; one-offs and single occurrences are written in UTC.
function toTime(value: string, like: ICAL.Time, keepZone: boolean, lastDay = false) {
  if (like.isDate) {
    if (!isDateOnly(value)) throw new RangeError('All-day events take dates like 2030-01-05');
    const day = ICAL.Time.fromDateString(value);
    if (lastDay) day.adjust(1, 0, 0, 0);
    return day;
  }
  if (isDateOnly(value)) throw new RangeError('This event has a time; give a date and time with an offset');
  const instant = ICAL.Time.fromJSDate(new Date(value), true);
  return keepZone ? instant.convertToZone(like.zone) : instant;
}

function applyText(ev: ICAL.Component, { title, location, description }: Changes) {
  if (title !== undefined) ev.updatePropertyWithValue('summary', title);
  if (location !== undefined) ev.updatePropertyWithValue('location', location);
  if (description !== undefined) ev.updatePropertyWithValue('description', description);
}

// Moving only the start keeps the length; an end given without a start keeps the start.
function applyTimes(ev: ICAL.Component, { start, end }: Changes, keepZone: boolean) {
  if (start === undefined && end === undefined) return;
  const event = new ICAL.Event(ev);
  const length = event.duration;
  const first = start === undefined ? event.startDate.clone() : toTime(start, event.startDate, keepZone);
  let last: ICAL.Time;
  if (end === undefined) { last = first.clone(); last.addDuration(length); }
  else last = toTime(end, event.startDate, keepZone, true);
  if (last.compare(first) <= 0) throw new RangeError('End must be after start');
  setTime(ev, 'dtstart', first);
  if (end === undefined && ev.hasProperty('duration')) return;
  ev.removeAllProperties('duration');
  setTime(ev, 'dtend', last);
}

// Splits a resource into its one series master and the separately edited occurrences.
function splitSeries(root: ICAL.Component) {
  const events = root.getAllSubcomponents('vevent');
  const masters = events.filter(e => !e.hasProperty('recurrence-id'));
  if (masters.length !== 1 || !(masters[0].hasProperty('rrule') || masters[0].hasProperty('rdate'))) throw new RangeError('Not a repeating series');
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

const isFirstOccurrence = (master: ICAL.Component, at: ICAL.Time) => {
  const first = new ICAL.Event(master).iterator().next();
  return !first || first.compare(at) >= 0;
};

const hasDayParts = (ev: ICAL.Component) => {
  const rule = ev.getFirstPropertyValue('rrule') as ICAL.Recur | null;
  return !!rule && DAY_PARTS.some(part => (rule.parts as Record<string, unknown[] | undefined>)[part]?.length);
};

const movesDay = (before: ICAL.Time, after: ICAL.Time) => before.year !== after.year || before.month !== after.month || before.day !== after.day;

// Moves cancelled dates, extra dates and the keys of edited occurrences along with a series
// whose start moved, so they still point at the same occurrences.
function shiftDates(master: ICAL.Component, overrides: ICAL.Component[], seconds: number) {
  const shifted = (value: ICAL.Time) => {
    const moved = value.clone();
    if (moved.isDate) moved.adjust(Math.round(seconds / 86400), 0, 0, 0); else moved.adjust(0, 0, 0, seconds);
    return moved;
  };
  for (const name of ['exdate', 'rdate']) {
    const values = master.getAllProperties(name).flatMap(p => p.getValues() as ICAL.Time[]);
    master.removeAllProperties(name);
    for (const value of values) setTime(master, name, shifted(value), true);
  }
  for (const override of overrides) setTime(override, 'recurrence-id', shifted(override.getFirstPropertyValue('recurrence-id') as ICAL.Time));
}

// Edits an event that does not repeat. Giving it an rrule makes it repeat.
export function editOneOff(root: ICAL.Component, changes: Changes) {
  if (nothingToChange(changes)) throw new RangeError('Nothing to change');
  const ev = root.getFirstSubcomponent('vevent')!;
  applyText(ev, changes);
  applyTimes(ev, changes, false);
  if (changes.rrule !== undefined) ev.updatePropertyWithValue('rrule', parseRule(changes.rrule));
  stamp(ev);
  return root.toString();
}

// Edits the whole series: every occurrence that has not been edited separately. A new start
// moves the series (cancelled dates and edited occurrences move with it); a new rrule changes
// how it repeats.
export function editSeries(root: ICAL.Component, changes: Changes) {
  if (nothingToChange(changes)) throw new RangeError('Nothing to change');
  const { master, overrides } = splitSeries(root);
  const before = (master.getFirstPropertyValue('dtstart') as ICAL.Time).clone();
  const rule = changes.rrule === undefined ? undefined : parseRule(changes.rrule);
  applyText(master, changes);
  applyTimes(master, changes, true);
  const after = master.getFirstPropertyValue('dtstart') as ICAL.Time;
  if (!rule && movesDay(before, after) && hasDayParts(master)) throw new RangeError('This series repeats on fixed days; give a new rrule to move it to another day');
  const shift = wall(after) - wall(before);
  if (shift !== 0) shiftDates(master, overrides, shift);
  if (rule) master.updatePropertyWithValue('rrule', rule);
  stamp(master);
  return root.toString();
}

// Cancels one occurrence by adding an EXDATE to the series, in the series' own start format
// (same zone, or DATE for all-day). A separately edited copy of that occurrence is dropped.
export function cancelOccurrence(root: ICAL.Component, occurrence: string) {
  const { master, overrides } = splitSeries(root);
  const at = findOccurrence(master, occurrence);
  const target = new Date(occurrence).getTime();
  for (const override of overrides.filter(e => startOf(e) === target)) root.removeSubcomponent(override);
  setTime(master, 'exdate', at, true);
  stamp(master);
  return root.toString();
}

// Edits one occurrence through an override (a VEVENT with the same UID and a RECURRENCE-ID),
// creating it from the series when the occurrence has none yet. The series itself and the
// other overrides are not touched.
export function editOccurrence(root: ICAL.Component, occurrence: string, changes: Changes) {
  if (nothingToChange(changes)) throw new RangeError('Nothing to change');
  if (changes.rrule !== undefined) throw new RangeError('One occurrence cannot have its own repeat rule');
  const { master, overrides } = splitSeries(root);
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
  applyText(override, changes);
  applyTimes(override, changes, false);
  stamp(override);
  return root.toString();
}

// The last moment the old series keeps when it is cut before `at`, in the form its DTSTART needs:
// a date for all-day series, UTC for zoned ones, floating for floating ones.
function untilBefore(dtstart: ICAL.Time, at: ICAL.Time) {
  if (dtstart.isDate) { const day = at.clone(); day.adjust(-1, 0, 0, 0); return day; }
  if (dtstart.zone.tzid === 'floating') { const moment = at.clone(); moment.adjust(0, 0, 0, -1); return moment; }
  return ICAL.Time.fromJSDate(new Date(at.toJSDate().getTime() - 1000), true);
}

// Cuts the series in `root` just before the occurrence `at`. `root` is left holding only what
// comes before it (UNTIL set, later dates and edited copies removed). Returns the master of a
// series that continues from `at`, with the later dates, plus the edited copies that belong to it.
function cutBefore(root: ICAL.Component, at: ICAL.Time) {
  const { master, overrides } = splitSeries(root);
  const dtstart = master.getFirstPropertyValue('dtstart') as ICAL.Time;
  const recur = master.getFirstPropertyValue('rrule') as ICAL.Recur | null;
  const rest = new ICAL.Component(structuredClone(master.toJSON()));

  for (const name of ['exdate', 'rdate']) {
    const kept: ICAL.Time[] = [], later: ICAL.Time[] = [];
    for (const property of master.getAllProperties(name)) {
      for (const value of property.getValues() as ICAL.Time[]) (value.compare(at) < 0 ? kept : later).push(value);
    }
    master.removeAllProperties(name);
    rest.removeAllProperties(name);
    for (const value of kept) setTime(master, name, value, true);
    for (const value of later) setTime(rest, name, value, true);
  }

  if (recur) {
    const rule = { ...recur.toJSON() } as Record<string, unknown>;
    delete rule.count;
    rule.until = untilBefore(dtstart, at);
    master.updatePropertyWithValue('rrule', ICAL.Recur.fromData(rule));
    if (recur.count) {
      // COUNT counts occurrences from the series start, so the rest keeps what is left of it.
      let before = 0;
      const occurrences = recur.iterator(dtstart);
      let next: ICAL.Time | null;
      while ((next = occurrences.next()) && next.compare(at) < 0) before++;
      rest.updatePropertyWithValue('rrule', ICAL.Recur.fromData({ ...recur.toJSON(), count: recur.count - before }));
    }
  }

  const atMs = at.toJSDate().getTime();
  const moved = overrides.filter(e => startOf(e) >= atMs);
  for (const override of moved) root.removeSubcomponent(override);
  stamp(master);
  return { rest, moved };
}

// Cancels the occurrence and every later one by ending the series just before it. Returns
// null when that is the whole series, which the caller deletes instead.
export function endSeriesBefore(root: ICAL.Component, occurrence: string) {
  const { master } = splitSeries(root);
  const at = findOccurrence(master, occurrence);
  if (isFirstOccurrence(master, at)) return null;
  cutBefore(root, at);
  return root.toString();
}

// Changes the occurrence and every later one. The old series ends just before the occurrence
// and a new series (a new resource, uid `uid`) continues from it with the changes. At the
// first occurrence that is the whole series, so it is edited in place and nothing is created.
export function splitSeriesAt(root: ICAL.Component, occurrence: string, changes: Changes, uid: string) {
  if (nothingToChange(changes)) throw new RangeError('Nothing to change');
  const { master } = splitSeries(root);
  const at = findOccurrence(master, occurrence);
  if (isFirstOccurrence(master, at)) return { current: editSeries(root, changes), created: undefined };

  const rule = changes.rrule === undefined ? undefined : parseRule(changes.rrule);
  const { rest, moved } = cutBefore(root, at);
  const length = new ICAL.Event(rest).duration;
  setTime(rest, 'dtstart', at);
  if (!rest.hasProperty('duration')) { const end = at.clone(); end.addDuration(length); setTime(rest, 'dtend', end); }
  applyText(rest, changes);
  applyTimes(rest, changes, true);
  const first = rest.getFirstPropertyValue('dtstart') as ICAL.Time;
  if (!rule && movesDay(at, first) && hasDayParts(rest)) throw new RangeError('This series repeats on fixed days; give a new rrule to move it to another day');
  const shift = wall(first) - wall(at);
  if (shift !== 0) shiftDates(rest, moved, shift);
  if (rule) rest.updatePropertyWithValue('rrule', rule);
  rest.updatePropertyWithValue('uid', uid);
  rest.updatePropertyWithValue('sequence', 0);
  stamp(rest);

  const created = new ICAL.Component(structuredClone(root.toJSON()));
  for (const event of created.getAllSubcomponents('vevent')) created.removeSubcomponent(event);
  created.addSubcomponent(rest);
  for (const override of moved) {
    override.updatePropertyWithValue('uid', uid);
    created.addSubcomponent(override);
  }
  return { current: root.toString(), created: created.toString() };
}
