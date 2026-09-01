import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Opening Save and organize used to look like a hard cut: `scaleIn` was a 2%
 * scale over 200ms, and closing called `dialog.close()` in the same turn as
 * `onClose`, so the parent unmounted the window before any exit could paint.
 *
 * The contract is the same one CreateListDialog already keeps: a native
 * `<dialog>` that stays open for the length of `saveModalOut`, marked
 * `is-closing`, closed by a timer rather than `animationend` so reduced
 * motion (where the animation is `none`) cannot trap the window open.
 */

const JSX = new URL('./SaveToListModal.jsx', import.meta.url);
const CSS = new URL('./SaveToListModal.css', import.meta.url);
const CARD_CSS = new URL('../Feed/PaperCard.css', import.meta.url);

test('the save modal holds a matching enter and exit pair', async () => {
  const css = await readFile(CSS, 'utf8');
  const jsx = await readFile(JSX, 'utf8');

  assert.match(css, /@keyframes saveModalIn/, 'SaveToListModal.css lost saveModalIn');
  assert.match(css, /@keyframes saveModalOut/, 'SaveToListModal.css lost saveModalOut');
  assert.match(css, /\.save-modal\s*\{[\s\S]*?animation:\s*saveModalIn/);
  assert.match(css, /\.save-modal\.is-closing\s*\{[\s\S]*?animation:\s*saveModalOut[^}]*forwards/);
  assert.match(css, /\.save-modal-dialog\.is-closing::backdrop\s*\{[\s\S]*?animation:\s*fadeOut[^}]*forwards/);

  const enter = css.match(/@keyframes saveModalIn\s*\{([\s\S]*?)\n\}/);
  const exit = css.match(/@keyframes saveModalOut\s*\{([\s\S]*?)\n\}/);
  assert.ok(enter && exit, 'expected both keyframe blocks');
  assert.match(enter[1], /translateY\(\s*16px\s*\)/, 'enter travel is too small to read as an arrival');
  assert.match(enter[1], /scale\(\s*0\.96\s*\)/, 'enter scale is too close to rest to register');
  assert.match(exit[1], /opacity:\s*0/, 'exit must fade out, not snap');

  assert.match(jsx, /setClosing\(true\)/, 'the window is not marked on the way out');
  assert.match(jsx, /is-closing/, 'the closing class never reaches the markup');
  assert.match(jsx, /DIALOG_EXIT_MS/, 'the timer that outlives reduced-motion is gone');
  assert.match(jsx, /prefersReducedMotion/, 'reduced motion must skip the wait');
});

test('the close timer matches the exit duration so the last frame is held', async () => {
  const jsx = await readFile(JSX, 'utf8');
  const css = await readFile(CSS, 'utf8');
  const timer = jsx.match(/const DIALOG_EXIT_MS = (\d+)/);
  const duration = css.match(/saveModalOut\s+([\d.]+)s/);
  assert.ok(timer && duration, 'could not read DIALOG_EXIT_MS or saveModalOut duration');
  assert.equal(Number(timer[1]), Math.round(Number(duration[1]) * 1000));
});

test('every close path still funnels through the unsaved-changes guard', async () => {
  const jsx = await readFile(JSX, 'utf8');
  assert.match(jsx, /onCancel/, 'the <dialog> Escape path must be intercepted');
  assert.match(jsx, /requestClose/, 'every close path funnels through requestClose');
  assert.match(jsx, /if \(saving \|\| closing \|\| closeTimer\.current\) return/);
  // Native `onClose` used to unmount immediately. It must not call the parent
  // callback any more — that is what cut the exit short.
  assert.match(jsx, /onClose=\{\(event\) => event\.stopPropagation\(\)\}/);
});

test('the bookmark rail pops the way like and read already do', async () => {
  const css = await readFile(CARD_CSS, 'utf8');
  const saved = css.match(/\.pc-side-btn--saved \.pc-side-icon\s*\{([^}]*)\}/);
  assert.ok(saved, 'lost .pc-side-btn--saved .pc-side-icon');
  assert.match(saved[1], /animation:\s*likePopIn/, 'saving a paper does not pop the bookmark');
});
