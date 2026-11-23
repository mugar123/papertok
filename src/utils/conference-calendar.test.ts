import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceEditions, findConferenceEdition } from '../data/conferences.ts';
import { groupConferences, isConferencePath, localCalendarDate } from './conference-calendar.ts';
import type { ConferenceEdition } from '../data/conferences.ts';

test('an edition stays upcoming until its last site ends', () => {
  const { upcoming, past } = groupConferences(conferenceEditions, '2026-12-13');
  assert.ok(upcoming.get('2026-12')?.some(edition => edition.id === 'neurips-2026'));
  assert.ok(past.some(edition => edition.id === 'colm-2026'));
  assert.ok(groupConferences(conferenceEditions, '2026-12-14').past.some(edition => edition.id === 'neurips-2026'));
});

test('edition IDs are unique and an unknown location is absent', () => {
  assert.equal(findConferenceEdition('iclr-2027')?.dates[0]?.city, undefined);
  assert.equal(findConferenceEdition('nobody'), undefined);
  assert.equal(new Set(conferenceEditions.map(edition => edition.id)).size, conferenceEditions.length);
});

test('conference paths accept the calendar and one edition segment', () => {
  for (const path of ['/conferences', '/conferences/', '/conferences/neurips-2026', '/conferences/neurips-2026/']) {
    assert.equal(isConferencePath(path), true, path);
  }
  for (const path of ['/conference', '/conferences//', '/conferences/a/extra', '/research/conferences']) {
    assert.equal(isConferencePath(path), false, path);
  }
});

test('the local calendar keeps a conference upcoming on its last day', () => {
  const instant = new Date('2026-12-14T02:30:00Z');
  const today = localCalendarDate(instant, 'America/Los_Angeles');
  assert.equal(today, '2026-12-13');
  assert.equal(localCalendarDate(instant, 'UTC'), '2026-12-14');
  assert.ok(groupConferences(conferenceEditions, today).upcoming.get('2026-12')?.some(row => row.id === 'neurips-2026'));
});

test('groups undated and single-day events and uses the first remaining site', () => {
  const fixture: ConferenceEdition = { id: 'fixture', name: 'Fixture', series: 'Fixture', field: 'cs', dates: [] };
  const oneDay = { ...fixture, id: 'one-day', dates: [{ start: '2027-02-01', end: null }] };
  const multiSite = { ...fixture, id: 'multi-site', dates: [
    { start: '2027-01-29', end: '2027-01-31' },
    { start: '2027-03-01', end: null },
    { start: '2027-02-04', end: null },
  ] };
  const { upcoming, undated, past } = groupConferences([multiSite, fixture, oneDay], '2027-02-01');
  assert.deepEqual([...upcoming], [['2027-02', [oneDay, multiSite]]]);
  assert.deepEqual(undated, [fixture]);
  assert.deepEqual(past, []);
  assert.deepEqual(groupConferences([oneDay], '2027-02-02').past, [oneDay]);
});
