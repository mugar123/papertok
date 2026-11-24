import assert from 'node:assert/strict';
import test from 'node:test';
import { currentAIUses } from './current-ai-uses.ts';

test('the uses tag states only a count that still holds', () => {
  const quota = { remainingUses: 3, dailyLimit: 10, resetAt: '2099-01-02T16:00:00Z' };
  const now = Date.parse('2099-01-02T09:00:00Z');
  assert.deepEqual(currentAIUses(quota, { now, online: true }), { left: 3, limit: 10 });
  assert.equal(currentAIUses(quota, { now: Date.parse('2099-01-02T16:00:01Z'), online: true }), null, 'past the reset');
  assert.equal(currentAIUses(quota, { now, online: false }), null, 'offline');
  assert.equal(currentAIUses(null, { now, online: true }), null, 'unknown');
  assert.equal(currentAIUses({ ...quota, unlimited: true }, { now, online: true }), null, 'unlimited');
  assert.equal(currentAIUses({ ...quota, resetAt: undefined }, { now, online: true }), null, 'no reset time');
});
