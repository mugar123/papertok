import { conferenceFields } from '../data/conferences.ts';
import type { ConferenceEdition, ConferenceField } from '../data/conferences.ts';
import { formatConferenceMonth } from './conference-text.ts';

export const conferenceFormats = {
  'in-person': 'In person',
  online: 'Online',
  unknown: 'Format not stated',
} as const;

type FormatFilter = keyof typeof conferenceFormats;

export type ConferenceFilters = {
  field: ConferenceField | null;
  /** `YYYY-MM`. */
  month: string | null;
  format: FormatFilter | null;
};

function known<T extends string>(options: Readonly<Record<T, string>>, value: string | null) {
  return value !== null && Object.hasOwn(options, value) ? value as T : null;
}

/** Reads a shared link: an unknown value is no filter. */
export function readConferenceFilters(params: URLSearchParams): ConferenceFilters {
  const month = params.get('month');
  return {
    field: known<ConferenceField>(conferenceFields, params.get('field')),
    month: month !== null && /^20\d\d-(?:0[1-9]|1[0-2])$/.test(month) ? month : null,
    format: known<FormatFilter>(conferenceFormats, params.get('format')),
  };
}

/** The parameters with one value changed. A missing value leaves the address. */
export function withConferenceParam(params: URLSearchParams, name: string, value: string | null) {
  const next = new URLSearchParams(params);
  if (value) next.set(name, value);
  else next.delete(name);
  return next;
}

/** The active filters in words, in the order of the filter bar. */
export function filterLabels({ field, month, format }: ConferenceFilters) {
  return [field && conferenceFields[field], month && formatConferenceMonth(month), format && conferenceFormats[format]].filter(label => label !== null);
}

/**
 * The formats an edition answers to. When its source states none, a recorded
 * place still says that people meet, but not whether one can join online.
 */
export function conferenceFormatsOf(edition: ConferenceEdition): FormatFilter[] {
  if (edition.format === 'hybrid') return ['in-person', 'online'];
  if (edition.format) return [edition.format];
  const placed = Boolean(edition.placeText ?? edition.venue) || edition.dates.some(site => site.city);
  return placed ? ['in-person', 'unknown'] : ['unknown'];
}

function meetsInMonth({ start, end }: ConferenceEdition['dates'][number], month: string) {
  return start.slice(0, 7) <= month && (end ?? start).slice(0, 7) >= month;
}

export function filterConferences(editions: readonly ConferenceEdition[], { field, month, format }: ConferenceFilters) {
  return editions.filter(edition => (!field || edition.field === field)
    && (!month || edition.dates.some(site => meetsInMonth(site, month)))
    && (!format || conferenceFormatsOf(edition).includes(format)));
}

/** Every month with a conference, in order, and the chosen one even if it has none. */
export function conferenceMonths(editions: readonly ConferenceEdition[], chosen: string | null) {
  const months = new Set(editions.flatMap(edition => edition.dates.map(site => site.start.slice(0, 7))));
  if (chosen) months.add(chosen);
  return [...months].sort();
}
