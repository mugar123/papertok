import { importedEditions, launchDetails } from './conference-editions.ts';

export const conferenceFields = {
  cs: 'Computer science & AI',
  physics: 'Physics',
  math: 'Mathematics',
  medicine: 'Medicine',
  biology: 'Biology',
  economics: 'Economics & finance',
  statistics: 'Statistics',
  engineering: 'Engineering',
  chemistry: 'Chemistry',
} as const;

export type ConferenceField = keyof typeof conferenceFields;
/** `country` is the site's ISO 3166-1 alpha-2 code, for an edition with a place per site. */
export type ConferenceSite = { start: string; end: string | null; city?: string; country?: string };
export type ConferenceFormat = 'in-person' | 'online' | 'hybrid';
/** `timeText` is the hour as the source writes it, with its zone. */
export type ConferenceDeadline = { label: string; date: string; timeText?: string; sourceUrl: string };
/** Facts read apart from an edition's row. Each deadline has its own source. */
export type ConferenceDetails = { venue?: string; deadlines?: readonly ConferenceDeadline[] };

export type ConferenceEdition = {
  id: string;
  name: string;
  series: string;
  acronym?: string;
  year: number;
  field: ConferenceField;
  dates: readonly ConferenceSite[];
  url?: string;
  sourceUrl?: string;
  checkedOn?: string;
  dateText?: string;
  placeText?: string;
  /** ISO 3166-1 alpha-2, only when the recorded place makes it certain. */
  country?: string;
  /** Absent when the source does not say whether one can join online. */
  format?: ConferenceFormat;
  /** A path on PaperTok's own origin: an organizer's server must not see who opens the page. */
  logo?: `/conference-logos/${string}`;
  source?: 'ccf' | 'databio';
} & ConferenceDetails;

const launchEditions: readonly ConferenceEdition[] = [
  { id: 'neurips-2026', name: 'NeurIPS 2026', acronym: 'NeurIPS', year: 2026, series: 'Conference on Neural Information Processing Systems', field: 'cs', checkedOn: '2026-11-23', url: 'https://neurips.cc/Conferences/2026', sourceUrl: 'https://neurips.cc/Conferences/2026/Visa', dates: [
    { start: '2026-12-06', end: '2026-12-12', city: 'Sydney, Australia', country: 'AU' },
    { start: '2026-12-09', end: '2026-12-13', city: 'Atlanta, United States', country: 'US' },
    { start: '2026-12-09', end: '2026-12-13', city: 'Paris, France', country: 'FR' },
  ] },
  { id: 'iclr-2027', name: 'ICLR 2027', acronym: 'ICLR', year: 2027, series: 'International Conference on Learning Representations', field: 'cs', checkedOn: '2026-11-23', url: 'https://iclr.cc/Conferences/2027', placeText: 'California, United States', country: 'US', dates: [{ start: '2027-04-26', end: '2027-04-30' }] },
  { id: 'iclr-2026', name: 'ICLR 2026', acronym: 'ICLR', year: 2026, series: 'International Conference on Learning Representations', field: 'cs', checkedOn: '2026-11-23', url: 'https://iclr.cc/Conferences/2026', dates: [{ start: '2026-04-23', end: '2026-04-27', city: 'Rio de Janeiro, Brazil', country: 'BR' }] },
  { id: 'icml-2026', name: 'ICML 2026', acronym: 'ICML', year: 2026, series: 'International Conference on Machine Learning', field: 'cs', checkedOn: '2026-11-23', url: 'https://icml.cc/Conferences/2026/CallForPapers', dates: [{ start: '2026-07-06', end: '2026-07-11', city: 'Seoul, South Korea', country: 'KR' }] },
  { id: 'colm-2026', name: 'COLM 2026', acronym: 'COLM', year: 2026, series: 'Conference on Language Modeling', field: 'cs', checkedOn: '2026-11-23', url: 'https://colm.cc/Conferences/2026/Dates', dates: [{ start: '2026-10-06', end: '2026-10-09', city: 'San Francisco, United States', country: 'US' }] },
];

export const conferenceEditions: readonly ConferenceEdition[] = [...launchEditions.map(edition => ({ ...edition, ...launchDetails[edition.id] })), ...importedEditions];

export function findConferenceEdition(id: string | undefined) {
  return conferenceEditions.find(edition => edition.id === id);
}
