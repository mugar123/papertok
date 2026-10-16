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
 * Crossing a card boundary used to re-render exactly two `PaperCard`s — the one
 * that stopped being active and the one that started (measured: 2 of 15
 * mounted). Since the comment count went, the card takes no active flag at all,
 * and the active card only steers the mount window.
 *
 * WHAT THE TRANSITION IS WORTH, honestly: on a desktop production build,
 * nothing measurable. Measured against a control on the same tree, with and
 * without it, the scroll is identical — 16.7ms median, 16.8ms p95, zero long
 * animation frames and ZERO blocking either way.
 *
 * The measurement that motivated it was taken against the DEV server, where
 * every card change produced a 50-94ms long animation frame attributed to
 * `performWorkUntilDeadline`. That was React's dev-mode render overhead, which
 * does not exist in the shipped bundle. Do not measure feed fluidity in dev.
 *
 * It stays as insurance, not as a fix: `PaperCard`'s render cost is real, and a
 * mid-range phone's main thread is closer to the dev profile than to a Mac's.
 * A transition can only help there and cannot hurt here.
 *
 * So this file does NOT pin a performance number. It pins the two conditions
 * that make the transition safe to keep, which are the part that can silently
 * stop being true.
 */
test('SOURCE: the scroll hands the active-card render to a transition', async () => {
  const code = stripComments(await read('./FeedContainer.tsx'));
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
  const code = stripComments(await read('./FeedContainer.tsx'));
  const calls = [...code.matchAll(/(startTransition\(\(\) => )?setActiveIndex\(/g)];

  assert.equal(calls.length, 2, 'exactly two places set the active card');
  const wrapped = calls.filter((m) => m[1]).length;
  assert.equal(wrapped, 1, 'one of them is in a transition (the scroll) and one is not (the resume)');
});

/**
 * The thing that makes the transition safe. If the card ever takes the active
 * flag again for anything visual or animated, a value that lands a frame or
 * two late stops being invisible and this decision needs revisiting rather
 * than silently shipping a flicker.
 */
test('SOURCE: the card takes no active flag from the feed', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  const feed = stripComments(await read('./FeedContainer.tsx'));

  assert.doesNotMatch(card, /\bisActive\b/, "PaperCard reads an active flag again — see the test's reasoning");
  assert.doesNotMatch(feed, /isActive=/, 'FeedContainer hands the card an active flag again');
});
