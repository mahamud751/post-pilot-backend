/** Offset (ms) of `timeZone` from UTC at instant `date`. */
function offsetAt(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in an IANA timezone to a UTC instant (PRD FR-08, TEST-09).
 * Times skipped by a DST jump resolve to the instant after the gap; repeated times resolve to
 * the first occurrence.
 */
export function zonedToUtc(date: string, time: string, timeZone: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  // Offsets a day either side bracket any transition on this date.
  const before = offsetAt(new Date(wallAsUtc - 86_400_000), timeZone);
  const after = offsetAt(new Date(wallAsUtc + 86_400_000), timeZone);
  const valid = [wallAsUtc - before, wallAsUtc - after].filter(
    candidate => offsetAt(new Date(candidate), timeZone) === wallAsUtc - candidate,
  );
  if (valid.length > 0) {
    return new Date(Math.min(...valid));
  }
  // In a spring-forward gap: reading the time with the pre-jump offset lands just after the gap.
  return new Date(wallAsUtc - before);
}

/** YYYY-MM-DD of `date` as seen in `timeZone`. */
export function localDate(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of `date` in `timeZone`. Hour 24 from some ICU builds is normalised to 0. */
export function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: Number(get('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  };
}

export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
