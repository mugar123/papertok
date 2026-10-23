import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/Paper.ts';
import {
  abstractsInFlight,
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
  needsOpenAlexEnrichment,
  preserveFeedAbstracts,
} from './feedEnrichment.ts';

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
    sources: { primary: 'openalex', enrichedBy: [] as string[] },
  }), false);
  assert.equal(needsOpenAlexEnrichment({
    id: '2607.12345',
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  }), true);
  assert.equal(needsOpenAlexEnrichment({
    id: '2607.12345',
    sources: { primary: 'arxiv', enrichedBy: ['openalex'] },
  }), false);
  assert.equal(needsOpenAlexEnrichment({ id: 'pmid:12345' }), false);
});

test('merges OpenAlex metadata before a feed batch is displayed', () => {
  const papers = [{
    id: 'arxiv:2607.12345v1',
    title: 'Paper',
    citationCount: 0,
    citationCountKnown: false,
    concepts: [] as import('../models/Paper.ts').PaperSubject[],
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  }];
  const merged = mergeOpenAlexEnrichment((papers as import('../models/Paper.ts').Paper[]), {
    '2607.12345': {
      citationCount: 0,
      citationCountKnown: true,
      concepts: [{ id: 'C1', display_name: 'Cosmology' }],
    },
  });

  assert.equal(merged[0].citationCountKnown, true);
  assert.equal(merged[0].concepts![0].display_name, 'Cosmology');
  assert.deepEqual(merged[0].sources.enrichedBy, ['openalex']);
});

test('paper identity survives a late OpenAlex merge that adds nothing new', () => {
  // Three cases distinguish "no record for this paper" from "a record that
  // changes nothing": both must return the *same* object so memo(PaperCard)
  // and its IntersectionObserver (keyed on `paper`) are not torn down for a
  // card whose content never actually moved.
  const untouched = {
    id: 'arxiv:2607.11111',
    title: 'Untouched',
    citationCount: 0,
    citationCountKnown: false,
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  };
  const realChange = {
    id: 'arxiv:2607.22222',
    title: 'Real change',
    citationCount: 0,
    citationCountKnown: false,
    sources: { primary: 'arxiv', enrichedBy: [] as string[] },
  };
  const noopChange = {
    id: 'arxiv:2607.33333',
    title: 'No-op change',
    citationCount: 12,
    citationCountKnown: true,
    sources: { primary: 'arxiv', enrichedBy: ['openalex'] },
    hasReferences: false,
    hasData: false,
    hasSupplement: false,
    peerReviewed: false,
    // PaperBuilder.merge unconditionally stamps `openAlex` with the raw
    // enrichment record it was given; this is a *different* object than the
    // one below (fresh API payload) but equal in every value, which is
    // exactly the case a reference check would miss.
    openAlex: { citationCount: 12, citationCountKnown: true },
  };

  const result = mergeOpenAlexEnrichment(([untouched, realChange, noopChange] as import('../models/Paper.ts').Paper[]), {
    '2607.22222': { citationCount: 9, citationCountKnown: true },
    '2607.33333': { citationCount: 12, citationCountKnown: true },
  });

  assert.ok(Object.is(result[0], untouched), 'no record at all: same object');
  assert.ok(!Object.is(result[1], realChange), 'record with new data: different object');
  assert.equal(result[1].citationCount, 9);
  assert.ok(Object.is(result[2], noopChange), 'record present but changes nothing: same object');
});

test('a journal DOI is a way into OpenAlex when there is no arXiv id', () => {
  // Measured 2026-09-07: a paper whose arXiv landing page OpenAlex has not
  // indexed can still be there under the DOI its journal issued, and that
  // route was never tried.
  assert.equal(
    getOpenAlexEnrichmentId({ id: '2609.04966', arxivId: '2609.04966', doi: '10.1142/S0218271826500495' }),
    '2609.04966',
    'the arXiv id still wins: its landing-page filter found 5 of 5 where the DOI route missed one',
  );
  assert.equal(getOpenAlexEnrichmentId({ id: 'ads:2023ASPC', doi: '10.1142/S0218271826500495' }), 'doi:10.1142/s0218271826500495');
  assert.equal(getOpenAlexEnrichmentId({ id: 'ads:x', doi: 'https://doi.org/10.1023/A:1024156116636' }), 'doi:10.1023/a:1024156116636');
  assert.equal(
    getOpenAlexEnrichmentId({ id: 'pmid:1', doi: '10.48550/arxiv.2506.06595' }),
    '',
    'the arXiv pseudo-DOI is not a second route to the same work',
  );
  assert.equal(getOpenAlexEnrichmentId({ id: 'pmid:1', doi: 'not a doi' }), '');
});

test('a paper reachable only by its DOI is worth enriching', () => {
  assert.equal(needsOpenAlexEnrichment({
    id: 'ads:2023ASPC',
    doi: '10.1142/S0218271826500495',
    sources: { primary: 'nasa-ads', enrichedBy: [] as string[] },
  }), true);
  assert.equal(needsOpenAlexEnrichment({
    id: 'ads:2023ASPC',
    doi: '10.1142/S0218271826500495',
    sources: { primary: 'nasa-ads', enrichedBy: ['openalex'] },
  }), false);
});

test('late metadata keeps displayed abstract and summary stable without losing citation updates', () => {
  const current = [{ id: 'W2020715063', title: 'Effective action for strongly correlated electron systems', authors: [], abstract: '', summary: '', sources: { primary: 'openalex', enrichedBy: [] } }] as import('../models/Paper.ts').Paper[];
  const enriched = [{ ...current[0], abstract: 'Late text', summary: 'Late text', citationCount: 16 }];
  const result = preserveFeedAbstracts(current, enriched);
  assert.equal(result[0].abstract, '');
  assert.equal(result[0].summary, '');
  assert.equal(result[0].citationCount, 16);
  assert.equal(preserveFeedAbstracts(current, [{ ...current[0], abstract: 'Late text' }])[0], current[0]);
});

test('late text fills only a card that says its abstract is loading', () => {
  const card = (id: string, abstract: string) => ({ id, title: `Synthetic paper ${id}`, authors: [], abstract, summary: abstract, sources: { primary: 'openalex', enrichedBy: [] } }) as Paper;
  const current = [card('loading', ''), card('settled', ''), card('shown', 'Publisher text.')];
  const enriched = current.map(paper => ({ ...paper, abstract: 'Late text', summary: 'Late text' }));
  const result = preserveFeedAbstracts(current, enriched, new Set(['loading', 'shown']));
  assert.deepEqual(result.map(paper => paper.abstract), ['Late text', '', 'Publisher text.']);
  assert.equal(result[0].summary, 'Late text');
});

test('a card is loading only while a request that can supply its abstract is running', () => {
  const papers = [
    { id: 'pubmed', pmid: '123', abstract: '', sources: { primary: 'pubmed', enrichedBy: [] } },
    { id: 'linked', arxivId: '1109.5103', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } },
    { id: 'physics-doi', doi: '10.1016/j.nuclphysb.2011.08.011', primaryCategory: 'hep-th', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } },
    { id: 'medicine-doi', doi: '10.5555/clinical-trial', primaryCategory: 'med.onc', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } },
    { id: 'with-text', pmid: '456', abstract: 'Publisher text.', sources: { primary: 'pubmed', enrichedBy: [] } },
  ].map(paper => ({ title: `Synthetic paper ${paper.id}`, authors: [], ...paper }) as Paper);
  const all = { openAlex: true, europePmc: true, recovery: true };
  assert.deepEqual([...abstractsInFlight(papers, all)], ['pubmed', 'linked', 'physics-doi']);
  assert.deepEqual([...abstractsInFlight(papers, { ...all, recovery: false })], ['pubmed']);
  assert.deepEqual([...abstractsInFlight(papers, { openAlex: false, europePmc: false, recovery: false })], []);
});
