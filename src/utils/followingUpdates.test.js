import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactSeenIds,
  getFollowingUpdatePaperKey,
  isRecentFollowingUpdate,
  mergeFollowingUpdatePapers,
} from './followingUpdates.js';

test('uses DOI as the stable inbox identity when available', () => {
  assert.equal(
    getFollowingUpdatePaperKey({ id: 'other-id', doi: 'https://doi.org/10.1000/ABC' }),
    'doi:10.1000/abc',
  );
});

test('deduplicates papers and preserves every followed-entity reason', () => {
  const merged = mergeFollowingUpdatePapers([
    {
      id: 'one',
      doi: '10.1000/same',
      title: 'Shared paper',
      published: '2026-06-01',
      citationCount: 2,
      _followedEntityMatches: [{ type: 'author', canonicalId: 'A1', displayName: 'Ada' }],
    },
    {
      id: 'two',
      doi: 'https://doi.org/10.1000/SAME',
      title: 'Shared paper',
      published: '2026-06-01',
      citationCount: 7,
      _followedEntityMatches: [{ type: 'topic', canonicalId: 'T1', displayName: 'Cosmología' }],
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].citationCount, 7);
  assert.deepEqual(merged[0]._followedEntityMatches.map(match => match.type), ['author', 'topic']);
});

test('sorts updates by publication date and rejects stale papers', () => {
  const now = Date.parse('2026-07-23T00:00:00Z');
  assert.equal(isRecentFollowingUpdate({ published: '2026-07-01' }, now, 365), true);
  assert.equal(isRecentFollowingUpdate({ published: '2024-01-01' }, now, 365), false);

  const sorted = mergeFollowingUpdatePapers([
    { id: 'old', title: 'Old', published: '2026-01-01' },
    { id: 'new', title: 'New', published: '2026-07-01' },
  ]);
  assert.deepEqual(sorted.map(paper => paper.id), ['new', 'old']);
});

test('keeps the seen-id list bounded and unique', () => {
  const ids = Array.from({ length: 510 }, (_, index) => `paper-${index}`);
  const compact = compactSeenIds([...ids, 'paper-509']);
  assert.equal(compact.length, 500);
  assert.equal(compact.at(-1), 'paper-509');
});
