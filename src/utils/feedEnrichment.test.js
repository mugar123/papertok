import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
  waitForInitialEnrichment,
} from './feedEnrichment.js';

test('normalizes arXiv versions for OpenAlex enrichment', () => {
  assert.equal(getOpenAlexEnrichmentId('arxiv:2607.12345v2'), '2607.12345');
  assert.equal(getOpenAlexEnrichmentId({ id: 'W123' }), 'openalex:W123');
  assert.equal(getOpenAlexEnrichmentId({ id: 'openalex:W123' }), 'openalex:W123');
});

test('merges OpenAlex metadata before a feed batch is displayed', () => {
  const papers = [{
    id: 'arxiv:2607.12345v1',
    title: 'Paper',
    citationCount: 0,
    citationCountKnown: false,
    concepts: [],
    sources: { primary: 'arxiv', enrichedBy: [] },
  }];
  const merged = mergeOpenAlexEnrichment(papers, {
    '2607.12345': {
      citationCount: 0,
      citationCountKnown: true,
      concepts: [{ id: 'C1', display_name: 'Cosmology' }],
    },
  });

  assert.equal(merged[0].citationCountKnown, true);
  assert.equal(merged[0].concepts[0].display_name, 'Cosmology');
  assert.deepEqual(merged[0].sources.enrichedBy, ['openalex']);
});

test('stops waiting when initial enrichment exceeds its budget', async () => {
  const result = await waitForInitialEnrichment(new Promise(() => {}), 5);
  assert.equal(result, null);
});
