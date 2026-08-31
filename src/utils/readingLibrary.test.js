import test from 'node:test';
import assert from 'node:assert/strict';
import { papersToBibTeX, papersToRIS, serializeLibraryPaper } from './readingLibrary.js';

const paper = {
  id: 'paper-1',
  title: 'A useful result',
  authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }],
  published: '2025-03-01',
  doi: '10.1234/example',
  journal: 'Journal of Tests',
};

test('serializes the metadata needed by the personal library', () => {
  const stored = serializeLibraryPaper(paper);
  assert.equal(stored.year, 2025);
  assert.equal(stored.authors.length, 2);
  assert.equal(stored.doi, '10.1234/example');
});

test('does not invent a title when the paper has none', () => {
  const stored = serializeLibraryPaper({ id: 'openalex:W1' });
  assert.equal(stored.title, '');
  assert.equal(stored.id, 'openalex:W1');
});

test('exports valid-looking BibTeX and RIS records', () => {
  const bib = papersToBibTeX([paper]);
  const ris = papersToRIS([paper]);
  assert.match(bib, /@article\{/);
  assert.match(bib, /author = \{Ada Lovelace and Alan Turing\}/);
  assert.match(ris, /TY {2}- JOUR/);
  assert.match(ris, /DO {2}- 10\.1234\/example/);
  assert.match(ris, /ER {2}-/);
});
