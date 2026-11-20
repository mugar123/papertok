import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteUseHint } from './rewrite-use-hint.ts';

const options = {
  paper: { primaryCategory: 'quant-ph' },
  interestSettings: {},
  globalLevel: 'university',
  isCached: () => false,
  locale: 'en-US',
} as const;

const reset = new Date(2099, 0, 2, 16);
const quota = { remainingUses: 1, dailyLimit: 10, resetAt: reset.toISOString() };

test('shows the remaining uses and local reset time, including at zero', () => {
  assert.equal(rewriteUseHint({ ...options, quota }), '1 AI use left today. Resets at 4:00 PM. Saved versions open free.');
  assert.equal(rewriteUseHint({ ...options, quota: { ...quota, remainingUses: 0 } }), '0 AI uses left today. Resets at 4:00 PM. Saved versions open free.');
});

test('omits unknown or expired counts and identifies a free reopen without quota', () => {
  assert.equal(rewriteUseHint({ ...options, quota: null }), '');
  assert.equal(rewriteUseHint({ ...options, quota: { ...quota, resetAt: '2020-01-01T00:00:00Z' } }), '');
  assert.equal(rewriteUseHint({ ...options, quota: null, isCached: () => true }), 'Open this version for free.');
});

test('only the Physics starting level qualifies for a free reopen', () => {
  const physics = { ...options, quota, interestSettings: { areaPreferences: { physics: { level: 'beginner' } } } } as const;
  assert.equal(rewriteUseHint({ ...physics, isCached: level => level === 'university' }),
    '1 AI use left today. Resets at 4:00 PM. Saved versions open free.');
  assert.equal(rewriteUseHint({ ...physics, isCached: level => level === 'beginner' }),
    'Open this version for free.');
});
