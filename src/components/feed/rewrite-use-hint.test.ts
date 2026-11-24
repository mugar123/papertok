import assert from 'node:assert/strict';
import test from 'node:test';
import { currentAIUses, rewriteUseHint } from './rewrite-use-hint.ts';

const options = {
  paper: { primaryCategory: 'quant-ph' },
  interestSettings: {},
  globalLevel: 'university',
  isCached: () => false,
} as const;

test('says nothing unless the version is saved', () => {
  assert.equal(rewriteUseHint(options), '');
  assert.equal(rewriteUseHint({ ...options, isCached: () => true }), 'Open this version for free.');
});

test('only the Physics starting level qualifies for a free reopen', () => {
  const physics = { ...options, interestSettings: { areaPreferences: { physics: { level: 'beginner' } } } } as const;
  assert.equal(rewriteUseHint({ ...physics, isCached: level => level === 'university' }), '');
  assert.equal(rewriteUseHint({ ...physics, isCached: level => level === 'beginner' }), 'Open this version for free.');
});

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
