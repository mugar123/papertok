import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteUseHint } from './rewrite-use-hint.ts';

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
