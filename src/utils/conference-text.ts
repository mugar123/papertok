import type { ConferenceEdition } from '../data/conferences.ts';

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

/** The first deadline that has not passed. */
export function nextDeadline({ deadlines }: Pick<ConferenceEdition, 'deadlines'>, today: string) {
  return deadlines?.find(deadline => deadline.date >= today);
}
