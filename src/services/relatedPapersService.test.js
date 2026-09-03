import test from 'node:test';
import assert from 'node:assert/strict';
import { getSemanticScholarPaperId } from './relatedPapersService.js';

test('prefers DOI and normalizes provider prefixes for related papers', () => {
  assert.equal(getSemanticScholarPaperId({ doi: 'https://doi.org/10.1000/TEST', arxivId: '1234.5' }), 'DOI:10.1000/TEST');
  assert.equal(getSemanticScholarPaperId({ arxivId: '2607.12345v2' }), 'ARXIV:2607.12345');
  assert.equal(getSemanticScholarPaperId({}), null);
});

import { clearRelatedPapersCache, getRelatedPapers } from './relatedPapersService.js';

const WORKER = 'https://papertok-report-api.example';

function twentyRecommendations() {
  return new Response(JSON.stringify({
    recommendedPapers: Array.from({ length: 20 }, (_, index) => ({
      paperId: `s2-${index}`,
      title: `Paper ${index}`,
      externalIds: { ArXiv: `2601.${String(index).padStart(5, '0')}` },
      authors: [],
    })),
  }), { headers: { 'content-type': 'application/json' } });
}

test('asks the Worker once per paper and trims locally whatever limit each caller wants', async () => {
  clearRelatedPapersCache();
  const asked = [];
  const fetchWorker = async url => { asked.push(new URL(url)); return twentyRecommendations(); };
  const paper = { id: 'arxiv:2607.12345', arxivId: '2607.12345' };

  const forFeed = await getRelatedPapers(paper, 20, { fetchWorker, apiBase: WORKER });
  const forSheet = await getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER });

  assert.equal(asked.length, 1, 'the sheet must be served from the feed\'s entry');
  // `limit` no longer travels: on the Worker it was a second cache key for the
  // same list, and at one request a second a second miss is a refusal.
  assert.equal(asked[0].searchParams.has('limit'), false);
  assert.equal(forFeed.length, 20);
  assert.equal(forSheet.length, 8);
  assert.deepEqual(forSheet, forFeed.slice(0, 8));
});

test('shares one request between two callers that ask for the same paper at once', async () => {
  clearRelatedPapersCache();
  let calls = 0;
  const fetchWorker = async () => { calls += 1; return twentyRecommendations(); };
  const paper = { id: 'arxiv:2607.12345', arxivId: '2607.12345' };

  // The cache only fills once the answer is in, so two callers in the same tick
  // were two Worker calls and two provider calls in the same second -- at one
  // request a second, the second is a refusal by construction. It happens: the
  // feed asks on like, save, PDF-open and ten seconds of dwell, the sheet can
  // open in that same second, and StrictMode mounts the sheet twice in dev.
  const [forSheet, forSheetAgain] = await Promise.all([
    getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER }),
    getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER }),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(forSheetAgain, forSheet);
});

test('does not remember a failed request as the paper\'s answer', async () => {
  clearRelatedPapersCache();
  let calls = 0;
  const fetchWorker = async () => {
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 429 });
    return twentyRecommendations();
  };
  const paper = { id: 'arxiv:2607.12345', arxivId: '2607.12345' };

  await assert.rejects(() => getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER }), /429/);
  const related = await getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER });

  assert.equal(calls, 2, 'the failure must not stay in flight, or in the cache');
  assert.equal(related.length, 8);
});
