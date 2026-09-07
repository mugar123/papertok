import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for the one frame that separates a sheet arriving from a sheet
 * appearing.
 *
 * Base UI seeds `mounted` from `open` (`internals/useTransitionStatus`), so a
 * popup that is already open on its first render never runs the
 * `open && !mounted` branch, never reaches `transitionStatus: 'starting'` and
 * never gets `data-starting-style`. That is deliberate — a `defaultOpen` popup
 * should not slide in on page load — and the opt-out, `animateInitialOpen`, is
 * internal: no Root exposes it.
 *
 * Measured against the real primitive at 390x844: mounted open, the drawer
 * travelled 0 px in 0 frames with the backdrop already at 0.4 in the first
 * frame it existed. Opened on the frame after mount, it travelled 243 px over
 * 20 frames with the backdrop fading in behind it. Neither way fires a
 * spurious `onOpenChangeComplete(false)`.
 */
test('the popup mounts closed and opens on the next frame', async () => {
  const hook = await read('./usePopupOpenOnMount.js');
  assert.match(hook, /const \[open, setOpen\] = useState\(false\);/, 'it mounts closed');
  assert.match(hook, /const frame = requestAnimationFrame\(\(\) => setOpen\(true\)\);/, 'and opens a frame later');
  assert.match(hook, /return \(\) => cancelAnimationFrame\(frame\);/, 'a sheet dismissed inside that frame leaves nothing armed');
});

test('the comments sheet takes its open state from the hook', async () => {
  const jsx = await read('../components/Comments/CommentsSheet.jsx');
  assert.match(jsx, /import \{ usePopupOpenOnMount \} from '\.\.\/\.\.\/hooks\/usePopupOpenOnMount\.js';/);
  assert.match(jsx, /const \{ open, setOpen, requestClose \} = usePopupOpenOnMount\(\);/);
  assert.doesNotMatch(jsx, /const \[open, setOpen\] = useState\(true\);/, 'never open on the first render');
  // The thread's reveal is keyed to that flip and not to mount, because the
  // slide it waits for does not start until the flag does.
  assert.match(
    jsx,
    /if \(!open\) return undefined;\s*const timer = setTimeout\(\(\) => setSheetArrived\(true\), SHEET_ARRIVAL\);/,
    'the beat belongs to the slide',
  );
});
