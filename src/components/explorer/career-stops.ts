import type { OrcidRecord } from '../../services/orcid-service.ts';

type Affiliation = NonNullable<OrcidRecord>['employments'][number];
export type CareerStop = Affiliation & { kind: 'study' | 'work' };
export type LineSlot = number | 'fold';

const year = (value: string | undefined, missing: number) => (value ? Number(value) : missing);

// Undated records go first rather than being given a year.
export function careerStops({ educations, employments }: Pick<NonNullable<OrcidRecord>, 'educations' | 'employments'>): CareerStop[] {
  return [
    ...educations.map((record) => ({ ...record, kind: 'study' as const })),
    ...employments.map((record) => ({ ...record, kind: 'work' as const })),
  ].sort((a, b) => year(a.startDate, -Infinity) - year(b.startDate, -Infinity)
    || year(a.endDate, Infinity) - year(b.endDate, Infinity));
}

// A degree with no end may simply not say, so only a job is current.
export const isCurrent = (stop: CareerStop) => stop.kind === 'work' && Boolean(stop.startDate) && !stop.endDate;

export function stopYears(stop: CareerStop) {
  if (!stop.startDate) return stop.endDate ? `Until ${stop.endDate}` : null;
  if (stop.endDate) return `${stop.startDate} → ${stop.endDate}`;
  return isCurrent(stop) ? `${stop.startDate} → Present` : stop.startDate;
}

export function lineStops(count: number, capacity: number, open: boolean): LineSlot[] {
  const all = Array.from({ length: count }, (_, at) => at);
  if (open || count <= capacity) return all;
  return [0, 'fold', ...all.slice(count - (capacity - 2))];
}

export function foldYears(hidden: CareerStop[]) {
  const dated = hidden.filter((stop) => stop.startDate);
  if (!dated.length) return null;
  const from = dated[0].startDate;
  if (dated.some(isCurrent)) return `${from} → Present`;
  const to = String(Math.max(...dated.map((stop) => Number(stop.endDate ?? stop.startDate))));
  return from === to ? from : `${from} → ${to}`;
}

// Sized so the line's edge cuts a stop through, which shows it scrolls.
const PEEK = 0.45;
export function stopWidth(count: number, width: number, min: number, gap: number) {
  if (count * min + (count - 1) * gap <= width) return null;
  const whole = Math.max(1, Math.floor((width - PEEK * min) / (min + gap)));
  return (width - whole * gap) / (whole + PEEK);
}
