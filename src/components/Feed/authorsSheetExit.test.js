import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for the authors sheet on a phone, which is the path to every
 * author there: the names take no pointer events under 768px, a tap on the
 * row opens the sheet, and the author is picked from it.
 */
test('the authors sheet lives on the body, outside the page the transition transforms', async () => {
  const jsx = await read('./PaperCard.jsx');
  const sheet = jsx.slice(jsx.indexOf('{createPortal(\n      <AnimatePresence>\n        {showAuthorsModal && ('), jsx.indexOf("'papertok-authors-sheet',"));
  assert.ok(sheet.length > 0, 'the sheet is portalled');
  assert.match(sheet, /className="pc-authors-modal-overlay"/);
  assert.match(sheet, /<\/AnimatePresence>,\s*document\.body,\s*$/);
  const css = await read('./PaperCard.css');
  assert.match(css, /\.pc-authors-modal-overlay \{\s*position: fixed;/, 'fixed, which is why it cannot sit inside a transformed page');
});

test('picking an author moves the sheet to its leaving pose and lets the page take it; dismissing it springs it back down', async () => {
  const jsx = await read('./PaperCard.jsx');
  assert.match(jsx, /const \[authorsSheetLeaving, setAuthorsSheetLeaving\] = useState\(false\);/);
  // Somewhere to go: the sheet stays mounted in its leaving pose (the page's
  // unmount removes it); nowhere: dismissed as if by the scrim.
  assert.match(jsx, /if \(path\) setAuthorsSheetLeaving\(true\);\s*else setShowAuthorsModal\(false\);/);
  assert.match(jsx, /animate=\{authorsSheetLeaving\s*\? \(prefersReducedMotion \? \{ opacity: 0 \} : \{ y: 24, opacity: 0 \}\)\s*: \{ y: 0, opacity: 1 \}\}/);
  assert.match(jsx, /authorsSheetLeaving\s*\? \{ duration: 0\.18, ease: \[0\.4, 0, 1, 1\] \}\s*: \{ type: 'spring', damping: 25, stiffness: 200 \}/, 'the page leaves in 0.2 s on the same curve');
  assert.match(jsx, /exit=\{prefersReducedMotion \? \{ opacity: 0 \} : \{ y: '100%' \}\}/, 'a dismissal still springs down');
  assert.match(jsx, /style=\{authorsSheetLeaving \? \{ pointerEvents: 'none' \} : undefined\}/, 'a leaving sheet takes no taps');
});
