import test from 'node:test';
import assert from 'node:assert/strict';
import { getCitationGraphDoi, mapCitationGraphPayload } from './citationGraphService.js';

test('requires a valid DOI before requesting a citation graph', () => {
  assert.equal(getCitationGraphDoi({ doi: 'https://doi.org/10.1000/TEST' }), '10.1000/test');
  assert.equal(getCitationGraphDoi({ arxivId: '2607.12345' }), '');
  assert.equal(getCitationGraphDoi({ doi: 'not-a-doi' }), '');
});

test('maps graph payloads to stable PaperTok papers and preserves counts', () => {
  const graph = mapCitationGraphPayload({
    references: [{ id: '10.1000/ref', doi: '10.1000/ref', title: 'Reference', year: 2020 }],
    citations: [{ id: '10.1000/cite', doi: '10.1000/cite', title: 'Citation', year: 2025 }],
    counts: { references: 42, citations: 7 },
    source: 'opencitations+openalex',
    partial: true,
  });
  assert.equal(graph.references[0].title, 'Reference');
  assert.equal(graph.citations[0].doi, '10.1000/cite');
  assert.deepEqual(graph.counts, { references: 42, citations: 7 });
  assert.equal(graph.partial, true);
});
