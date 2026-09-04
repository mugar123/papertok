import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The keyboard route into the annotation menu (WCAG 2.1.1).
 *
 * Before this, `onMouseUp` on each paragraph was the only way into
 * `SelectionMenu` -- a keyboard user has no caret to select a passage with
 * (paragraphs are not editable, and caret browsing is off by default and
 * absent on macOS), so highlighting, note-writing and "explain this" were
 * mouse-only. The fix makes each paragraph a tab stop on the desktop
 * ('menu') route and opens the same menu, over the whole paragraph, on
 * Enter -- and makes sure the menu itself is reachable once open, not only
 * once its composer is.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

const matchParagraphElement = (jsx) => jsx.match(/<p\s+key=\{paragraphIndex\}[\s\S]*?<\/p>\s*\);\s*\}\)\}/);

test('paragraphs are keyboard-focusable on the desktop selection route', async () => {
  const jsx = await read('./PaperReader.jsx');

  const paragraph = matchParagraphElement(jsx);
  assert.ok(
    paragraph,
    'the paragraph <p> rendered by section.paragraphs.map changed shape; update this test alongside it',
  );

  assert.match(
    paragraph[0],
    /tabIndex=\{selectionRoute === 'menu' \? 0 : undefined\}/,
    'paragraphs no longer get tabIndex 0 on the desktop route -- a keyboard user has no way to '
    + 'reach an unfocusable paragraph, so the annotation menu stays mouse-only (WCAG 2.1.1).',
  );
});

test('a focused paragraph opens the annotation menu on Enter', async () => {
  const jsx = await read('./PaperReader.jsx');

  const paragraph = matchParagraphElement(jsx);
  assert.ok(
    paragraph,
    'the paragraph <p> rendered by section.paragraphs.map changed shape; update this test alongside it',
  );
  assert.match(
    paragraph[0],
    /onKeyDown=\{selectionRoute === 'menu'/,
    'the focused paragraph no longer wires an onKeyDown handler -- tabbing to it now leads '
    + 'nowhere, since there is no Enter route into the menu.',
  );

  const handler = jsx.match(
    /const handleParagraphKeyDown = useCallback\(\(event, sectionId, paragraphIndex, paragraphText\) => \{[\s\S]*?\}, \[beginAnnotation, uid\]\);/,
  );
  assert.ok(
    handler,
    'handleParagraphKeyDown is gone, renamed, or no longer closes over [beginAnnotation, uid]; '
    + 'update this test alongside it',
  );
  assert.match(
    handler[0],
    /beginAnnotation\(\{/,
    'handleParagraphKeyDown no longer calls beginAnnotation -- Enter on a focused paragraph '
    + 'would open nothing.',
  );
  assert.match(
    handler[0],
    /event\.key !== 'Enter'/,
    'handleParagraphKeyDown no longer checks for the Enter key -- it would fire on every key, '
    + 'stealing normal typing/scrolling from a focused paragraph.',
  );
});

test('the mouse route is unchanged: paragraphs still wire onMouseUp to handleSelection', async () => {
  const jsx = await read('./PaperReader.jsx');

  assert.match(
    jsx,
    /onMouseUp=\{\(event\) => handleSelection\(section\.id, paragraphIndex, paragraph, event\.currentTarget\)\}/,
    'the mouse-up handler on the paragraph changed shape or was removed -- the keyboard fix must '
    + 'not touch the mouse route.',
  );

  assert.match(
    jsx,
    /const handleSelection = useCallback\(\(sectionId, paragraphIndex, paragraphText, paragraphNode\) => \{/,
    'handleSelection changed shape; update this test alongside it',
  );
});

test('the paragraph carries a hidden, screen-reader-only instruction for the Enter action', async () => {
  const jsx = await read('./PaperReader.jsx');

  assert.match(
    jsx,
    /aria-describedby=\{selectionRoute === 'menu' \? paragraphHintId : undefined\}/,
    'the paragraph no longer points aria-describedby at the hidden instructions -- a screen '
    + 'reader user tabbing onto a paragraph now hears only its text, with no indication Enter '
    + 'does anything.',
  );

  assert.match(
    jsx,
    /<p id=\{paragraphHintId\} className="visually-hidden">\{copy\.annotateParagraphInstructions\}<\/p>/,
    'the hidden instructions element that paragraphHintId points at changed shape or is gone; '
    + 'update this test alongside it',
  );
});

test('SelectionMenu moves focus into itself as soon as it opens, not only once composing starts', async () => {
  const jsx = await read('./SelectionMenu.jsx');

  // The bug this closes: the only focus() call in the old file ran inside
  // `if (composing) textareaRef.current?.focus()`, so the menu's first,
  // non-composing state (the one every open starts in) never received focus
  // at all -- a keyboard user who somehow triggered `pending` had a menu on
  // screen and no way to reach it with Tab.
  assert.match(
    jsx,
    /import \{ useDialogFocus \} from '\.\.\/\.\.\/hooks\/useDialogFocus\.js';/,
    'SelectionMenu no longer imports useDialogFocus -- without it (or an equivalent), the menu '
    + 'never receives focus in its first, non-composing state.',
  );

  assert.match(
    jsx,
    /useDialogFocus\(true, onClose\)/,
    'the call to useDialogFocus changed shape; update this test alongside it',
  );

  assert.match(
    jsx,
    /data-dialog-initial-focus/,
    'no element in the menu is marked data-dialog-initial-focus; useDialogFocus falls back to the '
    + 'first focusable element when nothing is marked, but the explicit marker is what survives a '
    + 'reordering of the buttons -- update this test alongside it if that trade was deliberately dropped',
  );

  // Escape-to-close must survive the move from the old bespoke listener to
  // useDialogFocus, which is the one thing in this file guaranteed to still
  // provide it.
  assert.doesNotMatch(
    jsx,
    /document\.addEventListener\('keydown', handleKey, true\)/,
    'the old bespoke Escape-key listener is still here alongside useDialogFocus -- Escape would '
    + 'fire onClose() twice (harmless) but the dead code should go; update this test if it was '
    + 'kept on purpose',
  );

  // The list -> compose refocus is a different transition than the initial
  // open (useDialogFocus's own initial-focus effect runs once, on mount,
  // while `composing` starts false and only flips after) and must survive.
  assert.match(
    jsx,
    /if \(composing\) textareaRef\.current\?\.focus\(\);/,
    'the composing-mode textarea autofocus is gone -- clicking "Write a note" would open the '
    + 'composer without moving focus into it.',
  );
});
