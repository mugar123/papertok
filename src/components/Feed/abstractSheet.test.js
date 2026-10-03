import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The abstract is not on the feed card (2026-09-26): the card leads with the
 * title and its "why it matters" line, and the abstract is one press away, in
 * the reading sheet. So there is one door, the same on every pointer, and no
 * panel in the card to fold, measure or unfold.
 */
test('the card has no abstract panel, only a named door to the reading sheet', async () => {
  const jsx = stripComments(await read('./PaperCard.jsx'));
  assert.doesNotMatch(jsx, /className=\{`pc-abstract /, 'no abstract panel in the card');
  assert.doesNotMatch(jsx, /abstractClipped|toggleExpanded|readsInSheet/, 'nothing left measuring or folding it');
  assert.match(jsx, /\{abstractText && \(\s*<button\s+type="button"\s+className="pc-abstract-link"\s+aria-haspopup="dialog"\s+onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*setShowAbstractSheet\(true\);\s*\}\}\s*>/);
  assert.match(jsx, /\{'Read abstract'\}/);
  assert.match(jsx, /\{showAbstractSheet && \(\s*<AbstractSheet paper=\{paper\} onClose=\{closeAbstractSheet\} \/>\s*\)\}/);
});

test('the reading sheet is a bottom drawer that arrives, scrolls inside and leaves before it unmounts', async () => {
  const jsx = stripComments(await read('./AbstractSheet.jsx'));
  assert.match(jsx, /const \{ open, requestClose \} = usePopupOpenOnMount\(\);/);
  assert.match(jsx, /onOpenChange=\{\(next\) => \{ if \(!next\) requestClose\(\); \}\}/);
  assert.match(jsx, /onOpenChangeComplete=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/);
  assert.match(jsx, /<DrawerBody className="abstract-sheet-body" data-base-ui-swipe-ignore>/);
  assert.match(jsx, /<ScientificText>\{paper\.abstract\}<\/ScientificText>/);
  assert.match(jsx, /initialFocus=\{closeRef\}/);
  const css = stripComments(await read('./AbstractSheet.css'));
  assert.match(css, /\.abstract-sheet-body p \{[^}]*font-family: var\(--font-serif\);[^}]*font-size: 1\.0625rem;[^}]*line-height: 1\.72;/);
  assert.match(css, /\.abstract-sheet-body \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/);
});
