import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string | URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

// PaperCard cannot be mounted under Node; the feed tests cover when a card is
// loading, and this pins what the card then says.
test('SOURCE: a card whose abstract is on its way says so as a status, then crosses to the text or to "No abstract"', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  const faces = jsx.slice(jsx.indexOf('{abstractText ? ('), jsx.indexOf("title={'No abstract'}"));
  assert.match(faces, /\) : abstractLoading \? \(/, 'the loading face comes before the missing-abstract face');
  assert.match(faces, /role="status"[\s\S]*title=\{'Loading abstract'\}/);
  assert.match(jsx, /: abstractLoading \? 'abstract:loading' : 'abstract:none'/,
    'each face has its own key, so the change cross-fades instead of swapping in place');
});
