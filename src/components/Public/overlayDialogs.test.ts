import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The two guest overlays are Base UI Dialogs (shadcn's `ui/dialog.tsx`).
 * What used to be hand-rolled — the focus trap, Escape, the scrim, the
 * enter/exit — is the primitive's, and these checks protect the invariants
 * that were pinned on the old implementation: the overlay is modal, its
 * close control has a bilingual name, focus lands where it always did, and
 * a parent that unmounts the overlay on close hears about it exactly once,
 * after the leave has played.
 */

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const authJsx = readFile(new URL('./AuthPrompt.tsx', import.meta.url), 'utf8').then(stripComments);
const authCss = readFile(new URL('./AuthPrompt.css', import.meta.url), 'utf8').then(stripComments);

test('the sign-in prompt is a modal Base UI Dialog that owns its own open flag', async () => {
  const jsx = await authJsx;
  assert.match(jsx, /from '\.\.\/ui\/dialog\.tsx'/);
  assert.match(jsx, /<Dialog\b[\s\S]*?\n\s*modal\n\s*>/, 'the dialog must stay modal: FeedContainer probes [aria-modal="true"]');
  assert.doesNotMatch(jsx, /useDialogFocus|framer-motion|aria-modal=/, 'the primitive owns focus, Escape and motion now');
  // App.tsx mounts it only while open, so it starts open and closes itself.
  assert.match(jsx, /useState(?:<[^;\n]+>)?\(true\)/);
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
  assert.match(jsx, /<DialogClose\s[\s\S]*?ref=\{closeButtonRef\}[\s\S]*?aria-label=(?:"Close"|\{'Close'\})/);
  assert.match(jsx, /<DialogTitle className="auth-modal-title">/);
  assert.match(jsx, /<DialogDescription className="auth-modal-lede">/);
  // The analytics contract of the door is unchanged: the shared sign-in hook
  // reports the press with the surface this door names, then the outcome.
  assert.match(jsx, /<SignInMethods \/>/);
  const methods = await readFile(new URL('./SignInMethods.tsx', import.meta.url), 'utf8');
  assert.match(methods, /useProviderSignIn\('auth_prompt'\)/);
  const hook = await readFile(new URL('./useProviderSignIn.ts', import.meta.url), 'utf8');
  assert.match(hook, /trackEvent\('select_content', \{ content_type: 'signup_cta', surface, method \}\)/);
  assert.match(hook, /trackEvent\(result\?\.isNewUser \? 'sign_up' : 'login', \{ method \}\)/);
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
