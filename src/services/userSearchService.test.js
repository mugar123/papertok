/**
 * User search (F9) — client half.
 *
 * What the rules enforce is tested against the emulator in
 * `tests/firestore.rules.test.js`; nothing here can prove a permission. What
 * this file pins down is the half the rules cannot see: that a search costs two
 * bounded queries and not one per keystroke, that the two result sets become
 * one list without duplicates, and that the indexed name is derived the way the
 * rules recompute it — because a derivation that disagrees with `.lower()`
 * makes a legitimate profile save unwritable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  USER_SEARCH_COLLECTION,
  USER_SEARCH_DEBOUNCE_MS,
  USER_SEARCH_LIMIT_CEILING,
  USER_SEARCH_MIN_LENGTH,
  USER_SEARCH_PAGE_SIZE,
  UserSearchAuthRequiredError,
  UserSearchUnsupportedError,
  isSearchableTerm,
  mergeUserSearchResults,
  normalizeUserSearchTerm,
  searchUsers,
  toIndexedName,
  userSearchEntry,
  userSearchReference,
} from './userSearchService.js';

/**
 * Captures the queries a search issues without touching Firestore. `query` is
 * recorded verbatim, so a test can assert on the constraints that were passed
 * rather than on a stub's idea of them.
 */
function fakeApi(rowsByField = {}, overrides = {}) {
  const issued = [];
  return {
    issued,
    api: {
      database: 'db',
      currentUser: { uid: 'searcher-uid' },
      isDemo: false,
      collection: (database, name) => `${database}/${name}`,
      query: (path, ...constraints) => ({ path, constraints }),
      getDocuments: async (built) => {
        issued.push(built);
        const field = built.constraints[0]?._field?.toString?.()
          || built.constraints[0]?.field
          || 'handle';
        const rows = rowsByField[field] || [];
        return { docs: rows.map(row => ({ id: row.uid, data: () => row })) };
      },
      ...overrides,
    },
  };
}

const row = (uid, handle, nameLower) => ({ uid, handle, nameLower });

// --- the indexed name -------------------------------------------------------

test('the indexed name is ASCII lowercase and nothing else', () => {
  // `firestore.rules` checks `nameLower == displayName.lower()` on every write.
  // Anything cleverer here — folding accents, stripping punctuation, splitting
  // words — is a derivation the rules cannot recompute, so it would either be
  // refused outright or reopen the name-stuffing hole that equality closes.
  assert.equal(toIndexedName('Ada Lovelace'), 'ada lovelace');
  assert.equal(toIndexedName('Nicolás Muñoz'), 'nicolás muñoz');
  // ASCII-only, because the rules engine's `.lower()` is ASCII-only — measured
  // against the emulator, where "MUÑOZ" lowers to "muÑoz". JavaScript's
  // `toLowerCase()` would say "muñoz", the equality in rules would fail, and a
  // real account called "Nicolás MUÑOZ García" could not save its profile.
  assert.equal(toIndexedName('MUÑOZ'), 'muÑoz');
  assert.equal(toIndexedName('ÑOÑO'), 'ÑoÑo', 'the ASCII letters lower, the Ñ does not');
  assert.equal(toIndexedName(undefined), '');
});

test('a term is lowered exactly the way the stored name was', () => {
  // Otherwise the query speaks a case the index does not hold.
  assert.equal(normalizeUserSearchTerm('MUÑOZ'), toIndexedName('MUÑOZ'));
});

test('an index entry carries two fields and nothing else', () => {
  const entry = userSearchEntry({ handle: '  Ada ', displayName: 'Ada Lovelace' });
  assert.deepEqual(entry, { handle: 'ada', nameLower: 'ada lovelace' });
  // No photo and no bio, deliberately: those are exactly what the F1 review
  // closed `list` on userProfiles/ to protect. The rules refuse extra keys, and
  // this is the client refusing to try.
  //
  // And no timestamp. The entry used to carry a server-stamped `createdAt` that
  // this function rewrote on every profile save, so it tracked the last edit
  // rather than the creation — and any signed-in caller could `orderBy` it for a
  // listing of who touched their profile most recently. Nothing read it.
  assert.deepEqual(Object.keys(entry).sort(), ['handle', 'nameLower']);
});

test('the entry holds no clock a searcher could order by', () => {
  // Pinned separately from the shape above, because this is the property that
  // matters rather than the field count: any timestamp here is an activity
  // signal, and the rules refuse keys this function does not produce.
  const entry = userSearchEntry({ handle: 'ada', displayName: 'Ada Lovelace' });
  for (const [key, value] of Object.entries(entry)) {
    assert.equal(typeof value, 'string', `${key} must be a plain string`);
  }
});

test('an entry cannot be built without the two fields it exists to hold', () => {
  assert.throws(() => userSearchEntry({ handle: '', displayName: 'Ada' }), TypeError);
  assert.throws(() => userSearchEntry({ handle: 'ada', displayName: '   ' }), TypeError);
});

test('the entry lives under the uid, matching its profile', () => {
  assert.equal(
    userSearchReference('db', 'user-1', (...parts) => parts.join('/')),
    `db/${USER_SEARCH_COLLECTION}/user-1`,
  );
});

// --- what gets sent ---------------------------------------------------------

test('a term is trimmed, collapsed and lowercased before it is sent', () => {
  assert.equal(normalizeUserSearchTerm('  Nico   Muñoz '), 'nico muñoz');
  assert.equal(normalizeUserSearchTerm(null), '');
  assert.equal(normalizeUserSearchTerm('x'.repeat(200)).length, 80, 'bounded like the field');
});

test('a leading @ is dropped, because handles are stored without one', () => {
  // Typing the exact handle you already know is the most confident search
  // anybody makes, and with the sigil left on it returned nobody. It matters
  // more now that this shares a box with paper search, where the @ is how you
  // say "a person, not a paper".
  assert.equal(normalizeUserSearchTerm('@NICK'), 'nick');
  assert.equal(normalizeUserSearchTerm('  @nick_mugar '), 'nick_mugar');
  assert.equal(normalizeUserSearchTerm('@@nick'), 'nick', 'a slip of the finger still searches');
  // Only leading, and only the sigil: an @ inside a term is a character like
  // any other, and the minimum length is measured after it goes.
  assert.equal(normalizeUserSearchTerm('nick@home'), 'nick@home');
  assert.equal(isSearchableTerm('@n'), false, 'one letter behind a sigil is still one letter');
  assert.equal(isSearchableTerm('@ni'), true);
});

test('below the minimum, a search costs nothing at all', async () => {
  assert.equal(USER_SEARCH_MIN_LENGTH, 2);
  assert.equal(isSearchableTerm('n'), false);
  assert.equal(isSearchableTerm(' ni '), true);
  const { api, issued } = fakeApi();
  assert.deepEqual(await searchUsers('n', api), []);
  assert.deepEqual(issued, [], 'no query may leave the client for a one-letter term');
});

test('one search is exactly two bounded queries', async () => {
  const { api, issued } = fakeApi();
  await searchUsers('nico', api);
  assert.equal(issued.length, 2, 'one per field: handle and nameLower');
  for (const built of issued) {
    assert.equal(built.path, `db/${USER_SEARCH_COLLECTION}`);
    assert.ok(
      built.constraints.some(constraint => constraint?.type === 'limit'),
      'every query carries a ceiling',
    );
  }
});

test('the page size stays under the ceiling the rules impose', () => {
  // The rules refuse `limit > 20` on this collection, so two queries of ten is
  // the whole budget of a search. A page size above the ceiling would not be a
  // bigger search, it would be a denied one.
  assert.ok(USER_SEARCH_PAGE_SIZE <= USER_SEARCH_LIMIT_CEILING);
  assert.equal(USER_SEARCH_LIMIT_CEILING, 20);
});

test('searching demands a session, and refuses demo mode', async () => {
  const anonymous = fakeApi({}, { currentUser: null });
  await assert.rejects(() => searchUsers('nico', anonymous.api), UserSearchAuthRequiredError);
  assert.deepEqual(anonymous.issued, [], 'a signed-out search never reaches the network');

  const demo = fakeApi({}, { isDemo: true });
  await assert.rejects(() => searchUsers('nico', demo.api), UserSearchUnsupportedError);
});

// --- merging ----------------------------------------------------------------

test('an account matching both fields appears once', () => {
  const merged = mergeUserSearchResults(
    [row('u1', 'nick_mugar', 'nicolás muñoz')],
    [row('u1', 'nick_mugar', 'nicolás muñoz'), row('u2', 'mugar', 'nico g')],
  );
  assert.deepEqual(merged.map(entry => entry.uid), ['u1', 'u2']);
});

test('handle matches lead, because an exact handle below three names reads as broken', () => {
  const merged = mergeUserSearchResults(
    [row('u9', 'nico', 'someone else')],
    [row('u1', 'a', 'nicolás a'), row('u2', 'b', 'nicolás b')],
  );
  assert.equal(merged[0].uid, 'u9');
});

test('merging survives an empty side and a malformed row', () => {
  assert.deepEqual(mergeUserSearchResults(null, undefined), []);
  assert.deepEqual(mergeUserSearchResults([{ handle: 'no-uid' }], []), []);
});

test('a search returns rows the list can paint with no further reads', async () => {
  const { api } = fakeApi({ handle: [row('u1', 'mugar', 'nico mugar')] });
  const results = await searchUsers('mu', api);
  assert.deepEqual(results, [{ uid: 'u1', handle: 'mugar', name: 'nico mugar' }]);
});

// --- structural -------------------------------------------------------------

test('SOURCE: no query in this service is issued without a ceiling', async () => {
  const source = await readFile(new URL('./userSearchService.js', import.meta.url), 'utf8');
  const queries = source.match(/query\(\s*\n?[\s\S]*?\n\s*\)\)/g) || [];
  assert.ok(queries.length > 0, 'expected at least one query to guard');
  for (const shape of queries) {
    assert.match(shape, /limit\(/, `unbounded query: ${shape}`);
  }
  assert.doesNotMatch(source, /getDocs\((?!query\()/, 'every getDocs goes through a bounded query');
});

test('SOURCE: the search never reads a profile, a handle or a photo', async () => {
  // The whole point of a separate collection is that a result row costs
  // nothing beyond the index document. A read of userProfiles/ per row would
  // put the price of the F1 directory back on the feature.
  const source = await readFile(new URL('./userSearchService.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(code, /userProfiles|handles|photo|bio/);
});

test('the debounce is long enough that typing is not a search per letter', () => {
  assert.ok(USER_SEARCH_DEBOUNCE_MS >= 400, 'the design floor is 400 ms');
});
