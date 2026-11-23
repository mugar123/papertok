import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceEditions, findConferenceEdition } from '../data/conferences.ts';
import { groupConferences } from './conference-calendar.ts';

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
