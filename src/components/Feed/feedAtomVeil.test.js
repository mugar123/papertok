import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for the handover from the atom to the papers. The atom screen
 * and the feed used to be two return branches of FeedContainer, so React
 * replaced one with the other in a single frame: the atom, then a paper
 * composing in, with nothing between the two.
 */
test('the atom screen is a veil over the feed, inside the same landmark as the cards', async () => {
  const jsx = await read('./FeedContainer.jsx');
  assert.match(jsx, /import \{ AnimatePresence, motion, useReducedMotion \} from 'framer-motion';/);
  assert.match(jsx, /const atomVeil = feedAtomVeilCopy\(\{ displayState, loading, isRefreshing \}\);/);
  // One tree for the wait and for the cards, so the veil can leave over them.
  const shared = jsx.match(/if \(displayState === FEED_DISPLAY_STATES\.FEED \|\| atomVeil\) \{[\s\S]*?<FeedLandmark landmark=\{landmark\}>[\s\S]*?<div className="feed-container" ref=\{feedRef\} onScroll=\{handleScroll\}>[\s\S]*?<AnimatePresence>\s*\{atomVeil && \(\s*<motion\.div\s+key="atom-veil"\s+className="feed-empty feed-empty--veil"/);
  assert.ok(shared, 'the FEED branch and the veil share the landmark and the container');
  // The old standalone returns are gone.
  assert.doesNotMatch(jsx, /className="feed-empty feed-empty--initial-loading"/);
});

test('the veil recedes: the ground fades, the atom shrinks and rises, the copy settles', async () => {
  const jsx = await read('./FeedContainer.jsx');
  assert.match(jsx, /const ATOM_VEIL_VARIANTS = \{[\s\S]*?gone: \{ opacity: 0, transition: \{ duration: 0\.42, ease: \[0\.16, 1, 0\.3, 1\] \} \}/);
  assert.match(jsx, /const ATOM_VARIANTS = \{[\s\S]*?gone: \{ opacity: 0, scale: 0\.62, y: -16, transition: \{ duration: 0\.36, ease: \[0\.16, 1, 0\.3, 1\] \} \}/);
  assert.match(jsx, /const ATOM_COPY_VARIANTS = \{[\s\S]*?gone: \{ opacity: 0, y: 6, transition: \{ duration: 0\.24, ease: \[0\.4, 0, 1, 1\] \} \}/);
  assert.match(jsx, /const ATOM_VEIL_REDUCED_VARIANTS = \{[\s\S]*?gone: \{ opacity: 0, transition: \{ duration: 0\.12 \} \}/);
  // Labels, not objects: the atom and the copy are children of the veil's
  // variant tree, and their `gone` plays when the veil's does.
  assert.match(jsx, /initial=\{false\}\s+animate="shown"\s+exit="gone"/);
  assert.match(jsx, /<motion\.div className="atom-loader" aria-hidden="true" variants=\{prefersReducedMotion \? undefined : ATOM_VARIANTS\}>/);
  assert.match(jsx, /<motion\.div className="feed-empty-copy" variants=\{prefersReducedMotion \? undefined : ATOM_COPY_VARIANTS\}>/);
});

test('the veil sits over the container and lets framer own its opacity', async () => {
  const css = await read('./FeedContainer.css');
  const rule = css.match(/\.feed-empty--veil \{[^}]*\}/)?.[0] || '';
  assert.match(rule, /position: absolute;/);
  assert.match(rule, /inset: 0;/);
  assert.match(rule, /margin-top: 0;/);
  assert.match(rule, /min-height: 0;/);
  assert.match(rule, /z-index: 2;/);
  assert.match(rule, /animation: none;/);
});

test('on the first entry the card composes under the veil instead of sitting at rest', async () => {
  const transition = await read('../Layout/PageTransition.jsx');
  assert.match(transition, /directionForNavigationType\(useNavigationType\(\), \{\s*historyIndex: typeof window !== 'undefined' \? window\.history\.state\?\.idx : null,\s*\}\)/);
});
