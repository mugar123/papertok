import type { ConferenceEdition, ConferenceSite } from '../data/conferences.ts';

export function isConferencePath(path: string) {
  return /^\/conferences(?:\/[^/]+)?\/?$/i.test(path);
}

export function localCalendarDate(date: Date, timeZone?: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

/** Groups by the month an edition starts in at the sites it is listed for, or under the month the reader chose. */
export function groupConferences(
  editions: readonly ConferenceEdition[],
  today: string,
  chosenMonth: string | null = null,
  sitesOf: (edition: ConferenceEdition) => readonly ConferenceSite[] = edition => edition.dates,
) {
  const upcoming = new Map<string, ConferenceEdition[]>();
  const undated: ConferenceEdition[] = [];
  const past: ConferenceEdition[] = [];
  const ordered = editions.map(edition => {
    const dates = [...sitesOf(edition)].sort((a, b) => a.start.localeCompare(b.start));
    const firstRemaining = dates.find(date => (date.end ?? date.start) >= today);
    return { edition, firstRemaining, start: firstRemaining?.start ?? dates[0]?.start ?? '' };
  }).sort((a, b) => a.start.localeCompare(b.start) || a.edition.id.localeCompare(b.edition.id));

  for (const { edition, firstRemaining, start } of ordered) {
    if (!start) {
      undated.push(edition);
    } else if (!firstRemaining) {
      past.push(edition);
    } else {
      const month = chosenMonth ?? start.slice(0, 7);
      const group = upcoming.get(month) ?? [];
      group.push(edition);
      upcoming.set(month, group);
    }
  }
  return { upcoming, undated, past: past.reverse() };
}
