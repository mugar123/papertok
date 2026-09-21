import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function block(code, from, to, label) {
  const start = code.indexOf(from);
  assert.ok(start >= 0, `expected to have found ${label}`);
  const end = code.indexOf(to, start + from.length);
  assert.ok(end > start, `expected to have found the end of ${label}`);
  return code.slice(start, end);
}

/**
 * Crossing a card boundary re-renders exactly two `PaperCard`s — the one that
 * stops being active and the one that starts. Measured: 2 of 15 mounted, with
 * the memo skipping the rest and no new paper objects, so the fan-out this
 * file's sibling fixed in September has stayed fixed.
 *
 * But `PaperCard` is a big component, and those two renders landed INSIDE the
 * frame the card settles on: seven long animation frames over six passes, all
 * attributed to `performWorkUntilDeadline`, the worst 94ms with 44ms of it
 * unyielded, against a 16.7ms median. Smooth, and then a three-to-five frame
 * stumble exactly where the reader is looking.
 *
 * In a transition React slices that work and yields to the scroll. Measured
 * against a control on the same tree: frames that block for more than 10ms
 * went 3 and 5 -> 2 and 2, and total blocking 81ms and 148ms -> 51ms and
 * 117ms.
 */
test('SOURCE: the scroll hands the active-card render to a transition', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const handler = block(code, 'const handleScroll = useCallback((event) => {', '}, [reportVisiblePaper', 'handleScroll');

  assert.match(handler, /startTransition\(\(\) => setActiveIndex\(index\)\)/,
    'the only state update a scroll event makes goes in at transition priority');
  assert.doesNotMatch(handler, /(?<!\(\) => )\bsetActiveIndex\(index\);/,
    'no synchronous copy left beside it');
  assert.match(code, /import \{[^}]*startTransition[^}]*\} from 'react';/, 'imported from react');
});

/**
 * And the resume path must NOT follow it. There the value has to be in place
 * before the mount window decides, or the card being restored to mounts alone
 * carrying the wrong active flag and refades its whole body the moment the
 * scroll event lands. That trap is described at the top of FeedContainer.
 */
test('SOURCE: the resume still sets the active card synchronously', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const calls = [...code.matchAll(/(startTransition\(\(\) => )?setActiveIndex\(/g)];

  assert.equal(calls.length, 2, 'exactly two places set the active card');
  const wrapped = calls.filter((m) => m[1]).length;
  assert.equal(wrapped, 1, 'one of them is in a transition (the scroll) and one is not (the resume)');
});

/**
 * The thing that makes the transition safe. If `isActive` ever grows a second
 * job inside the card — anything visual, anything animated — a value that
 * lands a frame or two late stops being invisible and this decision needs
 * revisiting rather than silently shipping a flicker.
 */
test('SOURCE: isActive still only gates the comment count inside the card', async () => {
  const code = stripComments(await read('./PaperCard.jsx'));
  const uses = [...code.matchAll(/\bisActive\b/g)];

  assert.equal(uses.length, 2, `isActive is read in ${uses.length} places, not 2 — see the test's reasoning`);
  assert.match(code, /isActive = false,/, 'one is the prop default');
  assert.match(code, /useCommentCount\(paper, Boolean\(isActive &&/, 'the other is the comment count');
});
