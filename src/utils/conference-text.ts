import type { ConferenceDeadline, ConferenceEdition } from '../data/conferences.ts';

const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const monthFormat = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** `2027-05` as `May 2027`. */
export function formatConferenceMonth(month: string) {
  return monthFormat.format(new Date(`${month}-01`));
}

/** The one date style of the calendar: `Dec 6 – 12, 2026`. */
export function formatConferenceDates(start: string, end: string | null) {
  return end ? dateFormat.formatRange(new Date(start), new Date(end)) : dateFormat.format(new Date(start));
}

/** Letters and digits, without the years a name adds to its series. */
function bareName(value: string) {
  return value.toLowerCase().replace(/\b20\d\d\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The series, unless the edition's name already says it. */
export function conferenceSubtitle({ name, series }: Pick<ConferenceEdition, 'name' | 'series'>) {
  return bareName(name).includes(bareName(series)) ? undefined : series;
}

/** The acronym as a cover prints it: without a year the cover already prints beside it. */
export function coverAcronym({ acronym, year }: Pick<ConferenceEdition, 'acronym' | 'year'>) {
  if (!acronym) return undefined;
  const suffix = [String(year), String(year).slice(2)].find(digits => acronym.endsWith(digits));
  return (suffix && acronym.slice(0, -suffix.length).replace(/[^\p{L}\p{N}]+$/u, '')) || acronym;
}

/** Whether the acronym and the year on the cover already make the edition's name. */
export function coverSaysName({ name, acronym, year }: Pick<ConferenceEdition, 'name' | 'acronym' | 'year'>) {
  return name === acronym || name === `${acronym} ${year}`;
}

const ccfAddress = 'https://github.com/ccfddl/ccf-deadlines';

/** The sources of a set of deadlines, each once, named by host and, when a host has several, by page. */
export function deadlineSources(deadlines: readonly ConferenceDeadline[]) {
  const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');
  const urls = [...new Set(deadlines.map(deadline => deadline.sourceUrl))];
  return urls.map((url) => {
    if (url.startsWith(ccfAddress)) return { url, name: 'CCF Deadlines' };
    const shared = urls.filter(other => hostOf(other) === hostOf(url)).length > 1;
    const { pathname, search } = new URL(url);
    return { url, name: hostOf(url) + (shared ? pathname + search : '') };
  });
}

/** Whether a fact the page shows comes from CCF Deadlines, whose licence asks for a credit. */
export function usesCcfDeadlines({ source, deadlines }: Pick<ConferenceEdition, 'source' | 'deadlines'>) {
  return source === 'ccf' || Boolean(deadlines?.some(deadline => deadline.sourceUrl.startsWith(ccfAddress)));
}

/** A deadline's date with the hour and time zone its source gives. */
export function formatDeadline({ date, timeText }: ConferenceDeadline) {
  return [formatConferenceDates(date, null), timeText].filter(Boolean).join(' · ');
}

/** Zones a source names by an abbreviation that fixes its offset, in minutes east of UTC. */
const fixedZones: Readonly<Record<string, number>> = {
  aoe: -720, utc: 0, gmt: 0, wet: 0, bst: 60, cet: 60, cest: 120, eet: 120, eest: 180,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
};

/** Zones a source names without saying whether summer time applies. */
const regionalZones: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:ET|eastern(?: time)?)\b/i, 'America/New_York'],
  [/\b(?:CT|central(?: time)?)\b/i, 'America/Chicago'],
  [/\b(?:MT|mountain(?: time)?)\b/i, 'America/Denver'],
  [/\b(?:PT|pacific(?: time)?)\b/i, 'America/Los_Angeles'],
];

const zoneOffset = /\b(?:UTC|GMT)\s*([+\-−])\s*(\d{1,2})(?:[:.]?(\d{2}))?/i;

/** The minutes after midnight that a time of day names, or null. Midnight ends the day. */
function minutesOfDay(text: string) {
  if (/\bmidnight\b/i.test(text)) return 24 * 60;
  if (/\bnoon\b/i.test(text)) return 12 * 60;
  const twelve = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\b/i.exec(text);
  if (twelve) {
    if (Number(twelve[1]) > 12) return null;
    return (Number(twelve[1]) % 12 + (twelve[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(twelve[2] ?? 0);
  }
  const clock = /\b(\d{1,2})[:.](\d{2})\b/.exec(text);
  return clock && Number(clock[1]) <= 24 && Number(clock[2]) < 60 ? Number(clock[1]) * 60 + Number(clock[2]) : null;
}

/** How far a zone's clock is ahead of UTC at an instant, in minutes. */
function offsetIn(timeZone: string, instant: number) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(instant);
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
  return (Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute')) - Math.floor(instant / 60000) * 60000) / 60000;
}

/**
 * The instant a deadline closes, in milliseconds. A source that gives an hour and a
 * zone this can read closes then. Any other deadline closes when its day ends in
 * AoE, the last zone on Earth, so it is never shown as passed too early.
 */
export function deadlineCloses({ date, timeText = '' }: Pick<ConferenceDeadline, 'date' | 'timeText'>) {
  const [year, month, day] = date.split('-').map(Number);
  const wallClock = (minutes: number) => Date.UTC(year, month - 1, day) + minutes * 60000;
  const endOfDayAoe = wallClock(24 * 60 + 720);
  const offset = zoneOffset.exec(timeText);
  const rest = offset ? timeText.replace(offset[0], ' ') : timeText;
  const minutes = minutesOfDay(rest);
  if (minutes === null) return endOfDayAoe;
  if (offset) {
    const sign = offset[1] === '+' ? 1 : -1;
    return wallClock(minutes) - sign * (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * 60000;
  }
  const fixed = Object.keys(fixedZones).find(name => new RegExp(`\\b${name}\\b`, 'i').test(rest));
  if (fixed) return wallClock(minutes) - fixedZones[fixed] * 60000;
  const regional = regionalZones.find(([pattern]) => pattern.test(rest))?.[1] ?? /\b[A-Z][a-z]+\/[A-Za-z_]+\b/.exec(rest)?.[0];
  if (!regional) return endOfDayAoe;
  try {
    // The offset at that wall-clock time, checked again across a change of summer time.
    const guess = wallClock(minutes) - offsetIn(regional, wallClock(minutes)) * 60000;
    return wallClock(minutes) - offsetIn(regional, guess) * 60000;
  } catch {
    return endOfDayAoe;
  }
}

/** The first deadline that has not closed at `now`, in milliseconds. */
export function nextDeadline({ deadlines }: Pick<ConferenceEdition, 'deadlines'>, now: number) {
  return deadlines?.find(deadline => deadlineCloses(deadline) > now);
}
