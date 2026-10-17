import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPersonalCandidates,
  personalRecommendationRequest,
  semanticScholarExampleId,
} from './personalRecommendationsService.ts';

const WORKER = 'https://papertok-report-api.example';

test('a feed paper is named the way Semantic Scholar knows it, or not at all', () => {
  // The ids the feed's sources actually give their papers.
  assert.equal(semanticScholarExampleId('2401.12345v3'), 'ARXIV:2401.12345');
  assert.equal(semanticScholarExampleId('hep-th/0603001'), 'ARXIV:hep-th/0603001');
  assert.equal(semanticScholarExampleId('arxiv:2401.12345'), 'ARXIV:2401.12345');
  assert.equal(semanticScholarExampleId('pmid:38012345'), 'PMID:38012345');
  assert.equal(semanticScholarExampleId('10.5281/zenodo.1234567'), 'DOI:10.5281/zenodo.1234567');
  assert.equal(semanticScholarExampleId('crossref:10.1038/s41586-024-07000-1'), 'DOI:10.1038/s41586-024-07000-1');
  assert.equal(semanticScholarExampleId('biorxiv:10.1101%2F2024.01.02.573000:v2'), 'DOI:10.1101/2024.01.02.573000');
  assert.equal(semanticScholarExampleId('B'.repeat(40)), 'b'.repeat(40));
  assert.equal(semanticScholarExampleId('openalex:W4391234567'), null);
  assert.equal(semanticScholarExampleId('core:123456'), null);
  // Past the Worker's limits, where one such id would refuse the whole request.
  assert.equal(semanticScholarExampleId(`10.1000/${'x'.repeat(250)}`), null);
  assert.equal(semanticScholarExampleId('pmid:1234567890123'), null);
});

test('a load asks about one interest: its newest examples and the newest rejections', () => {
  const positives = [
    { id: '2401.00009', category: 'astro-ph.GA' },
    { id: '2401.00008v2', category: 'cs.LG' },
    { id: 'openalex:W1', category: 'cs.LG' },
    { id: '2401.00007', category: 'cs.LG' },
    { id: '2401.00006', category: 'astro-ph.GA' },
  ];
  const negatives = ['2401.10000', 'openalex:W2'];

  // Four examples Semantic Scholar can be asked about: the draw lands on one.
  assert.deepEqual(personalRecommendationRequest(positives, negatives, () => 0), {
    positive: ['ARXIV:2401.00009', 'ARXIV:2401.00006'],
    negative: ['ARXIV:2401.10000'],
  });
  assert.deepEqual(personalRecommendationRequest(positives, negatives, () => 0.4), {
    positive: ['ARXIV:2401.00008', 'ARXIV:2401.00007'],
    negative: ['ARXIV:2401.10000'],
  });
  assert.equal(personalRecommendationRequest([{ id: 'openalex:W1', category: 'cs.LG' }], negatives), null);
});

test('the Worker is asked once and only usable ids come back', async () => {
  const sent: Array<{ url: string; method?: string; body: unknown }> = [];
  const fetchWorker = async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({
      papers: [{ arxivId: '2501.00001', doi: null }, { arxivId: null, doi: null }, { arxivId: null, doi: '10.1/b' }],
    }), { headers: { 'content-type': 'application/json' } });
  };
  const request = { positive: ['ARXIV:2401.00001'], negative: [] };

  const candidates = await fetchPersonalCandidates(request, { fetchWorker, apiBase: WORKER });

  assert.deepEqual(sent, [{ url: `${WORKER}/recommendations`, method: 'POST', body: request }]);
  assert.deepEqual(candidates, [{ arxivId: '2501.00001', doi: null }, { arxivId: null, doi: '10.1/b' }]);
});

test('a refused or failed request leaves the feed with nothing from this source', async () => {
  const request = { positive: ['ARXIV:2401.00001'], negative: [] };
  const refused = async () => new Response(JSON.stringify({ code: 'UPSTREAM_RATE_LIMITED' }), { status: 429 });
  const offline = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };

  assert.deepEqual(await fetchPersonalCandidates(request, { fetchWorker: refused, apiBase: WORKER }), []);
  assert.deepEqual(await fetchPersonalCandidates(request, { fetchWorker: offline, apiBase: WORKER }), []);
  assert.deepEqual(await fetchPersonalCandidates(null, { fetchWorker: refused, apiBase: WORKER }), []);
});
