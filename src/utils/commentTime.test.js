import test from 'node:test';
import assert from 'node:assert/strict';
import { commentDate, commentMillis } from './commentTime.js';

test('commentMillis reads Timestamps, Dates, ISO strings and epoch values', () => {
  const iso = '2026-08-31T12:00:00.000Z';
  const millis = Date.parse(iso);
  assert.equal(commentMillis({ toMillis: () => millis }), millis);
  assert.equal(commentMillis({ toDate: () => new Date(iso) }), millis);
  assert.equal(commentMillis(new Date(iso)), millis);
  assert.equal(commentMillis(iso), millis);
  assert.equal(commentMillis(millis), millis);
  assert.equal(commentMillis({ seconds: millis / 1000, nanoseconds: 0 }), millis);
  assert.equal(commentMillis(null), 0);
  assert.equal(commentMillis('nope'), 0);
});

test('commentDate is null when there is no time, otherwise a Date', () => {
  assert.equal(commentDate(null), null);
  assert.equal(commentDate('2026-08-31T12:00:00.000Z')?.toISOString(), '2026-08-31T12:00:00.000Z');
});
