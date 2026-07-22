import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
  needsOpenAlexEnrichment,
  takeFeedPage,
  waitForInitialEnrichment,
} from './feedEnrichment.js';

test('normalizes arXiv versions for OpenAlex enrichment', () => {
  assert.equal(getOpenAlexEnrichmentId('arxiv:2607.12345v2'), '2607.12345');
  assert.equal(getOpenAlexEnrichmentId({ id: 'W123' }), 'openalex:W123');
  assert.equal(getOpenAlexEnrichmentId({ id: 'openalex:W123' }), 'openalex:W123');
  assert.equal(getOpenAlexEnrichmentId({ id: '', arxivId: '2607.54321v3' }), '2607.54321');
  assert.equal(getOpenAlexEnrichmentId({ id: '10.1000/example', arxivId: '2607.54321v3' }), '2607.54321');
});

test('does not request duplicate enrichment for native OpenAlex papers', () => {
  assert.equal(needsOpenAlexEnrichment({
    id: 'openalex:W123',
    sources: { primary: 'openalex', enrichedBy: [] },
  }), false);
  assert.equal(needsOpenAlexEnrichment({
    id: '2607.12345',
    sources: { primary: 'arxiv', enrichedBy: [] },
  }), true);
  assert.equal(needsOpenAlexEnrichment({
    id: '2607.12345',
    sources: { primary: 'arxiv', enrichedBy: ['openalex'] },
  }), false);
  assert.equal(needsOpenAlexEnrichment({ id: 'pmid:12345' }), false);
});

test('caps every visible feed page before OpenAlex enrichment', () => {
  const candidates = Array.from({ length: 47 }, (_, index) => ({ id: `2607.${String(index).padStart(5, '0')}` }));
  const page = takeFeedPage(candidates, 15);

  assert.equal(page.length, 15);
  assert.equal(page[14].id, '2607.00014');
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
