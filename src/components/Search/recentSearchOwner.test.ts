import test from 'node:test';
import assert from 'node:assert/strict';
import { recentsShownTo, shouldRememberQuery } from './recentSearchOwner.ts';

const answered = {
  typed: true, hasSearched: true, resultsTerm: 'Private Alice query', query: 'Private Alice query',
  totalResults: 3, isPending: false, activeSection: 'all' as const,
  results: { papers: [1, 2], authors: [3], topics: [], institutions: [], projects: [] },
};

test('the recents read for one account are not shown to the next', () => {
  const alice = { uid: 'alice', queries: ['Private Alice query'] };
  assert.deepEqual(recentsShownTo(alice, 'alice'), ['Private Alice query']);
  assert.deepEqual(recentsShownTo(alice, 'bob'), []);
  assert.deepEqual(recentsShownTo(alice, undefined), []);
});

test('after an account change the closing palette saves nothing under the new UID', () => {
  for (const uid of ['bob', undefined]) {
    // Alice's recents and query are still in memory when the palette closes as Bob, or signed out.
    assert.equal(shouldRememberQuery({ ...answered, uid, ownerUid: 'alice' }), false);
  }
});

test('the signed-in account saves its own answered query', () => {
  assert.equal(shouldRememberQuery({ ...answered, uid: 'alice', ownerUid: 'alice' }), true);
});

test('a suggestion, an unanswered query or an empty section is not saved', () => {
  const owner = { uid: 'alice', ownerUid: 'alice' };
  assert.equal(shouldRememberQuery({ ...answered, ...owner, typed: false }), false);
  assert.equal(shouldRememberQuery({ ...answered, ...owner, isPending: true }), false);
  assert.equal(shouldRememberQuery({ ...answered, ...owner, resultsTerm: 'Private Alice' }), false);
  assert.equal(shouldRememberQuery({ ...answered, ...owner, totalResults: 0 }), false);
  assert.equal(shouldRememberQuery({ ...answered, ...owner, activeSection: 'topics' }), false);
  assert.equal(shouldRememberQuery({ ...answered, ...owner, activeSection: 'authors' }), true);
});
