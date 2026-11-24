import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteUseHint } from './rewrite-use-hint.ts';

const reset = new Date(2099, 0, 2, 16);
const quota = { remainingUses: 1, dailyLimit: 10, resetAt: reset.toISOString() };

test('shows the remaining uses and local reset time, including at zero', () => {
  assert.equal(rewriteUseHint(quota, false, 'en-US'), '1 AI use left today. Resets at 4:00 PM. Saved versions open free.');
  assert.equal(rewriteUseHint({ ...quota, remainingUses: 0 }, false, 'en-US'), '0 AI uses left today. Resets at 4:00 PM. Saved versions open free.');
});

test('omits unknown or expired counts and identifies a free reopen without quota', () => {
  assert.equal(rewriteUseHint(null, false, 'en-US'), '');
  assert.equal(rewriteUseHint({ ...quota, resetAt: '2020-01-01T00:00:00Z' }, false, 'en-US'), '');
  assert.equal(rewriteUseHint(null, true, 'en-US'), 'Open this version for free.');
});
