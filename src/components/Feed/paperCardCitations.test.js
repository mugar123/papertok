import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CITATION_GATE_MAX_WAIT_MS } from '../../utils/feedCitationGate.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  assert.ok(block.split('\n').length <= maxLines, `${label} capture spans past what it names`);
  return block;
}

/**
 * The whole point of the gate is that it happens BEFORE the paint. Held as an
 * ordering assertion rather than a text match: a gate that ran after
 * `setPapers` would still contain every keyword this test could look for.
 */
test('SOURCE: the citation gate is awaited before the feed paints', async () => {
  const code = stripComments(await read('../../context/FeedContext.jsx'));

  const gateAt = code.indexOf('awaitWithinGate(');
  assert.ok(gateAt > 0, 'FeedContext waits for the citation sources');

  const paintAt = code.indexOf('setPapers(nextPapers)');
  assert.ok(paintAt > 0, 'the first paint is still setPapers(nextPapers)');
  assert.ok(gateAt < paintAt, 'a gate after the paint is not a gate');

  assert.match(code, /await awaitWithinGate\(/,
    'the gate is awaited, not fired and forgotten');
});

/**
 * All three late sources carry `citationCount`, so gating on one of them
 * leaves the chip popping in from the other two.
 */
test('SOURCE: the gate waits for every source that carries a citation count', async () => {
  const code = stripComments(await read('../../context/FeedContext.jsx'));
  const gate = bounded(code, 'await awaitWithinGate([', ']);', 'the citation gate', 8);

  assert.match(gate, /enrichmentPromise/, 'OpenAlex');
  assert.match(gate, /iCitePromise/, 'iCite');
  assert.match(gate, /europePmcPromise/, 'Europe PMC');
});

/**
 * The gate is behind "nothing is on screen yet", which is exactly when there
 * is a veil to hold — NOT behind `reset`.
 *
 * The difference is not academic, it was measured. When the first page comes
 * back full of papers the reader has already seen, `loadPapers` RE-ENTERS
 * itself with `reset` false, and it is that call which paints. Behind `reset`,
 * that whole load slipped through the gate: feed painted at 2872ms with 1 chip
 * of 2, and the chips jumped 9 -> 14 at 3571ms with the reader already looking
 * (2026-09-20).
 *
 * What stays out stays out on purpose: `keepThroughVisible` is the
 * follow-change reset, where the reader keeps their place on a card, and
 * pagination and refresh both have papers on screen by definition.
 */
test('SOURCE: the gate is behind an empty screen, not behind `reset`', async () => {
  const code = stripComments(await read('../../context/FeedContext.jsx'));
  const gateAt = code.indexOf('awaitWithinGate(');
  const guard = code.slice(code.lastIndexOf('if (', gateAt), gateAt);

  assert.match(guard, /papers\.length === 0\s*&&\s*!keepThroughVisible/,
    'the gate asks whether anything is on screen');
  assert.doesNotMatch(guard, /\breset\b/,
    'gating on `reset` misses the re-entry that actually paints a slow first page');
});

/**
 * And the re-entry this guard exists for is still there. If it is ever removed
 * or given `reset: true`, the reasoning above stops applying and the guard
 * should be revisited rather than silently over-covering.
 */
test('SOURCE: the re-entry the guard was widened for still exists', async () => {
  const code = stripComments(await read('../../context/FeedContext.jsx'));
  assert.match(code, /loadPapersRef\.current\(false, activeMode, false, nextPageToFetch\)/,
    'the auto-fetch continuation paints with `reset` false');
});

/** A stale request that resolves its gate must not paint over a newer one. */
test('SOURCE: the request id is re-checked after the wait', async () => {
  const code = stripComments(await read('../../context/FeedContext.jsx'));
  const gateAt = code.indexOf('awaitWithinGate(');
  const after = code.slice(gateAt, code.indexOf('setPapers(nextPapers)', gateAt));

  assert.match(after, /requestId !== feedRequestId\.current\) return;/,
    'awaiting anything reopens the door a newer load may have come through');
});

test('the cap is short enough to be a loading screen and long enough to be worth it', () => {
  assert.ok(CITATION_GATE_MAX_WAIT_MS <= 1500, 'past this the veil is the feature the reader notices');
  assert.ok(CITATION_GATE_MAX_WAIT_MS >= 600, 'under this it would rarely catch a normal response');
});

/**
 * What the cap lets through: a chip landing in a row that is already on
 * screen. It cannot be given reserved space — the width depends on a number
 * nobody has yet — so the fade is the whole remedy, and it has to cover the
 * separator too or the flicker just moves into the dot.
 */
test('SOURCE: a late citation chip fades in, and so does its separator', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  const rule = bounded(css, '.pc-citations,\n.pc-meta-dot--citations {', '}', 'the citation fade', 5);

  assert.match(rule, /\.pc-meta-dot--citations/, 'the dot in front of the chip fades with it');
  assert.match(rule, /animation:\s*pcCitationsIn\s+220ms\s+linear/, 'a plain 220ms fade');
  // An expo over an opacity is not a fade, it is a flash with a tail. Measured
  // twice on this project; it must not come back through this rule.
  assert.doesNotMatch(rule, /cubic-bezier|--ease-out-expo|ease-in-out/,
    'the curve of a fade is linear');

  const frames = bounded(css, '@keyframes pcCitationsIn', '}', 'pcCitationsIn', 4);
  assert.match(frames, /from\s*\{\s*opacity:\s*0;/, 'it starts from invisible');
  assert.doesNotMatch(frames, /\bto\b|100%/,
    'one end only: the browser synthesises the other from the resting pose, so the chip cannot end up pinned at an opacity the stylesheet did not choose');

  const reduced = css.slice(css.indexOf('@keyframes pcCitationsIn'));
  assert.match(reduced, /@media \(prefers-reduced-motion: reduce\) \{\s*\.pc-citations,\s*\.pc-meta-dot--citations \{\s*animation: none;/,
    'reduced motion gives up the fade');
});

test('SOURCE: the dot before the chip is the one that carries the modifier', async () => {
  const code = stripComments(await read('./PaperCard.jsx'));
  const chip = bounded(code, '{(paper.citationCountKnown || paper.citationCount > 0) && (', 'pc-citations', 'the citation chip', 8);

  assert.match(chip, /className="pc-meta-dot pc-meta-dot--citations"/,
    'the separator inside this fragment, and no other, gets the fade');
  // Every other dot on the row belongs to metadata that was there from the
  // first paint and must not fade on its own.
  const dots = [...code.matchAll(/className="pc-meta-dot pc-meta-dot--citations"/g)];
  assert.equal(dots.length, 1, 'exactly one dot fades');
});
