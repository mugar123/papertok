import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { Paper } from '../models/Paper.ts';
import { OpenAlexAdapter } from './adapters/OpenAlexAdapter.ts';
import { PaperBuilder } from './PaperBuilder.ts';
import { getMissingArxivAbstractIds, getMissingAbstractDois, mergeFeedAbstracts } from '../utils/feedEnrichment.ts';
import { awaitWithinGate } from '../utils/feedCitationGate.ts';
import { hasUsableAIAbstract } from '../utils/aiExplanationAccess.ts';

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

const source = stripTypeScriptTypes(readFileSync(new URL('./feedAbstractService.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export async function', 'async function'));
function recovery(arxiv: (ids: string[]) => Promise<Paper[]>, inspire: (dois: string[]) => Promise<Partial<Paper>[]> = async () => [], waitMs = 100) {
  const env = { fetchPapersByIds: arxiv, fetchInspireAbstracts: inspire, getMissingArxivAbstractIds, getMissingAbstractDois,
    awaitWithinGate: (promises: PromiseLike<unknown>[]) => awaitWithinGate(promises, { maxWaitMs: waitMs }),
  };
  const recover = new Function(...Object.keys(env), `${source}; return recoverFeedAbstracts;`)(...Object.values(env)) as (papers: Paper[]) => Promise<Partial<Paper>[]>;
  return async (papers: Paper[]) => mergeFeedAbstracts(papers, await recover(papers));
}
function deferred() {
  let resolve!: (papers: Paper[]) => void;
  const promise = new Promise<Paper[]>(done => { resolve = done; });
  return { promise, resolve };
}

// Trimmed OpenAlex W2020715063, retrieved by DOI on 2026-10-18.
const screenshotPaper = PaperBuilder.create(new OpenAlexAdapter().mapToStandard({
  id: 'https://openalex.org/W2020715063',
  title: 'Effective action for strongly correlated electron systems',
  doi: 'https://doi.org/10.1016/j.nuclphysb.2011.08.011', type: 'article',
  publication_year: 2011, abstract_inverted_index: null,
  locations: [{ landing_page_url: 'http://arxiv.org/abs/1109.5103', pdf_url: 'https://arxiv.org/pdf/1109.5103' }],
})!);

test('the screenshot paper is withheld until its linked arXiv abstract settles', async () => {
  const pending = deferred();
  const prepare = recovery(async ids => { assert.deepEqual(ids, ['1109.5103']); return pending.promise; });
  let published: Paper[] = [];
  const loading = prepare([screenshotPaper]).then(papers => { published = papers; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(published.length, 0);
  // Synthetic response text; identity and the missing source record above are captured.
  pending.resolve([{ ...arxivPaper, arxivId: '1109.5103', abstract: 'Verified abstract for the electron model.' }]);
  await loading;
  assert.equal(published[0].abstract, 'Verified abstract for the electron model.');
  assert.equal(published[0].doi, screenshotPaper.doi);
  assert.equal(published[0].id, screenshotPaper.id);
});

test('the video abstract is recovered before admission without changing published metadata', async () => {
  const result = await recovery(async () => [arxivPaper])([videoPaper]);
  assert.deepEqual(result[0], { ...videoPaper, abstract: sourceAbstract, summary: sourceAbstract, sources: { primary: 'openalex', enrichedBy: ['arxiv'], peerReviewedByDoiComplete: true } });
});

test('scientific reviews recover by exact DOI while a failed arXiv source leaves its paper usable', async () => {
  const review = { ...videoPaper, id: 'review', arxivId: undefined, doi: '10.1016/0370-2693(86)90963-9', primaryCategory: 'hep-th', publicationType: 'review', openAccess: false };
  const result = await recovery(async () => { throw new Error('Unavailable'); }, async dois => {
    assert.deepEqual(dois, [review.doi]);
    return [{ doi: review.doi, abstract: 'Verified publisher text.', sources: { primary: 'inspire', enrichedBy: [] } }];
  })([videoPaper, review]);
  assert.equal(result[0], videoPaper);
  assert.equal(result[1].abstract, 'Verified publisher text.');
  assert.equal(result[1].publicationType, 'review');
  assert.equal(result[1].openAccess, false);
});

test('the deadline keeps a usable paper and a late response never mutates the admitted batch', async () => {
  const pending = deferred();
  const review = { ...videoPaper, id: 'review', arxivId: undefined, doi: '10.5555/independent-review', primaryCategory: 'hep-ph' };
  const result = await recovery(() => pending.promise, async () => [{ doi: review.doi, abstract: 'Available DOI abstract.', sources: { primary: 'inspire', enrichedBy: [] } }], 10)([videoPaper, review]);
  assert.equal(result[0], videoPaper);
  assert.equal(result[1].abstract, 'Available DOI abstract.');
  pending.resolve([arxivPaper]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(hasUsableAIAbstract(result[0].abstract), false);
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

test('INSPIRE is asked only for physics papers, since it holds no other field', async () => {
  const physics = { ...videoPaper, id: 'physics', arxivId: undefined, doi: '10.1016/j.nuclphysb.2011.08.011', primaryCategory: 'hep-th' };
  const medicine = { ...videoPaper, id: 'medicine', arxivId: undefined, doi: '10.5555/clinical-trial', primaryCategory: 'med.onc' };
  const unfiled = { ...videoPaper, id: 'unfiled', arxivId: undefined, doi: '10.5555/no-field' };
  const asked: string[][] = [];
  await recovery(async () => [], async dois => { asked.push(dois); return []; })([physics, medicine, unfiled]);
  assert.deepEqual(asked, [[physics.doi]]);
});
