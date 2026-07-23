import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateCitationGraphPapers,
  extractCitationDoi,
  extractCitationOpenAlexId,
  normalizeCitationDoi,
  normalizeCitationRows,
} from './citationGraph.js';

test('normalizes DOI URLs and extracts identifiers from OpenCitations rows', () => {
  assert.equal(normalizeCitationDoi('https://doi.org/10.1000/TEST.1'), '10.1000/test.1');
  const identifiers = 'omid:br/1 doi:10.7717/peerj-cs.421 openalex:W3134956838 pmid:33817056';
  assert.equal(extractCitationDoi(identifiers), '10.7717/peerj-cs.421');
  assert.equal(extractCitationOpenAlexId(identifiers), 'W3134956838');
});

test('normalizes and deduplicates citation relationships', () => {
  const rows = [
    { cited: 'omid:1 doi:10.1000/A openalex:W1', creation: '2024-01-01' },
    { cited: 'omid:2 doi:10.1000/A openalex:W1', creation: '2024-01-01' },
    { cited: 'omid:3 doi:10.1000/CURRENT openalex:W2', creation: '2024-01-01' },
  ];
  assert.deepEqual(normalizeCitationRows(rows, 'reference', '10.1000/current'), [{
    doi: '10.1000/a',
    openAlexId: 'W1',
    relation: 'reference',
    date: '2024-01-01',
    authorSelfCitation: false,
    journalSelfCitation: false,
  }]);
});

test('deduplicates graph papers by DOI before applying the display limit', () => {
  const papers = [
    { id: 'one', doi: '10.1000/A' },
    { id: 'two', doi: 'https://doi.org/10.1000/a' },
    { id: 'three', doi: '10.1000/B' },
  ];
  assert.deepEqual(deduplicateCitationGraphPapers(papers, 2).map(item => item.id), ['one', 'three']);
});
