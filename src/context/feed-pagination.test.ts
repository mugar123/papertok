import type { Paper } from '../models/paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canFetchNextPage, hasSeenRanking, isEmptyFirstPage, pageAfterLoad, planUnshowablePage, showsNoPaper } from './feed-pagination.ts';
import { joinFeedPage } from './feed-notable-cards.ts';
import { feedSeenIds } from '../utils/seen-paper-filter.ts';

const page = (index: number, count = 15) => Array.from({ length: count }, (_, n) => ({ id: `page-${index}-${n}` }) as Paper);

test('a reset whose exclusions leave no client-usable fallback restarts once without exclusions', () => {
  for (const candidateCount of [0, 1]) {
    assert.deepEqual(planUnshowablePage({ candidateCount, currentPage: 0, reset: true, excludedCount: 200, seenFallback: undefined, shownBeforeHere: [] }), { kind: 'relax-exclusions', page: 0 });
  }
  const seen = page(0, 1);
  const carried = planUnshowablePage({ candidateCount: 2, currentPage: 0, reset: true, excludedCount: 0, seenFallback: undefined, shownBeforeHere: seen });
  assert.deepEqual(carried, { kind: 'next-page', page: 1, seenFallback: { page: 0, papers: seen } });
  if (carried.kind !== 'next-page') assert.fail('the relaxed page must carry its viewed-only paper');
  assert.deepEqual(planUnshowablePage({ candidateCount: 0, currentPage: 1, reset: true, excludedCount: 0, seenFallback: carried.seenFallback, shownBeforeHere: [] }), { kind: 'show-seen', papers: seen });
  assert.deepEqual(planUnshowablePage({ candidateCount: 0, currentPage: 0, reset: true, excludedCount: 0, seenFallback: undefined, shownBeforeHere: [] }), { kind: 'show-none' });
});

test('a page the reader has entirely liked, saved or dismissed goes one page on, carrying nothing to show again', () => {
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 15, currentPage: 0, seenFallback: undefined, shownBeforeHere: [] }),
    { kind: 'next-page', page: 1, seenFallback: undefined },
  );
});

test('a page entirely shown before goes one page on and carries itself in case no later page has unseen papers', () => {
  const seen = page(0);
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 15, currentPage: 0, seenFallback: undefined, shownBeforeHere: seen }),
    { kind: 'next-page', page: 1, seenFallback: { page: 0, papers: seen } },
  );
  // Page 1 was seen too: the first seen page stays the one carried.
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 15, currentPage: 1, seenFallback: { page: 0, papers: seen }, shownBeforeHere: page(1) }),
    { kind: 'next-page', page: 2, seenFallback: { page: 0, papers: seen } },
  );
});

test('at the pagination ceiling the carried seen page is shown again, and the reader can scroll on', () => {
  const seen = page(0);
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 15, currentPage: 10, seenFallback: { page: 0, papers: seen }, shownBeforeHere: page(10) }),
    { kind: 'show-seen', papers: seen },
  );
  assert.deepEqual(pageAfterLoad(15, 10, { page: 0, papers: seen }), { nextPage: 11, hasMore: true });
});

test('when the next page is empty the carried seen page is shown, and scrolling asks for that empty page again', () => {
  const seen = page(0);
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 0, currentPage: 1, seenFallback: { page: 0, papers: seen }, shownBeforeHere: [] }),
    { kind: 'show-seen', papers: seen },
  );
  assert.deepEqual(pageAfterLoad(0, 1, { page: 0, papers: seen }), { nextPage: 1, hasMore: true });
});

test('an empty later page with nothing carried ends the feed', () => {
  assert.deepEqual(planUnshowablePage({ candidateCount: 0, currentPage: 3, seenFallback: undefined, shownBeforeHere: [] }), { kind: 'show-none' });
  assert.deepEqual(pageAfterLoad(0, 3, undefined), { nextPage: 4, hasMore: false });
  assert.equal(isEmptyFirstPage(false, 0, undefined), false);
});

test('an empty first page is a load failure, not an empty end', () => {
  assert.equal(isEmptyFirstPage(true, 0, undefined), true);
  assert.equal(isEmptyFirstPage(true, 15, undefined), false);
  // A reset that skipped past seen pages has those to show.
  assert.equal(isEmptyFirstPage(true, 0, { page: 0, papers: page(0) }), false);
});

test('a page with papers goes on to the next one', () => {
  assert.deepEqual(pageAfterLoad(15, 0, undefined), { nextPage: 1, hasMore: true });
});

test('the automatic fetch stops at the pagination ceiling and on an empty page', () => {
  assert.equal(canFetchNextPage(2, 9), true);
  assert.equal(canFetchNextPage(2, 10), false);
  assert.equal(canFetchNextPage(0, 0), false);
});

// The corpus adds the reader's unseen notable papers after a page's own, on
// every page it is asked for, even one whose other papers the reader all saw.
const notableOn = (index: number) => [0, 1].map(n => ({ id: `notable-${index}-${n}`, _notable: true }) as Paper);
const notableAt = (papers: Paper[]) => papers.flatMap((paper, index) => (paper._notable ? [[index, paper.id]] : []));
const firstScreen = { reset: true, keepThroughVisible: false, visiblePaperId: null };
const shownWith = (papers: Paper[]) => joinFeedPage([], papers.filter(paper => !paper._notable), papers.filter(paper => paper._notable), firstScreen);

test('a page whose other papers were all seen goes one page on though it holds unseen notable cards, and a seen notable card is not carried', () => {
  // Pages 0 and 1: the feed can show only their notable cards.
  assert.equal(showsNoPaper(notableOn(0)), true);
  assert.equal(showsNoPaper([]), true);
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 17, currentPage: 0, seenFallback: undefined, shownBeforeHere: [...page(0), ...notableOn(0)], notableHere: notableOn(0) }),
    { kind: 'next-page', page: 1, seenFallback: { page: 0, papers: page(0) } },
  );
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 17, currentPage: 1, seenFallback: { page: 0, papers: page(0) }, shownBeforeHere: [...page(1), ...notableOn(1)], notableHere: notableOn(1) }),
    { kind: 'next-page', page: 2, seenFallback: { page: 0, papers: page(0) } },
  );
  // Page 2 has unseen papers: fourteen cards and its first notable one, then the fifteenth card.
  const unseen = [...page(2), ...notableOn(2)];
  assert.equal(showsNoPaper(unseen), false);
  assert.deepEqual(notableAt(shownWith(unseen)), [[14, 'notable-2-0']]);
});

test('at the pagination ceiling the carried seen page is shown again with the last page\'s unseen notable card fifteenth', () => {
  const plan = planUnshowablePage({ candidateCount: 17, currentPage: 10, seenFallback: { page: 0, papers: page(0) }, shownBeforeHere: [...page(10), ...notableOn(10)], notableHere: notableOn(10) });
  assert.equal(plan.kind, 'show-seen');
  const shown = shownWith(plan.kind === 'show-seen' ? plan.papers : []);
  assert.deepEqual(shown.filter(paper => !paper._notable), page(0), 'the feed is not empty: the first page is shown again');
  assert.deepEqual(notableAt(shown), [[14, 'notable-10-0']]);
});

// A notable card is never shown twice, so it is no seen paper to fall back on:
// a fresh load whose exclusions left only unseen notable cards asks again
// without them, and the notable cards come with that page.
test('a reset whose exclusions leave only unseen notable cards restarts once without exclusions', () => {
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 2, currentPage: 0, reset: true, excludedCount: 200, seenFallback: undefined, shownBeforeHere: notableOn(0), notableHere: notableOn(0) }),
    { kind: 'relax-exclusions', page: 0 },
  );
});

test('when the next page is empty the carried seen page is shown without a notable card: an empty page has none', () => {
  const plan = planUnshowablePage({ candidateCount: 0, currentPage: 1, seenFallback: { page: 0, papers: page(0) }, shownBeforeHere: [], notableHere: [] });
  assert.deepEqual(plan, { kind: 'show-seen', papers: page(0) });
  assert.deepEqual(notableAt(shownWith(plan.kind === 'show-seen' ? plan.papers : [])), []);
});

// A Worker that skips seen papers (PAP-103) answers each page with the next
// papers of the reader's ranking the request's filter does not hold, so a
// reload is one request however many pages the reader saw, and sends seen
// papers only when the ranking has no other.
const ids = (papers: Paper[]) => papers.map(paper => paper.id);

test('a reload whose whole ranking the reader has seen shows its first page again from one request, and the reader can scroll on', () => {
  const seen = new Set(ids(page(0)));
  assert.equal(hasSeenRanking({ papers: page(0), skipsSeen: true }, seen), true);
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 15, currentPage: 0, seenFallback: undefined, shownBeforeHere: page(0), rankingSeen: true }),
    { kind: 'show-seen', papers: page(0) },
    'no later page would have an unseen paper',
  );
  assert.deepEqual(pageAfterLoad(15, 0, undefined), { nextPage: 1, hasMore: true });
  // Its unseen notable cards still take their places among the papers shown again.
  const plan = planUnshowablePage({ candidateCount: 17, currentPage: 0, seenFallback: undefined, shownBeforeHere: [...page(0), ...notableOn(0)], notableHere: notableOn(0), rankingSeen: true });
  assert.deepEqual(notableAt(shownWith(plan.kind === 'show-seen' ? plan.papers : [])), [[14, 'notable-0-0']]);
});

test('a page whose unseen papers the reader all knows goes one page on, and the Worker passes over them next', () => {
  // Liked on another device: the filter does not hold them, and the feed leaves them out.
  const seen = new Set(['seen-before']);
  assert.equal(hasSeenRanking({ papers: page(0), skipsSeen: true }, seen), false);
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 15, currentPage: 0, seenFallback: undefined, shownBeforeHere: [], rankingSeen: false }),
    { kind: 'next-page', page: 1, seenFallback: undefined },
  );
});

test('a page of papers the reader saw before the 2,000 most recent is not their whole ranking: the Worker was not told of them', () => {
  const later = Array.from({ length: 2_000 }, (_, n) => ({ id: `later-${n}` }) as Paper);
  // Oldest first, the way the session lists the papers it has seen.
  const held = new Set(feedSeenIds([...ids(page(0)), ...ids(later)], true));
  assert.equal(hasSeenRanking({ papers: page(0), skipsSeen: true }, held), false, 'the request left them out, so the Worker sent them as unseen');
  assert.equal(hasSeenRanking({ papers: later.slice(-15), skipsSeen: true }, held), true, 'the request held these');
});

test('a seen notable card, or a Worker that pages by number, does not say the reader saw their ranking', () => {
  const seen = new Set([...ids(page(0)), 'notable-0-0']);
  assert.equal(hasSeenRanking({ papers: [...page(1), ...notableOn(0)], skipsSeen: true }, seen), false, 'the ranking has unseen papers');
  assert.equal(hasSeenRanking({ papers: page(0), skipsSeen: false }, seen), false, 'the app walks the pages itself, as before');
  assert.deepEqual(
    planUnshowablePage({ candidateCount: 15, currentPage: 0, seenFallback: undefined, shownBeforeHere: page(0), rankingSeen: false }),
    { kind: 'next-page', page: 1, seenFallback: { page: 0, papers: page(0) } },
  );
});
