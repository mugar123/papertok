import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Opening Save and organize used to look like a hard cut: `scaleIn` was a 2%
 * scale over 200ms, and closing called `dialog.close()` in the same turn as
 * `onClose`, so the parent unmounted the window before any exit could paint.
 *
 * The window is a Base UI Dialog now (ui/dialog.jsx), and the contract is the
 * primitive's: the popup is marked `data-open` on the way in and `data-closed`
 * on the way out, held in the document until `saveModalOut` has finished, and
 * the parent — which unmounts the component — hears of the close from
 * `onOpenChangeComplete(false)` and from nowhere else. Under reduced motion
 * the stylesheet sets the animation to `none`, there is nothing to wait for,
 * and the primitive reports the close at once: no timer has to outlive it.
 */

const JSX = new URL('./SaveToListModal.jsx', import.meta.url);
const CSS = new URL('./SaveToListModal.css', import.meta.url);
const CARD_CSS = new URL('../Feed/PaperCard.css', import.meta.url);

/** Comments are prose, not code: a decoy comment must never satisfy a test. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('the save modal holds a matching enter and exit pair on the primitive\'s own attributes', async () => {
  const css = await readFile(CSS, 'utf8');

  assert.match(css, /@keyframes saveModalIn/, 'SaveToListModal.css lost saveModalIn');
  assert.match(css, /@keyframes saveModalOut/, 'SaveToListModal.css lost saveModalOut');
  assert.match(css, /\.save-modal\[data-open\]\s*\{[\s\S]*?animation:\s*saveModalIn/);
  assert.match(css, /\.save-modal\[data-closed\]\s*\{[\s\S]*?animation:\s*saveModalOut[^}]*forwards/);
  assert.match(css, /\.save-modal-scrim\[data-closed\]\s*\{[\s\S]*?animation:\s*fadeOut[^}]*forwards/);
  // A window on its way out takes no taps.
  assert.match(css, /\.save-modal\[data-closed\]\s*\{[^}]*pointer-events:\s*none/);
  // The hand-rolled exit is gone with the timer that held it.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /is-closing/);

  const enter = css.match(/@keyframes saveModalIn\s*\{([\s\S]*?)\n\}/);
  const exit = css.match(/@keyframes saveModalOut\s*\{([\s\S]*?)\n\}/);
  assert.ok(enter && exit, 'expected both keyframe blocks');
  assert.match(enter[1], /translateY\(\s*16px\s*\)/, 'enter travel is too small to read as an arrival');
  assert.match(enter[1], /scale\(\s*0\.96\s*\)/, 'enter scale is too close to rest to register');
  assert.match(exit[1], /opacity:\s*0/, 'exit must fade out, not snap');
  // The primitive centres the popup with the `translate` property: a keyframe
  // touching it would drag the window to the corner mid-animation.
  assert.doesNotMatch(enter[1], /\btranslate:/);
  assert.doesNotMatch(exit[1], /\btranslate:/);
});

test('the exit plays before the parent unmounts the window, and the parent hears of it exactly once', async () => {
  const code = stripComments(await readFile(JSX, 'utf8'));

  // The window owns its open state because App.jsx unmounts it on `onClose`.
  assert.match(code, /const \[open, setOpen\] = useState\(true\);/);
  assert.match(code, /<Dialog\s[\s\S]*?open=\{open\}/, 'the Root is controlled by the window');
  assert.match(code, /onOpenChangeComplete=\{handleOpenChangeComplete\}/, 'the parent is told after the animations, not before');
  assert.match(
    code,
    /const handleOpenChangeComplete = \(nextOpen\) => \{\s*if \(!nextOpen\) onClose\(\);\s*\};/,
  );
  const notifiesParent = code.match(/\bonClose\(\)/g) ?? [];
  assert.equal(notifiesParent.length, 1, 'onClose() must be called from onOpenChangeComplete and nowhere else');
  // Closing is one state change; nothing times the exit by hand any more.
  assert.match(code, /const closeDialog = \(\) => setOpen\(false\);/);
  assert.doesNotMatch(code, /DIALOG_EXIT_MS|setTimeout|is-closing|useReducedMotion|useDialogFocus|showModal/);
});

test('every close path still funnels through the unsaved-changes guard, and a close while saving is refused', async () => {
  const code = stripComments(await readFile(JSX, 'utf8'));

  // Escape, the scrim and the X all arrive as Base UI's onOpenChange(false):
  // the request is refused and routed through the guard.
  assert.match(code, /onOpenChange=\{\(nextOpen, eventDetails\) => \{ if \(!nextOpen\) onCancel\(eventDetails\); \}\}/);
  assert.match(
    code,
    /const onCancel = \(eventDetails\) => \{\s*eventDetails\.cancel\(\);\s*requestClose\(\);\s*\};/,
  );
  assert.match(code, /if \(saving \|\| !open\) return/, 'a close while saving, or while already leaving, is refused');
  const guard = code.match(/const requestClose = \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(guard, 'requestClose is gone');
  assert.match(guard[0], /if \(dirty\) \{\s*setConfirmingDiscard\(true\);\s*return;\s*\}/);
  assert.match(guard[0], /closeDialog\(\);/);
  // The X is a DialogClose, so touch screen readers can leave the popup
  // (dialog.md, `modal`), and it goes through the same request as Escape.
  assert.match(code, /<DialogClose\s[\s\S]*?render=\{<Button variant="ghost" size="icon-sm" aria-label=\{copy\.close\} \/>\}/);
  assert.doesNotMatch(code, /onClick=\{requestClose\}/, 'no second close path beside the primitive\'s');
});

test('the window is a modal Base UI dialog that owns focus, Escape and the scroll guard', async () => {
  const code = stripComments(await readFile(JSX, 'utf8'));
  assert.match(code, /import \{ Dialog, DialogClose, DialogContent, DialogTitle \} from '\.\.\/ui\/dialog\.jsx';/);
  assert.doesNotMatch(code, /modal=\{false\}/, 'FeedContainer probes [aria-modal="true"]; the window must stay modal');
  assert.doesNotMatch(code, /<dialog\b|useDialogFocus/);
  assert.match(code, /<DialogContent\s[\s\S]*?className="save-modal"[\s\S]*?closeLabel=\{copy\.close\}/);
  assert.match(code, /<DialogTitle>\{copy\.title\}<\/DialogTitle>/, 'the headline names the dialog');
  // The rows keep a real, focusable checkbox each; the fields keep a label.
  assert.match(code, /<Checkbox\s[\s\S]*?className="save-modal-tick"[\s\S]*?checked=\{selected\}/);
  assert.match(code, /<Label className="save-modal-field-label" htmlFor="save-modal-note">/);
  assert.match(code, /<Textarea\s+id="save-modal-note"/);
  assert.match(code, /<Input\s+className="save-modal-tag-input"\s+aria-labelledby="save-modal-tags-label"/);
});

test('reduced motion drops the enter and the exit, so the close completes at once', async () => {
  const css = await readFile(CSS, 'utf8');
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
  const block = reduced.find((rule) => /\.save-modal\[data-closed\]/.test(rule));
  assert.ok(block, 'the reduced-motion block does not cover the exit');
  assert.match(block, /\.save-modal\[data-open\],\s*\.save-modal\[data-closed\],\s*\.save-modal-scrim\[data-open\],\s*\.save-modal-scrim\[data-closed\],[\s\S]*?animation: none;/);
});

test('the bookmark rail pops the way like and read already do', async () => {
  const css = await readFile(CARD_CSS, 'utf8');
  const saved = css.match(/\.pc-side-btn--saved \.pc-side-icon\s*\{([^}]*)\}/);
  assert.ok(saved, 'lost .pc-side-btn--saved .pc-side-icon');
  assert.match(saved[1], /animation:\s*likePopIn/, 'saving a paper does not pop the bookmark');
});

test('the guest save prompt traps focus and closes on Escape', async () => {
  const source = await readFile(new URL('../Public/AuthPrompt.jsx', import.meta.url), 'utf8');
  // Either the shared keyboard hook or a Base UI Dialog, which owns the trap,
  // Escape and the restore itself; anything else is a window nobody can leave.
  const onHook = /useDialogFocus\(true, onClose\)/.test(source);
  const onDialog = /from '\.\.\/ui\/dialog(?:\.jsx)?'/.test(source) && /<Dialog\b/.test(source) && !/modal=\{false\}/.test(source);
  assert.ok(onHook || onDialog, 'AuthPrompt lost the dialog keyboard contract');
  assert.ok(
    /data-dialog-initial-focus/.test(source) || /initialFocus=/.test(source),
    'nothing inside the prompt is marked as the initial focus',
  );
});

test('the window takes its time on the way in and out', async () => {
  // Asked for on 2026-09-03: the arrival and the dismissal read as too quick.
  // 1.5× on both, the scrim on the same clocks so neither outlives the other.
  const css = await readFile(CSS, 'utf8');
  assert.match(css, /\.save-modal-scrim\[data-open\] \{\s*animation: fadeIn 0\.36s cubic-bezier\(0\.16, 1, 0\.3, 1\);/);
  assert.match(css, /\.save-modal\[data-open\] \{\s*animation: saveModalIn 0\.36s cubic-bezier\(0\.16, 1, 0\.3, 1\);/);
  assert.match(css, /\.save-modal\[data-closed\] \{\s*animation: saveModalOut 0\.3s cubic-bezier\(0\.4, 0, 1, 1\) forwards;/);
  assert.match(css, /\.save-modal-scrim\[data-closed\] \{\s*animation: fadeOut 0\.32s cubic-bezier\(0\.4, 0, 1, 1\) forwards;/);
});
