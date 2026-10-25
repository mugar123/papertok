import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFollowingFeedRelevanceScore,
  orderFollowingFeedPapers,
} from './following-feed.ts';

const NOW = Date.parse('2026-07-28T12:00:00Z');

function followedPaper(id: string, followId: string, overrides = {}) {
  return {
    id,
    title: `Paper ${id}`,
    published: '2026-07-20',
    citationCount: 2,
    _followedEntityMatches: [{
      type: 'institution' as const,
      canonicalId: followId,
      displayName: followId,
    }],
    ...overrides,
  };
}

test('uses seen state as a novelty signal without hiding a much stronger paper', () => {
  const items = [
    followedPaper('seen-relevant', 'MIT', { doi: '10.1/a', published: '2026-07-27', citationCount: 20 }),
    followedPaper('unseen-stale', 'MIT', { doi: '10.1/b', published: '2026-02-01', citationCount: 0 }),
  ];
  const seen = new Set(['doi:10.1/a']);

  const ordered = orderFollowingFeedPapers(items, seen, { now: NOW }).map(paper => paper.id);
  assert.deepEqual(ordered, ['seen-relevant', 'unseen-stale']);
});

test('rewards papers that match several followed entities', () => {
  const singleMatch = followedPaper('single', 'MIT');
  const multipleMatches = {
    ...followedPaper('multiple', 'MIT'),
    _followedEntityMatches: [
      ...singleMatch._followedEntityMatches,
      { type: 'topic' as const, canonicalId: 'T1', displayName: 'Quantum Physics' },
    ],
  };

  assert.ok(
    getFollowingFeedRelevanceScore(multipleMatches, new Set(), NOW)
      > getFollowingFeedRelevanceScore(singleMatch, new Set(), NOW),
  );
});

test('mixes similarly relevant follows instead of preserving five-paper source blocks', () => {
  const items = [
    ...Array.from({ length: 5 }, (_, index) => followedPaper(`mit-${index}`, 'MIT')),
    ...Array.from({ length: 5 }, (_, index) => followedPaper(`leiden-${index}`, 'Leiden')),
  ];
  const ordered = orderFollowingFeedPapers(items, new Set(), { now: NOW });
  const followIds = ordered.map(paper => paper._followedEntityMatches[0].canonicalId);
  let longestRun = 1;
  let currentRun = 1;
  for (let index = 1; index < followIds.length; index += 1) {
    currentRun = followIds[index] === followIds[index - 1] ? currentRun + 1 : 1;
    longestRun = Math.max(longestRun, currentRun);
  }

  assert.ok(followIds.slice(0, 4).includes('MIT'));
  assert.ok(followIds.slice(0, 4).includes('Leiden'));
  assert.ok(longestRun <= 2);
});

test('breaks otherwise equal relevance with citations and tolerates empty input', () => {
  const items = [
    followedPaper('low', 'MIT', { doi: '10.2/a', citationCount: 1 }),
    followedPaper('high', 'Leiden', { doi: '10.2/b', citationCount: 40 }),
  ];
  const ordered = orderFollowingFeedPapers(items, new Set(), { now: NOW }).map(paper => paper.id);
  assert.deepEqual(ordered, ['high', 'low']);
  assert.deepEqual(orderFollowingFeedPapers(undefined, undefined), []);
});

import { followingFirstLoadPending, mergeOrderedPapers } from './following-feed.ts';

/**
 * A silent refresh landing while the Following feed is on screen used to
 * re-rank the whole list under the reader. The cards already showing keep
 * their places, under their fresh copies; what the refresh dropped goes,
 * what it brought is appended in its own order.
 */
test('a refresh keeps the cards on screen where they are and appends what is new', () => {
  const previous = [
    { id: 'a', title: 'A', citationCount: 1 },
    { id: 'b', title: 'B', citationCount: 1 },
    { id: 'c', title: 'C', citationCount: 1 },
  ];
  const fresh = [
    { id: 'd', title: 'D', citationCount: 9 },
    { id: 'c', title: 'C', citationCount: 5 },
    { id: 'a', title: 'A', citationCount: 4 },
    { id: 'e', title: 'E', citationCount: 2 },
  ];
  const merged = mergeOrderedPapers(previous, fresh);
  assert.deepEqual(merged.map(paper => paper.id), ['a', 'c', 'd', 'e'], 'a and c stay in order, b is gone, d and e follow');
  assert.equal(merged[0].citationCount, 4, 'the copy on screen is the fresh one');
  assert.equal(mergeOrderedPapers([], fresh), fresh, 'nothing on screen: the fresh ranking as is');
  assert.deepEqual(mergeOrderedPapers(previous, []), [], 'the refresh emptied the feed');
});

/**
 * Following showed a skeleton card while it waited for its first papers; For
 * You shows its discovery screen. Same screen for both: the page tells the
 * container it is on its first load until something has answered.
 */
test('the first wait of the Following feed is a first load until something has answered', () => {
  assert.equal(followingFirstLoadPending({ items: [], loading: false, lastUpdatedAt: null }), true, 'the tick before the refresh starts');
  assert.equal(followingFirstLoadPending({ items: [], loading: true, lastUpdatedAt: null }), true, 'the refresh in flight');
  assert.equal(followingFirstLoadPending({ items: [], loading: false, lastUpdatedAt: '2026-09-03T00:00:00Z' }), false, 'answered with nothing: the empty state');
  assert.equal(followingFirstLoadPending({ items: [{ id: 'a' }], loading: true, lastUpdatedAt: null }), false, 'cards on screen: the feed');
  assert.equal(followingFirstLoadPending({ items: [], loading: true, lastUpdatedAt: null, error: new Error('x') }), false, 'an error is the error screen\'s');
});

/**
 * Coming back to Following found the cards shuffled: every mount ranked from
 * scratch with a seen-set that had just grown by the cards scrolled past.
 * The feed the reader left is the feed they come back to.
 */
test('the Following feed resumes the order it left with, and merges a refresh into it', async () => {
  const { resumeOrderedPapers } = await import('./following-feed.ts');
  const items = [{ id: 'a', title: 'A', citationCount: 1 }, { id: 'b', title: 'B', citationCount: 9 }];
  const first = resumeOrderedPapers({ items: null, ordered: [] }, items, new Set());
  assert.deepEqual(first.map(paper => paper.id), ['b', 'a'], 'the first visit ranks');
  const resumed = resumeOrderedPapers({ items, ordered: first }, items, new Set(['doi:x', 'id:b']));
  assert.equal(resumed, first, 'the same items resume in the same order, whatever was marked seen meanwhile');
  const fresh = [{ id: 'c', title: 'C', citationCount: 99 }, { id: 'a', title: 'A', citationCount: 1 }];
  const merged = resumeOrderedPapers({ items, ordered: first }, fresh, new Set());
  assert.deepEqual(merged.map(paper => paper.id), ['a', 'c'], 'a refresh keeps the places it can and appends the rest');
});

import { orderFromKeys, orderKeysOf, resumeOrderedPapers as resumeFromKeys } from './following-feed.ts';
import { getFollowingUpdatePaperKey } from './following-updates.ts';

test('after a reload the order the reader left is rebuilt from its keys over the items that came back', () => {
  const a = followedPaper('a', 'x', { published: '2026-07-01' });
  const b = followedPaper('b', 'y', { published: '2026-07-27' });
  const c = followedPaper('c', 'z', { published: '2026-07-10' });
  const d = followedPaper('d', 'w', { published: '2026-07-26' });
  const items = [a, b, c, d];
  const keys = [getFollowingUpdatePaperKey(c), getFollowingUpdatePaperKey(a), 'id:gone'];

  assert.deepEqual(orderFromKeys(items, keys).map(paper => paper.id), ['c', 'a'], 'the stored keys pick the items, in the stored order, and skip what is gone');
  assert.deepEqual(orderFromKeys(items, []), []);
  assert.deepEqual(orderFromKeys(items, null!), []);

  const resumed = resumeFromKeys({ items: null, ordered: [], orderKeys: keys }, items, new Set());
  assert.deepEqual(resumed.slice(0, 2).map(paper => paper.id), ['c', 'a'], 'the feed resumes in the order it left');
  assert.deepEqual([...resumed.map(paper => paper.id)].sort(), ['a', 'b', 'c', 'd'], 'and the rest is appended');
  assert.deepEqual(orderKeysOf(resumed).slice(0, 2), keys.slice(0, 2));

  const inMemory = resumeFromKeys({ items: null, ordered: [b, a], orderKeys: keys }, items, new Set());
  assert.deepEqual(inMemory.slice(0, 2).map(paper => paper.id), ['b', 'a'], 'the order still in memory wins over the stored keys');
});

/**
 * Skip, in the Following feed. The card used to stay exactly where it was:
 * `markNotInterested` drops the paper from For You's list (FeedContext), and
 * this page renders a `source` list of its own, so nothing on screen changed.
 * The set the skip writes is the one thing both feeds share, so this page
 * applies it to its own list — and, being the persisted set, it also keeps
 * the paper from coming back on the next refresh or the next visit.
 */
test('the Following feed drops what the reader skipped, and keeps the array when it drops nothing', async () => {
  const { withoutNotInterested } = await import('./following-feed.ts');
  const papers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  assert.deepEqual(
    withoutNotInterested(papers, new Set(['b'])).map(paper => paper.id),
    ['a', 'c'],
  );
  assert.equal(withoutNotInterested(papers, new Set(['zzz'])), papers,
    'same reference for a set that touches nothing: no re-render, no reshuffle');
  assert.equal(withoutNotInterested(papers, new Set()), papers);
  assert.equal(withoutNotInterested(papers, null), papers,
    'a profile that has not loaded yet hides nothing');
  assert.deepEqual(withoutNotInterested(null!, new Set(['a'])), []);
  assert.deepEqual(
    withoutNotInterested([null!, { id: 'a' }], new Set(['a'])).map(Boolean),
    [false],
    'a hole in the list is not an id, and is not what the skip removed',
  );
});
