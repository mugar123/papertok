import test from 'node:test';
import assert from 'node:assert/strict';
import { mapEuropePmcResult, mergeEuropePmcEnrichment } from './europePmcService.js';
import { PaperBuilder } from './PaperBuilder.js';

test('maps Europe PMC open full text and biomedical metadata', () => {
  const mapped = mapEuropePmcResult({
    id: '12345',
    pmcid: 'PMC12345',
    abstractText: 'A <i>useful</i> abstract &amp; result.',
    meshHeadingList: { meshHeading: [{ descriptorName: 'Heart Diseases' }] },
    keywordList: { keyword: ['Cardiology', 'Heart Diseases'] },
    fullTextUrlList: { fullTextUrl: [
      { availabilityCode: 'OA', documentStyle: 'html', url: 'https://europepmc.org/articles/PMC12345' },
      { availabilityCode: 'OA', documentStyle: 'pdf', url: 'https://europepmc.org/articles/PMC12345?pdf=render' },
    ] },
    isOpenAccess: 'Y',
    citedByCount: 17,
    hasReferences: 'Y',
    hasData: 'Y',
    hasSuppl: 'N',
    license: 'cc by',
  });

  assert.equal(mapped.abstract, 'A useful abstract & result.');
  assert.deepEqual(mapped.biomedicalTerms, ['Heart Diseases', 'Cardiology']);
  assert.equal(mapped.openAccess, true);
  assert.equal(mapped.citationCount, 17);
  assert.equal(mapped.hasReferences, true);
  assert.equal(mapped.hasData, true);
  assert.equal(mapped.hasSupplement, false);
  assert.equal(mapped.accessSource, 'europepmc');
  assert.match(mapped.openAccessPdfUrl, /pdf=render/);
});

test('ignores unsafe Europe PMC URLs', () => {
  const mapped = mapEuropePmcResult({
    id: '999',
    fullTextUrlList: { fullTextUrl: [
      { availabilityCode: 'OA', documentStyle: 'html', url: 'javascript:alert(1)' },
    ] },
  });

  assert.equal(mapped.landingPageUrl, undefined);
  assert.equal(mapped.openAccess, true);
});

/* --- Late merge into an already painted page ----------------------------- */

// Built the way every adapter builds one. A hand-rolled literal misses the
// fields PaperBuilder.create fills in (hasData, peerReviewed...), and then a
// no-op merge looks like a change that isn't one.
const pubmedPaper = (pmid, extra = {}) => PaperBuilder.create({
  id: `pmid:${pmid}`,
  pmid,
  title: `Paper ${pmid}`,
  abstract: '',
  categories: ['Neoplasms'],
  keywords: ['Neoplasms'],
  openAccess: false,
  sources: { primary: 'pubmed', enrichedBy: [] },
  ...extra,
});

test('merges a Europe PMC record into the PubMed paper that owns the pmid', () => {
  const papers = [pubmedPaper('111'), pubmedPaper('222')];
  const records = new Map([['111', {
    pmid: '111',
    pmcid: 'PMC1',
    abstract: 'A real abstract of more than a few words about cancer outcomes.',
    biomedicalTerms: ['Breast Neoplasms'],
    concepts: [{ id: 'epmc:111:0', display_name: 'Breast Neoplasms', level: 2 }],
    citationCount: 12,
    openAccess: true,
    openAccessPdfUrl: 'https://europepmc.org/articles/PMC1?pdf=render',
    europePmcUrl: 'https://europepmc.org/article/MED/111',
    accessSource: 'europepmc',
    hasReferences: true,
    hasData: false,
    hasSupplement: true,
  }]]);

  const [merged, untouched] = mergeEuropePmcEnrichment(papers, records);
  assert.equal(merged.openAccess, true);
  assert.equal(merged.openAccessPdfUrl, 'https://europepmc.org/articles/PMC1?pdf=render');
  assert.equal(merged.pmcid, 'PMC1');
  assert.equal(merged.citationCount, 12);
  assert.deepEqual(merged.biomedicalTerms, ['Breast Neoplasms']);
  assert.deepEqual(merged.keywords, ['Neoplasms', 'Breast Neoplasms']);
  assert.deepEqual(merged.categories, ['Neoplasms', 'Breast Neoplasms']);
  assert.equal(merged.hasSupplement, true);
  assert.ok(merged.sources.enrichedBy.includes('europepmc'));
  assert.ok(Object.is(untouched, papers[1]), 'a paper without a record keeps its identity');
});

test('a record that changes nothing hands back the same object', () => {
  const paper = pubmedPaper('333', { sources: { primary: 'pubmed', enrichedBy: ['europepmc'] } });
  const [result] = mergeEuropePmcEnrichment([paper], new Map([['333', { pmid: '333' }]]));
  assert.ok(Object.is(result, paper));
});

test('accepts a plain object keyed by pmid and tolerates a pmid: prefix', () => {
  const [result] = mergeEuropePmcEnrichment(
    [pubmedPaper('444', { pmid: 'pmid:444' })],
    { 444: { pmid: '444', citationCount: 3 } },
  );
  assert.equal(result.citationCount, 3);
});

test('an empty answer is not a reason to rebuild the page', () => {
  const papers = [pubmedPaper('555')];
  assert.ok(Object.is(mergeEuropePmcEnrichment(papers, new Map()), papers));
});

test('never downgrades a card PubMed already marked open (embargoed PMC record)', () => {
  // PubmedAdapter sets openAccess: true whenever a PMC id exists, with no pdfUrl.
  // Europe PMC answers isOpenAccess 'N' for an embargoed author manuscript.
  const paper = pubmedPaper('666', { pmcid: 'PMC6', openAccess: true, accessSource: 'pmc' });
  const [merged] = mergeEuropePmcEnrichment([paper], new Map([['666', {
    pmid: '666', openAccess: false, accessSource: undefined, citationCount: 4,
  }]]));
  assert.equal(merged.openAccess, true, 'the old adapter only ever upgraded access');
  assert.equal(merged.accessSource, 'pmc');
  assert.equal(merged.citationCount, 4, 'the rest of the record still lands');
});

test('an open record points the landing page at Europe PMC, as the adapter used to', () => {
  const paper = pubmedPaper('777', { landingPageUrl: 'https://pubmed.ncbi.nlm.nih.gov/777/' });
  const [merged] = mergeEuropePmcEnrichment([paper], new Map([['777', {
    pmid: '777', openAccess: true, landingPageUrl: 'https://europepmc.org/article/MED/777', accessSource: 'europepmc',
  }]]));
  assert.equal(merged.landingPageUrl, 'https://europepmc.org/article/MED/777');
  assert.equal(merged.openAccess, true);
});
