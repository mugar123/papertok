import test from 'node:test';
import assert from 'node:assert/strict';
import { finishLegacyAuthorsMigration } from './followingMigration.js';

const transforms = {
  remove: (...names) => ({ op: 'remove', names }),
  timestamp: () => 'SERVER_TIMESTAMP',
};

test('clears exactly the names read, as a field transform, never the whole array', () => {
  const patch = finishLegacyAuthorsMigration(['Ada Lovelace', 'Grace Hopper'], transforms);
  assert.deepEqual(patch, {
    followedAuthors: { op: 'remove', names: ['Ada Lovelace', 'Grace Hopper'] },
    followingMigratedAt: 'SERVER_TIMESTAMP',
  });
});

test('drops null, undefined and empty-string garbage before calling arrayRemove', () => {
  // The legacy array was never validated on the way in; passing a nullish
  // entry straight to arrayRemove throws in the real SDK.
  const patch = finishLegacyAuthorsMigration(['Ada Lovelace', null, '', undefined, 'Grace Hopper'], transforms);
  assert.deepEqual(patch.followedAuthors, { op: 'remove', names: ['Ada Lovelace', 'Grace Hopper'] });
});

test('dedupes repeated names', () => {
  const patch = finishLegacyAuthorsMigration(['Ada Lovelace', 'Ada Lovelace', 'Grace Hopper'], transforms);
  assert.deepEqual(patch.followedAuthors, { op: 'remove', names: ['Ada Lovelace', 'Grace Hopper'] });
});

test('still names a (possibly empty) removal and still stamps the migration when nothing valid survives filtering', () => {
  const patch = finishLegacyAuthorsMigration([null, ''], transforms);
  assert.deepEqual(patch, {
    followedAuthors: { op: 'remove', names: [] },
    followingMigratedAt: 'SERVER_TIMESTAMP',
  });
});

test('defaults to the real firebase arrayRemove/serverTimestamp, not a plain array', () => {
  // No injected transforms here on purpose: this is what production actually
  // calls. A regression back to `followedAuthors: []` would return a bare
  // array, which is exactly what this must not be.
  const patch = finishLegacyAuthorsMigration(['Ada Lovelace']);
  assert.equal(Array.isArray(patch.followedAuthors), false, 'must be a field-transform sentinel, not the array itself');
  assert.notDeepEqual(patch.followedAuthors, []);
  assert.equal(patch.followedAuthors?._methodName, 'arrayRemove');
  assert.deepEqual(patch.followedAuthors?._elements, ['Ada Lovelace']);
  assert.ok(patch.followingMigratedAt, 'followingMigratedAt must still be stamped in the same patch');
});
