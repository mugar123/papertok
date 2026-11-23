import type { ConferenceEdition, ConferenceSite } from '../data/conferences.ts';

/** One site of an edition on the calendar. */
export type CalendarEntry = { edition: ConferenceEdition; start: string; end: string; city?: string };

/** An entry's bar within one week. `lane` is the row it takes. */
export type WeekSegment = { entry: CalendarEntry; column: number; span: number; lane: number; startsHere: boolean; endsHere: boolean };

type WeekLayout = { segments: WeekSegment[]; rows: number; hidden: number[] };

/** Rows a week shows before it folds its busiest days into "+N more". */
const MAX_ROWS = 4;

function addDays(day: string, count: number) {
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function addMonths(month: string, count: number) {
  const date = new Date(`${month}-01`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}

/** The weeks that cover a month, from Sunday as the interface's locale counts them. */
export function monthWeeks(month: string) {
  const first = `${month}-01`;
  const start = addDays(first, -new Date(first).getUTCDay());
  const weeks: string[][] = [];
  for (let day = start; day.slice(0, 7) <= month; day = addDays(day, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(day, index)));
  }
  return weeks;
}

function byStart(a: CalendarEntry, b: CalendarEntry) {
  return a.start.localeCompare(b.start) || b.end.localeCompare(a.end) || a.edition.id.localeCompare(b.edition.id);
}

export function calendarEntries(editions: readonly { edition: ConferenceEdition; sites: readonly ConferenceSite[] }[]): CalendarEntry[] {
  return editions.flatMap(({ edition, sites }) => sites.map(({ start, end, city }) => ({ edition, start, end: end ?? start, city }))).sort(byStart);
}

export function entriesBetween(entries: readonly CalendarEntry[], first: string, last: string) {
  return entries.filter(entry => entry.start <= last && entry.end >= first);
}

export function entriesInMonth(entries: readonly CalendarEntry[], month: string) {
  return entriesBetween(entries, `${month}-01`, addDays(`${addMonths(month, 1)}-01`, -1));
}

/** The nearest month with a conference after this one, or else before it. */
export function nearestMonth(entries: readonly CalendarEntry[], month: string) {
  const starts = entries.map(entry => entry.start.slice(0, 7));
  return starts.find(start => start > month) ?? starts.findLast(start => start < month);
}

/** Places a week's bars. Days past the last row count what they hide. */
export function layoutWeek(week: readonly string[], entries: readonly CalendarEntry[]): WeekLayout {
  const [first, last] = [week[0], week[6]];
  const laneEnds: string[] = [];
  const placed = entriesBetween(entries, first, last).sort(byStart).map((entry): WeekSegment => {
    const from = entry.start < first ? first : entry.start;
    const to = entry.end > last ? last : entry.end;
    const free = laneEnds.findIndex(end => end < from);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = to;
    const column = week.indexOf(from);
    return { entry, column, span: week.indexOf(to) - column + 1, lane, startsHere: from === entry.start, endsHere: to === entry.end };
  });
  const folds = laneEnds.length > MAX_ROWS;
  const lanes = folds ? MAX_ROWS - 1 : MAX_ROWS;
  const segments = placed.filter(segment => segment.lane < lanes);
  const hidden = week.map((_, day) => placed.filter(({ lane, column, span }) => lane >= lanes && column <= day && day < column + span).length);
  return { segments, rows: Math.min(laneEnds.length, MAX_ROWS), hidden };
}

/** The day a phone calendar opens on: the one in the link, today, or the month's first conference. */
export function openingDay(month: string, day: string | null, today: string, entries: readonly CalendarEntry[]) {
  if (day?.startsWith(month)) return day;
  if (today.startsWith(month)) return today;
  const first = `${month}-01`;
  const [entry] = entriesInMonth(entries, month);
  return entry && entry.start > first ? entry.start : first;
}

/** Where a key moves the focus in the day grid, or null for a key it leaves alone. */
export function dayAfterKey(day: string, key: string) {
  const weekday = new Date(day).getUTCDay();
  switch (key) {
    case 'ArrowLeft': return addDays(day, -1);
    case 'ArrowRight': return addDays(day, 1);
    case 'ArrowUp': return addDays(day, -7);
    case 'ArrowDown': return addDays(day, 7);
    case 'Home': return addDays(day, -weekday);
    case 'End': return addDays(day, 6 - weekday);
    case 'PageUp': return sameDayIn(addMonths(day.slice(0, 7), -1), day);
    case 'PageDown': return sameDayIn(addMonths(day.slice(0, 7), 1), day);
    default: return null;
  }
}

/** The same day of another month, or that month's last day. */
function sameDayIn(month: string, day: string) {
  const last = addDays(`${addMonths(month, 1)}-01`, -1);
  const same = `${month}${day.slice(7)}`;
  return same > last ? last : same;
}
