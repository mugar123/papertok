import test from 'node:test';
import assert from 'node:assert/strict';
import { mapICitePublication, mergeICiteEnrichment } from './iCiteService.js';

test('maps confirmed NIH iCite zero citations separately from unknown metadata', () => {
  const metrics = mapICitePublication({
    pmid: 123456,
    doi: 'https://doi.org/10.1000/Example',
    citation_count: 0,
    relative_citation_ratio: null,
    nih_percentile: 17.5,
    apt: 0.2,
    is_clinical: false,
    provisional: true,
  });

  assert.equal(metrics.pmid, '123456');
  assert.equal(metrics.doi, '10.1000/example');
  assert.equal(metrics.citationCount, 0);
  assert.equal(metrics.citationCountKnown, true);
  assert.equal(metrics.iciteMetrics.relativeCitationRatio, null);
  assert.equal(metrics.iciteMetrics.nihPercentile, 17.5);
});

test('merges iCite metrics only into the matching PubMed paper', () => {
  const papers = [
    { id: 'pmid:1', pmid: '1', title: 'Matched', sources: { primary: 'pubmed', enrichedBy: [] } },
    { id: 'arxiv:1', title: 'Unmatched', sources: { primary: 'arxiv', enrichedBy: [] } },
  ];
  const merged = mergeICiteEnrichment(papers, {
    1: { pmid: '1', citationCount: 9, citationCountKnown: true, iciteMetrics: { nihPercentile: 80 } },
  });

  assert.equal(merged[0].citationCount, 9);
  assert.equal(merged[0].iciteMetrics.nihPercentile, 80);
  assert.ok(merged[0].sources.enrichedBy.includes('icite'));
  assert.equal(merged[1], papers[1]);
});

test('paper identity survives a late iCite merge that adds nothing new', () => {
  // Same identity contract as mergeOpenAlexEnrichment (src/utils/feedEnrichment.js):
  // a record that exists but changes no field must still return the original
  // object, or memo(PaperCard) and its IntersectionObserver (keyed on `paper`)
  // get torn down for a card whose content never actually moved.
  const untouched = {
    id: 'arxiv:1', pmid: '', title: 'No pmid', sources: { primary: 'arxiv', enrichedBy: [] },
  };
  const realChange = {
    id: 'pmid:2', pmid: '2', title: 'Real change', citationCount: 0, citationCountKnown: false,
    sources: { primary: 'pubmed', enrichedBy: [] },
  };
  const noopChange = {
    id: 'pmid:3',
    pmid: '3',
    title: 'No-op change',
    citationCount: 9,
    citationCountKnown: true,
    // A separate object from the enrichment payload below (fresh API
    // payload) but equal in every value — the case a reference check misses.
    iciteMetrics: { nihPercentile: 80 },
    sources: { primary: 'pubmed', enrichedBy: ['icite'] },
    hasReferences: false,
    hasData: false,
    hasSupplement: false,
    peerReviewed: false,
  };

  const result = mergeICiteEnrichment([untouched, realChange, noopChange], {
    2: { citationCount: 9, citationCountKnown: true },
    3: { citationCount: 9, citationCountKnown: true, iciteMetrics: { nihPercentile: 80 } },
  });

  assert.ok(Object.is(result[0], untouched), 'no pmid match: same object');
  assert.ok(!Object.is(result[1], realChange), 'record with new data: different object');
  assert.equal(result[1].citationCount, 9);
  assert.ok(Object.is(result[2], noopChange), 'record present but changes nothing: same object');
});
