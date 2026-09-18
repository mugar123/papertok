import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_MARK_KEY, markSignedIn, clearSignedIn, hasSignedIn } from './sessionMark.js';

const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('the key is the one the landing head reads', () => { assert.equal(SESSION_MARK_KEY, 'papertok_signed_in'); });
test('marking and clearing round-trip through the given storage', () => {
  const s = fakeStorage();
  assert.equal(hasSignedIn(s), false);
  markSignedIn(s); assert.equal(s.getItem(SESSION_MARK_KEY), '1'); assert.equal(hasSignedIn(s), true);
  clearSignedIn(s); assert.equal(hasSignedIn(s), false);
});
test('a storage that throws is treated as absent, never as an error', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(hasSignedIn(broken), false);
  assert.doesNotThrow(() => markSignedIn(broken));
  assert.doesNotThrow(() => clearSignedIn(broken));
});
