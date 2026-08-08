import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCitationGraphDoi,
  hydrateCitationGraphPaper,
  mapCitationGraphPayload,
} from './citationGraphService.js';

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

test('hydrates a graph paper before display while retaining its stable identity', async () => {
  const paper = mapCitationGraphPayload({
    references: [{
      id: 'graph-record',
      doi: '10.1000/ref',
      title: 'Reference',
      abstract: 'Resumen no disponible.',
      openAccess: false,
    }],
  }).references[0];
  const hydrated = await hydrateCitationGraphPaper(paper, {
    fetchPapersByDois: async () => [{
      id: 'W123',
      doi: 'https://doi.org/10.1000/ref',
      abstract: 'A sourced OpenAlex abstract.',
      journal: 'Journal of Tests',
      openAccess: false,
      sources: { primary: 'openalex', enrichedBy: [] },
    }],
    findOpenAccessCopy: async () => null,
  });

  assert.equal(hydrated.id, 'graph-record');
  assert.equal(hydrated.abstract, 'A sourced OpenAlex abstract.');
  assert.equal(hydrated.journal, 'Journal of Tests');
  assert.equal(hydrated.openAccess, false);
  assert.equal(hydrated.citationMetadataResolved, true);
  assert.deepEqual(hydrated.sources.enrichedBy, ['openalex']);
});

test('merges only confirmed open-access metadata and never invents an abstract', async () => {
  const paper = {
    id: '10.1000/ref',
    doi: '10.1000/ref',
    title: 'Reference',
    abstract: 'No abstract available.',
    openAccess: false,
    sources: { primary: 'opencitations', enrichedBy: [] },
  };
  const hydrated = await hydrateCitationGraphPaper(paper, {
    fetchPapersByDois: async () => [{
      doi: '10.1000/ref',
      abstract: 'Resumen no disponible.',
      openAccess: false,
    }],
    findOpenAccessCopy: async () => ({
      pdfUrl: 'https://repository.example/ref.pdf',
      accessSource: 'unpaywall',
      license: 'cc-by',
    }),
  });

  assert.equal(hydrated.abstract, 'No abstract available.');
  assert.equal(hydrated.openAccess, true);
  assert.equal(hydrated.openAccessPdfUrl, 'https://repository.example/ref.pdf');
  assert.equal(hydrated.accessSource, 'unpaywall');
  assert.deepEqual(hydrated.sources.enrichedBy, ['openalex', 'unpaywall']);
});
