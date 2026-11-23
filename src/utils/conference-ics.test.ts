import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceIcs } from './conference-ics.ts';
import type { ConferenceEdition } from '../data/conferences.ts';

const now = new Date('2026-11-23T18:30:15.250Z');
const edition: ConferenceEdition = {
  id: 'neurips-2026', name: 'NeurIPS 2026', series: 'Conference', year: 2026, field: 'cs', url: 'https://neurips.cc/Conferences/2026',
  dates: [
    { start: '2026-12-06', end: '2026-12-12', city: 'Sydney, Australia' },
    { start: '2026-12-31', end: null, city: 'Paris, France' },
  ],
};

test('writes one all-day event per site, ending the day after its last day', () => {
  assert.equal(conferenceIcs(edition, now), [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PaperTok//Conference calendar//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', 'UID:neurips-2026-1@papertok.app', 'DTSTAMP:20261123T183015Z',
    'DTSTART;VALUE=DATE:20261206', 'DTEND;VALUE=DATE:20261213',
    'SUMMARY:NeurIPS 2026 (Sydney\\, Australia)', 'LOCATION:Sydney\\, Australia', 'URL:https://neurips.cc/Conferences/2026', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:neurips-2026-2@papertok.app', 'DTSTAMP:20261123T183015Z',
    'DTSTART;VALUE=DATE:20261231', 'DTEND;VALUE=DATE:20270101',
    'SUMMARY:NeurIPS 2026 (Paris\\, France)', 'LOCATION:Paris\\, France', 'URL:https://neurips.cc/Conferences/2026', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n'));
});

test('escapes text and folds a long line by octets without losing a character', () => {
  const long = { ...edition, url: undefined, name: 'Säo; a, b\\c ' + 'é'.repeat(60), dates: [{ start: '2027-01-01', end: null }] };
  const file = conferenceIcs(long, now);
  for (const line of file.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.ok(file.replaceAll('\r\n ', '').includes('SUMMARY:Säo\\; a\\, b\\\\c ' + 'é'.repeat(60) + '\r\n'));
  assert.doesNotMatch(file, /LOCATION|URL/);
});
