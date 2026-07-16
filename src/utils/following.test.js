import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFollowEntity,
  createFollowKey,
  followsEntity,
  getFollowingStorageKey,
  migrateLegacyAuthors,
  normalizeFollowId,
} from './following.js';

test('normalizes provider URLs into stable ids', () => {
  assert.equal(normalizeFollowId('https://openalex.org/A123'), 'A123');
  assert.equal(normalizeFollowId('https://ror.org/02f40zc51'), '02f40zc51');
  assert.equal(createFollowKey('institution', 'https://openalex.org/I1'), 'institution_I1');
});

test('matches by id and falls back to normalized display name', () => {
  const followed = [{ type: 'author', canonicalId: 'A1', displayName: 'José García' }];
  assert.equal(followsEntity(followed, { type: 'author', id: 'https://openalex.org/A1', name: 'Other' }), true);
  assert.equal(followsEntity(followed, { type: 'author', id: 'legacy:jose', name: 'Jose Garcia' }), true);
});

test('creates isolated storage keys and migrates unique legacy authors', () => {
  assert.notEqual(getFollowingStorageKey('one'), getFollowingStorageKey('two'));
  const migrated = migrateLegacyAuthors(['Ada Lovelace', 'Ada Lovelace']);
  assert.equal(migrated.length, 1);
  assert.deepEqual(createFollowEntity(migrated[0])?.type, 'author');
});

