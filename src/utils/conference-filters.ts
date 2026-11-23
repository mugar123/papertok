import { conferenceFields } from '../data/conferences.ts';
import type { ConferenceEdition, ConferenceField, ConferenceSite } from '../data/conferences.ts';
import { conferenceRegions, regionOfCountry } from '../data/conference-regions.ts';
import type { ConferenceRegion } from '../data/conference-regions.ts';
import { formatConferenceMonth } from './conference-text.ts';

export const conferenceFormats = {
  'in-person': 'In person',
  online: 'Online',
  unknown: 'Format not stated',
} as const;

type FormatFilter = keyof typeof conferenceFormats;

export type ConferenceFilters = {
  field: ConferenceField | null;
  region: ConferenceRegion | null;
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
    region: known<ConferenceRegion>(conferenceRegions, params.get('region')),
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
export function filterLabels({ field, region, month, format }: ConferenceFilters) {
  return [field && conferenceFields[field], region && conferenceRegions[region], month && formatConferenceMonth(month), format && conferenceFormats[format]].filter(label => label !== null);
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

/**
 * The regions of one site, or of an edition that has no dates yet. A site whose
 * country is not certain is in its own choice, so no region hides it unseen.
 */
function regionsAt(edition: ConferenceEdition, site?: ConferenceSite): ConferenceRegion[] {
  if (edition.format === 'online') return ['online'];
  const country = site?.country ?? edition.country;
  const place = (country && regionOfCountry(country)) || 'unknown';
  return edition.format === 'hybrid' ? [place, 'online'] : [place];
}

/** Every region an edition meets in, once each. */
export function conferenceRegionsOf(edition: ConferenceEdition) {
  const sites = edition.dates.length ? edition.dates : [undefined];
  return [...new Set(sites.flatMap(site => regionsAt(edition, site)))];
}

function meetsInMonth({ start, end }: ConferenceSite, month: string) {
  return start.slice(0, 7) <= month && (end ?? start).slice(0, 7) >= month;
}

/** The sites of an edition in the region and the month. */
export function matchingSites(edition: ConferenceEdition, { region, month }: Pick<ConferenceFilters, 'region' | 'month'>) {
  return edition.dates.filter(site => (!region || regionsAt(edition, site).includes(region)) && (!month || meetsInMonth(site, month)));
}

export function filterConferences(editions: readonly ConferenceEdition[], filters: ConferenceFilters) {
  const { field, region, month, format } = filters;
  return editions.filter(edition => (!field || edition.field === field)
    && (!format || conferenceFormatsOf(edition).includes(format))
    && (edition.dates.length ? matchingSites(edition, filters).length > 0 : !month && (!region || conferenceRegionsOf(edition).includes(region))));
}

export function isCalendarView(params: URLSearchParams) {
  return params.get('view') === 'calendar';
}

/** The chosen day of the link's month, as `YYYY-MM-DD`. */
export function readConferenceDay(params: URLSearchParams, month: string) {
  const day = `${month}-${params.get('day') ?? ''}`;
  return /-\d\d$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().startsWith(day) ? day : null;
}

/** Every month with a conference, in order, and the chosen one even if it has none. */
export function conferenceMonths(editions: readonly ConferenceEdition[], chosen: string | null) {
  const months = new Set(editions.flatMap(edition => edition.dates.map(site => site.start.slice(0, 7))));
  if (chosen) months.add(chosen);
  return [...months].sort();
}
