/**
 * The people index, client half.
 *
 * What the rules enforce is tested against the emulator in
 * `tests/firestore.rules.test.js`; nothing here can prove a permission. What
 * this file pins down is that the indexed name is derived the way the rules
 * recompute it — because a derivation that disagrees with `.lower()` makes a
 * legitimate profile save unwritable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_SEARCH_COLLECTION,
  toIndexedName,
  userSearchEntry,
  userSearchReference,
} from './userSearchService.ts';

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
