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
