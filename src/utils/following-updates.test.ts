import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactSeenIds,
  getFollowingUpdatePaperKey,
  getFollowingSignature,
  isCurrentFollowingRequest,
  isFollowingCacheFresh,
  isRecentFollowingUpdate,
  keepPapersOfFollows,
  mergeFollowingUpdatePapers,
} from './following-updates.ts';
import type { Paper, PaperFollowMatch } from '../models/paper.ts';

const authorA = { type: 'author', canonicalId: 'A1' } as PaperFollowMatch;
const topicT = { type: 'topic', canonicalId: 'T1' } as PaperFollowMatch;
const paperOf = (id: string, matches: PaperFollowMatch[]) => ({ id, title: id, _followedEntityMatches: matches }) as Paper;

test('an unfollow takes off at once the cards only that follow brought in (ENG-110)', () => {
  const papers = [paperOf('author-only', [authorA]), paperOf('both', [authorA, topicT]), paperOf('topic-only', [topicT])];
  assert.deepEqual(keepPapersOfFollows(papers, [authorA, topicT]).map(paper => paper.id), ['author-only', 'both', 'topic-only']);
  assert.deepEqual(keepPapersOfFollows(papers, [topicT]).map(paper => paper.id), ['both', 'topic-only']);
  assert.deepEqual(keepPapersOfFollows(papers, []), []);
});

test('a response for follows the reader has since changed is not delivered (ENG-110)', () => {
  const started = { userId: 'u1', signature: getFollowingSignature([authorA, topicT]) };
  assert.equal(isCurrentFollowingRequest(started, started), true);
  assert.equal(isCurrentFollowingRequest({ userId: 'u1', signature: getFollowingSignature([topicT]) }, started), false, 'unfollowed');
  assert.equal(isCurrentFollowingRequest({ ...started, userId: 'u2' }, started), false, 'other account');
  assert.equal(isCurrentFollowingRequest({ userId: null, signature: '' }, started), false, 'signed out');
});

test('a stored result in which some follows failed is not fresh, so the next load asks again (ENG-110)', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const savedAt = new Date(now - 60_000).toISOString();
  const ttl = 15 * 60 * 1000;
  const answered = { signature: 'author:A1|topic:T1', savedAt, meta: { failedEntities: 0 } };
  assert.equal(isFollowingCacheFresh(answered, 'author:A1|topic:T1', ttl, now), true);
  assert.equal(isFollowingCacheFresh({ ...answered, meta: { failedEntities: 1 } }, 'author:A1|topic:T1', ttl, now), false);
  assert.equal(isFollowingCacheFresh(answered, 'author:A1', ttl, now), false, 'other follows');
  assert.equal(isFollowingCacheFresh({ ...answered, savedAt: new Date(now - ttl).toISOString() }, 'author:A1|topic:T1', ttl, now), false, 'expired');
});

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

// ENG-109: the card credits the source of the abstract it shows.
test('the abstract a merged update keeps brings its credit, and no other', () => {
  const record = (id: string, abstract: string, abstractSource?: 'crossref' | 'semanticscholar') => ({
    id, doi: '10.1000/credited', title: 'A credited paper', published: '2026-07-01', abstract, ...(abstractSource && { abstractSource }),
  }) as import('../models/paper.ts').Paper;
  const recovered = record('openalex:W1', 'The longer abstract Semantic Scholar holds for this paper.', 'semanticscholar');
  const own = record('repository:1', 'A shorter own abstract.');
  for (const records of [[recovered, own], [own, recovered]]) {
    const [merged] = mergeFollowingUpdatePapers(records);
    assert.deepEqual([merged.abstract, merged.abstractSource], [recovered.abstract, 'semanticscholar'], records[0].id);
  }
  const longerOwn = record('repository:2', 'A longer abstract the repository lists for this paper, in full.');
  const shorter = record('openalex:W2', 'A recovered abstract.', 'crossref');
  for (const records of [[shorter, longerOwn], [longerOwn, shorter]]) {
    const [merged] = mergeFollowingUpdatePapers(records);
    assert.deepEqual([merged.abstract, merged.abstractSource], [longerOwn.abstract, undefined], records[0].id);
  }
});

test('keeps identical titles from different first authors separate', () => {
  const merged = mergeFollowingUpdatePapers(([
    { id: 'one', title: 'Introduction', authors: [{ name: 'Ada Lovelace' }] },
    { id: 'two', title: 'Introduction', authors: [{ name: 'Grace Hopper' }] },
  ] as import('../models/paper.ts').Paper[]));

  assert.equal(merged.length, 2);
});

// The name the OpenAlex mappers write for a missing one names nobody.
test('keeps identical titles apart when the first author is a placeholder for a missing name', () => {
  for (const name of ['Unknown', 'Unknown Author']) {
    const merged = mergeFollowingUpdatePapers(([
      { id: 'openalex:W1', doi: '10.1000/one', title: 'Introduction', authors: [{ name }], citationCount: 0 },
      { id: 'openalex:W2', doi: '10.1000/two', title: 'Introduction', authors: [{ name }], citationCount: 222 },
    ] as import('../models/paper.ts').Paper[]));
    assert.deepEqual(merged.map(paper => [paper.doi, paper.citationCount]).sort(), [['10.1000/one', 0], ['10.1000/two', 222]], name);
  }
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
