import test from 'node:test';
import assert from 'node:assert/strict';
import { PubmedAdapter, classifyPubmedCategory } from './adapters/PubmedAdapter.js';

test('classifies PubMed papers using title, abstract, and MeSH-style subjects', () => {
  const category = classifyPubmedCategory({
    title: 'Cardiac arrhythmia after myocardial infarction',
    abstract: 'A clinical study of cardiovascular outcomes.',
    categories: ['Heart Diseases', 'Cardiology'],
  }, ['med.onco', 'med.cardio', 'med.neuro']);

  assert.equal(category, 'med.cardio');
});

test('does not invent a random PubMed category for ambiguous papers', () => {
  const category = classifyPubmedCategory({
    title: 'A multicenter observational study',
    abstract: 'Results from several participating institutions.',
    categories: [],
  }, ['med.onco', 'med.cardio']);

  assert.equal(category, null);
});

test('trusts the query category when PubMed was searched for one subcategory', () => {
  const category = classifyPubmedCategory({ title: 'Sparse metadata record' }, ['bio.micro']);
  assert.equal(category, 'bio.micro');
});

test('maps PubMed access using the canonical openAccess field', () => {
  const adapter = new PubmedAdapter();
  const closedPaper = adapter.mapToStandard({ uid: '1', title: 'Closed', articleids: [] });
  const pmcPaper = adapter.mapToStandard({
    uid: '2',
    title: 'Open',
    articleids: [{ idtype: 'pmc', value: 'PMC2' }],
  });

  assert.equal(closedPaper.openAccess, false);
  assert.equal(pmcPaper.openAccess, true);
  assert.equal(closedPaper.isOpenAccess, undefined);
});

// The three E-utilities requests this adapter used to make left the browser
// directly, with no abort signal and no NCBI key, so readers behind one NAT
// rate-limited each other. They now go to the Worker as one call. Nothing below
// asserts the mapping -- that is unchanged on purpose -- only where the bytes
// come from.

function recordingGlobalFetch(recorded) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalError = console.error;
  globalThis.fetch = async input => {
    recorded.push(String(input?.url || input));
    return new Response('{}', { status: 500 });
  };
  console.warn = () => {};
  console.error = () => {};
  return () => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

test('reads PubMed through the Worker route instead of calling NCBI from the browser', async () => {
  const escaped = [];
  const workerCalls = [];
  const restore = recordingGlobalFetch(escaped);
  try {
    const adapter = new PubmedAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async url => {
        workerCalls.push(String(url));
        return new Response(JSON.stringify({
          esearchresult: { count: '2', idlist: ['31000001'] },
          result: { 31000001: { uid: '31000001', title: 'One', articleids: [] } },
          // Deliberately empty: parsing it needs `DOMParser`, which is a browser
          // API, and the enrichment it feeds is optional by design.
          efetch: '',
          _papertok: { efetch: 'unavailable' },
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    const result = await adapter.search('malaria', 2, { type: 'author' });

    assert.equal(result.total, 2);
    assert.equal(result.papers[0].id, 'pmid:31000001');
    assert.equal(workerCalls.length, 1);
    const requested = new URL(workerCalls[0]);
    assert.equal(requested.pathname, '/sources/pubmed');
    assert.equal(requested.searchParams.get('q'), 'malaria[Author]');
    assert.equal(requested.searchParams.get('page'), '2');
    assert.equal(requested.searchParams.get('limit'), '25');
  } finally {
    restore();
  }

  // Enrichment may still reach OpenAlex and Europe PMC; what must never happen
  // again is a browser talking to E-utilities.
  const toNcbi = escaped.filter(url => url.includes('eutils.ncbi.nlm.nih.gov'));
  assert.deepEqual(toNcbi, [], `PubMed was still called directly: ${toNcbi.join(', ')}`);
});

test('carries a deadline on the PubMed request', async () => {
  const escaped = [];
  const restore = recordingGlobalFetch(escaped);
  let seenSignal;
  try {
    const adapter = new PubmedAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async (_url, options) => {
        seenSignal = options?.signal;
        return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await adapter.search('malaria', 1);
  } finally {
    restore();
  }

  assert.ok(seenSignal, 'the PubMed request reaches the Worker with no AbortSignal');
  assert.equal(seenSignal.aborted, false);
});
