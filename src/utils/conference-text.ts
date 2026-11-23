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

/** Zones a source names by an abbreviation of standard time, in minutes east of UTC. */
const fixedZones: Readonly<Record<string, number>> = {
  aoe: -720, utc: 0, gmt: 0, wet: 0, cet: 60, eet: 120, est: -300, cst: -360, mst: -420, pst: -480,
};

/**
 * Summer-time abbreviations and the zone whose clock they name. Out of season a source
 * most likely means that zone's local time, so the later of the two readings counts.
 */
const summerZones: Readonly<Record<string, readonly [number, string]>> = {
  bst: [60, 'Europe/London'], cest: [120, 'Europe/Paris'], eest: [180, 'Europe/Athens'],
  edt: [-240, 'America/New_York'], cdt: [-300, 'America/Chicago'], mdt: [-360, 'America/Denver'], pdt: [-420, 'America/Los_Angeles'],
};

/** Zones a source names without saying whether summer time applies. */
const regionalZones: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:ET|eastern(?: time)?)\b/i, 'America/New_York'],
  [/\b(?:CT|central(?: time)?)\b/i, 'America/Chicago'],
  [/\b(?:MT|mountain(?: time)?)\b/i, 'America/Denver'],
  [/\b(?:PT|pacific(?: time)?)\b/i, 'America/Los_Angeles'],
];

/** Words that make "Central" or "Eastern" another region's zone, such as Central European Time. */
const otherRegions = /\b(?:europe(?:an)?|australia(?:n)?|africa(?:n)?|brazil(?:ian)?|china|india|japan|korea)\b/i;

/** A UTC offset, not one inside a zone name such as Etc/GMT+12. */
const zoneOffset = /(?<![/\w])(?:UTC|GMT)\s*([+\-−])\s*(\d{1,2})(?:[:.]?(\d{2}))?/gi;

/** An IANA zone name such as Europe/Paris or Etc/GMT+12. */
const ianaZone = /\b[A-Z][a-z]+\/[A-Za-z_]+(?:[+-]\d{1,2})?/g;

const timeOfDay =/\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\b|\b(\d{1,2})[:.](\d{2})\b|\b(midnight|noon)\b/gi;

/**
 * The minutes after midnight that the one time in a text names, or null when it names
 * none or several. Midnight, 12 AM and 00:00 end the day, so a deadline is never early;
 * 12:30 AM and 00:30 are half an hour after that.
 */
function minutesOfDay(text: string) {
  const times = [...text.matchAll(timeOfDay)];
  if (times.length !== 1) return null;
  const [, hour12, minute12, half, hour24, minute24, word] = times[0];
  if (word) return word.toLowerCase() === 'noon' ? 12 * 60 : 24 * 60;
  const hour = Number(hour12 ?? hour24);
  const minute = Number(minute12 ?? minute24 ?? 0);
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) return half.toLowerCase() === 'a' ? 24 * 60 + minute : 12 * 60 + minute;
    return (hour + (half.toLowerCase() === 'p' ? 12 : 0)) * 60 + minute;
  }
  if (hour > 24 || (hour === 24 && minute > 0)) return null;
  return hour === 0 ? 24 * 60 + minute : hour * 60 + minute;
}

/** How far a zone's clock is ahead of UTC at an instant, in minutes. */
function offsetIn(timeZone: string, instant: number) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(instant);
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
  return (Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute')) - Math.floor(instant / 60000) * 60000) / 60000;
}

/** A zone's offset at a wall-clock time, checked again across a change of summer time. */
function offsetAtWallClock(timeZone: string, wallClock: number) {
  return offsetIn(timeZone, wallClock - offsetIn(timeZone, wallClock) * 60000);
}

/**
 * The offset, in minutes east of UTC, of the one zone a text names, or null when it
 * names none, several, or one this cannot read.
 */
function zoneOf(text: string, wallClock: number) {
  const iana = text.match(ianaZone) ?? [];
  const offsets = [...text.matchAll(zoneOffset)];
  const rest = offsets.reduce((left, offset) => left.replace(offset[0], ' '), text).replace(ianaZone, ' ');
  if (otherRegions.test(rest)) return null;
  const named = (names: string[]) => names.filter(name => new RegExp(`\\b${name}\\b`, 'i').test(rest));
  const fixed = named(Object.keys(fixedZones));
  const summer = named(Object.keys(summerZones));
  const regional = regionalZones.filter(([pattern]) => pattern.test(rest)).map(([, zone]) => zone);
  // "Mountain Standard Time" or "Pacific Time (Hawaii)" may be a place without summer time.
  if (regional.length && /\bstandard\b|\(/i.test(rest)) return null;
  if (offsets.length + fixed.length + summer.length + regional.length + iana.length !== 1) return null;
  try {
    if (offsets.length) {
      const [, sign, hours, minutes] = offsets[0];
      if (Number(hours) > 14 || Number(minutes ?? 0) > 59) return null;
      return (sign === '+' ? 1 : -1) * (Number(hours) * 60 + Number(minutes ?? 0));
    }
    if (fixed.length) return fixedZones[fixed[0]];
    if (summer.length) {
      const [literal, zone] = summerZones[summer[0]];
      return Math.min(literal, offsetAtWallClock(zone, wallClock));
    }
    return offsetAtWallClock(regional[0] ?? iana[0], wallClock);
  } catch {
    // A zone name the browser does not know.
    return null;
  }
}

/**
 * The instant a deadline closes, in milliseconds. A source that gives one hour and one
 * zone this can read closes then. Any other deadline closes when its day ends in AoE,
 * the last zone on Earth, so it is never shown as passed too early.
 */
export function deadlineCloses({ date, timeText = '' }: Pick<ConferenceDeadline, 'date' | 'timeText'>) {
  const [year, month, day] = date.split('-').map(Number);
  const wallClock = (minutes: number) => Date.UTC(year, month - 1, day) + minutes * 60000;
  const endOfDayAoe = wallClock(24 * 60 + 720);
  const minutes = minutesOfDay(timeText.replace(zoneOffset, ' '));
  const offset = minutes === null ? null : zoneOf(timeText, wallClock(minutes));
  return minutes === null || offset === null ? endOfDayAoe : wallClock(minutes) - offset * 60000;
}

/** The first deadline that has not closed at `now`, in milliseconds. */
export function nextDeadline({ deadlines }: Pick<ConferenceEdition, 'deadlines'>, now: number) {
  return deadlines?.find(deadline => deadlineCloses(deadline) > now);
}
