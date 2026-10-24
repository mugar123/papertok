import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string | URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

// PaperCard cannot be mounted under Node; the feed tests cover when a card is
// loading, and this pins what the card then says.
test('SOURCE: a card whose abstract is on its way says so, then crosses to the text or to "No abstract available"', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  const missing = jsx.indexOf("title={'No abstract available'}");
  assert.ok(missing > 0, 'a card without an abstract says so in the words the status region speaks');
  const faces = jsx.slice(jsx.indexOf('{abstractText ? ('), missing);
  assert.match(faces, /\) : abstractLoading \? \(/, 'the loading face comes before the missing-abstract face');
  assert.match(faces, /title=\{'Loading abstract'\}/);
  assert.match(jsx, /: abstractLoading \? 'abstract:loading' : 'abstract:none'/,
    'each face has its own key, so the change cross-fades instead of swapping in place');
});

// A live region that is removed, or inserted already holding its words, is
// not reliably spoken, so the faces above cannot carry the status themselves.
// What the region says is tested with its rules in utils/feedAbstractWait.test.ts.
test('SOURCE: one region mounted with the card speaks the wait and how it ended', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  const slotStart = jsx.indexOf('<div ref={slotRef}');
  const actions = jsx.indexOf('<div className="pc-action-bar">', slotStart);
  const faces = jsx.slice(slotStart, jsx.lastIndexOf('</AnimatePresence>', actions));
  assert.doesNotMatch(faces, /role=/, 'the faces that come and go have no live role');
  assert.match(jsx.slice(slotStart, actions), /<\/AnimatePresence>\s*<\/div>\s*<\/div>\s*(?:\{\}\s*)?<span className="visually-hidden" role="status">\{abstractStatus\}<\/span>/);
  assert.match(jsx, /const abstractStatus = abstractStatusText\(/);
});
