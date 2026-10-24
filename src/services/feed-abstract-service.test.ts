import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAlexAdapter } from './adapters/open-alex-adapter.ts';
import { PaperBuilder } from './paper-builder.ts';
import { recoverFeedAbstracts } from './feed-abstract-service.ts';
import { getMissingArxivAbstractIds, getMissingAbstractDois, mergeFeedAbstracts } from '../utils/feed-enrichment.ts';

// Trimmed OpenAlex W3029239115 and arXiv 2005.12542v4 payloads fetched on
// 2026-10-18 for the user's video. The abstract is the source's actual text.
const videoPaper = PaperBuilder.create(new OpenAlexAdapter().mapToStandard({
  id: 'https://openalex.org/W3029239115',
  title: 'Applications of Algebraic Combinatorics to Algebraic Geometry',
  doi: 'https://doi.org/10.1016/j.indag.2021.09.002',
  ids: { openalex: 'https://openalex.org/W3029239115' },
  type: 'article',
  publication_date: '2021-12-01',
  publication_year: 2021,
  cited_by_count: 8,
  abstract_inverted_index: null,
  authorships: [],
  open_access: { is_oa: true },
  primary_location: { landing_page_url: 'https://doi.org/10.1016/j.indag.2021.09.002', is_published: true },
  locations: [{ landing_page_url: 'http://arxiv.org/abs/2005.12542', pdf_url: 'https://arxiv.org/pdf/2005.12542' }],
})!);
const sourceAbstract = 'We formulate a number of new results in Algebraic Geometry and outline their derivation from Theorem 2.12 which belongs to Algebraic Combinatorics.';
const arxivPaper = PaperBuilder.create({
  id: '2005.12542', arxivId: '2005.12542', title: videoPaper.title,
  abstract: sourceAbstract, sources: { primary: 'arxiv', enrichedBy: [] },
  publicationStatus: 'preprint', openAccess: true,
});

test('a recovered arXiv abstract fills the video paper without changing published metadata', () => {
  const result = mergeFeedAbstracts([videoPaper], [arxivPaper]);
  assert.deepEqual(result[0], { ...videoPaper, abstract: sourceAbstract, summary: sourceAbstract, sources: { primary: 'openalex', enrichedBy: ['arxiv'], peerReviewedByDoiComplete: true } });
});

test('scientific reviews recover by exact DOI while a failed arXiv source leaves its paper usable', async t => {
  const review = { ...videoPaper, id: 'review', arxivId: undefined, doi: '10.1016/0370-2693(86)90963-9', primaryCategory: 'hep-th', publicationType: 'review', openAccess: false };
  // Under node no arXiv route is configured, so the linked arXiv lookup for the
  // video paper fails. The INSPIRE response has the API's shape; its text is synthetic.
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).searchParams.get('q'), `doi:"${review.doi}"`);
    return Response.json({ hits: { total: 1, hits: [{ metadata: { dois: [{ value: review.doi }], abstracts: [{ value: 'Verified publisher text.' }] } }] } });
  });
  const papers = [videoPaper, review];
  const result = mergeFeedAbstracts(papers, await recoverFeedAbstracts(papers));
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result[0], videoPaper);
  assert.equal(result[1].abstract, 'Verified publisher text.');
  assert.equal(result[1].publicationType, 'review');
  assert.equal(result[1].openAccess, false);
});

test('DOI recovery skips existing abstracts and arXiv links, and preserves unmatched work', () => {
  const unlinked = { ...videoPaper, arxivId: undefined, doi: 'https://doi.org/10.5555/KNOWN', primaryCategory: 'hep-th' };
  const unavailable = { ...unlinked, doi: undefined };
  const existing = { ...unlinked, abstract: 'Existing source text.' };
  assert.deepEqual(getMissingAbstractDois([unlinked, unavailable, existing, videoPaper, { ...unlinked, doi: '10.5555/known' }]), ['10.5555/known']);
  const papers = [unlinked, unavailable, existing, videoPaper];
  assert.equal(mergeFeedAbstracts(papers, [{ doi: '10.5555/another', abstract: 'Other text.', sources: { primary: 'inspire', enrichedBy: [] } }]), papers);
});

test('only asks for linked OpenAlex papers missing an abstract, deduplicating versioned IDs', () => {
  assert.deepEqual(getMissingArxivAbstractIds([
    videoPaper,
    { ...videoPaper, arxivId: 'arxiv:2005.12542v4' },
    { ...videoPaper, abstract: 'The publisher already supplied this abstract.', arxivId: '2101.12345' },
    { ...videoPaper, arxivId: undefined },
    { ...videoPaper, arxivId: 'not-an-arxiv-id' },
    { ...arxivPaper, abstract: 'No abstract available.' },
  ]), ['2005.12542']);
});

test('preserves existing abstracts, missing records, and closed access', () => {
  const closed = { ...videoPaper, openAccess: false, pdfUrl: null };
  const existing = { ...videoPaper, abstract: 'Already supplied by the publisher.' };
  const unlinked = { ...videoPaper, arxivId: undefined };
  const other = { ...videoPaper, arxivId: 'hep-th/9901001' };
  const papers = [closed, existing, unlinked, other];
  const merged = mergeFeedAbstracts(papers, [arxivPaper]);
  assert.equal(merged[0].abstract, sourceAbstract);
  assert.equal(merged[0].openAccess, false);
  assert.equal(merged[0].pdfUrl, null);
  assert.equal(merged[0].publicationStatus, 'published');
  assert.equal(merged[1], existing);
  assert.equal(merged[2], unlinked);
  assert.equal(merged[3], other);
  assert.equal(mergeFeedAbstracts(papers, []), papers);
  assert.equal(mergeFeedAbstracts(papers, [{ ...arxivPaper, abstract: 'No abstract available.' }]), papers);
  assert.equal(mergeFeedAbstracts(merged, [arxivPaper]), merged);
});

test('INSPIRE is asked only for physics papers, since it holds no other field', () => {
  const physics = { ...videoPaper, id: 'physics', arxivId: undefined, doi: '10.1016/j.nuclphysb.2011.08.011', primaryCategory: 'hep-th' };
  const medicine = { ...videoPaper, id: 'medicine', arxivId: undefined, doi: '10.5555/clinical-trial', primaryCategory: 'med.onc' };
  const unfiled = { ...videoPaper, id: 'unfiled', arxivId: undefined, doi: '10.5555/no-field' };
  assert.deepEqual(getMissingAbstractDois([physics, medicine, unfiled]), ['10.1016/j.nuclphysb.2011.08.011']);
});
