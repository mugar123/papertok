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
import { getProjectDisplayName } from './entityMetadata.js';

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

test('removes undefined provider fields before persisting a follow', () => {
  const follow = createFollowEntity({
    type: 'author',
    id: 'A1',
    displayName: 'Ada',
    externalIds: { orcid: undefined, semanticScholar: 'S1' },
    metadata: { categoryIds: [undefined, 'cs.AI'] },
  });
  assert.deepEqual(follow.externalIds, { semanticScholar: 'S1' });
  assert.deepEqual(follow.metadata.categoryIds, ['cs.AI']);
});

/**
 * A grant code is not unique across funders, so `searchProjects().id` moved
 * from the bare code to the OpenAIRE id (`prefix::hash`), and the Explorer's
 * entity id moved with it. Both feed `canonicalId`, which is the Firestore
 * document key — so a project followed before that change is stored under
 * `project_100010` while the search row now computes
 * `project_snsf________::…`. The displayName fallback in `followsEntity` is
 * the only thing that still recognises those follows, and it catches only if
 * the row spells the name the way the page stored it. It did not: the
 * Explorer writes `${acronym}: ${title}` and the row passed the acronym
 * alone, so the heart came up unfilled on a project the reader already
 * followed and a click wrote a second document for it — a duplicate row in
 * Following settings, a duplicated entity in the feed and the digest, and an
 * unfollow that had to be done twice.
 */
test('a project followed under its old grant-code id is still recognised from a search row', () => {
  const stored = [{
    type: 'project',
    canonicalId: '100010',
    displayName: 'QUANTUMLEAP: Quantum leap in photonics',
    source: 'openaire',
  }];
  const row = {
    id: 'snsf________::daa28096f9e8879ab3a02b90aa0e2f83',
    code: '100010',
    acronym: 'QUANTUMLEAP',
    title: 'Quantum leap in photonics',
  };

  assert.equal(
    followsEntity(stored, { type: 'project', id: row.id, displayName: getProjectDisplayName(row) }),
    true,
    'the id does not match any more, so the name is what has to',
  );
  assert.equal(
    followsEntity(stored, { type: 'project', id: row.id, displayName: row.acronym }),
    false,
    'the acronym on its own is what orphaned the follow',
  );
});

test('a project name is its acronym and its title, or whichever of the two it has', () => {
  assert.equal(getProjectDisplayName({ acronym: 'LEAP', title: 'Quantum leap' }), 'LEAP: Quantum leap');
  assert.equal(getProjectDisplayName({ title: 'Quantum leap' }), 'Quantum leap');
  assert.equal(getProjectDisplayName({ acronym: 'LEAP' }), 'LEAP');
  assert.equal(getProjectDisplayName(null), '');
});
