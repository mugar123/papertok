import type { OrcidRecord } from '../../services/orcid-service.ts';

type Affiliation = NonNullable<OrcidRecord>['employments'][number];
export type CareerStop = Affiliation & { kind: 'study' | 'work' };
export type Stop = number | 'fold';

const year = (value: string | undefined, missing: number) => (value ? Number(value) : missing);

// Studies and work on one line, by start year, then by end year. A record
// with no start has no place in time: it goes first instead of being given a
// year. One with no end has not ended, so it goes after those that have.
export function careerStops({ educations, employments }: Pick<NonNullable<OrcidRecord>, 'educations' | 'employments'>): CareerStop[] {
  return [
    ...educations.map((record) => ({ ...record, kind: 'study' as const })),
    ...employments.map((record) => ({ ...record, kind: 'work' as const })),
  ].sort((a, b) => year(a.startDate, -Infinity) - year(b.startDate, -Infinity)
    || year(a.endDate, Infinity) - year(b.endDate, Infinity));
}

// A job with a start and no end is current. A degree with no end may simply
// not say, so it shows its start alone.
export const isCurrent = (stop: CareerStop) => stop.kind === 'work' && Boolean(stop.startDate) && !stop.endDate;

export function stopYears(stop: CareerStop) {
  if (!stop.startDate) return stop.endDate ? `Until ${stop.endDate}` : null;
  if (stop.endDate) return `${stop.startDate} → ${stop.endDate}`;
  return isCurrent(stop) ? `${stop.startDate} → Present` : stop.startDate;
}

// The stops a line with room for `capacity` shows: all of them when they fit
// or the reader opened the fold; otherwise the first, a fold for the middle,
// and as many of the latest as are left.
export function lineStops(count: number, capacity: number, open: boolean): Stop[] {
  const all = Array.from({ length: count }, (_, at) => at);
  if (open || count <= capacity) return all;
  return [0, 'fold', ...all.slice(count - (capacity - 2))];
}

// The years a fold stands for, from its dated records only: from the first
// start to the latest end, or to the present when one of them is current.
export function foldYears(hidden: CareerStop[]) {
  const dated = hidden.filter((stop) => stop.startDate);
  if (!dated.length) return null;
  const from = dated[0].startDate;
  const to = dated.some(isCurrent) ? 'Present' : String(Math.max(...dated.map((stop) => Number(stop.endDate ?? stop.startDate))));
  return from === to ? from : `${from} → ${to}`;
}

// The width of a stop when the career is wider than the line: as wide as it
// can be, at least `min`, while the edge cuts the next stop through, so the
// cut stop says the line scrolls on. Null when every stop fits.
const PEEK = 0.45;
export function stopWidth(count: number, width: number, min: number, gap: number) {
  if (count * min + (count - 1) * gap <= width) return null;
  const whole = Math.max(1, Math.floor((width - PEEK * min) / (min + gap)));
  return (width - whole * gap) / (whole + PEEK);
}
