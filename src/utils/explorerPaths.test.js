import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorExplorerPath, openAlexAuthorId } from './explorerPaths.js';

test('an author with an OpenAlex id opens by id, name riding along for the masthead', () => {
  assert.equal(
    authorExplorerPath({ name: 'Ada Lovelace', id: 'https://openalex.org/A5023888391' }, 'openalex:W1'),
    '/explorer/author/A5023888391?name=Ada%20Lovelace',
  );
  assert.equal(authorExplorerPath({ name: 'Ada', id: 'a5023888391' }, 'x'), '/explorer/author/A5023888391?name=Ada', 'a bare id, any case');
  assert.equal(openAlexAuthorId({ id: 'https://openalex.org/I123' }), '', 'an institution id is not an author');
});

test('an author without an id keeps the name door, with the arXiv id the explorer matches on', () => {
  assert.equal(authorExplorerPath({ name: 'Grace Hopper' }, 'arxiv:2401.12345'), '/explorer/author/Grace%20Hopper?arxivId=2401.12345');
  assert.equal(authorExplorerPath('Grace Hopper', '2401.12345'), '/explorer/author/Grace%20Hopper?arxivId=2401.12345', 'a plain string author');
  assert.equal(authorExplorerPath({ name: '' }, 'x'), '', 'nothing to open');
});

test('signed out, the public entity page gets the id when there is one, and the name beside it', () => {
  assert.equal(
    authorExplorerPath({ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }, 'x', { publicMode: true }),
    '/public/entity/author/A1?name=Ada%20Lovelace',
  );
  assert.equal(authorExplorerPath({ name: 'Ada Lovelace' }, 'x', { publicMode: true }), '/public/entity/author/Ada%20Lovelace');
});

test('SOURCE: every author link on the card goes through the helper', async () => {
  const jsx = await readFile(new URL('../components/Feed/PaperCard.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(jsx, /\/explorer\/author\/\$\{encodeURIComponent\(/, 'no card builds a name-only author path by hand anymore');
  assert.ok((jsx.match(/authorExplorerPath\(/g) || []).length >= 2, 'both author lists use it');
});
