import test from 'node:test';
import assert from 'node:assert/strict';
import { documentIsAuthoritative, queryIsAuthoritative } from './cacheAuthority.js';

/**
 * Measured against the live backend with the connection down and a target the
 * page had not asked for before: `getDocs` resolved with 0 documents,
 * `fromCache: true`, in 0.5 ms — an empty SUCCESS, not a rejection. Three
 * screens believed it. This is the rule that stops them.
 */

const query = (size, fromCache) => ({ empty: size === 0, size, metadata: { fromCache } });
const document = (exists, fromCache) => ({ exists: () => exists, metadata: { fromCache } });

test('an empty query answered only by the cache is not an absence', () => {
  assert.equal(queryIsAuthoritative(query(0, true)), false);
});

test('an empty query the server answered is a real absence', () => {
  assert.equal(queryIsAuthoritative(query(0, false)), true);
});

test('a query with results is worth using however it was served', () => {
  assert.equal(queryIsAuthoritative(query(3, true)), true);
  assert.equal(queryIsAuthoritative(query(3, false)), true);
});

test('a missing document answered only by the cache is not a missing document', () => {
  assert.equal(documentIsAuthoritative(document(false, true)), false);
});

test('a missing document the server answered really is missing', () => {
  assert.equal(documentIsAuthoritative(document(false, false)), true);
});

test('a document that exists is worth using however it was served', () => {
  assert.equal(documentIsAuthoritative(document(true, true)), true);
  assert.equal(documentIsAuthoritative(document(true, false)), true);
});

test('`exists` as a plain boolean is read the same way', () => {
  // Not every snapshot-shaped object in this codebase carries the method form.
  assert.equal(documentIsAuthoritative({ exists: true, metadata: { fromCache: true } }), true);
  assert.equal(documentIsAuthoritative({ exists: false, metadata: { fromCache: true } }), false);
});

test('an answer that never arrived is not an answer', () => {
  for (const missing of [undefined, null]) {
    assert.equal(queryIsAuthoritative(missing), false);
    assert.equal(documentIsAuthoritative(missing), false);
  }
});

test('a snapshot with no metadata is trusted, because only the SDK omits it', () => {
  // Test doubles and hand-built snapshots have no `metadata`. Treating that as
  // "cache-served" would make every stubbed read look unavailable.
  assert.equal(queryIsAuthoritative({ empty: true, size: 0 }), true);
  assert.equal(documentIsAuthoritative({ exists: () => false }), true);
});
