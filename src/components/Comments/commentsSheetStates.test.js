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
  // Sliced, not matched: the thread inside this presence brings a nested
  // `</AnimatePresence>` of its own, and a lazy regex would stop at it.
  const opened = jsx.indexOf('<AnimatePresence mode="popLayout" initial={false}>');
  const after = jsx.indexOf('{WAITING_COPY[status] && (');
  assert.ok(opened !== -1 && after > opened, 'the body presence is where it was');
  const presence = [jsx.slice(opened, after)];
  assert.ok(presence, 'one presence holds the skeleton and the empty state');
  assert.match(presence[0], /status === 'loading' && \(\s*<motion\.div\s+key="loading"\s+className="comments-sheet-loading"/);
  assert.match(presence[0], /status === 'ready' && thread\.length === 0 && \(\s*<motion\.div\s+key="empty"\s+className="comments-sheet-state"/);
  // The skeleton leaves as the message arrives — the leaving one is popped out
  // of flow, so the message takes the space in the same frame.
  assert.match(presence[0], /exit=\{prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, y: 6 \}\}/);
  assert.match(presence[0], /initial=\{prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, y: 10 \}\}/);
  // Gated on the sheet's arrival now, like the thread: see the reveal test.
  assert.match(presence[0], /animate=\{revealed \? \{ opacity: 1, y: 0 \} : \{ opacity: 0, y: 10 \}\}/);
});

test('the delayed reveal sits on the rows, so framer owns the skeleton\'s own opacity', async () => {
  const css = await read('./CommentsSheet.css');
  const block = css.match(/\.comments-sheet-loading \.comment-skeleton \{[^}]*\}/)?.[0] || '';
  assert.match(block, /opacity: 0;/);
  assert.match(block, /animation: comments-skeleton-reveal 140ms ease-out forwards;/);
  // The hold is the component's now: rows held at `opacity: 0` still fired
  // this animation while the wrapper was leaving, painting grey over the
  // comments that had just arrived.
  assert.doesNotMatch(block, /320ms/, 'the hold is no longer a delay on the fade');
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /\{skeletonShowing && \[0, 1, 2\]\.map\(index => \(/, 'the rows are not rendered inside the hold');
  assert.doesNotMatch(css, /\n\.comments-sheet-loading \{[^}]*animation:/, 'a CSS animation on the motion element would override its exit');
  // `popLayout` positions the leaving element against the nearest positioned
  // ancestor; the body has to be that ancestor, not the sheet above it.
  assert.match(css, /\.comments-sheet-body \{[^}]*position: relative;/);
});

/**
 * SOURCE tests for the thread's arrival. Two separate faults, both measured in
 * a browser against the real curves before this was written:
 *
 * - The comments were drawn ACROSS the skeleton. `popLayout` takes the leaving
 *   skeleton out of flow, so the thread had the body in the same frame while
 *   the grey bars were still fading over the exact rows the first lines of
 *   type land on: 134 ms of serif text crossed by grey rectangles.
 * - On a thread served from the cache the reveal was spent behind the drawer.
 *   The sheet takes 400 ms to slide up; every row was fully opaque at 300 ms,
 *   with the sheet still a hundred pixels short of home, so nobody ever saw it.
 */
test('the thread waits for the skeleton to clear before its first row lands', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(jsx, /const REVEAL_LEAD = 0\.12;/, 'the reveal has a head start over the exit it replaces');
  // The head start is owed to grey the reader can actually see: inside the
  // hold the skeleton never left `opacity: 0`, and the common open — a Worker
  // answer in a couple of hundred milliseconds — lands there.
  assert.match(jsx, /const SKELETON_HOLD = 320;/, 'the hold is mirrored from the stylesheet');
  assert.match(
    jsx,
    /const clearingSkeleton = paintedBody === 'skeleton' && skeletonShowing;/,
    'only a skeleton that was actually visible is worth waiting for',
  );
  assert.match(
    jsx,
    /const timer = setTimeout\(\(\) => setSkeletonShowing\(true\), SKELETON_HOLD\);/,
    'the grey is announced by the same hold the stylesheet waits out',
  );
  assert.match(jsx, /const revealDelay = index => \(clearingSkeleton \? REVEAL_LEAD : 0\) \+ rowDelay\(index\);/);
  // A comment just posted is the answer to something the reader did: no queue.
  const cascade = jsx.match(/ease: ARRIVE, delay: revealDelay\(index\) \},/g) ?? [];
  assert.equal(cascade.length, 2, 'the cascade is the reveal, for a row and for a reply');
});

test('opening the sheet plays the reveal, and it waits for the sheet to get there', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  // The drawer's slide is 400 ms and spends 84 % of its travel in the first
  // 200, so a reveal that starts at once is over before the sheet is home —
  // which is how a real animation came to read as no animation at all.
  assert.match(jsx, /const SHEET_ARRIVAL = 200;/);
  assert.match(
    jsx,
    /const timer = setTimeout\(\(\) => setSheetArrived\(true\), SHEET_ARRIVAL\);/,
    'the beat is the sheet\'s own, not the read\'s',
  );
  assert.match(jsx, /const revealed = prefersReducedMotion \|\| sheetArrived;/, 'reduced motion never waits');
  // Held, not animated: a row waiting its turn is not moving.
  const held = jsx.match(/: \{ opacity: 0, y: \d+, transition: \{ duration: 0 \} \}\}/g) ?? [];
  assert.equal(held.length, 2, 'the row and the reply both hold until the sheet is home');
  assert.match(jsx, /animate=\{revealed\s*\?\s*\{ opacity: 1, y: 0 \} : \{ opacity: 0, y: 10 \}\}/, 'so does the empty verdict');
});

test('what the body painted is recorded after the frame, not during the effect', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  assert.match(
    jsx,
    /const frame = requestAnimationFrame\(\(\) => setPaintedBody\(bodyKind\)\);\s*return \(\) => cancelAnimationFrame\(frame\);/,
    'a body that changed twice inside one frame was never seen',
  );
  assert.match(jsx, /const bodyKind = status === 'loading' \? 'skeleton'/);
});

test('the empty verdict leaves instead of vanishing under the first comment', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const empty = jsx.match(/<motion\.div\s+key="empty"[\s\S]*?>/)?.[0] || '';
  assert.match(empty, /exit=\{prefersReducedMotion/, 'the empty state has an exit at all');
  assert.match(empty, /\{ opacity: 0, y: -4, transition: \{ duration: 0\.14, ease: LEAVE \} \}/);
});

test('the thread lives in that presence too, so its last row still gets to leave', async () => {
  const jsx = await read('./CommentsSheet.jsx');
  const opened = jsx.indexOf('<AnimatePresence mode="popLayout" initial={false}>');
  const after = jsx.indexOf('{WAITING_COPY[status] && (');
  const presence = jsx.slice(opened, after);
  // It used to sit outside, appearing and vanishing on its own: deleting the
  // last comment of a paper erased it in a single frame, and the row never
  // played the exit every other row plays.
  assert.match(presence, /status === 'ready' && thread\.length > 0 && \(/);
  assert.match(presence, /<motion\.ul\s+key="thread"\s+className="comments-list"/);
  // A leaving list is rendered from the children it had, so its exit is the
  // last row's: the same slide, the same 180 ms.
  const row = jsx.match(/exit=\{prefersReducedMotion\s*\?\s*\{ opacity: 0, transition: \{ duration: 0\.1 \} \}\s*:\s*\{ opacity: 0, x: -16, transition: \{ duration: 0\.18, ease: LEAVE \} \}\}/g) ?? [];
  assert.equal(row.length, 2, 'the list leaves with the very gesture its rows leave with');
  // ...and it arrives with nothing of its own: the rows own the reveal.
  const tag = presence.match(/<motion\.ul[^>]*>/)?.[0] || '';
  assert.ok(tag, 'the list opens as one tag');
  assert.doesNotMatch(tag, /initial=|animate=/, 'no entrance on the container');
});
