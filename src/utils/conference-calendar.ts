import type { ConferenceEdition } from '../data/conferences.ts';

export function isConferencePath(path: string) {
  return /^\/conferences(?:\/[^/]+(?:\/papers)?)?\/?$/i.test(path);
}

export function groupConferences(editions: readonly ConferenceEdition[], today: string) {
  const upcoming = new Map<string, ConferenceEdition[]>();
  const undated: ConferenceEdition[] = [];
  const past: ConferenceEdition[] = [];
  const ordered = [...editions].sort((a, b) =>
    (a.dates[0]?.start ?? '').localeCompare(b.dates[0]?.start ?? '') || a.id.localeCompare(b.id));

  for (const edition of ordered) {
    const first = edition.dates[0];
    if (!first) {
      undated.push(edition);
    } else if (edition.dates.every(date => (date.end ?? date.start) < today)) {
      past.push(edition);
    } else {
      const month = first.start.slice(0, 7);
      const group = upcoming.get(month) ?? [];
      group.push(edition);
      upcoming.set(month, group);
    }
  }
  return { upcoming, undated, past: past.reverse() };
}
