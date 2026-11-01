import assert from 'node:assert/strict';
import test from 'node:test';
import { withStubbedFetch } from '../src/test-support/deadline-harness.ts';
import { fetchFullText, normalizeFullTextRequest } from './full-text.ts';

// Synthetic documents, trimmed to the markers each provider's real answer carries.
const LATEXML = '<html><body><article class="ltx_document"><h1 class="ltx_title ltx_title_document">T</h1></article></body></html>';
const NOT_CONVERTED = '<html><body><p>No HTML for this paper.</p></body></html>';
const JATS = '<?xml version="1.0"?><article><front><article-meta/></front><body><sec><title>Introduction</title></sec></body></article>';

const params = (query: Record<string, string>) => new URLSearchParams(query);

function upstream(answers: Record<string, () => Response>) {
  const calls: string[] = [];
  const stub = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    const answer = Object.entries(answers).find(([prefix]) => url.startsWith(prefix));
    return answer ? answer[1]() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, stub };
}

test('keeps only well-formed identifiers, in the form sent upstream', () => {
  assert.deepEqual(
    normalizeFullTextRequest(params({ arxiv_id: 'arXiv:1706.03762v7', pmcid: 'pmc1762328', doi: 'https://doi.org/10.1371/Journal.PONE.0000001' })),
    { arxivId: '1706.03762', fullTextId: 'PMC1762328', doi: '10.1371/journal.pone.0000001' },
  );
  assert.deepEqual(
    normalizeFullTextRequest(params({ arxiv_id: '../etc', pmcid: 'PPR1326190' })),
    { arxivId: '', fullTextId: 'PPR1326190', doi: '' },
  );
  assert.equal(normalizeFullTextRequest(params({ arxiv_id: 'x', pmcid: 'PMC12/../1', doi: 'not-a-doi' })), null);
  assert.equal(normalizeFullTextRequest(params({})), null);
});

test('answers with arXiv\'s own HTML when it has converted the paper', async () => {
  const { calls, stub } = upstream({ 'https://arxiv.org/html/': () => new Response(LATEXML) });
  const answer = await withStubbedFetch(stub, () => fetchFullText({ arxivId: '1706.03762', fullTextId: '', doi: '' }));

  assert.equal(answer.source, 'arxiv');
  assert.equal(answer.format, 'latexml');
  assert.equal(answer.document, LATEXML);
  assert.deepEqual(calls, ['https://arxiv.org/html/1706.03762']);
});

test('falls back to ar5iv when arXiv answers with a page that is not a conversion', async () => {
  const { calls, stub } = upstream({
    'https://arxiv.org/html/': () => new Response(NOT_CONVERTED),
    'https://ar5iv.labs.arxiv.org/html/': () => new Response(LATEXML),
  });
  const answer = await withStubbedFetch(stub, () => fetchFullText({ arxivId: 'hep-th/9901001', fullTextId: '', doi: '' }));

  assert.equal(answer.source, 'ar5iv');
  assert.equal(answer.document, LATEXML);
  assert.equal(calls.length, 2);
});

test('finds an open article in Europe PMC by DOI and keeps its licence', async () => {
  const { calls, stub } = upstream({
    'https://www.ebi.ac.uk/europepmc/webservices/rest/search': () => Response.json({
      resultList: { result: [{ isOpenAccess: 'Y', pmcid: 'PMC1762328', license: 'cc by', fullTextIdList: { fullTextId: ['PMC1762328'] } }] },
    }),
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1762328/fullTextXML': () => new Response(JATS),
  });
  const answer = await withStubbedFetch(stub, () => fetchFullText({ arxivId: '', fullTextId: '', doi: '10.1371/journal.pone.0000001' }));

  assert.deepEqual(answer, {
    source: 'europepmc',
    format: 'jats',
    url: 'https://europepmc.org/article/PMC/PMC1762328',
    fullTextId: 'PMC1762328',
    license: 'cc by',
    document: JATS,
  });
  assert.equal(new URL(calls[0]).searchParams.get('query'), 'DOI:"10.1371/journal.pone.0000001"');
});

test('does not ask for the full text of an article Europe PMC does not list as open', async () => {
  const { calls, stub } = upstream({
    'https://www.ebi.ac.uk/europepmc/webservices/rest/search': () => Response.json({
      resultList: { result: [{ isOpenAccess: 'N', pmcid: 'PMC2000000' }] },
    }),
  });
  const answer = await withStubbedFetch(stub, () => fetchFullText({ arxivId: '', fullTextId: '', doi: '10.1000/closed' }));

  assert.equal(answer.document, null);
  assert.equal(calls.length, 1);
});

test('reads a preprint by its Europe PMC identifier and tries arXiv first when both are known', async () => {
  const { calls, stub } = upstream({
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PPR1326190/fullTextXML': () => new Response(JATS),
  });
  const answer = await withStubbedFetch(stub, () => fetchFullText({ arxivId: '2401.00001', fullTextId: 'PPR1326190', doi: '' }));

  assert.equal(answer.source, 'europepmc');
  assert.equal(answer.url, 'https://europepmc.org/article/PPR/PPR1326190');
  assert.deepEqual(calls.map(url => new URL(url).host), ['arxiv.org', 'ar5iv.labs.arxiv.org', 'www.ebi.ac.uk']);
});

test('a provider that fails leaves no document and says the absence is not established', async () => {
  const failing = (async () => { throw new TypeError('network down'); }) as typeof fetch;
  const failed = await withStubbedFetch(failing, () => fetchFullText({ arxivId: '1706.03762', fullTextId: 'PMC1762328', doi: '' }));
  assert.deepEqual(failed, { source: null, format: null, url: null, document: null, unavailable: true });

  const { stub } = upstream({
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML': () => new Response('error', { status: 500 }),
  });
  const refused = await withStubbedFetch(stub, () => fetchFullText({ arxivId: '', fullTextId: 'PMC1', doi: '' }));
  assert.equal(refused.document, null);
  assert.equal(refused.unavailable, true);
});

test('a paper no provider has is a confirmed absence, and a failing renderer still leaves the other to answer', async () => {
  const { stub } = upstream({});
  const absent = await withStubbedFetch(stub, () => fetchFullText({ arxivId: '2401.00001', fullTextId: '', doi: '' }));
  assert.deepEqual(absent, { source: null, format: null, url: null, document: null });

  const { stub: arxivDown } = upstream({
    'https://arxiv.org/html/': () => new Response('busy', { status: 503 }),
    'https://ar5iv.labs.arxiv.org/html/': () => new Response(LATEXML),
  });
  const fromAr5iv = await withStubbedFetch(arxivDown, () => fetchFullText({ arxivId: '2401.00001', fullTextId: '', doi: '' }));
  assert.equal(fromAr5iv.source, 'ar5iv');
});
