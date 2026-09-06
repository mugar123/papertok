import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Three seams of the follow sheet that lint and build cannot hold, in the
 * source-level style of profileOverlays.test.js.
 *
 * 1. The arrival. Base UI plays `data-starting-style` only when `open` flips
 *    from false to true on a mounted root; a Drawer that mounts already open
 *    skips it (`useTransitionStatus`, `animateInitialOpen` is not exposed).
 *    Measured 2026-09-06: the sheet was at opacity 1 on its first frame, on
 *    desktop and on phones alike. Mounting closed and opening on the next
 *    frame is what makes the arrival exist.
 * 2. The reads. Every row's account goes through the loader, whose one rule
 *    is that a failure is not an answer. A `readUserProfile(...).catch(() =>
 *    null)` here was how a dropped request became "Account unavailable" for
 *    the rest of the tab session.
 * 3. The state bands enter like the rows do, instead of popping.
 */

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const stripComments = source => source
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('the sheet mounts closed and opens on the next frame, so Base UI plays the arrival', async () => {
  const jsx = stripComments(await read('./FollowSheet.jsx'));

  assert.match(jsx, /const \[open, setOpen\] = useState\(false\);/);
  assert.match(jsx, /requestAnimationFrame\(\(\) => setOpen\(true\)\)/);
  assert.match(jsx, /cancelAnimationFrame\(frame\)/, 'an unmount before the frame must not open a dead sheet');
});

test('every profile behind a row is read through the loader, never settled by a catch', async () => {
  const jsx = stripComments(await read('./FollowSheet.jsx'));

  assert.match(jsx, /from '\.\/followListLoad\.js';/);
  assert.match(jsx, /resolveRowProfiles\(/);
  assert.match(jsx, /readFollowPage\(/);
  assert.doesNotMatch(jsx, /readUserProfile\b/, 'the SDK profile read has no place in this sheet');
  assert.doesNotMatch(jsx, /\.catch\(\(\) => null\)/, 'a failure turned into null is the bug this guards');
  assert.doesNotMatch(jsx, /followRowProfileCache\.set/, 'only the loader writes the profile cache');
});

test('the counters warm their list on intent, so the sheet can open on rows', async () => {
  const jsx = stripComments(await read('./PublicProfilePage.jsx'));

  assert.match(jsx, /import \{ prefetchFollowList \} from '\.\/followListLoad\.js';/);
  for (const tab of ['following', 'followers']) {
    const start = jsx.indexOf(`onClick={() => setFollowSheet('${tab}')}`);
    assert.ok(start > 0, `the ${tab} counter button should be there`);
    const button = jsx.slice(start, jsx.indexOf('</button>', start));
    assert.match(button, new RegExp(`onPointerEnter=\\{\\(\\) => prefetchFollowList\\(statsUid, '${tab}'\\)\\}`));
    assert.match(button, new RegExp(`onFocus=\\{\\(\\) => prefetchFollowList\\(statsUid, '${tab}'\\)\\}`));
  }
});

test('the state bands arrive with the house curve, and only by opacity under reduced motion', async () => {
  const css = stripComments(await read('./FollowSheet.css'));

  const band = css.match(/\.follow-sheet-state\s*\{[^}]*\}/)?.[0] || '';
  assert.match(band, /animation:\s*follow-sheet-state-in/);
  assert.match(css, /@keyframes follow-sheet-state-in\s*\{[\s\S]*?opacity: 0;[\s\S]*?translateY\(/);

  const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.match(reduced, /follow-sheet-state-fade|\.follow-sheet-state\s*\{[^}]*animation/, 'the band still fades under reduced motion');
  assert.doesNotMatch(reduced.match(/@keyframes follow-sheet-state-fade\s*\{[\s\S]*?\}\s*\}/)?.[0] || '', /translate/);
});
