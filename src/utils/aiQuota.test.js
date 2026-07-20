import assert from 'node:assert/strict';
import test from 'node:test';
import { formatQuotaCountdown, getQuotaCountdown } from './aiQuota.js';

test('formats a live countdown until the quota reset', () => {
  const resetAt = '2026-07-21T00:00:00.000Z';
  assert.deepEqual(getQuotaCountdown(resetAt, Date.parse('2026-07-20T22:58:57.000Z')), {
    totalSeconds: 3_663,
    hours: 1,
    minutes: 1,
    seconds: 3,
  });
  assert.equal(formatQuotaCountdown(resetAt, Date.parse('2026-07-20T21:30:00.000Z')), '2 h 30 min');
});

test('does not invent a countdown for an invalid reset timestamp', () => {
  assert.equal(getQuotaCountdown('not-a-date'), null);
  assert.equal(formatQuotaCountdown('not-a-date'), '');
});
