import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Opening Save and organize used to look like a hard cut: `scaleIn` was a 2%
 * scale over 200ms, and closing called `dialog.close()` in the same turn as
 * `onClose`, so the parent unmounted the window before any exit could paint.
 *
 * The window is a Base UI Dialog now (ui/dialog.tsx), and the contract is the
 * primitive's: the popup is marked `data-open` on the way in and `data-closed`
 * on the way out, held in the document until `dialogOut` has finished, and
 * the parent — which unmounts the component — hears of the close from
 * `onOpenChangeComplete(false)` and from nowhere else. Under reduced motion
 * the stylesheet sets the animation to `none`, there is nothing to wait for,
 * and the primitive reports the close at once: no timer has to outlive it.
 */

const JSX = new URL('./SaveToListModal.tsx', import.meta.url);
const CSS = new URL('./SaveToListModal.css', import.meta.url);
const CARD_CSS = new URL('../Feed/PaperCard.css', import.meta.url);

/** Comments are prose, not code: a decoy comment must never satisfy a test. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('the save modal moves like every dialog: no enter or exit of its own', async () => {
  const css = stripComments(await readFile(CSS, 'utf8'));
  // ui/dialog.jsx owns `dialogIn` / `dialogOut` for every window (2026-10-15).
  assert.doesNotMatch(css, /@keyframes saveModal(In|Out)/);
  assert.doesNotMatch(css, /\.save-modal(-scrim)?\[data-(open|closed)\]\s*\{[^}]*animation/);
  // A window on its way out takes no taps.
  assert.match(css, /\.save-modal\[data-closed\]\s*\{[^}]*pointer-events:\s*none/);
  assert.doesNotMatch(css, /is-closing/);
});

test('the exit plays before the parent unmounts the window, and the parent hears of it exactly once', async () => {
  const code = stripComments(await readFile(JSX, 'utf8'));

  // The window owns its open state because App.jsx unmounts it on `onClose`.
  assert.match(code, /const \[open, setOpen\] = useState\(true\);/);
  // A drawer mounted open still arrives: ui/drawer holds its first frame back.
  const drawer = await readFile(new URL('../ui/drawer.tsx', import.meta.url), 'utf8');
  assert.match(drawer, /open=\{open === undefined \? undefined : open && firstFrameDone\}/);
  assert.match(code, /<Root\s[\s\S]*?open=\{open\}/, 'the Root is controlled by the window');
  assert.match(code, /onOpenChangeComplete=\{handleOpenChangeComplete\}/, 'the parent is told after the animations, not before');
  assert.match(
    code,
    /const handleOpenChangeComplete = \(nextOpen: boolean\) => \{\s*if \(!nextOpen\) onClose\(\);\s*\};/,
  );
  // Standalone, the parent hears of a close only once the exit has played.
  // Embedded in another sheet, that sheet plays the exit, so it is told at once.
  const notifiesParent = code.match(/\bonClose\(\)/g) ?? [];
  assert.equal(notifiesParent.length, 2, 'onClose() is called from onOpenChangeComplete and, embedded, from closeDialog only');
  // Closing is one state change; nothing times the exit by hand any more.
  assert.match(code, /const closeDialog = \(\) => \(embedded \? onClose\(\) : setOpen\(false\)\);/);
  assert.doesNotMatch(code, /DIALOG_EXIT_MS|setTimeout|is-closing|useReducedMotion|useDialogFocus|showModal/);
});

test('every close path still funnels through the unsaved-changes guard, and a close while saving is refused', async () => {
  const code = stripComments(await readFile(JSX, 'utf8'));

  // Escape, the scrim and the X all arrive as Base UI's onOpenChange(false):
  // the request is refused and routed through the guard.
  assert.match(code, /onOpenChange=\{\(nextOpen, eventDetails\) => \{ if \(!nextOpen\) onCancel\(eventDetails\); \}\}/);
  assert.match(
    code,
    /const onCancel = \(eventDetails(?:: [^;\n]+)?\) => \{\s*eventDetails\.cancel\(\);\s*requestClose\(\{ explicit: eventDetails\.reason === 'close-press' \}\);\s*\};/,
  );
  assert.match(code, /if \(saving \|\| !open\) return/, 'a close while saving, or while already leaving, is refused');
  const guard = code.match(/const requestClose = \(\{ explicit = false \} = \{\}\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(guard, 'requestClose is gone');
  // Only the X, and only once the prompt is showing, answers it by closing:
  // Escape and the scrim keep asking, so a stray press cannot drop a note.
  assert.match(guard[0], /if \(dirty && !\(explicit && confirmingDiscard\)\) \{\s*setConfirmingDiscard\(true\);\s*return;\s*\}/);
  assert.match(guard[0], /closeDialog\(\);/);
  // The X is a DialogClose, so touch screen readers can leave the popup
  // (dialog.md, `modal`), and it goes through the same request as Escape.
  assert.match(code, /<Close\s[\s\S]*?render=\{<Button variant="ghost" size="icon-sm" aria-label=\{copy\.close\} \/>\}/);
  assert.doesNotMatch(code, /onClick=\{requestClose\}/, 'no second close path beside the primitive\'s');
});

test('the window is a modal Base UI dialog that owns focus, Escape and the scroll guard', async () => {
  const code = stripComments(await readFile(JSX, 'utf8'));
  assert.match(code, /import \{ Dialog, DialogClose, DialogContent, DialogTitle \} from '\.\.\/ui\/dialog\.tsx';/);
  assert.doesNotMatch(code, /modal=\{false\}/, 'FeedContainer probes [aria-modal="true"]; the window must stay modal');
  assert.doesNotMatch(code, /<dialog\b|useDialogFocus/);
  assert.match(code, /<DialogContent\s[\s\S]*?className="save-modal"[\s\S]*?closeLabel=\{copy\.close\}/);
  assert.match(code, /const Title = isPhone \? DrawerTitle : DialogTitle;/);
  assert.match(code, /const Root = isPhone \? Drawer : Dialog;/);
  assert.match(code, /const Close = isPhone \? DrawerClose : DialogClose;/);
  assert.match(code, /<Title className="visually-hidden">\{copy\.title\}<\/Title>/, 'the title names the dialog, out of sight');
  // The rows keep a real, focusable checkbox each; the fields keep a label.
  assert.match(code, /<Checkbox\s[\s\S]*?className="save-modal-tick"[\s\S]*?checked=\{selected\}/);
  assert.match(code, /<Label className="save-modal-field-label" htmlFor="save-modal-note">/);
  assert.match(code, /<Textarea\s+id="save-modal-note"/);
  assert.match(code, /<Input\s+className="save-modal-tag-input"\s+aria-labelledby="save-modal-tags-label"/);
});

test('reduced motion drops the enter and the exit, so the close completes at once', async () => {
  // The dialog primitive gates its own motion behind `motion-safe:` (ui/dialog.jsx),
  // so under reduced motion nothing runs and Base UI closes at once.
  const dialog = await readFile(new URL('../ui/dialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /motion-safe:data-open:\[animation:dialogIn/);
  assert.match(dialog, /motion-safe:data-closed:\[animation:dialogOut/);
});

test('the rail toggles do not pop: the fill is the feedback on the most-pressed buttons', async () => {
  const css = await readFile(CARD_CSS, 'utf8');
  assert.doesNotMatch(css, /likePopIn/, 'a keyframe pop restarts on every press and replays on mount (2026-10-15)');
  assert.match(css, /\.pc-side-btn:active \.pc-side-icon \{\s*transform: scale\(var\(--press-scale\)\);/);
});

test('the guest save prompt traps focus and closes on Escape', async () => {
  const source = await readFile(new URL('../Public/AuthPrompt.tsx', import.meta.url), 'utf8');
  // Either the shared keyboard hook or a Base UI Dialog, which owns the trap,
  // Escape and the restore itself; anything else is a window nobody can leave.
  const onHook = /useDialogFocus\(true, onClose\)/.test(source);
  const onDialog = /from '\.\.\/ui\/dialog\.tsx'/.test(source) && /<Dialog\b/.test(source) && !/modal=\{false\}/.test(source);
  assert.ok(onHook || onDialog, 'AuthPrompt lost the dialog keyboard contract');
  assert.ok(
    /data-dialog-initial-focus/.test(source) || /initialFocus=/.test(source),
    'nothing inside the prompt is marked as the initial focus',
  );
});
