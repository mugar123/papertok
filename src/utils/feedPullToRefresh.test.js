import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PULL_REFRESH_THRESHOLD_PX,
  PULL_FLING_MIN_PX,
  PULL_BLOCKING_SCROLLERS,
  pullStartFrom,
  pullProgress,
  pullOutcome,
  isPullRefresh,
} from './feedPullToRefresh.js';

const noScroller = { closest: () => null };
const insideAbstract = { closest: (sel) => (sel === PULL_BLOCKING_SCROLLERS ? {} : null) };

test('a pull only begins at the top of the feed', () => {
  assert.equal(pullStartFrom({ target: noScroller, scrollTop: 0, clientY: 200 }), 200);
  assert.equal(pullStartFrom({ target: noScroller, scrollTop: 1, clientY: 200 }), null);
  assert.equal(pullStartFrom({ target: noScroller, scrollTop: 700, clientY: 200 }), null);
});

test('a drag that begins inside the open abstract is refused', () => {
  assert.equal(pullStartFrom({ target: insideAbstract, scrollTop: 0, clientY: 200 }), null);
});

test('progress grows with the distance and is clamped to 1', () => {
  assert.equal(pullProgress({ startY: 100, currentY: 100 }), 0);
  assert.equal(pullProgress({ startY: 100, currentY: 60 }), 0, 'upwards is not a pull');
  assert.equal(pullProgress({ startY: 100, currentY: 100 + PULL_REFRESH_THRESHOLD_PX / 2 }), 0.5);
  assert.equal(pullProgress({ startY: 100, currentY: 100 + PULL_REFRESH_THRESHOLD_PX * 3 }), 1);
  assert.equal(pullProgress({ startY: null, currentY: 400 }), 0);
});

test('a slow drag refreshes only past the threshold', () => {
  const slow = (dy) => pullOutcome({ startY: 100, endY: 100 + dy, elapsedMs: 2000 });
  assert.equal(slow(PULL_REFRESH_THRESHOLD_PX - 1), 'none');
  assert.equal(slow(PULL_REFRESH_THRESHOLD_PX + 1), 'refresh');
});

test('a fast fling refreshes before the threshold, but never a tremor', () => {
  const fast = (dy, ms) => pullOutcome({ startY: 100, endY: 100 + dy, elapsedMs: ms });
  assert.equal(fast(60, 30), 'refresh', '60px in 30ms is 2px/ms: a fling');
  assert.equal(fast(PULL_FLING_MIN_PX - 5, 10), 'none', 'too short to be a decision');
  assert.equal(fast(60, 200), 'none', '60px in 200ms is a slow drag short of the threshold');
});

test('isPullRefresh keeps the slow-drag answer', () => {
  assert.equal(isPullRefresh({ startY: 100, endY: 100 + PULL_REFRESH_THRESHOLD_PX + 1 }), true);
  assert.equal(isPullRefresh({ startY: 100, endY: 150 }), false);
  assert.equal(isPullRefresh({ startY: null, endY: 900 }), false);
});

/**
 * The blocking list must keep describing what really scrolls inside a card:
 * an `overflow-y: auto` added to PaperCard.css without an entry here would
 * silently reopen the abstract's bug for the new scroller.
 */
test('SOURCE: every in-card vertical scroller is on the blocking list', async () => {
  const css = (await readFile(new URL('../components/Feed/PaperCard.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/overflow(?:-y)?\s*:\s*(?:hidden\s+)?(?:auto|scroll)\b/.test(m[2])) selectors.push(m[1].trim());
  }
  const blocked = PULL_BLOCKING_SCROLLERS.split(',').map((s) => s.trim());
  const uncovered = selectors.filter((sel) => !blocked.some((b) => sel.includes(b.replace(/^\./, ''))));
  assert.deepEqual(uncovered.filter((s) => /^\.pc-abstract/.test(s)), [], 'an abstract scroller escaped the list');
});
