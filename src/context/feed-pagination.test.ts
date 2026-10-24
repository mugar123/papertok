import type { Paper } from '../models/paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canFetchNextPage, isEmptyFirstPage, pageAfterLoad, planUnshowablePage } from './feed-pagination.ts';

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
