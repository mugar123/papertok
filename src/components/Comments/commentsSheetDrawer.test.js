import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The comments sheet is a Base UI Drawer: the primitive owns the scrim, the
 * slide, the swipe-to-dismiss, the focus trap, Escape and focus restore. What
 * this holds is the seam — that nothing the primitive replaced comes back
 * beside it, and that the parent is still told exactly once, after the leave.
 */

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the comments sheet is a modal Drawer that tells its parent once, after the leave', async () => {
  const jsx = stripComments(await read('./CommentsSheet.jsx'));

  assert.match(jsx, /import \{ Drawer, DrawerBody, DrawerContent \} from '\.\.\/ui\/drawer\.jsx';/);
  assert.match(jsx, /<Drawer\s[\s\S]*?\bmodal\b/);
  assert.match(jsx, /onOpenChangeComplete=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/);
  // `onClose` reaches the parent from that one place and nowhere else.
  assert.equal((jsx.match(/\bonClose\(\)/g) || []).length, 1, 'onClose() should be called from exactly one place');
  assert.match(jsx, /<DrawerContent[\s\S]*?aria-label=\{text\(COPY\.title\)\}/);
  // The thread and the composer are the drawer's content region (text stays
  // selectable without starting a swipe); the composer is the ui Textarea.
  assert.match(jsx, /<DrawerBody className="comments-sheet-frame">/);
  assert.match(jsx, /<Textarea\s[\s\S]*?className="comments-composer-input"/);

  assert.doesNotMatch(jsx, /useDialogFocus|asChild|is-closing|setClosing|EXIT_MS|comments-sheet-backdrop|aria-modal=/);
});

test('the comments stylesheet reads on its own and leaves the scrim to the drawer', async () => {
  const css = stripComments(await read('./CommentsSheet.css'));

  // The drawer's bleed variable is restated in the rule that reads it, so a
  // token scan of this file alone finds it defined.
  const sheet = css.match(/\n\.comments-sheet\s*\{([^}]*)\}/);
  assert.ok(sheet, 'expected a .comments-sheet rule');
  assert.match(sheet[1], /--bleed:\s*3rem/);
  assert.match(sheet[1], /padding-bottom:\s*var\(--bleed\)/);

  assert.doesNotMatch(css, /\.comments-sheet-backdrop/);
  // Wide screens float the sheet through the drawer's viewport, and its
  // arrival is written on Base UI's attributes.
  assert.match(css, /\.comments-sheet-viewport\s*\{/);
  assert.match(css, /\.comments-sheet\[data-starting-style\]/);
  assert.match(css, /\.comments-sheet\[data-ending-style\]/);
});
