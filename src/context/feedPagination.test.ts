import type { Paper } from '../models/Paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canFetchNextPage, isEmptyFirstPage, pageAfterLoad, planUnshowablePage, showsNoPaper } from './feedPagination.ts';
import { joinFeedPage } from './feedNotableCards.ts';

const page = (index: number, count = 15) => Array.from({ length: count }, (_, n) => ({ id: `page-${index}-${n}` }) as Paper);

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

test('when the next page is empty the carried seen page is shown without a notable card: an empty page has none', () => {
  const plan = planUnshowablePage({ candidateCount: 0, currentPage: 1, seenFallback: { page: 0, papers: page(0) }, shownBeforeHere: [], notableHere: [] });
  assert.deepEqual(plan, { kind: 'show-seen', papers: page(0) });
  assert.deepEqual(notableAt(shownWith(plan.kind === 'show-seen' ? plan.papers : [])), []);
});
