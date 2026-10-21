import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
  const jsx = stripComments(await read('./PaperReader.tsx'));
  assert.match(jsx, /document\.addEventListener\('mouseup', handleDocumentMouseUp\);/);
  assert.match(jsx, /return \(\) => document\.removeEventListener\('mouseup', handleDocumentMouseUp\);/);
  // The paragraph is the one the selection starts in — or ends in, when the
  // start overshot into the gap above — inside the reader's own scroller.
  assert.match(jsx, /const start = range\.startContainer;/);
  assert.match(jsx, /const paragraph = paragraphAround\(start\) \|\| paragraphAround\(range\.endContainer\);/);
  assert.match(jsx, /\.closest<HTMLElement>\('\.rd-p\[data-section\]'\)/);
  assert.match(jsx, /if \(!paragraph \|\| !scrollRef\.current\?\.contains\(paragraph\)\) return;/);
  // Notes, highlights and explanations are for a fine pointer only.
  assert.match(jsx, /if \(!annotating\) return undefined;/);
  assert.doesNotMatch(jsx, /'selectionchange'/);
  // The paragraph's source text comes from state by the ids the DOM carries.
  assert.match(jsx, /const paragraphTextFor = useCallback(?:<[^;\n]+>)?\(\(sectionId: string \| undefined, paragraphIndex: number\) => \{/);
  assert.match(jsx, /handleSelection\(sectionId, paragraphIndex, text, paragraph, /);
  // A selection that ends in a later paragraph of the same section is one passage.
  assert.match(jsx, /last\.dataset\.section === sectionId && lastIndex > paragraphIndex/);
  // Keyboard route untouched.
  assert.match(jsx, /onKeyDown=\{annotating \? \(event\) => handleParagraphKeyDown\(event, section\.id, paragraphIndex, paragraph\)/);
});
