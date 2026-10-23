import ICAL from 'ical.js';

// Builds the VTIMEZONE an event needs to be saved in a named timezone, from the runtime's own
// timezone data. Without it a repeating event written in UTC would drift an hour at every
// daylight-saving change.

const DAY = 86400000;

export function isKnownZone(tzid: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tzid }); return true; } catch { return false; }
}

function clock(tzid: string) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: tzid, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const parts = (ms: number) => {
    const found: Record<string, number> = {};
    for (const part of format.formatToParts(new Date(ms))) if (part.type !== 'literal') found[part.type] = Number(part.value);
    return found;
  };
  return {
    parts,
    // Seconds east of UTC at this instant.
    offset(ms: number) {
      const p = parts(ms);
      return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 1000);
    },
  };
}

// The clock time a UTC instant has in the zone.
export function localTime(tzid: string, ms: number, zone: ICAL.Timezone) {
  const p = clock(tzid).parts(ms);
  return new ICAL.Time({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second }, zone);
}

// A VTIMEZONE covering the year before `aroundMs` and thirty years after, with one observance
// per offset change found in that window.
export function vtimezone(tzid: string, aroundMs: number) {
  const { offset } = clock(tzid);
  const year = new Date(aroundMs).getUTCFullYear();
  const from = Date.UTC(year - 1, 0, 1);
  const to = Date.UTC(year + 30, 0, 1);
  const changes: { at: number; from: number; to: number }[] = [];
  let previous = from;
  let previousOffset = offset(from);
  for (let at = from + 3 * DAY; at <= to; at += 3 * DAY) {
    const current = offset(at);
    if (current !== previousOffset) {
      let low = previous, high = at;
      while (high - low > 1000) {
        const middle = Math.floor((low + high) / 2);
        if (offset(middle) === previousOffset) low = middle; else high = middle;
      }
      changes.push({ at: high, from: previousOffset, to: current });
    }
    previous = at;
    previousOffset = current;
  }
  const standard = Math.min(offset(from), ...changes.map(c => c.to));
  const component = new ICAL.Component('vtimezone');
  component.addPropertyWithValue('tzid', tzid);
  const observance = (kind: string, local: Date, fromOffset: number, toOffset: number) => {
    const o = new ICAL.Component(kind);
    o.addPropertyWithValue('dtstart', new ICAL.Time({ year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate(), hour: local.getUTCHours(), minute: local.getUTCMinutes(), second: local.getUTCSeconds() }, ICAL.Timezone.localTimezone));
    o.addPropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromSeconds(fromOffset));
    o.addPropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromSeconds(toOffset));
    component.addSubcomponent(o);
  };
  observance('standard', new Date(Date.UTC(1970, 0, 1)), offset(from), offset(from));
  for (const change of changes) observance(change.to > standard ? 'daylight' : 'standard', new Date(change.at + change.from * 1000), change.from, change.to);
  return component;
}
