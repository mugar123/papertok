import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for the handover from the thread's skeleton to "Nobody has
 * commented yet". React swapped the two in one frame: three grey lines, then a
 * centred message, with nothing between.
 */
test('the skeleton and the empty state cross-fade in place', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const presence = jsx.match(/<AnimatePresence mode="popLayout" initial=\{false\}>[\s\S]*?<\/AnimatePresence>/);
  assert.ok(presence, 'one presence holds the skeleton and the empty state');
  assert.match(presence[0], /status === 'loading' && \(\s*<motion\.div\s+key="loading"\s+className="comments-sheet-loading"/);
  assert.match(presence[0], /status === 'ready' && thread\.length === 0 && \(\s*<motion\.div\s+key="empty"\s+className="comments-sheet-state"/);
  // The skeleton leaves as the message arrives — the leaving one is popped out
  // of flow, so the message takes the space in the same frame.
  assert.match(presence[0], /exit=\{prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, y: 6 \}\}/);
  assert.match(presence[0], /initial=\{prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, y: 10 \}\}/);
  assert.match(presence[0], /animate=\{\{ opacity: 1, y: 0 \}\}/);
});

test('the delayed reveal sits on the rows, so framer owns the skeleton\'s own opacity', async () => {
  const css = await read('./CommentsSheet.css');
  const block = css.match(/\.comments-sheet-loading \.comment-skeleton \{[^}]*\}/)?.[0] || '';
  assert.match(block, /opacity: 0;/);
  assert.match(block, /animation: comments-skeleton-reveal 140ms ease-out 320ms forwards;/);
  assert.doesNotMatch(css, /\n\.comments-sheet-loading \{[^}]*animation:/, 'a CSS animation on the motion element would override its exit');
  // `popLayout` positions the leaving element against the nearest positioned
  // ancestor; the body has to be that ancestor, not the sheet above it.
  assert.match(css, /\.comments-sheet-body \{[^}]*position: relative;/);
});
