import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelatedPaperEntries,
  getRelatedPaperIdentity,
  stepRelatedPaperTrail,
} from './related-paper-transition.ts';

test('centring on a paper already on the trail cuts the trail back to it', () => {
  const start = { doi: '10.1000/p' };
  const reference = { doi: '10.1000/r' };
  const trail = stepRelatedPaperTrail([start], reference);
  assert.deepEqual(trail, [start, reference]);
  // P cites R, so P is among R's citations; centring on it returns to P.
  assert.deepEqual(stepRelatedPaperTrail(trail, { doi: 'https://doi.org/10.1000/P' }), [start]);
  assert.deepEqual(stepRelatedPaperTrail(trail, { doi: '10.1000/q' }), [start, reference, { doi: '10.1000/q' }]);
});

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
