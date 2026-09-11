import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PULL_BLOCKING_SCROLLERS,
  PULL_REFRESH_THRESHOLD_PX,
  isPullRefresh,
  pullStartFrom,
} from './feedPullToRefresh.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * A touch target that reports which of the feed's scrollers it sits inside.
 * `closest` is the only thing `pullStartFrom` asks of it, which is the whole
 * point of it asking for the capability rather than for `instanceof Element`.
 */
const targetInside = (...ancestorSelectors) => ({
  closest: (selector) => (ancestorSelectors.includes(selector) ? { tag: selector } : null),
});

test('a drag from the top of the feed, on the card itself, starts a pull', () => {
  assert.equal(pullStartFrom({ target: targetInside(), scrollTop: 0, clientY: 140 }), 140);
});

test('a drag that begins mid-feed is not a pull', () => {
  assert.equal(pullStartFrom({ target: targetInside(), scrollTop: 812, clientY: 140 }), null);
});

/**
 * The reported bug, as a test. The expanded abstract is a real touch
 * scroller inside the card, and a DOM descendant of `.feed-container`: its
 * touchstart bubbles into the feed's handler with the feed itself still at
 * `scrollTop === 0`, because the feed never moved — the abstract did. A
 * reader on the FIRST card who read down and then dragged back up to the
 * first line lifted their finger past the threshold and had the paper they
 * were reading replaced by a randomised feed.
 */
test('a drag that begins inside the open abstract is refused, even with the feed at the top', () => {
  const insideAbstract = targetInside(PULL_BLOCKING_SCROLLERS);
  assert.equal(pullStartFrom({ target: insideAbstract, scrollTop: 0, clientY: 480 }), null);
  // And the refusal is what does it: the same gesture on anything else at the
  // same scroll position does start a pull.
  assert.equal(pullStartFrom({ target: targetInside('.pc-title'), scrollTop: 0, clientY: 480 }), 480);
});

test('a target with no closest() is still allowed to pull', () => {
  assert.equal(pullStartFrom({ target: null, scrollTop: 0, clientY: 12 }), 12);
  assert.equal(pullStartFrom({ target: {}, scrollTop: 0, clientY: 12 }), 12);
});

test('only a downward drag past the threshold asks for a refresh', () => {
  assert.equal(PULL_REFRESH_THRESHOLD_PX, 90);
  assert.equal(isPullRefresh({ startY: 100, endY: 191 }), true);
  assert.equal(isPullRefresh({ startY: 100, endY: 190 }), false, 'the threshold is exclusive');
  assert.equal(isPullRefresh({ startY: 300, endY: 100 }), false, 'an upward drag never refreshes');
  assert.equal(isPullRefresh({ startY: null, endY: 400 }), false, 'a touch that never started a pull cannot end one');
});

/**
 * Every block in the CSS file, selector and body, for blocks with no nested
 * rule inside them — enough to read `@media` contents as well as top-level
 * rules, and all this needs.
 */
function leafRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const open = /\{/g;
  let match;
  while ((match = open.exec(source)) !== null) {
    const close = source.indexOf('}', match.index);
    const nested = source.indexOf('{', match.index + 1);
    if (close === -1 || (nested !== -1 && nested < close)) continue;
    const before = source.lastIndexOf('}', match.index);
    const start = Math.max(before, source.lastIndexOf('{', match.index - 1)) + 1;
    rules.push({
      selector: source.slice(start, match.index).trim(),
      body: source.slice(match.index + 1, close),
    });
  }
  return rules;
}

/**
 * The refusal list is a fixed selector — one `closest()`, no layout and no
 * style reads — so it can only stay honest if something re-reads the
 * stylesheet. Every box inside a card that scrolls VERTICALLY has to be
 * accounted for here: either it is refused, or it is portaled out of
 * `.feed-container` and its touches never reach the feed's handlers at all.
 * A new one fails this test and forces the choice to be made.
 */
test('every vertical scroller inside the card is either refused or portaled out of the feed', async () => {
  const css = await read('../components/Feed/PaperCard.css');
  const classified = {
    '.pc-abstract--open': 'refused',
    // Base UI `Drawer`/`Dialog` render through a portal (components/ui), so
    // these are not descendants of `.feed-container`.
    '.related-list': 'portaled',
    '.pc-authors-modal-list': 'portaled',
  };
  const vertical = leafRules(css)
    .filter(rule => /(?:^|[;{\s])overflow(?:-y)?:\s*(?:auto|scroll)\s*;/.test(rule.body))
    .flatMap(rule => rule.selector.split(',').map(one => one.trim()));
  assert.deepEqual(
    [...new Set(vertical)].sort(),
    Object.keys(classified).sort(),
    'a new vertical scroller inside the card: refuse the pull on it, or prove it is portaled, then list it here',
  );
  for (const [selector, verdict] of Object.entries(classified)) {
    if (verdict !== 'refused') continue;
    assert.ok(
      PULL_BLOCKING_SCROLLERS.split(',').map(one => one.trim()).includes(selector),
      `${selector} must be in PULL_BLOCKING_SCROLLERS`,
    );
  }

  // The two horizontal-only scrollers are deliberately absent from the list:
  // a downward drag is never theirs to answer.
  const horizontal = leafRules(css)
    .filter(rule => /overflow-x:\s*(?:auto|scroll)\s*;/.test(rule.body))
    .flatMap(rule => rule.selector.split(',').map(one => one.trim()));
  assert.deepEqual([...new Set(horizontal)].sort(), ['.pc-linked-resources-list', '.pc-topics']);
  for (const selector of horizontal) {
    assert.ok(!PULL_BLOCKING_SCROLLERS.includes(selector), `${selector} scrolls sideways; a pull must still work on it`);
  }
});

/**
 * The container is where the refusal is actually reached: reverting
 * `handleTouchStart` to its own `scrollTop === 0 ? clientY : null` would
 * leave every test above passing while the hole reopened.
 */
test('SOURCE: the feed asks feedPullToRefresh where a pull starts, and hands it the touch target', async () => {
  const code = stripComments(await read('../components/Feed/FeedContainer.jsx'));
  assert.match(code, /import \{ isPullRefresh, pullStartFrom \} from '\.\.\/\.\.\/utils\/feedPullToRefresh\.js';/);
  assert.match(
    code,
    /const handleTouchStart = useCallback\(\(e\) => \{\s*pullStartY\.current = pullStartFrom\(\{\s*target: e\.target,\s*scrollTop: e\.currentTarget\.scrollTop,\s*clientY: e\.touches\[0\]\.clientY,\s*\}\);\s*\}, \[\]\);/,
    'the target is what carries the refusal; a start read from scrollTop alone is the bug',
  );
  assert.match(
    code,
    /if \(isPullRefresh\(\{ startY, endY: e\.changedTouches\[0\]\.clientY \}\) && !loading\) handleRefresh\(\);/,
  );
  assert.doesNotMatch(code, /dy > 90/, 'the threshold lives in the module, not inline in the handler');
});
