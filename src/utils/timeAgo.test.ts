import test from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo } from './timeAgo.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

test('timeAgo reads every shape a list date arrives in', () => {
  assert.equal(timeAgo(daysAgo(0.2), 'en', NOW), 'today');
  assert.equal(timeAgo(daysAgo(1).toISOString(), 'en', NOW), 'yesterday');
  assert.equal(timeAgo({ toDate: () => daysAgo(3) }, 'en', NOW), '3 days ago');
  assert.equal(timeAgo(daysAgo(15), 'en', NOW), '2 weeks ago');
  assert.equal(timeAgo(daysAgo(70), 'en', NOW), '2 months ago');
  assert.equal(timeAgo(daysAgo(800), 'en', NOW), '2 years ago');
});

test('timeAgo has nothing to say without a usable date', () => {
  assert.equal(timeAgo(undefined, 'en', NOW), null);
  assert.equal(timeAgo('not a date', 'en', NOW), null);
});
