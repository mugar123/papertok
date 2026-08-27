import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCitationGraph,
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
    degraded: true,
  });
  assert.equal(graph.references[0].title, 'Reference');
  assert.equal(graph.citations[0].doi, '10.1000/cite');
  assert.deepEqual(graph.counts, { references: 42, citations: 7 });
  assert.equal(graph.partial, true);
  assert.equal(graph.degraded, true);
});

test('a payload that never mentions degradation is not treated as degraded', () => {
  const graph = mapCitationGraphPayload({ counts: { references: 3, citations: 0 } });
  assert.equal(graph.degraded, false);
  assert.equal(graph.partial, false);
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

/**
 * StrictMode mounts a component, tears it down and mounts it again, so the
 * sheet asks for the same neighbourhood twice within the same millisecond —
 * observed against the deployed Worker, two identical requests at t=27319.
 *
 * `/citation-graph` reserves nine OpenAlex calls per request, so serving that
 * pair upstream twice is not free, and the second view must still be handed the
 * answer: the run that started the request is the one StrictMode tears down.
 */
function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

const GRAPH_PAYLOAD = {
  references: [{ id: '10.1000/ref', doi: '10.1000/ref', title: 'Reference', year: 2019 }],
  citations: [],
  counts: { references: 12, citations: 0 },
  source: 'opencitations',
};

test('two views asking for the same neighbourhood share one request', async () => {
  let calls = 0;
  const workerFetch = async () => {
    calls += 1;
    await new Promise(resolve => { setTimeout(resolve, 0); });
    return jsonResponse(GRAPH_PAYLOAD);
  };
  const paper = { doi: '10.1000/shared-flight' };
  const dependencies = { authenticatedWorkerFetch: workerFetch, apiBase: 'https://worker.example' };

  const [first, second] = await Promise.all([
    getCitationGraph(paper, 8, dependencies),
    getCitationGraph(paper, 8, dependencies),
  ]);

  assert.equal(calls, 1, 'the neighbourhood was fetched twice');
  assert.equal(first, second, 'the second view got a different object');
  assert.equal(first.counts.references, 12);
});

test('a neighbourhood that failed is asked for again', async () => {
  let calls = 0;
  const workerFetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return jsonResponse(GRAPH_PAYLOAD);
  };
  const paper = { doi: '10.1000/retry-me' };
  const dependencies = { authenticatedWorkerFetch: workerFetch, apiBase: 'https://worker.example' };

  await assert.rejects(getCitationGraph(paper, 8, dependencies));
  const recovered = await getCitationGraph(paper, 8, dependencies);

  assert.equal(calls, 2, 'the failure was remembered instead of retried');
  assert.equal(recovered.counts.references, 12);
});
