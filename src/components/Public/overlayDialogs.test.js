import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The two guest overlays are Base UI Dialogs (shadcn's `ui/dialog.jsx`).
 * What used to be hand-rolled — the focus trap, Escape, the scrim, the
 * enter/exit — is the primitive's, and these checks protect the invariants
 * that were pinned on the old implementation: the overlay is modal, its
 * close control has a bilingual name, focus lands where it always did, and
 * a parent that unmounts the overlay on close hears about it exactly once,
 * after the leave has played.
 */

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const authJsx = readFile(new URL('./AuthPrompt.jsx', import.meta.url), 'utf8').then(stripComments);
const authCss = readFile(new URL('./AuthPrompt.css', import.meta.url), 'utf8').then(stripComments);
const gipJsx = readFile(new URL('./GuestInterestsPrompt.jsx', import.meta.url), 'utf8').then(stripComments);
const gipCss = readFile(new URL('./GuestInterestsPrompt.css', import.meta.url), 'utf8').then(stripComments);

test('the sign-in prompt is a modal Base UI Dialog that owns its own open flag', async () => {
  const jsx = await authJsx;
  assert.match(jsx, /from '\.\.\/ui\/dialog\.jsx'/);
  assert.match(jsx, /<Dialog\b[\s\S]*?\n\s*modal\n\s*>/, 'the dialog must stay modal: FeedContainer probes [aria-modal="true"]');
  assert.doesNotMatch(jsx, /useDialogFocus|framer-motion|aria-modal=/, 'the primitive owns focus, Escape and motion now');
  // App.jsx mounts it only while open, so it starts open and closes itself.
  assert.match(jsx, /useState\(true\)/);
  assert.match(jsx, /open=\{isOpen\}/);
  assert.match(jsx, /const isOpen = open && !user/, 'a session appearing is itself the close');
});

test('the sign-in prompt tells App to unmount it once, after the leave has played', async () => {
  const jsx = await authJsx;
  const complete = jsx.match(/onOpenChangeComplete=\{\(isOpen\) => \{ if \(!isOpen\) onClose\(\); \}\}/);
  assert.ok(complete, 'onClose must be called from onOpenChangeComplete(false)');
  const calls = jsx.match(/\bonClose\(\)/g) ?? [];
  assert.equal(calls.length, 1, 'onClose reaches the parent from exactly one place');
});

test('the sign-in prompt keeps its close control, its name, and its initial focus', async () => {
  const jsx = await authJsx;
  assert.match(jsx, /initialFocus=\{closeButtonRef\}/);
  assert.match(jsx, /<DialogClose\s[\s\S]*?ref=\{closeButtonRef\}[\s\S]*?aria-label=\{isEnglish \? 'Close' : 'Cerrar'\}/);
  assert.match(jsx, /<DialogTitle className="auth-modal-title">/);
  assert.match(jsx, /<DialogDescription className="auth-modal-lede">/);
  // The analytics contract of the door is unchanged.
  assert.match(jsx, /trackEvent\('select_content', \{ content_type: 'signup_cta', surface: 'auth_prompt', method \}\)/);
  assert.match(jsx, /trackEvent\(result\?\.isNewUser \? 'sign_up' : 'login', \{ method \}\)/);
});

test('the sign-in sheet keeps its look and leaves the centring to the primitive', async () => {
  const css = await authCss;
  const sheet = css.match(/\.auth-modal\s*\{[^}]*\}/);
  assert.ok(sheet, 'AuthPrompt.css lost .auth-modal');
  assert.doesNotMatch(sheet[0], /position:/, 'the popup is positioned by the primitive');
  assert.match(sheet[0], /border-radius:\s*var\(--radius-2xl\)/);
  assert.match(sheet[0], /box-shadow:\s*var\(--shadow-xl\)/);
  const scrim = css.match(/\.auth-modal-backdrop\s*\{[^}]*\}/);
  assert.ok(scrim, 'AuthPrompt.css lost .auth-modal-backdrop');
  assert.doesNotMatch(scrim[0], /backdrop-filter|position:|z-index/);
});

test('the interests prompt is a modal Dialog and settles into one parent callback', async () => {
  const jsx = await gipJsx;
  assert.match(jsx, /from '\.\.\/ui\/dialog\.jsx'/);
  assert.match(jsx, /<Dialog open=\{open\} onOpenChange=\{setOpen\} onOpenChangeComplete=\{settle\} modal>/);
  assert.doesNotMatch(jsx, /useDialogFocus|framer-motion|aria-modal=/);
  // An answer and a dismissal both close the sheet first; the parent hears
  // one of them once the leave has played.
  const settle = jsx.match(/const settle = \(isOpen\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(settle, 'GuestInterestsPrompt lost settle()');
  assert.match(settle[0], /if \(answer\) onSubmit\?\.\(answer\);\s*else onDismiss\?\.\(\);/);
  assert.equal((jsx.match(/onDismiss\?\.\(\)/g) ?? []).length, 1);
  assert.equal((jsx.match(/onSubmit\?\.\(/g) ?? []).length, 1);
  // The close control is named in both languages, and focus opens on the
  // first area, as the old data-dialog-initial-focus did.
  assert.match(jsx, /closeLabel=\{copy\.close\[mode\]\}/);
  assert.match(jsx, /initialFocus=\{firstAreaRef\}/);
  assert.match(jsx, /ref=\{index === 0 \? firstAreaRef : undefined\}/);
  // The chips are the shared Toggle: a native button on which Base UI
  // writes `aria-pressed` and `data-pressed`; the CSS reads the attribute.
  assert.match(jsx, /import \{ Toggle \} from '\.\.\/ui\/toggle\.jsx'/);
  assert.match(jsx, /<Toggle\s[\s\S]*?className="gip-area"\s+pressed=\{isSelected\}\s+onPressedChange=\{\(\) => toggle\(key\)\}/);
  assert.doesNotMatch(jsx, /aria-pressed=|is-selected/);
  const css = await gipCss;
  assert.match(css, /\.gip-area\[data-pressed\]\s*\{/);
  assert.doesNotMatch(css, /\.gip-area\.is-selected|:not\(\.is-selected\)/);
});

test('the interests sheet docks to the bottom on a phone and floats centred from 640px', async () => {
  const css = await gipCss;
  const phone = css.match(/\.gip\s*\{[^}]*\}/);
  assert.ok(phone, 'GuestInterestsPrompt.css lost .gip');
  assert.match(phone[0], /top:\s*auto/);
  assert.match(phone[0], /bottom:\s*0/);
  assert.match(phone[0], /translate:\s*-50% 0/);
  const wide = css.match(/@media \(min-width: 640px\)\s*\{[\s\S]*?\.gip\s*\{[^}]*\}/);
  assert.ok(wide, 'the wide breakpoint lost its .gip rule');
  assert.match(wide[0], /top:\s*50%/);
  assert.match(wide[0], /translate:\s*-50% -50%/);
  assert.doesNotMatch(css, /\.gip-backdrop\s*\{[^}]*(?:position|z-index|place-items)/);
});
