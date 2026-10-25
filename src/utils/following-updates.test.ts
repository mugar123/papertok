import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactSeenIds,
  getFollowingUpdatePaperKey,
  isRecentFollowingUpdate,
  mergeFollowingUpdatePapers,
} from './following-updates.ts';

test('uses DOI as the stable inbox identity when available', () => {
  assert.equal(
    getFollowingUpdatePaperKey({ id: 'other-id', doi: 'https://doi.org/10.1000/ABC' }),
    'doi:10.1000/abc',
  );
});

test('deduplicates papers and preserves every followed-entity reason', () => {
  const merged = mergeFollowingUpdatePapers(([
    {
      id: 'one',
      doi: '10.1000/same',
      title: 'Shared paper',
      published: '2026-06-01',
      citationCount: 2,
      _followedEntityMatches: [{ type: 'author' as const, canonicalId: 'A1', displayName: 'Ada' }],
    },
    {
      id: 'two',
      doi: 'https://doi.org/10.1000/SAME',
      title: 'Shared paper',
      published: '2026-06-01',
      citationCount: 7,
      _followedEntityMatches: [{ type: 'topic' as const, canonicalId: 'T1', displayName: 'Cosmología' }],
    },
  ] as import('../models/paper.ts').Paper[]));

  assert.equal(merged.length, 1);
  assert.equal(merged[0].citationCount, 7);
  assert.deepEqual(merged[0]._followedEntityMatches!.map(match => (match as Exclude<typeof match, string>).type), ['author', 'topic']);
});

test('deduplicates provider records by title and first author when their ids differ', () => {
  const merged = mergeFollowingUpdatePapers(([
    {
      id: 'openalex:W1',
      title: 'A shared result without a DOI',
      authors: [{ name: 'Ada Lovelace' }],
      published: '2026-07-01',
      citationCount: 3,
      abstract: 'Short abstract.',
      _followedEntityMatches: [{ type: 'author' as const, canonicalId: 'A1', displayName: 'Ada Lovelace' }],
    },
    {
      id: 'repository:99',
      title: 'A Shared Result Without a DOI',
      authors: [{ name: 'Ada Lovelace' }],
      published: '2026-07-01',
      citationCount: 12,
      abstract: 'A longer abstract supplied by the second provider.',
      _followedEntityMatches: [{ type: 'institution' as const, canonicalId: 'I1', displayName: 'Analytical Engine Lab' }],
    },
  ] as import('../models/paper.ts').Paper[]));

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'openalex:W1');
  assert.equal(merged[0].citationCount, 12);
  assert.equal(merged[0].abstract, 'A longer abstract supplied by the second provider.');
  assert.deepEqual(merged[0]._followedEntityMatches!.map(match => (match as Exclude<typeof match, string>).type), ['author', 'institution']);
});

test('keeps identical titles from different first authors separate', () => {
  const merged = mergeFollowingUpdatePapers(([
    { id: 'one', title: 'Introduction', authors: [{ name: 'Ada Lovelace' }] },
    { id: 'two', title: 'Introduction', authors: [{ name: 'Grace Hopper' }] },
  ] as import('../models/paper.ts').Paper[]));

  assert.equal(merged.length, 2);
});

test('sorts updates by publication date and rejects stale papers', () => {
  const now = Date.parse('2026-07-23T00:00:00Z');
  assert.equal(isRecentFollowingUpdate({ published: '2026-07-01' }, now, 365), true);
  assert.equal(isRecentFollowingUpdate({ published: '2024-01-01' }, now, 365), false);

  const sorted = mergeFollowingUpdatePapers(([
    { id: 'old', title: 'Old', published: '2026-01-01' },
    { id: 'new', title: 'New', published: '2026-07-01' },
  ] as import('../models/paper.ts').Paper[]));
  assert.deepEqual(sorted.map(paper => paper.id), ['new', 'old']);
});

test('keeps the seen-id list bounded and unique', () => {
  const ids = Array.from({ length: 510 }, (_, index) => `paper-${index}`);
  const compact = compactSeenIds([...ids, 'paper-509']);
  assert.equal(compact.length, 500);
  assert.equal(compact.at(-1), 'paper-509');
});
