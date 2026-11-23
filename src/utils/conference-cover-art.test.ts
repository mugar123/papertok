import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceEditions, conferenceFields } from '../data/conferences.ts';
import type { ConferenceField } from '../data/conferences.ts';
import { coverArt } from './conference-cover-art.ts';

test('editions of one series share a cover and two series in a field do not', () => {
  for (const field of Object.keys(conferenceFields) as ConferenceField[]) {
    assert.deepEqual(coverArt(field, 'Series A'), coverArt(field, 'Series A'), field);
    assert.notEqual(coverArt(field, 'Series A').figure, coverArt(field, 'Series B').figure, field);
  }
});

test('every registered edition draws paths with finite numbers', () => {
  for (const { id, field, series } of conferenceEditions) {
    const { ground, figure } = coverArt(field, series);
    for (const path of [ground, figure]) {
      assert.match(path, /^M/, id);
      assert.doesNotMatch(path, /NaN|Infinity|undefined/, id);
    }
  }
});
