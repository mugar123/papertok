import { importedEditions } from './conference-editions.ts';

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
type DateRange = { start: string; end: string | null; city?: string };

export type ConferenceEdition = {
  id: string;
  name: string;
  series: string;
  field: ConferenceField;
  dates: readonly DateRange[];
  url?: string;
  sourceUrl?: string;
  checkedOn?: string;
  dateText?: string;
  placeText?: string;
  online?: boolean;
  source?: 'ccf' | 'databio';
};

const launchEditions: readonly ConferenceEdition[] = [
  { id: 'neurips-2026', name: 'NeurIPS 2026', series: 'Conference on Neural Information Processing Systems', field: 'cs', checkedOn: '2026-11-23', url: 'https://neurips.cc/Conferences/2026', sourceUrl: 'https://neurips.cc/Conferences/2026/Visa', dates: [
    { start: '2026-12-06', end: '2026-12-12', city: 'Sydney, Australia' },
    { start: '2026-12-09', end: '2026-12-13', city: 'Atlanta, United States' },
    { start: '2026-12-09', end: '2026-12-13', city: 'Paris, France' },
  ] },
  { id: 'iclr-2027', name: 'ICLR 2027', series: 'International Conference on Learning Representations', field: 'cs', checkedOn: '2026-11-23', url: 'https://iclr.cc/Conferences/2027', placeText: 'California, United States', dates: [{ start: '2027-04-26', end: '2027-04-30' }] },
  { id: 'iclr-2026', name: 'ICLR 2026', series: 'International Conference on Learning Representations', field: 'cs', checkedOn: '2026-11-23', url: 'https://iclr.cc/Conferences/2026', dates: [{ start: '2026-04-23', end: '2026-04-27', city: 'Rio de Janeiro, Brazil' }] },
  { id: 'icml-2026', name: 'ICML 2026', series: 'International Conference on Machine Learning', field: 'cs', checkedOn: '2026-11-23', url: 'https://icml.cc/Conferences/2026/CallForPapers', dates: [{ start: '2026-07-06', end: '2026-07-11', city: 'Seoul, South Korea' }] },
  { id: 'colm-2026', name: 'COLM 2026', series: 'Conference on Language Modeling', field: 'cs', checkedOn: '2026-11-23', url: 'https://colm.cc/Conferences/2026/Dates', dates: [{ start: '2026-10-06', end: '2026-10-09', city: 'San Francisco, United States' }] },
];

export const conferenceEditions = [...launchEditions, ...importedEditions];

export function findConferenceEdition(id: string | undefined) {
  return conferenceEditions.find(edition => edition.id === id);
}
