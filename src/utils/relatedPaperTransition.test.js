import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelatedPaperEntries,
  getRelatedPaperIdentity,
} from './relatedPaperTransition.js';

test('prefers normalized stable identifiers for related paper identity', () => {
  assert.equal(
    getRelatedPaperIdentity({
      id: 'openalex:W1',
      doi: 'https://doi.org/10.1000/EXAMPLE',
      arxivId: '2607.12345v2',
    }),
    'doi:10.1000/example',
  );
  assert.equal(getRelatedPaperIdentity({ arxivId: 'arxiv:2607.12345v2' }), 'arxiv:2607.12345');
  assert.equal(getRelatedPaperIdentity({ openAlexId: 'https://openalex.org/W2' }), 'openalex:w2');
});

test('makes duplicate and identifier-less graph rows render with unique keys', () => {
  const entries = buildRelatedPaperEntries([
    { id: 'same', title: 'First' },
    { id: 'same', title: 'Second' },
    { title: 'No stable id' },
    { title: 'No stable id' },
    {},
  ]);

  assert.equal(new Set(entries.map(entry => entry.key)).size, entries.length);
  assert.deepEqual(entries.map(entry => entry.key), [
    'id:same#0',
    'id:same#1',
    'title:no stable id#0',
    'title:no stable id#1',
    'index:4#0',
  ]);
});
