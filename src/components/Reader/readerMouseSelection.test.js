import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The mouse-up that turns a selection into the menu lived on each paragraph,
 * so a drag released on the section title, in the margin or in the gap
 * between paragraphs — where a drag to the end of a sentence usually ends —
 * opened nothing and left the browser's blue selection on the page
 * (measured 2026-09-17, see docs/AUDITORIA-LECTOR-SELECCION-2026-09-17.md).
 * The document listens now, and the paragraph is read off the selection
 * itself: the one that holds where the selection STARTS, which also fixes a
 * selection across two paragraphs quoting from the wrong one.
 */
test('a mouse selection is resolved from the Range, from the paragraph it starts in, wherever the button is released', async () => {
  const jsx = stripComments(await read('./PaperReader.jsx'));
  assert.match(jsx, /document\.addEventListener\('mouseup', handleDocumentMouseUp\);/);
  assert.match(jsx, /return \(\) => document\.removeEventListener\('mouseup', handleDocumentMouseUp\);/);
  // The paragraph is the one the selection starts in — or ends in, when the
  // start overshot into the gap above — inside the reader's own scroller.
  assert.match(jsx, /const start = range\.startContainer;/);
  assert.match(jsx, /const paragraph = paragraphAround\(start\) \|\| paragraphAround\(range\.endContainer\);/);
  assert.match(jsx, /\.closest\('\.rd-p\[data-section\]'\)/);
  assert.match(jsx, /if \(!paragraph \|\| !scrollRef\.current\?\.contains\(paragraph\)\) return;/);
  // Only on the route that has a menu to open.
  assert.match(jsx, /if \(selectionRoute !== 'menu'\) return undefined;/);
  // The paragraph's source text comes from state by the ids the DOM carries.
  assert.match(jsx, /const paragraphTextFor = useCallback\(\(sectionId, paragraphIndex\) => \{/);
  assert.match(jsx, /handleSelection\(paragraph\.dataset\.section, paragraphIndex, text, paragraph\);/);
  // Keyboard route untouched.
  assert.match(jsx, /onKeyDown=\{selectionRoute === 'menu'\s*\? \(event\) => handleParagraphKeyDown\(event, section\.id, paragraphIndex, paragraph\)/);
});
