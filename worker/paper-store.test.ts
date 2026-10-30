import type { Paper, PaperFollowMatch } from '../src/models/paper.ts';
import type { OpenAlexLocation } from '../src/services/adapters/open-alex-types.ts';
import type { KeptRanking, RankingCache } from './paper-store.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  arxivIdOf, daysFromNow, embedPending, embedWorks, evictExpired, ingestPapers, interleaveByWeight, keysForPaperId, parseFeedRequest, quantize, rankBySimilarity,
  notableSince, readFeedPage, readNotableCandidates, readVector, rewriteWorks, thinLeaves, thinLeavesReport,
} from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { FeedTimings } from './feed-timings.ts';
import { PaperBuilder } from '../src/services/paper-builder.ts';
import { getAllLeafCategories } from '../src/data/category-taxonomy.ts';
import { mapAdsPaper } from '../src/services/domain-source-records.ts';
import { mapHuggingFacePaper } from '../src/services/hugging-face-records.ts';
import { mapPubmedSummary } from '../src/services/adapters/pubmed-records.ts';
import { mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { journalExplorerLink } from '../src/utils/explorer-paths.ts';
import { feedSeenFilter, feedSeenIds } from '../src/utils/seen-paper-filter.ts';
import { mergeFeedAbstracts, notablePlaces, placeNotableCards } from '../src/utils/feed-enrichment.ts';
import { sourceAttribution } from '../src/utils/source-attribution.ts';
import { testD1 } from './test-support/sqlite-d1.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

async function evictAll(env: Parameters<typeof evictExpired>[0], now: number) {
  let after: number | null = 0;
  while (after !== null) after = await evictExpired(env, now, after);
}

test('only arXiv identifiers reach the store lookup', () => {
  assert.equal(arxivIdOf('arxiv:2610.01234v2'), '2610.01234');
  assert.equal(arxivIdOf('hep-th/9901001'), 'hep-th/9901001');
  assert.equal(arxivIdOf('math.GT/0309136v1'), 'math/0309136');
  assert.equal(arxivIdOf('10.1145/3320269.3372198'), '');
  assert.equal(arxivIdOf('W4391234567'), '');
});

test('the closest liked paper orders the page; recency separates near ties', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const rows = [
    { id: 'far-new', embedding: quantize([0, 1]), published: '2026-10-21T00:00:00Z' },
    { id: 'close-old', embedding: quantize([1, 0]), published: '2026-10-01T00:00:00Z' },
    { id: 'close-new', embedding: quantize([1, 0]), published: '2026-10-20T00:00:00Z' },
  ];
  const likes = [quantize([1, 0])];
  assert.deepEqual(rankBySimilarity(rows, likes, { now }).map(({ row }) => row.id), ['close-new', 'close-old', 'far-new']);
  assert.deepEqual(rankBySimilarity(rows, [], { now }).map(({ row }) => row.id), ['far-new', 'close-new', 'close-old']);
});

test('a paper not yet embedded is still served, after the ones that match', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const rows = [
    { id: 'pending-newest', embedding: null, published: '2026-10-21T12:00:00Z' },
    { id: 'match', embedding: quantize([1, 0]), published: '2026-10-15T00:00:00Z' },
  ];
  assert.deepEqual(rankBySimilarity(rows, [quantize([1, 0])], { now }).map(({ row }) => row.id), ['match', 'pending-newest']);
  assert.deepEqual(rankBySimilarity(rows, [], { now }).map(({ row }) => row.id), ['pending-newest', 'match']);
});

test('a stored vector reads back the same whether D1 returns bytes or numbers', () => {
  const stored = quantize([3, -4]);
  assert.deepEqual([...stored], [76, -102]);
  const unsignedBytes = [...new Uint8Array(stored.buffer)];
  assert.deepEqual([...readVector(unsignedBytes)], [76, -102]);
  assert.deepEqual([...readVector(stored.buffer)], [76, -102]);
});

test('a rejection demotes near copies, without penalizing a distant topic', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const rows = [
    { id: 'copy', embedding: quantize([1, 0]), published: '2026-10-20' },
    { id: 'other', embedding: quantize([0.6, 0.8]), published: '2026-10-20' },
  ];
  const baseline = rankBySimilarity(rows, [quantize([1, 0])], { now });
  const rejected = rankBySimilarity(rows, [quantize([1, 0])], { now, negatives: [quantize([1, 0])] });
  assert.deepEqual(baseline.map(({ row }) => row.id), ['copy', 'other']);
  assert.deepEqual(rejected.map(({ row }) => row.id), ['other', 'copy']);
  assert.equal(rejected[0].score, baseline[1].score);
  assert.ok(rejected[1].semanticScore < rejected[0].semanticScore);
});

test('semantic diversity moves a second interest ahead of near duplicates and retains every candidate', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => ({ id: `copy-${index}`, embedding: quantize([1, 0]), published: '2026-10-20' })),
    { id: 'second-interest', embedding: quantize([0.85, 0.53]), published: '2026-10-20' },
  ];
  const ranked = rankBySimilarity(rows, [quantize([1, 0])], { now });
  assert.deepEqual(ranked.slice(0, 2).map(({ row }) => row.id), ['copy-0', 'second-interest']);
  assert.equal(new Set(ranked.map(({ row }) => row.id)).size, 21);
});

// D1 answers a BLOB as an array of its unsigned bytes, and a ranked page
// decodes up to 4,000 of them: 50 to 170 ms of Worker CPU in the #272 review.
test("a page's vectors decode in a few milliseconds from the numbers D1 returns", () => {
  const vectors = Array.from({ length: 4_000 }, (_, row) => Array.from({ length: 256 }, (_, index) => (row * 31 + index * 17) & 255));
  let fastest = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    vectors.forEach(readVector);
    fastest = Math.min(fastest, performance.now() - started);
  }
  assert.ok(fastest < 15, `4,000 vectors took ${fastest.toFixed(1)} ms`);
});

// ─── The corpus in D1 (migrations applied to an in-memory SQLite) ───

const NOW = Date.parse('2026-10-22T03:00:00Z');

// Synthetic records in the shapes the sources' mappers return.
const arxivRecord = arxivRecordPaper({
  arxivId: '2610.11111',
  title: 'Sparse attention for long documents',
  abstract: 'We make attention sparse.',
  authors: ['Ana Pérez', 'Li Wei'],
  categories: ['cs.CL', 'cs.LG'],
  doi: null,
  journalRef: null,
  comments: null,
  published: '2026-10-10T12:00:00.000Z',
  updated: '2026-10-10T12:00:00.000Z',
});
const arxivRevision = arxivRecordPaper({
  arxivId: '2610.11111',
  title: 'Sparse attention for long documents and code',
  abstract: 'We make attention sparse, and prove that it converges.',
  authors: ['Ana Pérez', 'Li Wei'],
  categories: ['cs.CL', 'cs.LG'],
  doi: null,
  journalRef: null,
  comments: null,
  published: '2026-10-10T12:00:00.000Z',
  updated: '2026-10-20T08:00:00.000Z',
});
const huggingFaceRecord = mapHuggingFacePaper({
  paper: { id: '2610.11111', title: 'Sparse attention for long documents', summary: 'We make attention sparse.', publishedAt: '2026-10-10T12:00:00.000Z', upvotes: 31, authors: [{ name: 'Ana Pérez' }] },
}, ['cs.CV'])!;

function corpus() {
  const { binding, db } = testD1();
  return { env: { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0], db };
}
const rows = (db: ReturnType<typeof testD1>['db'], sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;

test('two sources listing one paper make one row under the id readers already hold, filed under both lanes', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }], { now: NOW });
  await ingestPapers(env, [{ paper: huggingFaceRecord, lanes: ['cs.CV'] }], { now: NOW });
  const works = rows(db, 'SELECT paper FROM works');
  assert.equal(works.length, 1);
  const paper = JSON.parse(String(works[0].paper));
  assert.equal(paper.id, '2610.11111');
  assert.equal(paper.huggingFaceUpvotes, 31, 'the second source adds what it knows');
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane), ['cs.CL', 'cs.CV', 'cs.LG']);
});

// #270 filed each new arXiv version whole. Since #272 a listing merges into
// the stored row, and `merge` only fills gaps, so a revised title or abstract
// never reached the card or its vector.
test("the source a row came from replaces its title and abstract when it lists the paper again; another source's text does not", async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }], { now: NOW });
  db.exec(`INSERT INTO work_vectors (work_id, embedding) SELECT id, x'01' FROM works`);
  await ingestPapers(env, [{ paper: arxivRevision, lanes: [] }], { now: NOW });
  const stored = (id: string) => JSON.parse(String(rows(db, `SELECT w.paper FROM works w JOIN work_keys k ON k.work_id = w.id WHERE k.key = 'id:${id}'`)[0].paper));
  assert.deepEqual([stored('2610.11111').title, stored('2610.11111').abstract], [arxivRevision.title, arxivRevision.abstract]);
  assert.equal(rows(db, 'SELECT work_id FROM work_vectors').length, 0, 'the new text is embedded again');
  // Hugging Face still lists the first version's text.
  await ingestPapers(env, [{ paper: huggingFaceRecord, lanes: [] }], { now: NOW });
  assert.deepEqual([stored('2610.11111').title, stored('2610.11111').abstract], [arxivRevision.title, arxivRevision.abstract]);

  // esummary has no abstract: a listing without efetch's keeps the stored one.
  const article = { ...mapPubmedSummary({ uid: '42900003', title: 'A cardiology trial', source: 'J', pubdate: '2026 Oct 12', pubtype: ['Journal Article'] }), abstract: 'We randomised 400 patients.' };
  await ingestPapers(env, [{ paper: article, lanes: ['med.cardio'] }], { now: NOW });
  await ingestPapers(env, [{ paper: { ...article, title: 'A cardiology trial (corrected)', abstract: '' }, lanes: ['med.cardio'] }], { now: NOW });
  assert.deepEqual([stored('pmid:42900003').title, stored('pmid:42900003').abstract], ['A cardiology trial (corrected)', 'We randomised 400 patients.']);
});

// ENG-105: W7222919853 was stored with a funding note as its abstract before
// the OpenAlex mapper refused one. Its listing now maps without an abstract, and
// "a listing without an abstract keeps the stored one" kept the note for good.
test('a funding note stored as the abstract is replaced when its source lists the paper without one', async () => {
  const { env, db } = corpus();
  const note = 'Semyon Malamud gratefully acknowledges the financial';
  const listed = mapOpenAlexWork({
    id: 'https://openalex.org/W7222919853',
    title: 'Infinite Factor Structure in Conditional Asset Pricing',
    type: 'report',
    publication_date: '2026-10-20',
    abstract_inverted_index: { Semyon: [0], Malamud: [1], gratefully: [2], acknowledges: [3], the: [4], financial: [5] },
  })!;
  assert.equal(listed.abstract, 'No abstract available.');
  const stored = () => JSON.parse(String(rows(db, 'SELECT paper FROM works')[0].paper));
  await ingestPapers(env, [{ paper: { ...listed, abstract: note }, lanes: ['area:physics'] }], { now: NOW });
  db.exec(`INSERT INTO work_vectors (work_id, embedding) SELECT id, x'01' FROM works`);
  assert.equal(stored().abstract, note);
  await ingestPapers(env, [{ paper: listed, lanes: ['area:physics'] }], { now: NOW });
  assert.equal(stored().abstract, 'No abstract available.');
  assert.equal(rows(db, 'SELECT work_id FROM work_vectors').length, 0, 'the paper is embedded again, by its title');
});

// ENG-109: a card credits Semantic Scholar for the abstract recovered from it.
// The row's own source listing the paper with an abstract replaces that text,
// and the credit goes with it.
test("an abstract recovered from Semantic Scholar keeps its credit while the row's source lists the paper without one, and loses it to that source's text", async () => {
  const { env, db } = corpus();
  const work = { id: 'https://openalex.org/W4410000009', doi: 'https://doi.org/10.5555/recovered', title: 'A journal article OpenAlex lists without its abstract', type: 'article', publication_date: '2026-10-20' };
  const stored = () => JSON.parse(String(rows(db, 'SELECT paper FROM works')[0].paper)) as Paper;
  await ingestPapers(env, [{ paper: mapOpenAlexWork(work)!, lanes: ['econ.TH'] }], { now: NOW });
  const recovered = 'The abstract Semantic Scholar holds for this journal article, in full.';
  const [withAbstract] = mergeFeedAbstracts([stored()], [{ doi: '10.5555/recovered', abstract: recovered, sources: { primary: 'semanticscholar', enrichedBy: [] } }]);
  db.prepare('UPDATE works SET paper = ?').run(JSON.stringify(withAbstract));
  await ingestPapers(env, [{ paper: mapOpenAlexWork(work)!, lanes: ['econ.TH'] }], { now: NOW });
  assert.deepEqual([stored().abstract, stored().abstractSource], [recovered, 'semanticscholar']);
  assert.deepEqual(sourceAttribution(stored()), { label: 'Abstract:', name: 'Semantic Scholar', href: 'https://www.semanticscholar.org/?utm_source=api' });
  const listedWithAbstract = mapOpenAlexWork({ ...work, abstract_inverted_index: { OpenAlex: [0], now: [1], 'lists the abstract its publisher deposited for this article.': [2] } })!;
  await ingestPapers(env, [{ paper: listedWithAbstract, lanes: ['econ.TH'] }], { now: NOW });
  assert.deepEqual([stored().abstract, stored().abstractSource], ['OpenAlex now lists the abstract its publisher deposited for this article.', undefined]);
  assert.equal(sourceAttribution(stored()), null, 'the card credits Semantic Scholar for nothing it shows');
});

// A row recovered before ENG-109 names Semantic Scholar only among the sources
// merged in, and its card says "With data from Semantic Scholar" for the
// recovered text. That text replaced, the card credits no one.
test('a row recovered before its source was recorded credits Semantic Scholar until its own source lists an abstract', async () => {
  const { env, db } = corpus();
  const work = { id: 'https://openalex.org/W4410000010', doi: 'https://doi.org/10.5555/recovered-earlier', title: 'A journal article recovered before the field existed', type: 'article', publication_date: '2026-10-20' };
  const stored = () => JSON.parse(String(rows(db, 'SELECT paper FROM works')[0].paper)) as Paper;
  await ingestPapers(env, [{ paper: mapOpenAlexWork(work)!, lanes: ['econ.TH'] }], { now: NOW });
  const earlier = PaperBuilder.merge(stored(), { abstract: 'The abstract Semantic Scholar held for this journal article, in full.' }, 'semanticscholar');
  db.prepare('UPDATE works SET paper = ?').run(JSON.stringify(earlier));
  assert.equal(sourceAttribution(stored())?.label, 'With data from');
  const listedWithAbstract = mapOpenAlexWork({ ...work, abstract_inverted_index: { OpenAlex: [0], now: [1], 'lists the abstract its publisher deposited for this article.': [2] } })!;
  await ingestPapers(env, [{ paper: listedWithAbstract, lanes: ['econ.TH'] }], { now: NOW });
  assert.equal(stored().abstract, 'OpenAlex now lists the abstract its publisher deposited for this article.');
  assert.equal(sourceAttribution(stored()), null);
});

// Hugging Face lists arXiv papers with the title and abstract it copied from
// arXiv. A night whose arXiv sets fail still runs the Hugging Face lane, so
// that lane can start a row, which then never took a new arXiv version.
test("a row Hugging Face started takes arXiv's new version, and Hugging Face's copy does not undo it", async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: huggingFaceRecord, lanes: ['cs.CV'] }], { now: NOW });
  await ingestPapers(env, [{ paper: arxivRevision, lanes: [] }], { now: NOW });
  const stored = () => JSON.parse(String(rows(db, 'SELECT paper FROM works')[0].paper));
  assert.deepEqual([stored().id, stored().title, stored().abstract], ['arxiv:2610.11111', arxivRevision.title, arxivRevision.abstract]);
  await ingestPapers(env, [{ paper: huggingFaceRecord, lanes: ['cs.CV'] }], { now: NOW });
  assert.deepEqual([stored().title, stored().abstract], [arxivRevision.title, arxivRevision.abstract]);
});

// The PubMed mapper writes "Untitled" for a record esummary gives no title.
// Filed, the placeholder was a card's title, and a listing of a stored paper
// replaced its real title with it.
test('a listing without a real title is not filed, and does not rename the stored paper', async () => {
  const { env, db } = corpus();
  const listing = (title: string) => mapPubmedSummary({ uid: '42900003', title, source: 'J', pubdate: '2026 Oct 12', pubtype: ['Journal Article'] });
  await ingestPapers(env, [{ paper: listing(''), lanes: ['med.cardio'] }], { now: NOW });
  assert.equal(rows(db, 'SELECT id FROM works').length, 0);
  await ingestPapers(env, [{ paper: listing('A cardiology trial'), lanes: ['med.cardio'] }], { now: NOW });
  await ingestPapers(env, [{ paper: listing(''), lanes: ['med.cardio'] }], { now: NOW });
  assert.deepEqual(rows(db, 'SELECT paper FROM works').map(row => JSON.parse(String(row.paper)).title), ['A cardiology trial']);
});

test('a record that names two stored papers folds them into one, keeping one id and every lane', async () => {
  const { env, db } = corpus();
  const journal = { ...mapOpenAlexWork({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/sparse', title: 'Sparse attention for long documents (journal version)', publication_date: '2026-10-12' })!, doi: '10.1000/sparse' };
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }, { paper: journal, lanes: ['bio.comp'] }], { now: NOW });
  assert.equal(rows(db, 'SELECT id FROM works').length, 2, 'nothing yet says they are one paper');
  const bridge = { ...journal, id: 'openalex:W2', arxivId: '2610.11111' };
  await ingestPapers(env, [{ paper: bridge, lanes: [] }], { now: NOW });
  const works = rows(db, 'SELECT id, paper FROM works');
  assert.equal(works.length, 1);
  assert.deepEqual(rows(db, 'SELECT DISTINCT work_id FROM work_keys').map(row => row.work_id), [works[0].id], 'every key names the remaining row');
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane), ['bio.comp', 'cs.CL', 'cs.LG']);
});

test("a notable lane keeps a folded paper until its listing's date, then drops it while the paper's categories keep it", async () => {
  const { env, db } = corpus();
  const journal = { ...mapOpenAlexWork({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/sparse', title: 'Sparse attention for long documents (journal version)', publication_date: '2026-10-12' })!, doi: '10.1000/sparse' };
  const listedUntil = Date.parse('2026-11-05T03:00:00Z');
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }], { now: NOW });
  await ingestPapers(env, [{ paper: journal, lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: new Date(listedUntil).toISOString() });
  // Another source's record of both folds the journal's row into the arXiv one.
  await ingestPapers(env, [{ paper: { ...journal, id: 'openalex:W2', arxivId: '2610.11111' }, lanes: [] }], { now: NOW });
  const notable = () => rows(db, "SELECT w.paper ->> '$.id' AS id FROM work_lanes l JOIN works w ON w.id = l.work_id WHERE l.lane = 'notable:cs.LG'").map(row => row.id);
  await evictExpired(env, listedUntil - 86_400_000);
  assert.deepEqual(notable(), ['2610.11111']);
  await evictExpired(env, listedUntil + 86_400_000);
  assert.deepEqual(notable(), []);
  assert.equal(rows(db, 'SELECT id FROM works').length, 1);
});

test('a fold of two rows of one notable lane keeps the later listing date', async () => {
  const { env, db } = corpus();
  const journal = { ...mapOpenAlexWork({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/sparse', title: 'Sparse attention for long documents (journal version)', publication_date: '2026-10-12' })!, doi: '10.1000/sparse' };
  const [earlier, later] = ['2026-10-29T03:00:00.000Z', '2026-11-05T03:00:00.000Z'];
  await ingestPapers(env, [{ paper: arxivRecord, lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: earlier });
  await ingestPapers(env, [{ paper: journal, lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: later });
  // Another source's record of both folds the journal's row into the arXiv one.
  await ingestPapers(env, [{ paper: { ...journal, id: 'openalex:W2', arxivId: '2610.11111' }, lanes: [] }], { now: NOW });
  assert.deepEqual(rows(db, "SELECT listed_until FROM work_lanes WHERE lane = 'notable:cs.LG'").map(row => row.listed_until), [later]);
});

test('a journal article keeps its row reviewed when a later harvest lists a record of it without an answer', async () => {
  // Synthetic OpenAlex records as the harvest maps them, one harvest each, so
  // the stored row is the base of each later merge. OpenAlex's record of the
  // eprint, typed `preprint` under arXiv's DOI while listing the journal's
  // copy, reopens the article's answer; its record of the journal DOI
  // without a source gives none.
  const { env, db } = corpus();
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const arxivLocation: OpenAlexLocation = {
    landing_page_url: 'https://arxiv.org/abs/2610.00007',
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
  const journalLocation: OpenAlexLocation = {
    landing_page_url: `https://doi.org/${journalDoi}`,
    is_published: true,
    source: { id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal', host_organization_name: 'Elsevier' },
  };
  const work = (id: string, doi: string, type: string, locations: OpenAlexLocation[]) => mapOpenAlexWork({
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/${doi}`,
    title: 'Bank capital and the transmission of monetary policy',
    type,
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
    publication_date: '2026-10-12',
    primary_location: locations[0],
    locations,
  })!;
  const article = work('W502', journalDoi, 'article', [journalLocation, arxivLocation]);
  const eprint = work('W503', '10.48550/arXiv.2610.00007', 'preprint', [arxivLocation, journalLocation]);
  const withoutSource = work('W507', journalDoi, 'article', [{ ...journalLocation, source: null }, arxivLocation]);
  for (const paper of [article, eprint, withoutSource]) await ingestPapers(env, [{ paper, lanes: [] }], { now: NOW });
  const works = rows(db, 'SELECT paper FROM works').map(row => JSON.parse(String(row.paper)));
  assert.equal(works.length, 1);
  assert.equal(works[0].doi, journalDoi);
  assert.equal(works[0].peerReviewed, true);
});

test('a row stored before merges kept review evidence does not read reviewed on the evidence merged into it since', async () => {
  // Synthetic records as the sources' mappers return them, one harvest each.
  // Code before `sources.peerReviewedByDoi` stored a merged row without the
  // answers its records gave under each DOI (stripped here, as that code
  // never wrote them), so it lacks NASA ADS's non-refereed record of the
  // journal article. A row built from scratch keeps that denial. Records
  // merged since must not make the row read reviewed where that code did
  // not: it reads unknown, as that code read it.
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const title = 'Bank capital and the transmission of monetary policy';
  const arxivLocation: OpenAlexLocation = {
    landing_page_url: 'https://arxiv.org/abs/2610.00007',
    is_published: false,
    source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' },
  };
  const journalLocation: OpenAlexLocation = {
    landing_page_url: `https://doi.org/${journalDoi}`,
    is_published: true,
    source: { id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal', host_organization_name: 'Elsevier' },
  };
  const work = (id: string, doi: string, type: string, locations: OpenAlexLocation[]) => mapOpenAlexWork({
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/${doi}`,
    title,
    type,
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
    publication_date: '2026-10-12',
    primary_location: locations[0],
    locations,
  })!;
  const article = work('W502', journalDoi, 'article', [journalLocation, arxivLocation]);
  const eprint = work('W503', '10.48550/arXiv.2610.00007', 'preprint', [arxivLocation, journalLocation]);
  const withoutSource = work('W507', journalDoi, 'article', [{ ...journalLocation, source: null }, arxivLocation]);
  const ssrnEntry = work('W513', '10.2139/ssrn.4400000', 'preprint', [{
    landing_page_url: 'https://doi.org/10.2139/ssrn.4400000',
    is_published: false,
    source: { id: 'https://openalex.org/S4210172589', display_name: 'SSRN Electronic Journal', type: 'repository', host_organization_name: 'RELX Group' },
  }, arxivLocation]);
  const conferenceDoi = '10.1145/3600000.3600001';
  const conferenceVersion = work('W505', conferenceDoi, 'article', [{
    landing_page_url: `https://doi.org/${conferenceDoi}`,
    is_published: true,
    source: { id: 'https://openalex.org/S222', display_name: 'ACM Economics and Computation', type: 'conference', host_organization_name: 'ACM' },
  }, arxivLocation]);
  const notRefereed = mapAdsPaper({
    bibcode: '2026JIntE.160j3900E',
    title: [title],
    author: ['Economist, Ana'],
    doi: [journalDoi],
    identifier: ['arXiv:2610.00007'],
    property: ['ARTICLE', 'OPENACCESS'],
    doctype: 'article',
    pub: 'Journal of International Economics',
    pubdate: '2026-10-12',
    year: '2026',
    abstract: 'Bank capital.',
  })!;
  const arxivListingJournal = arxivRecordPaper({
    arxivId: '2610.00007',
    title,
    abstract: 'Bank capital.',
    authors: ['Ana Economist'],
    categories: ['econ.GN'],
    doi: journalDoi,
    journalRef: null,
    comments: null,
    published: '2026-10-12T12:00:00.000Z',
    updated: '2026-10-12T12:00:00.000Z',
  });
  const harvest = async (before: Paper[], after: Paper[], legacy: boolean) => {
    const { env, db } = corpus();
    for (const paper of before) await ingestPapers(env, [{ paper, lanes: [] }], { now: NOW });
    if (legacy) db.prepare("UPDATE works SET paper = json_remove(paper, '$.sources.peerReviewedByDoi', '$.sources.peerReviewedByDoiComplete')").run();
    for (const paper of after) await ingestPapers(env, [{ paper, lanes: [] }], { now: NOW });
    return rows(db, 'SELECT paper FROM works').map(row => JSON.parse(String(row.paper)) as Paper);
  };
  for (const [stored, legacy] of [['from scratch', false], ['before the evidence was kept', true]] as const) {
    // A later harvest lists the article again, then OpenAlex's record of the
    // eprint, which reopens the row's answer, then its record of the journal
    // DOI without a source, which gives none.
    const reopened = await harvest([article, notRefereed], [article, eprint, withoutSource], legacy);
    assert.equal(reopened.length, 1, stored);
    assert.equal(reopened[0].doi, journalDoi, stored);
    assert.equal(reopened[0].peerReviewed, undefined, stored);
    // The followed feed puts an arXiv record that lists the journal's DOI
    // before a row that began as the paper's SSRN entry.
    const served = PaperBuilder.deduplicate([arxivListingJournal, ...await harvest([ssrnEntry, notRefereed], [article], legacy)]);
    assert.equal(served.length, 1, stored);
    assert.equal(served[0].doi, journalDoi, stored);
    assert.equal(served[0].peerReviewed, legacy ? undefined : false, stored);
    // A row built from scratch that began as the reviewed conference version
    // keeps its `true` when the eprint's records arrive; one stored before
    // reads unknown there, as that code read it. Behind OpenAlex's record of
    // the journal DOI without a source, the row built from scratch answers
    // for that DOI with NASA ADS's `false`; the one stored before lacks it
    // and must not lend that DOI the conference version's `true`.
    const conference = await harvest([conferenceVersion, notRefereed], [eprint, arxivListingJournal], legacy);
    assert.equal(conference.length, 1, stored);
    assert.equal(conference[0].doi, conferenceDoi, stored);
    assert.equal(conference[0].peerReviewed, legacy ? undefined : true, stored);
    const behindJournal = PaperBuilder.deduplicate([withoutSource, ...conference]);
    assert.equal(behindJournal.length, 1, stored);
    assert.equal(behindJournal[0].doi, journalDoi, stored);
    assert.equal(behindJournal[0].peerReviewed, legacy ? undefined : false, stored);
  }
});

test('a paper published before the corpus window is not filed, unless its lane keeps listings', async () => {
  const { env, db } = corpus();
  const old = { ...arxivRecord, id: '2401.00001', arxivId: '2401.00001', title: 'An older paper', published: '2024-01-10T00:00:00.000Z' };
  await ingestPapers(env, [{ paper: old, lanes: ['mech.aero'] }], { now: NOW });
  assert.equal(rows(db, 'SELECT id FROM works').length, 0);
  await ingestPapers(env, [{ paper: old, lanes: ['mech.aero'] }], { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  assert.deepEqual(rows(db, 'SELECT kept_until FROM works').map(row => row.kept_until), ['2026-11-05T03:00:00.000Z']);
});

// esummary dates the issue "2026": read as 1 January, outside the 90 days.
test('a PubMed article in a volume dated by its year alone is filed under the day it went online', async () => {
  const { env, db } = corpus();
  const article = mapPubmedSummary({ uid: '42900002', title: 'A cardiology article in the 2026 volume', source: 'J', pubdate: '2026', epubdate: '2026 Oct 16', pubtype: ['Journal Article'] });
  await ingestPapers(env, [{ paper: article, lanes: ['med.cardio'] }], { now: NOW });
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes').map(row => row.lane), ['med.cardio']);
});

test('a paper past its keeping date leaves with its keys, lanes and vector', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }], { now: NOW });
  db.exec(`INSERT INTO work_vectors (work_id, embedding) SELECT id, x'01' FROM works`);
  // Kept for the corpus's 90 days after 2026-10-10.
  await evictAll(env, Date.parse('2027-01-09T00:00:00Z'));
  for (const table of ['works', 'work_keys', 'work_lanes', 'work_vectors']) {
    assert.equal(rows(db, `SELECT * FROM ${table}`).length, 0, table);
  }
});

test('a page ranks its lanes by the liked papers, says what each was found under and never offers a like', async () => {
  const { env, db } = corpus();
  const paper = (id: string, title: string, published: string) => ({ ...arxivRecord, id, arxivId: id, title, published });
  await ingestPapers(env, [
    { paper: paper('2610.00001', 'Liked paper about proteins', '2026-07-30T00:00:00.000Z'), lanes: ['q-bio.BM'] },
    { paper: paper('2610.00002', 'Close to the liked paper', '2026-10-02T00:00:00.000Z'), lanes: ['q-bio.BM'] },
    { paper: paper('2610.00003', 'Far from it but newer', '2026-10-20T00:00:00.000Z'), lanes: ['q-bio.BM', 'author:A123'] },
  ], { now: NOW });
  const idOf = (paperId: string) => rows(db, `SELECT work_id FROM work_keys WHERE key = 'arxiv:${paperId}'`)[0].work_id;
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  insert.run(idOf('2610.00001') as number, vector([1, 0]));
  insert.run(idOf('2610.00002') as number, vector([1, 0.05]));
  insert.run(idOf('2610.00003') as number, vector([0, 1]));
  const query = parseFeedRequest({
    categories: ['q-bio.BM'],
    follows: [{ type: 'author', canonicalId: 'https://openalex.org/A123', displayName: 'Ana Pérez' }],
    positiveIds: ['arxiv:2610.00001v2'],
    pageSize: 5,
  });
  const page = await readFeedPage(env, query, { now: NOW });
  assert.deepEqual(page.map(item => item.id), ['2610.00002', '2610.00003']);
  assert.deepEqual(page.map(item => item._fetchedFor), [['q-bio.BM'], ['q-bio.BM']]);
  assert.deepEqual(page[1]._followedEntityMatches, [{ type: 'author', canonicalId: 'https://openalex.org/A123', displayName: 'Ana Pérez' }]);
  assert.equal(page[0]._followedEntityMatches, undefined);
  // The like, due to leave on 2026-10-28, is kept while readers rank by it.
  assert.equal(rows(db, `SELECT liked_until FROM works WHERE id = ${idOf('2610.00001')}`)[0].liked_until, '2026-11-21T03:00:00.000Z');
  await evictAll(env, Date.parse('2026-11-01T00:00:00Z'));
  assert.deepEqual(rows(db, "SELECT key FROM work_keys WHERE key = 'arxiv:2610.00001'").length, 1, 'past its date, still ranked by');
});

// D3 (Pablo, 2026-10-25): at most 10 followed journals a reader. A journal's
// lane costs the harvest a list call a night whoever follows it, so the cap
// holds where the lanes are made, whatever a client stored.
test('a request serves at most 10 followed journals, and still its other follows', () => {
  const journals = Array.from({ length: 12 }, (_, index) => ({ type: 'journal', canonicalId: `S${1000 + index}`, displayName: `Journal ${index}` }));
  const author = { type: 'author', canonicalId: 'A5023888391', displayName: 'Wei Zhang' };
  const { follows } = parseFeedRequest({ categories: [], follows: [...journals, author] });
  assert.deepEqual(follows.map(follow => follow.lane), [
    ...Array.from({ length: 10 }, (_, index) => `source:S${1000 + index}`),
    'author:A5023888391',
  ]);
});

test("a request's journals do not take the lanes of its 20 other follows", () => {
  const journals = Array.from({ length: 10 }, (_, index) => ({ type: 'journal', canonicalId: `S${1000 + index}`, displayName: `Journal ${index}` }));
  const others = [
    ...Array.from({ length: 8 }, (_, index) => ({ type: 'author', canonicalId: `A${5000 + index}`, displayName: `Author ${index}` })),
    ...Array.from({ length: 14 }, (_, index) => ({ type: 'topic', canonicalId: `T${2000 + index}`, displayName: `Topic ${index}` })),
  ];
  const { follows } = parseFeedRequest({ categories: [], follows: [...journals, ...others] });
  assert.equal(follows.filter(follow => follow.type === 'journal').length, 10);
  assert.equal(follows.filter(follow => follow.type !== 'journal').length, 20);
});

test('feed feedback is optional, deduplicated, bounded and accepts only string IDs', () => {
  assert.deepEqual(parseFeedRequest(null).negativeIds, []);
  assert.deepEqual(parseFeedRequest(null).excludedIds, []);
  const query = parseFeedRequest({ negativeIds: [null, {}, 1, '', ' rejected ', 'rejected'], excludedIds: [false, ' seen ', 'seen'] });
  assert.deepEqual(query.negativeIds, ['rejected']);
  assert.deepEqual(query.excludedIds, ['seen']);
  const many = parseFeedRequest({ negativeIds: Array.from({ length: 50 }, (_, index) => `negative-${index}`), excludedIds: Array.from({ length: 250 }, (_, index) => `seen-${index}`) });
  assert.equal(many.negativeIds.length, 24);
  assert.equal(many.excludedIds.length, 200);
});

test("the app's ids for a paper find it whichever form they take", () => {
  assert.deepEqual(keysForPaperId('arxiv:2610.11111v3'), ['id:arxiv:2610.11111v3', 'arxiv:2610.11111']);
  assert.deepEqual(keysForPaperId('W4391234567'), ['id:w4391234567', 'id:openalex:w4391234567']);
  assert.deepEqual(keysForPaperId('pmid:41000001'), ['id:pmid:41000001', 'pmid:41000001']);
  assert.deepEqual(keysForPaperId('doi:10.1145/3320269.3372198'), ['id:doi:10.1145/3320269.3372198', '10.1145/3320269.3372198']);
});

test("a reader of economics also gets the working-paper series, filed under none of their categories, and a followed search matches its papers", async () => {
  const { env } = corpus();
  const paper = (id: string, title: string) => ({ ...arxivRecord, id, arxivId: id, title, published: '2026-10-15T00:00:00.000Z', allCategories: [], categories: [] });
  await ingestPapers(env, [
    { paper: paper('2610.00011', 'An econometrics preprint'), lanes: ['econ.EM'] },
    { paper: paper('2610.00012', 'A working paper of a series'), lanes: ['series:working-papers'] },
    { paper: paper('2610.00013', 'A paper a followed search found'), lanes: ['query:large language models'] },
  ], { now: NOW });
  const economics = await readFeedPage(env, parseFeedRequest({ categories: ['econ.EM'] }), { now: NOW });
  assert.deepEqual(economics.map(item => [item.id, item._fetchedFor]).sort(), [['2610.00011', ['econ.EM']], ['2610.00012', undefined]]);
  assert.deepEqual((await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'] }), { now: NOW })).map(item => item.id), [], 'other readers do not get the series');
  const followed = await readFeedPage(env, parseFeedRequest({
    follows: [{ type: 'topic', canonicalId: 'query-topic-1', displayName: 'Large language models', metadata: { query: 'large language models' } }],
  }), { now: NOW });
  assert.deepEqual(followed.map(item => [item.id, item._followedEntityMatches?.map(match => (match as PaperFollowMatch).canonicalId)]), [['2610.00013', ['query-topic-1']]]);
});

// PAP-107: a journal article of a whole area, as its OpenAlex lane lists it.
const physicsWork = {
  id: 'https://openalex.org/W7223244690',
  doi: 'https://doi.org/10.7566/jpsj.95.111002',
  title: 'High-harmonic Generation Spectroscopy in van der Waals Materials',
  type: 'article',
  publication_date: '2026-10-21',
  authorships: [{ author: { id: 'https://openalex.org/A5102845839', display_name: 'Kento Uchida' }, institutions: [] }],
  abstract_inverted_index: { 'High-harmonic': [0], generation: [1], probes: [2], 'electron dynamics in crystalline solids.': [3] },
  primary_location: { is_oa: false, landing_page_url: 'https://doi.org/10.7566/jpsj.95.111002', source: { id: 'https://openalex.org/S119212824', display_name: 'Journal of the Physical Society of Japan', type: 'journal' } },
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  primary_topic: {
    id: 'https://openalex.org/T10566',
    display_name: 'Laser-Matter Interactions and Applications',
    subfield: { id: 'https://openalex.org/subfields/3107', display_name: 'Atomic and Molecular Physics, and Optics' },
    field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' },
  },
} as Parameters<typeof mapOpenAlexWork>[0];
const physicsJournalArticle = mapOpenAlexWork(physicsWork)!;

test("a reader of any leaf of an area is served the area's journal articles, filed under none of their leaves, and eviction keeps them while the lane lists them", async () => {
  const { env, db } = corpus();
  const quantum = { ...arxivRecord, id: '2610.00021', arxivId: '2610.00021', title: 'A quantum error-correcting code', allCategories: ['quant-ph'], categories: ['quant-ph'], primaryCategory: 'quant-ph', published: '2026-10-20T00:00:00.000Z' };
  await ingestPapers(env, [
    { paper: quantum, lanes: [] },
    { paper: physicsJournalArticle, lanes: ['area:physics'] },
  ], { now: NOW });
  const served = async (categories: string[]) => (await readFeedPage(env, parseFeedRequest({ categories }), { now: NOW }))
    .map(item => [item.id, item._fetchedFor]);
  // Newest first: the article is dated a day after the preprint.
  assert.deepEqual(await served(['quant-ph']), [['openalex:W7223244690', undefined], ['2610.00021', ['quant-ph']]]);
  assert.deepEqual(await served(['hep-th']), [['openalex:W7223244690', undefined]], 'any physics leaf');
  assert.deepEqual(await served(['math.AG']), [], 'another area');
  assert.deepEqual(await served(['med.onco']), [], 'another area');
  await evictAll(env, NOW);
  assert.deepEqual(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'area:physics'").length, 1);
  assert.equal(rows(db, 'SELECT id FROM works').length, 2, 'the area lane keeps its paper in the corpus');
});

test("a Chemistry reader is served Chemistry's journal articles, which keep OpenAlex's classification, and a Chemical Engineering reader is not", async () => {
  const { env } = corpus();
  const chemistryArticle = mapOpenAlexWork({
    ...physicsWork,
    id: 'https://openalex.org/W7223244691',
    doi: 'https://doi.org/10.1021/example.chem.1',
    title: 'A Divergent Strategy for the Synthesis of Iridoid Glycosides',
    primary_topic: {
      id: 'https://openalex.org/T10215',
      display_name: 'Synthetic Organic Chemistry Methods',
      subfield: { id: 'https://openalex.org/subfields/1605', display_name: 'Organic Chemistry' },
      field: { id: 'https://openalex.org/fields/16', display_name: 'Chemistry' },
    },
  })!;
  await ingestPapers(env, [{ paper: chemistryArticle, lanes: ['area:chem'] }], { now: NOW });
  const served = async (categories: string[]) => readFeedPage(env, parseFeedRequest({ categories }), { now: NOW });
  const [paper] = await served(['chem.org']);
  assert.equal(paper.id, 'openalex:W7223244691');
  assert.equal(paper.primaryTopic?.subfield?.display_name, 'Organic Chemistry');
  assert.deepEqual(paper.categories, chemistryArticle.categories);
  assert.deepEqual((await served(['chem.spectro'])).map(item => item.id), ['openalex:W7223244691'], 'any chemistry leaf');
  assert.deepEqual(await served(['chemeng.process']), [], 'Chemical Engineering is another area');
});

test("the follows' page reads no area lane: its categories stand for followed topics, which an article found only at area level matches none of", async () => {
  const { env } = corpus();
  const quantum = { ...arxivRecord, id: '2610.00021', arxivId: '2610.00021', title: 'A quantum error-correcting code', allCategories: ['quant-ph'], categories: ['quant-ph'], primaryCategory: 'quant-ph', published: '2026-10-20T00:00:00.000Z' };
  await ingestPapers(env, [
    { paper: quantum, lanes: [] },
    { paper: physicsJournalArticle, lanes: ['area:physics'] },
  ], { now: NOW });
  // As the feed asks for its follows: a followed topic that is one of the
  // app's categories is asked for as that category, beside the follow itself.
  const followed = await readFeedPage(env, parseFeedRequest({
    categories: ['quant-ph'],
    follows: [{ type: 'topic', canonicalId: 'T10017', displayName: 'Quantum error correction' }],
  }), { now: NOW });
  assert.deepEqual(followed.map(item => [item.id, item._fetchedFor]), [['2610.00021', ['quant-ph']]]);
  // A reader whose only follow is a category: it has no lane of its own.
  const categoryFollowed = await readFeedPage(env, parseFeedRequest({
    categories: ['quant-ph'],
    follows: [{ type: 'topic', canonicalId: 'quant-ph', displayName: 'Quantum Physics' }],
  }), { now: NOW });
  assert.deepEqual(categoryFollowed.map(item => [item.id, item._fetchedFor]), [['2610.00021', ['quant-ph']]]);
});

// OpenAlex dates an area's journal articles by day alone, mostly the day
// before the harvest, so newest first a reader's whole day of preprints ranks
// ahead of them (PAP-107 cold-reader measurement, 2026-10-23).
test("journal articles and preprints compete by relevance without a per-page minimum", async () => {
  const { env, db } = corpus();
  const preprints = Array.from({ length: 20 }, (_, index) => ({
    ...arxivRecord, id: `2610.${30001 + index}`, arxivId: `2610.${30001 + index}`, title: `Quantum error correction, result ${index + 1}`,
    allCategories: ['quant-ph'], categories: ['quant-ph'], primaryCategory: 'quant-ph', published: new Date(NOW - (index + 1) * 3_600_000).toISOString(),
  }));
  // 2026-10-21 to 2026-10-17: older than every preprint above.
  const articles = Array.from({ length: 5 }, (_, index) => mapOpenAlexWork({
    ...physicsWork, id: `https://openalex.org/W90000${index + 1}`, doi: `https://doi.org/10.7566/jpsj.95.${index + 1}`,
    title: `Spectroscopy of van der Waals materials, part ${index + 1}`, publication_date: `2026-10-${21 - index}`,
  })!);
  // Liked papers outside the asked lanes, one like the preprints, one like the articles.
  const likedPreprint = { ...arxivRecord, id: '2610.11112', arxivId: '2610.11112', title: 'A liked paper like the preprints' };
  const likedArticle = { ...arxivRecord, id: '2610.11113', arxivId: '2610.11113', title: 'A liked paper like the articles' };
  await ingestPapers(env, [
    ...[...preprints, likedPreprint, likedArticle].map(paper => ({ paper, lanes: [] })),
    ...articles.map(paper => ({ paper, lanes: ['area:physics'] })),
  ], { now: NOW });
  const embed = (id: string, values: number[]) => db.prepare('INSERT INTO work_vectors (work_id, embedding) SELECT work_id, ? FROM work_keys WHERE key = ?')
    .run(Buffer.from(quantize(values).buffer), `id:${id.toLowerCase()}`);
  [...preprints, likedPreprint].forEach(paper => embed(paper.id, [1, 0]));
  [...articles, likedArticle].forEach(paper => embed(paper.id, [0, 1]));

  const page = async (number: number, positiveIds: string[] = []) => {
    const ids = (await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], page: number, positiveIds }), { now: NOW })).map(item => item.id);
    return { preprints: ids.filter(id => !id.startsWith('openalex:')), articles: ids.filter(id => id.startsWith('openalex:')) };
  };
  const preprintIds = preprints.map(paper => paper.id);
  const articleIds = articles.map(paper => paper.id);
  // Newest first, then by either kind of liked paper: no publication quota.
  assert.deepEqual(await page(0), { preprints: preprintIds.slice(0, 15), articles: [] });
  assert.deepEqual(await page(1), { preprints: preprintIds.slice(15), articles: articleIds });
  // By a like that puts every preprint first, the same.
  assert.deepEqual(await page(0, [likedPreprint.id]), { preprints: preprintIds.slice(0, 15), articles: [] });
  // All five relevant articles lead, even though they are older.
  assert.deepEqual(await page(0, [likedArticle.id]), { preprints: preprintIds.slice(0, 10), articles: articleIds });
});

// 30 preprints of the last 30 hours, and 9 older articles of the physics area's lane.
async function preprintsAndArticles() {
  const store = corpus();
  const preprints = Array.from({ length: 30 }, (_, index) => ({
    ...arxivRecord, id: `2610.${40001 + index}`, arxivId: `2610.${40001 + index}`, title: `Quantum error correction, finding ${index + 1}`,
    allCategories: ['quant-ph'], categories: ['quant-ph'], primaryCategory: 'quant-ph', published: new Date(NOW - (index + 1) * 3_600_000).toISOString(),
  }));
  const articles = Array.from({ length: 9 }, (_, index) => mapOpenAlexWork({
    ...physicsWork, id: `https://openalex.org/W91000${index + 1}`, doi: `https://doi.org/10.7566/jpsj.96.${index + 1}`,
    title: `Spectroscopy of layered crystals, part ${index + 1}`, publication_date: `2026-10-${20 - index}`,
  })!);
  await ingestPapers(store.env, [
    ...preprints.map(paper => ({ paper, lanes: [] })),
    ...articles.map(paper => ({ paper, lanes: ['area:physics'] })),
  ], { now: NOW });
  return { ...store, preprintIds: preprints.map(paper => paper.id), articleIds: articles.map(paper => paper.id) };
}

// The app's exploration asks 5 to 8 cards of nearby categories at a random
// page (FeedContext), which reads the same area lanes as the feed's page.
test("all page sizes use the same relevance order", async () => {
  const { env, preprintIds } = await preprintsAndArticles();
  const ids = async (page: number, pageSize: number) => (await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], page, pageSize }), { now: NOW }))
    .map(item => item.id);
  const pages = async (count: number, pageSize: number) => (await Promise.all(Array.from({ length: count }, (_, page) => ids(page, pageSize)))).flat();
  // Newest first, the 30 preprints come before every article.
  assert.deepEqual(await pages(6, 5), preprintIds);
  assert.deepEqual(await pages(3, 8), preprintIds.slice(0, 24));
  assert.deepEqual(await ids(0, 15), preprintIds.slice(0, 15));
});

test("reranking retains served ranks and relevance order without repeating papers", async () => {
  const { env, preprintIds, articleIds } = await preprintsAndArticles();
  // As the corpus feed keeps an order until its follow-up work ends: the ranks served only.
  const kept = new Map<string, KeptRanking>();
  const cache: RankingCache = {
    get: async key => kept.get(key) ?? null,
    put: async (key, ranking) => { kept.set(key, { ...ranking, ranks: ranking.ranks.slice(0, ranking.served), final: false }); },
  };
  const page = async (number: number) => (await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], page: number }), { now: NOW, cache }))
    .map(item => item.id);
  const first = await page(0);
  // A preprint the harvest files before the next page.
  const newest = { ...arxivRecord, id: '2610.49999', arxivId: '2610.49999', title: 'Quantum error correction, the newest finding', allCategories: ['quant-ph'], categories: ['quant-ph'], primaryCategory: 'quant-ph', published: new Date(NOW - 1_800_000).toISOString() };
  await ingestPapers(env, [{ paper: newest, lanes: [] }], { now: NOW });
  const [second, third] = [await page(1), await page(2)];
  const articlesOf = (ids: string[]) => ids.filter(id => id.startsWith('openalex:'));
  assert.deepEqual([first, second, third].map(articlesOf), [[], [], articleIds]);
  assert.deepEqual(second.slice(0, 1), [newest.id], 'the paper that arrived starts the next page');
  assert.deepEqual([...first, ...second, ...third].sort(), [...preprintIds, newest.id, ...articleIds].sort(), 'every paper once');
});

// OpenAlex dates an article by its day alone, so one night's articles of every
// area share their date: of each area's 200 newest on 2026-10-23, 191 computer
// science and 197 physics articles were dated 2026-10-22 (PAP-107 review).
test("equally recent articles take turns across areas after newer candidates", async () => {
  const { env } = corpus();
  // A reader of an optimization and a learning category: 40 preprints of the last 20 hours.
  const preprints = Array.from({ length: 40 }, (_, index) => {
    const category = index % 2 ? 'cs.LG' : 'math.OC';
    return {
      ...arxivRecord, id: `2610.${50001 + index}`, arxivId: `2610.${50001 + index}`, title: `Optimization for learning, result ${index + 1}`,
      allCategories: [category], categories: [category], primaryCategory: category, published: new Date(NOW - (index + 1) * 1_800_000).toISOString(),
    };
  });
  const article = (area: 'ai' | 'math', index: number) => ({
    paper: mapOpenAlexWork({
      ...physicsWork, id: `https://openalex.org/W9${area === 'ai' ? 3 : 4}000${index + 1}`, doi: `https://doi.org/10.1000/${area}.${index + 1}`,
      title: `A journal article of the ${area} area, number ${index + 1}`, publication_date: '2026-10-21',
    })!,
    lanes: [`area:${area}`],
  });
  await ingestPapers(env, [
    ...preprints.map(paper => ({ paper, lanes: [] })),
    ...Array.from({ length: 6 }, (_, index) => article('ai', index)),
    ...Array.from({ length: 6 }, (_, index) => article('math', index)),
  ], { now: NOW });
  const areasOn = async (page: number) => {
    const ids = (await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG', 'math.OC'], page }), { now: NOW })).map(item => item.id);
    return { ai: ids.filter(id => id.startsWith('openalex:W93')).length, math: ids.filter(id => id.startsWith('openalex:W94')).length };
  };
  const [first, second] = [await areasOn(2), await areasOn(3)];
  assert.ok(first.ai > 0 && first.math > 0, `the first page holds both areas' articles: ${JSON.stringify(first)}`);
  assert.deepEqual({ ai: first.ai + second.ai, math: first.math + second.math }, { ai: 6, math: 6 });
});

test("an area's journal lane is read beside a reader's own lanes, not out of their candidates: a like still finds a preprint 17 days back in a busy category", async () => {
  const { env, db } = corpus();
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertKey = db.prepare('INSERT INTO work_keys (key, work_id) VALUES (?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  const insertVector = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const add = (workId: number, paperId: string, published: string, lane: string | null, like: number[]) => {
    insertWork.run(workId, JSON.stringify({ id: paperId, title: `Paper ${paperId}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertKey.run(`id:${paperId.toLowerCase()}`, workId);
    if (lane) insertLane.run(lane, workId, published);
    insertVector.run(workId, Buffer.from(quantize(like).buffer));
  };
  db.exec('BEGIN');
  // A busy category: 2,600 preprints, one every 10 minutes for 18 days. Only
  // the 2,401st newest is like the reader's like, which is in no asked lane.
  for (let index = 0; index < 2_600; index += 1) {
    add(index + 1, `2610.${10_000 + index}`, new Date(NOW - (index + 1) * 600_000).toISOString(), 'cs.LG', index === 2_400 ? [0, 0, 1] : [1, 0, 0]);
  }
  add(2_601, '2609.99999', new Date(NOW - 3 * 86_400_000).toISOString(), null, [0, 0, 1]);
  // The area's journal lane, as full as a few weeks of nights make it: 200 articles a night.
  for (let index = 0; index < 2_000; index += 1) {
    add(3_000 + index, `openalex:W95${String(index).padStart(5, '0')}`, `2026-10-${21 - Math.floor(index / 200)}T00:00:00.000Z`, 'area:ai', [0, 1, 0]);
  }
  db.exec('COMMIT');
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], positiveIds: ['2609.99999'] }), { now: NOW });
  assert.equal(page[0]?.id, '2610.12400');
});

test('the area lanes a request reads give at most 800 candidates together, in equal shares, though 800 does not divide by their number', async () => {
  const { env, db } = corpus();
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  const areas = ['ai', 'math', 'physics'];
  db.exec('BEGIN');
  // Three nights of 100 articles in each of three areas.
  areas.forEach((area, areaIndex) => {
    for (let index = 0; index < 300; index += 1) {
      const workId = areaIndex * 1_000 + index + 1;
      const published = `2026-10-${21 - Math.floor(index / 100)}T00:00:00.000Z`;
      insertWork.run(workId, JSON.stringify({ id: `openalex:W9${areaIndex}${String(index).padStart(4, '0')}`, title: `Article ${workId}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
      insertLane.run(`area:${area}`, workId, published);
    }
  });
  db.exec('COMMIT');
  const ranked: string[] = [];
  for (let page = 0; ; page += 1) {
    const papers = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG', 'math.OC', 'quant-ph'], page, pageSize: 30 }), { now: NOW });
    if (papers.length === 0) break;
    ranked.push(...papers.map(paper => paper.id));
  }
  const perArea = areas.map((_, areaIndex) => ranked.filter(id => id.startsWith(`openalex:W9${areaIndex}`)).length);
  assert.ok(ranked.length <= 800, `${ranked.length} area candidates: ${perArea.join(' + ')}`);
  assert.ok(ranked.length > 800 - areas.length, `${ranked.length} area candidates`);
  assert.deepEqual(perArea, perArea.map(() => perArea[0]), 'an equal share of each area');
});

// An area's lane lists articles without an abstract too (PAP-107); the mapper
// stands "No abstract available." in for the missing one.
test('a paper without an abstract is embedded by its title alone, not by the words standing in for the abstract', async () => {
  const { binding } = testD1();
  const embedded: string[] = [];
  const env = {
    PAPER_STORE: binding,
    REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
    AI: { run: async (_model: string, { text }: { text: string[] }) => {
      embedded.push(...text);
      return { data: text.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))) };
    } },
  } as unknown as Parameters<typeof embedPending>[0];
  const withoutAbstract = mapOpenAlexWork({ ...physicsWork, abstract_inverted_index: null })!;
  assert.equal(withoutAbstract.abstract, 'No abstract available.');
  await ingestPapers(env, [{ paper: withoutAbstract, lanes: ['area:physics'] }, { paper: arxivRecord, lanes: [] }], { now: NOW });
  assert.equal(await embedPending(env, 10), 2);
  // Newest first: the article is from 2026-10-21, the preprint from 2026-10-10.
  assert.deepEqual(embedded, ['High-harmonic Generation Spectroscopy in van der Waals Materials', 'Sparse attention for long documents\n\nWe make attention sparse.']);
});

test('two writers filing one paper at once meet on one row, and a short title joins nothing', async () => {
  const { env, db } = corpus();
  await Promise.all([
    ingestPapers(env, [{ paper: arxivRecord, lanes: [] }], { now: NOW }),
    ingestPapers(env, [{ paper: arxivRecord, lanes: ['cs.AI'] }], { now: NOW }),
  ]);
  assert.equal(rows(db, 'SELECT id FROM works').length, 1);
  // "2024" by a Wang is no paper's fingerprint: two such records stay two papers.
  const short = (id: string) => ({ ...arxivRecord, id, arxivId: id, title: '2024', authors: [{ name: 'Wei Wang' }] });
  await ingestPapers(env, [{ paper: short('2610.00031'), lanes: [] }, { paper: short('2610.00032'), lanes: [] }], { now: NOW });
  assert.equal(rows(db, 'SELECT id FROM works').length, 3);
});

test('a lane keeps the newest papers a page can rank from, and a paper left in no lane goes', async () => {
  const { env, db } = corpus();
  // More than the 4,000 a lane keeps, in one category, a day apart.
  const many = Array.from({ length: 4_003 }, (_, index) => ({
    paper: { ...arxivRecord, id: `2610.${String(index).padStart(5, '0')}`, arxivId: `2610.${String(index).padStart(5, '0')}`, title: `Paper number ${index} of a busy category`, allCategories: [], categories: [], published: new Date(NOW - index * 60_000).toISOString() },
    lanes: ['cs.LG'],
  }));
  await ingestPapers(env, many, { now: NOW });
  await evictAll(env, NOW);
  assert.equal(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'cs.LG'").length, 4_000);
  assert.equal(rows(db, 'SELECT id FROM works').length, 4_000, 'the three oldest, in no lane now, are gone');
  assert.equal(rows(db, "SELECT key FROM work_keys WHERE key = 'arxiv:2610.04002'").length, 0);
});

test('eviction resumes through bounded batches and removes expired records with their children', async () => {
  const { env, db } = corpus();
  const insert = db.prepare("INSERT INTO works (id, paper, published, kept_until) VALUES (?, '{}', '2026-07-01', '2026-08-01')");
  const key = db.prepare('INSERT INTO work_keys (key, work_id) VALUES (?, ?)');
  const lane = db.prepare("INSERT INTO work_lanes (lane, work_id, published) VALUES ('cs.CL', ?, '2026-07-01')");
  const vector = db.prepare("INSERT INTO work_vectors (work_id, embedding) VALUES (?, x'01')");
  for (let id = 1; id <= 1_200; id += 1) {
    insert.run(id);
    key.run(`id:expired-${id}`, id);
    lane.run(id);
    vector.run(id);
  }
  db.prepare('UPDATE works SET liked_until = ? WHERE id = 900').run(daysFromNow(30, NOW));
  let cursor = await evictExpired(env, NOW);
  assert.equal(rows(db, 'SELECT id FROM works').length, 700);
  assert.equal(cursor, 500);
  cursor = await evictExpired(env, NOW, cursor);
  assert.equal(cursor, 1_000);
  assert.equal(await evictExpired(env, NOW, cursor), null);
  assert.deepEqual(rows(db, 'SELECT id FROM works').map(row => row.id), [900]);
  for (const table of ['work_keys', 'work_lanes', 'work_vectors']) {
    assert.deepEqual(rows(db, `SELECT work_id FROM ${table}`).map(row => row.work_id), [900]);
  }
});

test('the leaves under 300 papers in 30 days are reported, fewest first', async () => {
  const { env, db } = corpus();
  const lane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  for (let id = 1; id <= 300; id += 1) lane.run('mech.fluid', id, daysFromNow(-29, NOW));
  lane.run('mech.cad', 301, daysFromNow(-1, NOW));
  lane.run('mech.cad', 302, daysFromNow(-29, NOW));
  lane.run('eess.telecom', 303, '2009-06-01T00:00:00.000Z');
  const thin = await thinLeaves(env.PAPER_STORE!, NOW);
  assert.deepEqual(thin.filter(entry => ['mech.fluid', 'mech.cad', 'eess.telecom'].includes(entry.leaf)), [{ leaf: 'eess.telecom', recent: 0 }, { leaf: 'mech.cad', recent: 2 }]);
});

test("the thin leaves step's output fits what the Workflows API keeps, and its log line names every leaf", () => {
  // The worst case the taxonomy allows: every leaf under the floor, the
  // longest ids first, each one character short of the floor.
  const leaves = getAllLeafCategories().map(leaf => leaf.id).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const thin = leaves.map(leaf => ({ leaf, recent: 299 }));
  const { line, summary } = thinLeavesReport(thin);
  assert.equal(summary.under, leaves.length);
  assert.equal(summary.thinnest.length, 30);
  assert.deepEqual(summary.thinnest.slice(0, 2), [`${leaves[0]}:299`, `${leaves[1]}:299`]);
  assert.ok(JSON.stringify(summary).length < 1_000, `${JSON.stringify(summary).length} characters`);
  assert.ok(line.startsWith(`${leaves.length} leaves under 300 papers in 30 days: ${leaves[0]}:299 ${leaves[1]}:299 `));
  assert.ok(line.endsWith(` ${leaves.at(-1)}:299`));
  assert.deepEqual(thinLeavesReport([]).summary, { under: 0, thinnest: [] });
});

test("a vector keeps its leading dimensions, and a cut one compares like a whole one", () => {
  const full = Array.from({ length: 1024 }, (_, index) => Math.sin(index + 1));
  assert.equal(quantize(full).length, 256);
  // What migration 0004 leaves of a vector stored whole: its first 256 bytes, no longer a unit vector.
  const storedWhole = Int8Array.from(full, value => Math.round((value / Math.hypot(...full)) * 127)).slice(0, 256);
  const close = full.map((value, index) => value + (index % 7 === 0 ? 0.05 : 0));
  const far = full.map((value, index) => (index % 2 ? -value : value));
  const rows = [
    { id: 'far', embedding: quantize(far), published: '2026-10-20T00:00:00Z' },
    { id: 'close', embedding: quantize(close), published: '2026-10-01T00:00:00Z' },
  ];
  const now = Date.parse('2026-10-22T00:00:00Z');
  assert.deepEqual(rankBySimilarity(rows, [storedWhole], { now }).map(({ row }) => row.id), ['close', 'far']);
  assert.deepEqual(rankBySimilarity(rows, [quantize(full)], { now }).map(({ row }) => row.id), ['close', 'far']);
});

test("a reader's later pages read the order the first page ranked, and only their own papers", async () => {
  const { env, db } = corpus();
  await ingestPapers(env, Array.from({ length: 6 }, (_, index) => ({
    paper: { ...arxivRecord, id: `2610.0010${index}`, arxivId: `2610.0010${index}`, title: `Paper ${index} on attention`, allCategories: [], categories: [], published: `2026-10-1${index}T00:00:00.000Z` },
    lanes: ['cs.CL'],
  })), { now: NOW });
  const stored = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => (stored.get(key) as never) ?? null,
    put: async (key: string, ranking: unknown) => { stored.set(key, ranking); },
  };
  const first = await readFeedPage(env, parseFeedRequest({ categories: ['cs.CL'], pageSize: 2 }), { now: NOW, cache });
  assert.deepEqual(first.map(paper => paper.id), ['2610.00105', '2610.00104']);
  // Whatever the lanes hold now, the session's next page follows the order it was shown.
  db.exec("DELETE FROM work_lanes");
  const second = await readFeedPage(env, parseFeedRequest({ categories: ['cs.CL'], page: 1, pageSize: 2 }), { now: NOW, cache });
  assert.deepEqual(second.map(paper => paper.id), ['2610.00103', '2610.00102']);
  assert.deepEqual(await readFeedPage(env, parseFeedRequest({ categories: ['cs.CL'], page: 1, pageSize: 2 }), { now: NOW }), [], 'without the order, the page ranks again');
});

// ─── Interest groups (ENG-137) ───

test('a request without interest groups is one group; with groups, its categories and likes are their union', () => {
  assert.deepEqual(parseFeedRequest({ categories: ['quant-ph', 'econ.GN'], positiveIds: ['a', 'b'] }).groups, [
    { categories: ['quant-ph', 'econ.GN'], exampleCategories: ['quant-ph', 'econ.GN'], positiveIds: ['a', 'b'], weight: 1 },
  ]);
  const groups = [
    { categories: ['quant-ph', 'hep-th'], exampleCategories: ['quant-ph', 'hep-th'], positiveIds: ['a'], weight: 1 },
    { categories: ['econ.GN', 'quant-ph'], exampleCategories: ['econ.GN'], positiveIds: ['b', 'a'], weight: 2 },
  ];
  // The app also sends the union, and the likes no group holds, at the top level.
  const query = parseFeedRequest({ categories: ['quant-ph', 'econ.GN'], positiveIds: ['a', 'b', 'c'], groups });
  assert.deepEqual(query.categories, ['quant-ph', 'hep-th', 'econ.GN']);
  assert.deepEqual(query.positiveIds, ['a', 'b', 'c']);
  assert.deepEqual(query.groups, groups);
});

test('an interest group without a valid category or with a weight outside (0, 10] is left out, and a request ranks at most 12', () => {
  const valid = { categories: ['cs.LG'], exampleCategories: ['cs.LG'], positiveIds: [], weight: 1 };
  const kept = parseFeedRequest({
    groups: [
      { ...valid, categories: ['not a category!', null] },
      ...[Number.NaN, Infinity, 0, -1, 10.5, '2', null].map(weight => ({ ...valid, weight })),
      { ...valid, categories: ['math.AG'], weight: 10 },
    ],
  });
  assert.deepEqual(kept.groups, [{ ...valid, categories: ['math.AG'], weight: 10 }]);
  assert.equal(parseFeedRequest({ groups: Array.from({ length: 13 }, () => valid) }).groups.length, 12);
});

test("interest groups' union keeps a request's 12 categories and 24 likes, and each group keeps only what the union holds", () => {
  const leaves = getAllLeafCategories().map(leaf => leaf.id);
  const query = parseFeedRequest({
    groups: Array.from({ length: 3 }, (_, group) => ({
      categories: leaves.slice(group * 5, group * 5 + 5),
      exampleCategories: leaves.slice(group * 5, group * 5 + 5),
      positiveIds: Array.from({ length: 10 }, (_, index) => `paper-${group}-${index}`),
      weight: 1,
    })),
  });
  assert.deepEqual(query.categories, leaves.slice(0, 12));
  assert.equal(query.positiveIds.length, 24);
  assert.deepEqual(query.groups.map(group => group.categories.length), [5, 5, 2]);
  assert.deepEqual(query.groups.map(group => group.positiveIds.length), [10, 10, 4]);
});

test('interest groups take turns on the page by weight, and a paper two groups ranked comes once', () => {
  const ranks = (...ids: number[]) => ids.map(workId => ({ workId, lanes: [] }));
  const ids = (lists: ReturnType<typeof ranks>[], weights: number[]) => interleaveByWeight(lists, weights).map(candidate => candidate.workId);
  assert.deepEqual(ids([ranks(1, 2, 3, 4), ranks(11, 12)], [2, 1]), [1, 11, 2, 3, 12, 4]);
  assert.deepEqual(ids([ranks(1, 2), ranks(1, 3)], [1, 1]), [1, 3, 2], 'the second group gives its next paper instead');
  assert.deepEqual(ids([ranks(), ranks(1), ranks(11, 12, 13)], [3, 5, 1]), [1, 11, 12, 13], 'a group without papers left gives up its turns');
});

// A reader of quantum physics, who liked a physics paper, and of general
// economics, who has liked nothing there yet. The newest physics preprint is
// the least like the liked paper, and the oldest economics preprint is a copy
// of it: ranked by that like, it would lead.
async function physicsAndEconomics() {
  const store = corpus();
  const preprint = (id: string, category: string, published: number) => ({
    ...arxivRecord, id, arxivId: id, title: `A ${category} preprint, ${id}`, allCategories: [category], categories: [category], primaryCategory: category,
    published: new Date(published).toISOString(),
  });
  const liked = preprint('2610.60000', 'quant-ph', NOW - 20 * 86_400_000);
  const physics = Array.from({ length: 8 }, (_, index) => preprint(`2610.${60001 + index}`, 'quant-ph', NOW - (index + 1) * 3_600_000));
  const economics = Array.from({ length: 12 }, (_, index) => preprint(`2610.${61001 + index}`, 'econ.GN', NOW - (index + 1) * 3_600_000 - 1_800_000));
  await ingestPapers(store.env, [liked, ...physics, ...economics].map(paper => ({ paper, lanes: [] })), { now: NOW });
  // `share` of the liked paper's direction and the rest on a dimension of its own:
  // two physics preprints are never close enough for the diversity pass to reorder them.
  const direction = (dimension: number, share: number) => Array.from({ length: 32 }, (_, index) => (index === 0 ? share : index === dimension ? Math.sqrt(1 - share ** 2) : 0));
  const embed = (id: string, values: number[]) => store.db.prepare('INSERT INTO work_vectors (work_id, embedding) SELECT work_id, ? FROM work_keys WHERE key = ?')
    .run(Buffer.from(quantize(values).buffer), `id:${id.toLowerCase()}`);
  embed(liked.id, direction(0, 1));
  physics.forEach((paper, index) => embed(paper.id, direction(index + 1, 0.44 + 0.06 * index)));
  economics.forEach((paper, index) => embed(paper.id, direction(index + 10, index === economics.length - 1 ? 1 : 0)));
  return { ...store, liked: liked.id, physics: physics.map(paper => paper.id), economics: economics.map(paper => paper.id), embed, direction };
}

const interestGroups = (physicsPositives: string[], weights = [1, 2]) => [
  { categories: ['quant-ph'], exampleCategories: ['quant-ph'], positiveIds: physicsPositives, weight: weights[0] },
  { categories: ['econ.GN'], exampleCategories: ['econ.GN'], positiveIds: [], weight: weights[1] },
];

async function servedByGroup(env: Parameters<typeof readFeedPage>[0], body: Parameters<typeof parseFeedRequest>[0], physics: string[], economics: string[]) {
  const ids = (await readFeedPage(env, parseFeedRequest(body), { now: NOW })).map(paper => paper.id);
  return { ids, physics: ids.filter(id => physics.includes(id)), economics: ids.filter(id => economics.includes(id)) };
}

test('each interest group ranks its own candidates by its own likes, and a group of twice the weight takes about twice the places', async () => {
  const { env, liked, physics, economics } = await physicsAndEconomics();
  const served = await servedByGroup(env, { categories: ['quant-ph', 'econ.GN'], positiveIds: [liked], groups: interestGroups([liked]) }, physics, economics);
  assert.equal(served.ids.length, 15);
  assert.ok(Math.abs(served.economics.length - 10) <= 1, `${served.economics.length} of 15 are economics`);
  assert.deepEqual(served.physics, [...physics].reverse().slice(0, served.physics.length), 'closest to the physics like first');
  assert.deepEqual(served.economics, economics.slice(0, served.economics.length), 'newest first: the physics like does not rank economics');
});

// Focus 1: a profile stored before examples had a category sends them in no group.
test("a like in no group ranks the groups whose example categories hold its stored paper's categories, and no other", async () => {
  const { env, liked, physics, economics } = await physicsAndEconomics();
  const served = await servedByGroup(env, { categories: ['quant-ph', 'econ.GN'], positiveIds: [liked], groups: interestGroups([]) }, physics, economics);
  assert.deepEqual(served.physics, [...physics].reverse().slice(0, served.physics.length), 'closest to the like first');
  assert.deepEqual(served.economics, economics.slice(0, served.economics.length), 'newest first');
});

// A journal article of an area's lane names none of the app's leaves, only
// OpenAlex's concepts; a working paper names its area. Like the physics like,
// either is a copy of the oldest economics preprint.
test("a like in no group whose paper names no leaf ranks the group of the area its primary category names or whose journal lane lists it", async () => {
  const { env, liked, physics, economics, embed, direction } = await physicsAndEconomics();
  const article = { ...mapOpenAlexWork({ ...physicsWork, id: 'https://openalex.org/W8200001', doi: 'https://doi.org/10.7566/jpsj.97.1', publication_date: '2026-09-01' })!, primaryCategory: '', categories: ['Physics', 'Optics'] };
  const workingPaper = {
    ...arxivRecord, id: 'repec:wp-2026-01', arxivId: undefined, doi: undefined, title: 'A working paper on bank capital', allCategories: [], categories: ['econ'], primaryCategory: 'econ',
    published: '2026-09-01T00:00:00.000Z',
  };
  await ingestPapers(env, [{ paper: article, lanes: ['area:physics'] }, { paper: workingPaper, lanes: ['series:working-papers'] }], { now: NOW });
  embed(article.id, direction(0, 1));
  embed(workingPaper.id, direction(0, 1));
  // The fixture's physics like, a copy of these, is not a like here: out of the way.
  const groups = interestGroups([]);
  const byArticle = await servedByGroup(env, { categories: ['quant-ph', 'econ.GN'], positiveIds: [article.id], excludedIds: [liked], groups }, physics, economics);
  assert.deepEqual(byArticle.physics, [...physics].reverse().slice(0, byArticle.physics.length), 'the article orders physics');
  assert.deepEqual(byArticle.economics, economics.slice(0, byArticle.economics.length), 'and not economics');
  const byWorkingPaper = await servedByGroup(env, { categories: ['quant-ph', 'econ.GN'], positiveIds: [workingPaper.id], excludedIds: [liked], groups }, physics, economics);
  assert.equal(byWorkingPaper.economics[0], economics.at(-1), 'the working paper orders economics');
  assert.deepEqual(byWorkingPaper.physics, physics.slice(0, byWorkingPaper.physics.length), 'and not physics');
});

test('an ungrouped like in an unlisted arXiv category ranks only its area, and sleeps when that area is removed', async () => {
  const { env, liked, physics, economics, embed, direction } = await physicsAndEconomics();
  const legacy = {
    ...arxivRecord, id: '2610.62001', arxivId: '2610.62001', title: 'Disordered spin systems',
    allCategories: ['cond-mat.dis-nn'], categories: ['cond-mat.dis-nn'], primaryCategory: 'cond-mat.dis-nn',
    published: '2026-09-01T00:00:00.000Z',
  };
  await ingestPapers(env, [{ paper: legacy, lanes: [] }], { now: NOW });
  embed(legacy.id, direction(0, 1));
  const groups = interestGroups([]);
  const request = { positiveIds: [legacy.id], excludedIds: [liked] };
  const economicsOnly = await servedByGroup(env, { ...request, groups: [groups[1]] }, physics, economics);
  assert.deepEqual(economicsOnly.ids, economics, 'removing Physics leaves Economics ordered by recency');
  const restored = await servedByGroup(env, { ...request, groups }, physics, economics);
  assert.deepEqual(restored.physics, [...physics].reverse().slice(0, restored.physics.length), 'restoring Physics restores its legacy like');
  assert.deepEqual(restored.economics, economics.slice(0, restored.economics.length), 'the Physics like never orders Economics');
});

test('a like in no group of an area no group holds ranks none, and one of no known area ranks every group', async () => {
  const { env, liked, physics, economics, embed, direction } = await physicsAndEconomics();
  const paper = (id: string, primaryCategory: string, categories: string[]) => ({
    ...arxivRecord, id, arxivId: undefined, doi: undefined, title: `A liked paper, ${id}`, allCategories: [], categories, primaryCategory, published: '2026-09-01T00:00:00.000Z',
  });
  const left = paper('pmid:41000101', 'math.AG', ['math.AG']);
  const unknown = paper('pmid:41000102', '', ['Some concept']);
  await ingestPapers(env, [{ paper: left, lanes: ['topic:T99901'] }, { paper: unknown, lanes: ['topic:T99902'] }], { now: NOW });
  embed(left.id, direction(0, 1));
  embed(unknown.id, direction(0, 1));
  const groups = interestGroups([]);
  const byLeft = await servedByGroup(env, { categories: ['quant-ph', 'econ.GN'], positiveIds: [left.id], excludedIds: [liked], groups }, physics, economics);
  assert.deepEqual(byLeft.physics, physics.slice(0, byLeft.physics.length), 'an area the reader left orders neither group');
  assert.deepEqual(byLeft.economics, economics.slice(0, byLeft.economics.length));
  const byUnknown = await servedByGroup(env, { categories: ['quant-ph', 'econ.GN'], positiveIds: [unknown.id], excludedIds: [liked], groups }, physics, economics);
  assert.deepEqual(byUnknown.physics, [...physics].reverse().slice(0, byUnknown.physics.length), 'an unknown area orders physics');
  assert.equal(byUnknown.economics[0], economics.at(-1), 'and economics');
});

// R6: a new subarea's group sits beside its area's group, in either order.
test("an area's journal article goes to the group asking for most of the area's leaves, whichever the app lists first", async () => {
  const { env, db } = corpus();
  const liked = { ...arxivRecord, id: '2610.62000', arxivId: '2610.62000', title: 'A liked particle physics preprint', allCategories: ['hep-ph'], categories: ['hep-ph'], primaryCategory: 'hep-ph', published: '2026-10-01T00:00:00.000Z' };
  const articles = Array.from({ length: 4 }, (_, index) => mapOpenAlexWork({
    ...physicsWork, id: `https://openalex.org/W820010${index}`, doi: `https://doi.org/10.7566/jpsj.98.${index}`, title: `A physics journal article, part ${index + 1}`, publication_date: `2026-10-${21 - index}`,
  })!);
  await ingestPapers(env, [{ paper: liked, lanes: [] }, ...articles.map(paper => ({ paper, lanes: ['area:physics'] }))], { now: NOW });
  const embed = (id: string, values: number[]) => db.prepare('INSERT INTO work_vectors (work_id, embedding) SELECT work_id, ? FROM work_keys WHERE key = ?')
    .run(Buffer.from(quantize(values).buffer), `id:${id.toLowerCase()}`);
  // The subarea's like is a copy of the oldest article: ranked by it, that article would lead.
  embed(liked.id, [1, 0, 0, 0, 0]);
  articles.forEach((paper, index) => embed(paper.id, index === articles.length - 1 ? [1, 0, 0, 0, 0] : [0, ...Array.from({ length: 4 }, (_, dimension) => (dimension === index ? 1 : 0))]));
  const area = { categories: ['quant-ph', 'hep-th', 'gr-qc'], exampleCategories: ['quant-ph', 'hep-th', 'gr-qc', 'hep-ph'], positiveIds: [], weight: 1 };
  const subarea = { categories: ['hep-ph'], exampleCategories: ['quant-ph', 'hep-th', 'gr-qc', 'hep-ph'], positiveIds: [liked.id], weight: 1 };
  for (const groups of [[area, subarea], [subarea, area]]) {
    const page = await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph', 'hep-th', 'gr-qc', 'hep-ph'], positiveIds: [liked.id], groups }), { now: NOW });
    assert.deepEqual(page.map(paper => paper.id), articles.map(paper => paper.id), 'newest first, as the area group without likes ranks them');
  }
});

// Focus 3: a subarea with almost nothing in the corpus.
test('a group without candidates leaves the page to the other groups, which fill it', async () => {
  const { env, liked, physics, economics } = await physicsAndEconomics();
  const groups = [{ categories: ['math.AG'], exampleCategories: ['math.AG'], positiveIds: [], weight: 5 }, ...interestGroups([liked])];
  const served = await servedByGroup(env, { categories: ['math.AG', 'quant-ph', 'econ.GN'], positiveIds: [liked], groups }, physics, economics);
  assert.equal(served.ids.length, 15);
  assert.equal(served.physics.length + served.economics.length, 15);
});

test("a later page with the same interest groups reads the first page's order, and one with another weight ranks again", async () => {
  const { env, db, liked } = await physicsAndEconomics();
  const stored = new Map<string, KeptRanking>();
  const cache: RankingCache = { get: async key => stored.get(key) ?? null, put: async (key, ranking) => { stored.set(key, ranking); } };
  const request = (page: number, weights: number[]) => parseFeedRequest({ categories: ['quant-ph', 'econ.GN'], positiveIds: [liked], groups: interestGroups([liked], weights), page, pageSize: 4 });
  const first = (await readFeedPage(env, request(0, [1, 2]), { now: NOW, cache })).map(paper => paper.id);
  db.exec('DELETE FROM work_lanes');
  const second = (await readFeedPage(env, request(1, [1, 2]), { now: NOW, cache })).map(paper => paper.id);
  assert.equal(second.length, 4);
  assert.deepEqual(second.filter(id => first.includes(id)), []);
  assert.deepEqual(await readFeedPage(env, request(1, [1, 3]), { now: NOW, cache }), [], 'another weight is another order');
});

test('seen aliases are excluded before pagination, including provisional rankings and cache misses', async () => {
  const { env } = corpus();
  await ingestPapers(env, Array.from({ length: 7 }, (_, index) => ({
    paper: { ...arxivRecord, id: `2610.0030${index}`, arxivId: `2610.0030${index}`, doi: undefined, title: `Seen pagination example ${index}`, published: `2026-10-1${index}T00:00:00.000Z`, allCategories: [], categories: [] },
    lanes: ['cs.CL'],
  })), { now: NOW });
  const stored = new Map<string, import('./paper-store.ts').KeptRanking>();
  const cache = {
    get: async (key: string) => stored.get(key) ?? null,
    put: async (key: string, ranking: import('./paper-store.ts').KeptRanking) => { stored.set(key, { ...ranking, final: false }); },
  };
  const query = { categories: ['cs.CL'], excludedIds: ['arxiv:2610.00306v2', '2610.00305'], pageSize: 2 };
  const first = await readFeedPage(env, parseFeedRequest(query), { now: NOW, cache });
  assert.deepEqual(first.map(paper => paper.id), ['2610.00304', '2610.00303']);
  const second = await readFeedPage(env, parseFeedRequest({ ...query, page: 1 }), { now: NOW, cache });
  assert.deepEqual(second.map(paper => paper.id), ['2610.00302', '2610.00301']);
  const missed = await readFeedPage(env, parseFeedRequest({ ...query, page: 1 }), { now: NOW });
  assert.deepEqual(missed.map(paper => paper.id), ['2610.00302', '2610.00301']);
  const refreshed = await readFeedPage(env, parseFeedRequest({ ...query, excludedIds: [...query.excludedIds, ...first.map(paper => paper.id)] }), { now: NOW, cache });
  assert.deepEqual(refreshed.map(paper => paper.id), ['2610.00302', '2610.00301']);
});

test('a client can relax exhausted exclusions while positives and explicit rejections stay excluded', async () => {
  const { env } = corpus();
  await ingestPapers(env, Array.from({ length: 3 }, (_, index) => ({
    paper: { ...arxivRecord, id: `2610.0040${index}`, arxivId: `2610.0040${index}`, doi: undefined, title: `Exhausted seen fallback ${index}`, published: `2026-10-1${index}T00:00:00.000Z`, allCategories: [], categories: [] },
    lanes: ['cs.CL'],
  })), { now: NOW });
  const query = parseFeedRequest({ categories: ['cs.CL'], positiveIds: ['2610.00400'], negativeIds: ['2610.00401'], excludedIds: ['arxiv:2610.00402v2'], pageSize: 15 });
  assert.deepEqual(await readFeedPage(env, query, { now: NOW }), []);
  const relaxed = { ...query, excludedIds: [] };
  assert.deepEqual((await readFeedPage(env, relaxed, { now: NOW })).map(paper => paper.id), ['2610.00402']);
  assert.deepEqual(await readFeedPage(env, { ...relaxed, page: 1 }, { now: NOW }), []);
  assert.deepEqual(await readFeedPage(env, { ...query, negativeIds: ['2610.00401', '2610.00402'] }, { now: NOW }), []);
});

// ─── Notable papers in the feed ───

// Three of cs.LG's most-cited articles as its notable lane files them
// (paper-sources.ts), from OpenAlex's records of 2026-10-23 (trimmed).
const notableWork = (id: string, title: string, date: string, citations: number, isOa: boolean) => mapOpenAlexWork({
  id: `https://openalex.org/${id}`,
  doi: `https://doi.org/10.1/${id}`,
  title,
  type: 'article',
  publication_date: date,
  publication_year: Number(date.slice(0, 4)),
  cited_by_count: citations,
  primary_location: { is_oa: isOa, landing_page_url: `https://doi.org/10.1/${id}`, source: { id: 'https://openalex.org/S1', display_name: 'A core journal', type: 'journal' } },
  open_access: { is_oa: isOa, oa_status: isOa ? 'diamond' : 'closed', oa_url: null },
})!;
const NOTABLE = [
  notableWork('W4309674289', 'Survey of Hallucination in Natural Language Generation', '2022-11-17', 4889, true),
  notableWork('W2493916176', 'Enriching Word Vectors with Subword Information', '2017-12-01', 9650, true),
  notableWork('W2107743791', 'Probabilistic Latent Semantic Indexing', '2017-08-02', 3988, false),
];

// `count` recent cs.LG papers, an hour apart before `now`.
const recentPapers = (count: number, now = NOW) => Array.from({ length: count }, (_, index) => ({
  paper: { ...arxivRecord, id: `2610.${String(index).padStart(5, '0')}`, arxivId: `2610.${String(index).padStart(5, '0')}`, title: `Recent paper ${index} on learning`, allCategories: [], categories: [], published: new Date(now - (index + 1) * 3_600_000).toISOString() },
  lanes: ['cs.LG'],
}));

async function notableCorpus() {
  const { env, db } = corpus();
  await ingestPapers(env, recentPapers(40), { now: NOW });
  await ingestPapers(env, NOTABLE.map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  return { env, db };
}

const recentIds = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `2610.${String(from + index).padStart(5, '0')}`);

test("a page that asks for notable papers gets the unseen ones of the reader's categories after its own, with their own year, citations and access", async () => {
  const { env } = await notableCorpus();
  // The reader saw the newest of the three on an earlier day.
  const seen = ['openalex:W4309674289'];
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 15, seen: feedSeenFilter(seen), notable: 3 }), { now: NOW });
  // Without a like, the closest is the newest.
  assert.deepEqual(page.map(paper => paper.id), [...recentIds(0, 15), 'openalex:W2493916176', 'openalex:W2107743791']);
  assert.deepEqual(page.map(paper => paper._notable === true), [...Array(15).fill(false), true, true]);
  for (const paper of page.slice(15)) {
    assert.deepEqual(paper._fetchedFor, ['cs.LG'], 'found for the category it is notable in');
    assert.equal(paper.year, 2017);
    assert.equal(paper.citationCountKnown, true);
  }
  assert.deepEqual([page[15].citationCount, page[15].openAccess], [9650, true]);
  assert.deepEqual([page[16].citationCount, page[16].openAccess], [3988, false], 'a closed article stays closed');

  // Asked for one, the page adds the closest.
  const one = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 15, seen: feedSeenFilter(seen), notable: 1 }), { now: NOW });
  assert.deepEqual(one.slice(15).map(paper => paper.id), ['openalex:W2493916176']);

  // Once shown they are seen, and none is left: the next page is the reader's other papers only.
  const shown = [...seen, ...page.map(paper => paper.id)];
  const next = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], page: 1, pageSize: 15, seen: feedSeenFilter(shown), notable: 3 }), { now: NOW });
  assert.deepEqual(next.map(paper => paper.id), recentIds(15, 30));
});

// ADS's listing cannot leave out retracted papers; the enrichment is what
// learns that OpenAlex marks one retracted (README step 5).
test('a notable paper ADS listed is not offered until the enrichment has asked OpenAlex about it', async () => {
  const { env, db } = await notableCorpus();
  const listed = mapAdsPaper({
    bibcode: '2018Natur.556...74Z', title: ['Quantized Majorana conductance'], author: ['Zhang, Hao'],
    abstract: 'A synthetic abstract about Majorana zero modes in hybrid nanowires.', year: '2018', pubdate: '2018-04-00',
    identifier: ['arXiv:1710.10701'], arxiv_class: ['cond-mat.mes-hall'], citation_count: 1500, doctype: 'article',
  }, ['cs.LG'])!;
  await ingestPapers(env, [{ paper: listed, lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  const request = parseFeedRequest({ categories: ['cs.LG'], pageSize: 15, seen: feedSeenFilter([]), notable: 5 });
  const offered = async () => (await readFeedPage(env, request, { now: NOW })).filter(paper => paper._notable).map(paper => paper.arxivId || paper.id);
  assert.ok(!(await offered()).includes('1710.10701'), 'not offered before the enrichment');
  assert.equal((await offered()).length, 3, 'the notable papers OpenAlex listed still are');
  db.prepare("UPDATE works SET enriched_at = ? WHERE paper ->> '$.arxivId' = '1710.10701'").run(new Date(NOW).toISOString());
  assert.ok((await offered()).includes('1710.10701'), 'offered once enriched and not retracted');
});

test('a reader who has seen every notable paper, a request that does not say what was seen or one that asks for none gets none', async () => {
  const { env } = await notableCorpus();
  const seenAll = feedSeenFilter(NOTABLE.map(paper => paper.id));
  for (const query of [{ seen: seenAll, notable: 3 }, { notable: 3 }, { seen: feedSeenFilter([]) }]) {
    const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 30, ...query }), { now: NOW });
    assert.deepEqual(page.map(paper => paper.id), recentIds(0, 30));
    assert.ok(!page.some(paper => paper._notable));
  }
  // An order ranked with notable papers serves only requests that ask for them.
  // The category's own lane lists the notable papers too: an order ranked with
  // notable papers leaves them out of its ranks.
  await ingestPapers(env, NOTABLE.map(paper => ({ paper, lanes: ['cs.LG'] })), { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  const stored = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => (stored.get(key) as never) ?? null,
    put: async (key: string, ranking: unknown) => { stored.set(key, ranking); },
  };
  const first = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 30, seen: feedSeenFilter([]), notable: 3 }), { now: NOW, cache });
  assert.equal(first.filter(paper => paper._notable).length, 3);
  // The page size is part of the key too: only the notable request differs.
  const later = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], page: 1, pageSize: 30 }), { now: NOW, cache });
  assert.ok(!later.some(paper => paper._notable));
  assert.deepEqual(later.map(paper => paper.id), [...recentIds(30, 40), ...NOTABLE.map(paper => paper.id)], 'without notable papers, the category lists them as its own oldest');
});

test('a notable paper the reader rejected or the app excludes is not offered, and the next unseen one is', async () => {
  const { env } = await notableCorpus();
  const notableOffered = async (body: { negativeIds?: string[]; excludedIds?: string[] }) => (
    await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 15, seen: feedSeenFilter([]), notable: 1, ...body }), { now: NOW })
  ).filter(paper => paper._notable).map(paper => paper.id);
  // Without a like, the closest is the newest.
  assert.deepEqual(await notableOffered({}), ['openalex:W4309674289']);
  assert.deepEqual(await notableOffered({ negativeIds: ['W4309674289'] }), ['openalex:W2493916176']);
  assert.deepEqual(await notableOffered({ negativeIds: ['W4309674289'], excludedIds: ['openalex:W2493916176'] }), ['openalex:W2107743791']);
});

test('a page short of papers of its own still adds the notable ones asked for, and a page past the last adds none', async () => {
  const { env } = corpus();
  await ingestPapers(env, recentPapers(14), { now: NOW });
  await ingestPapers(env, [{ paper: NOTABLE[1], lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  const request = (page: number) => parseFeedRequest({ categories: ['cs.LG'], page, pageSize: 15, seen: feedSeenFilter([]), notable: 3 });
  const page = await readFeedPage(env, request(0), { now: NOW });
  assert.deepEqual(page.map(paper => [paper.id, paper._notable === true]), [...recentIds(0, 14).map(id => [id, false]), ['openalex:W2493916176', true]]);
  assert.deepEqual(await readFeedPage(env, request(1), { now: NOW }), [], 'notable papers alone are no page');
});

// `count` notable works of `year`, one a day from 1 January; the id is the year and the rank.
const notableYear = (year: number, count: number) => Array.from({ length: count }, (_, rank) => notableWork(
  `W${year}${String(rank).padStart(3, '0')}`, `Highly cited study ${rank} of ${year}`, new Date(Date.UTC(year, 0, 1 + rank)).toISOString().slice(0, 10), 10_000 - rank, true,
));
const LISTED_UNTIL = '2027-01-15T03:00:00.000Z';

// The notable candidates of `lanes` at `now`, by paper id.
async function notableRead({ env, db }: ReturnType<typeof corpus>, lanes: string[], now: number) {
  const paperIds = new Map(rows(db, "SELECT id, paper ->> '$.id' AS paper_id FROM works").map(row => [row.id, String(row.paper_id)]));
  return (await readNotableCandidates(env.PAPER_STORE!, lanes, now)).candidates.map(({ workId, ...candidate }) => ({ id: paperIds.get(workId)!, ...candidate }));
}
const yearOf = (id: string) => id.slice('openalex:W'.length, 'openalex:W'.length + 4);
const DAY = 86_400_000;

test('a page reads each notable lane by year: 25 of every year, a slice that moves on each UTC day, so every notable is offered within four days', async () => {
  const store = corpus();
  const listed = [...notableYear(2016, 100), ...notableYear(2020, 100), ...notableYear(2025, 100)];
  await ingestPapers(store.env, listed.map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: LISTED_UNTIL });
  const days: string[][] = [];
  for (let day = 0; day < 4; day += 1) {
    const ids = (await notableRead(store, ['notable:cs.LG'], NOW + day * DAY)).map(candidate => candidate.id);
    assert.equal(new Set(ids).size, 75);
    for (const year of ['2016', '2020', '2025']) assert.equal(ids.filter(id => yearOf(id) === year).length, 25, `25 of ${year} on day ${day}`);
    days.push(ids);
  }
  assert.ok(!days[1].some(id => days[0].includes(id)), 'the next day reads another slice');
  assert.deepEqual(new Set(days.flat()), new Set(listed.map(paper => paper.id)), 'four days offer every notable');
  const lateSameDay = Date.parse('2026-10-22T23:59:00Z');
  assert.deepEqual((await notableRead(store, ['notable:cs.LG'], lateSameDay)).map(candidate => candidate.id), days[0], 'the slice holds for the whole UTC day');

  // A year short of a hundred wraps inside its own count; a year of two is read every day.
  const short = [...notableYear(2019, 40), ...notableYear(2023, 2)];
  await ingestPapers(store.env, short.map(paper => ({ paper, lanes: ['notable:cs.CV'] })), { now: NOW, keepUntil: LISTED_UNTIL });
  const shortDays: string[][] = [];
  for (let day = 0; day < 4; day += 1) {
    const ids = (await notableRead(store, ['notable:cs.CV'], NOW + day * DAY)).map(candidate => candidate.id);
    assert.equal(ids.filter(id => yearOf(id) === '2019').length, 25);
    assert.deepEqual(ids.filter(id => yearOf(id) === '2023').sort(), ['openalex:W2023000', 'openalex:W2023001']);
    shortDays.push(ids);
  }
  assert.deepEqual(new Set(shortDays.flat()), new Set(short.map(paper => paper.id)));

  // A year past a hundred (a listing and its drop-outs) is read whole within ceil(110 / 25) = 5 days.
  const long = notableYear(2018, 110);
  await ingestPapers(store.env, long.map(paper => ({ paper, lanes: ['notable:cs.AI'] })), { now: NOW, keepUntil: LISTED_UNTIL });
  const longDays: string[][] = [];
  for (let day = 0; day < 5; day += 1) {
    const ids = (await notableRead(store, ['notable:cs.AI'], NOW + day * DAY)).map(candidate => candidate.id);
    assert.equal(ids.length, 25);
    longDays.push(ids);
  }
  assert.deepEqual(new Set(longDays.flat()), new Set(long.map(paper => paper.id)), 'five days offer every row of a year of 110');
});

test('a paper in two notable lanes is read once with both, and a lane or year without rows reads nothing', async () => {
  const store = corpus();
  const [shared] = notableYear(2016, 1);
  const vision = notableYear(2021, 3);
  // Two nights' listings: cs.LG has only the 2016 paper, cs.CV the same paper and three of 2021.
  await ingestPapers(store.env, [{ paper: shared, lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: LISTED_UNTIL });
  await ingestPapers(store.env, [shared, ...vision].map(paper => ({ paper, lanes: ['notable:cs.CV'] })), { now: NOW, keepUntil: LISTED_UNTIL });
  const read = await notableRead(store, ['notable:cs.LG', 'notable:cs.CV', 'notable:cs.AI'], NOW);
  assert.deepEqual(read.map(({ id, lanes }) => ({ id, lanes })), [
    { id: 'openalex:W2016000', lanes: ['notable:cs.LG', 'notable:cs.CV'] },
    { id: 'openalex:W2021002', lanes: ['notable:cs.CV'] },
    { id: 'openalex:W2021001', lanes: ['notable:cs.CV'] },
    { id: 'openalex:W2021000', lanes: ['notable:cs.CV'] },
  ]);
  assert.deepEqual(await notableRead(store, ['notable:cs.AI'], NOW), []);
});

test('a notable older than the window is not read after 1 January', async () => {
  const store = corpus();
  await ingestPapers(store.env, [{ paper: notableWork('W2016999', 'A highly cited study of June 2016', '2016-06-01', 8000, true), lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: LISTED_UNTIL });
  assert.deepEqual((await notableRead(store, ['notable:cs.LG'], Date.parse('2026-12-31T12:00:00Z'))).map(candidate => candidate.id), ['openalex:W2016999']);
  assert.deepEqual(await notableRead(store, ['notable:cs.LG'], Date.parse('2027-01-02T12:00:00Z')), []);
});

test('a notable of the current year is not read until that year is over', async () => {
  const store = corpus();
  // A row the listing before the by-year one left, or a merge whose date is this year.
  await ingestPapers(store.env, [{ paper: notableWork('W2026999', 'A highly cited study of March 2026', '2026-03-01', 8000, true), lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: LISTED_UNTIL });
  assert.deepEqual(await notableRead(store, ['notable:cs.LG'], NOW), []);
  assert.deepEqual((await notableRead(store, ['notable:cs.LG'], Date.parse('2027-01-02T12:00:00Z'))).map(candidate => candidate.id), ['openalex:W2026999'], 'the last completed year');
});

// A notable lane is read in two round trips: its rows, then the stored row of
// each of the day's slice. An enrichment batch rewrites its papers, which takes
// a retracted one or an erratum out of every lane, and only then marks them
// enriched (`enrichPending`); a page that reads in between must not offer them.
test('a notable paper the enrichment takes out of its lane between the two reads of the lane is not offered', async t => {
  const { env, db } = corpus();
  const adsListed = mapAdsPaper({
    bibcode: '2018Natur.556...74Z', title: ['Quantized Majorana conductance'], author: ['Zhang, Hao'],
    abstract: 'A synthetic abstract about Majorana zero modes in hybrid nanowires.', year: '2018', pubdate: '2018-04-00',
    identifier: ['arXiv:1710.10701'], arxiv_class: ['cond-mat.mes-hall'], citation_count: 1500, doctype: 'article',
  }, ['cs.LG'])!;
  const listed = [...NOTABLE, adsListed];
  await ingestPapers(env, listed.map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: LISTED_UNTIL });
  const stored = (paper: Paper) => {
    const row = db.prepare("SELECT id, paper FROM works WHERE paper ->> '$.id' = ?").get(paper.id) as { id: number; paper: string };
    return { id: row.id, before: JSON.parse(row.paper) as Paper };
  };
  const binding = env.PAPER_STORE!;
  const batch = binding.batch.bind(binding);
  let reads = 0;
  t.mock.method(binding, 'batch', async <T>(statements: D1PreparedStatement[]) => {
    const answered = await batch<T>(statements);
    reads += 1;
    if (reads === 1) {
      // The lane's rows are read. The enrichment finds the ADS paper retracted
      // and the paper OpenAlex listed last an erratum, then marks the batch done.
      const retracted = stored(adsListed);
      const erratum = stored(NOTABLE[2]);
      await rewriteWorks(env, [
        { ...retracted, after: { ...retracted.before, publicationStatus: 'retracted' } },
        { ...erratum, after: { ...erratum.before, publicationType: 'erratum' } },
      ], NOW);
      db.prepare('UPDATE works SET enriched_at = ?').run(new Date(NOW).toISOString());
    }
    return answered;
  });
  const read = await notableRead({ env, db }, ['notable:cs.LG'], NOW);
  assert.equal(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'notable:cs.LG'").length, 2, 'the enrichment ran between the reads and took two papers out of the lane');
  assert.deepEqual(read.map(candidate => candidate.id), [NOTABLE[0].id, NOTABLE[1].id]);
});

// The statement each notable lane was read with before ENG-150, which numbered
// the years in SQL with window functions: kept here only as the oracle that the
// read in index order must match.
const WINDOW_FUNCTION_NOTABLE_READ = `SELECT work_id, published,
      CASE WHEN in_slice THEN EXISTS (SELECT 1 FROM works w WHERE w.id = s.work_id
        AND (w.enriched_at IS NOT NULL OR w.paper ->> '$.adsBibcode' IS NULL)) ELSE 0 END AS offered FROM (
      SELECT work_id, published, ((rn - 1 + ?) % n < ?) AS in_slice FROM (
      SELECT work_id, published,
             ROW_NUMBER() OVER (PARTITION BY substr(published, 1, 4) ORDER BY published DESC, work_id) AS rn,
             COUNT(*)     OVER (PARTITION BY substr(published, 1, 4)) AS n
      FROM work_lanes WHERE lane = ? AND published >= ? AND published < ?
    )) s ORDER BY published DESC, work_id`;

test('a notable lane read in index order offers the same candidates, in the same order, as the window functions did on every day', async () => {
  const { env, db } = corpus();
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until, enriched_at) VALUES (?, ?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  // Rows per year: a year before the window, an empty one, one shorter than
  // the slice, one of the slice, one past it, a listing, a listing with its
  // drop-outs, two listings, and the current year's. Most of a year shares a
  // few dates, as OpenAlex's 1 January does, so the work id breaks the ties;
  // ids are out of date order.
  const perYear: Array<[number, number]> = [[2015, 7], [2016, 0], [2017, 1], [2018, 24], [2019, 25], [2020, 26], [2021, 100], [2022, 110], [2023, 200], [2024, 3], [2025, 57], [2026, 4]];
  let number = 0;
  const lanes = { lg: 'notable:cs.LG', cv: 'notable:cs.CV' };
  db.exec('BEGIN');
  for (const [year, count] of perYear) {
    for (let rank = 0; rank < count; rank += 1) {
      number += 1;
      const id = 1 + ((number * 7_919) % 100_003);
      const day = [0, 0, 0, 31, 59, 180, 364][rank % 7];
      const published = new Date(Date.UTC(year, 0, 1 + day, rank % 5 === 0 ? 0 : 12)).toISOString();
      // Every fourth is a paper ADS listed: half of those enriched since.
      const fromAds = number % 4 === 0;
      const paper = { id: `openalex:W${id}`, title: `Highly cited study ${id}`, ...(fromAds ? { adsBibcode: `${year}Natur.${id}` } : {}) };
      // A lane row whose stored row is gone is not offered.
      if (number % 37 !== 0) insertWork.run(id, JSON.stringify(paper), published, '2027-03-01T00:00:00.000Z', fromAds && number % 8 === 0 ? '2026-10-01T00:00:00.000Z' : null);
      insertLane.run(lanes.lg, id, published);
      // A third of them are listed in cs.CV too, and cs.CV has its own.
      if (number % 3 === 0) insertLane.run(lanes.cv, id, published);
    }
  }
  for (let rank = 0; rank < 40; rank += 1) {
    const id = 200_000 + ((rank * 13) % 40);
    const published = new Date(Date.UTC(2019 + (rank % 3), 5, 1)).toISOString();
    insertWork.run(id, JSON.stringify({ id: `openalex:W${id}`, title: `Vision study ${id}` }), published, '2027-03-01T00:00:00.000Z', null);
    insertLane.run(lanes.cv, id, published);
  }
  db.exec('COMMIT');

  // The window functions' rows of each lane, and the candidates the lanes
  // give: their offered rows in turns, a work listed by two lanes once, at its
  // first turn, with both lanes and its newest date.
  const oracle = (lane: string, now: number) => db.prepare(WINDOW_FUNCTION_NOTABLE_READ)
    .all(Math.floor(now / DAY) * 25, 25, lane, notableSince(now), `${new Date(now).getUTCFullYear()}-01-01`) as Array<{ work_id: number; published: string; offered: number }>;
  const inTurns = (asked: string[], perLane: Array<Array<{ work_id: number; published: string }>>) => {
    const byWork = new Map<number, { workId: number; published: string; lanes: string[] }>();
    for (let position = 0; position < Math.max(...perLane.map(rows => rows.length)); position += 1) {
      perLane.forEach((rows, index) => {
        const row = rows[position];
        if (!row) return;
        const candidate = byWork.get(row.work_id);
        if (!candidate) byWork.set(row.work_id, { workId: row.work_id, published: row.published, lanes: [asked[index]] });
        else {
          candidate.lanes.push(asked[index]);
          if (row.published > candidate.published) candidate.published = row.published;
        }
      });
    }
    return [...byWork.values()];
  };
  // Ten days in a row, the slices of a year of 200 wrapping around, and a day
  // in January, when the window moves on by a year.
  const days = [...Array.from({ length: 10 }, (_, day) => NOW + day * DAY), Date.parse('2027-01-02T12:00:00Z')];
  for (const now of days) {
    for (const asked of [[lanes.lg], [lanes.cv], [lanes.lg, lanes.cv], [lanes.cv, lanes.lg, 'notable:cs.AI']]) {
      const expected = asked.map(lane => oracle(lane, now));
      const read = await readNotableCandidates(env.PAPER_STORE!, asked, now);
      const label = `${asked.join(', ')} on ${new Date(now).toISOString().slice(0, 10)}`;
      assert.deepEqual(read.candidates, inTurns(asked, expected.map(rows => rows.filter(row => row.offered))), label);
      assert.deepEqual([...read.inLanes].sort((a, b) => a - b), [...new Set(expected.flat().map(row => row.work_id))].sort((a, b) => a - b), label);
    }
  }
  // The data reaches every case: of cs.LG's 546 rows in the window on the
  // first day, the day's slice holds 178 (25 of a year, or a shorter year
  // whole), and some of those are not offered: a paper ADS listed and not yet
  // enriched, or a row whose stored row is gone.
  const today = oracle(lanes.lg, NOW);
  const offered = today.filter(row => row.offered).length;
  assert.equal(today.length, 546);
  assert.ok(offered > 0 && offered < 178, `${offered} of the slice's 178 offered`);
});

test("a notable paper one of the reader's own lanes also holds comes as a notable card on the day of its slice, and as no rank on the other days", async () => {
  const { env } = corpus();
  await ingestPapers(env, recentPapers(5), { now: NOW });
  const year = notableYear(2020, 100);
  await ingestPapers(env, year.map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: LISTED_UNTIL });
  // The oldest of the year, the last of its 100 rows: the slice reaches it on
  // the day after NOW. cs.LG's own lane holds it too, as a lane that keeps
  // old papers would.
  const [paper] = year;
  await ingestPapers(env, [{ paper, lanes: ['cs.LG'] }], { now: NOW, keepUntil: LISTED_UNTIL });
  // The reader has seen the year's other papers, so only this one can be a notable card.
  const seen = feedSeenFilter(year.slice(1).map(other => other.id));
  const notableByDay: string[][] = [];
  for (let day = 0; day < 4; day += 1) {
    const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 15, seen, notable: 5 }), { now: NOW + day * DAY });
    assert.deepEqual(page.filter(card => !card._notable).map(card => card.id), recentIds(0, 5), `day ${day}: the ranks are the lane's recent papers only`);
    notableByDay.push(page.filter(card => card._notable).map(card => card.id));
  }
  assert.deepEqual(notableByDay, [[], [paper.id], [], []]);
});

test('the app shows one card in fifteen notable from corpus pages of fifteen and the cards the follows and exploration add', async () => {
  const { env } = corpus();
  await ingestPapers(env, recentPapers(160), { now: NOW });
  // Synthetic works in the recorded shape.
  const notable = Array.from({ length: 16 }, (_, index) => notableWork(`W9000000${String(index).padStart(2, '0')}`, `Highly cited study ${index} of representation learning`, '2019-05-01', 5000 - index, true));
  await ingestPapers(env, notable.map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  // Cards the follows (up to six) and exploration (up to ten) add to each page.
  for (const added of [[0], [6], [16], [6, 16, 0, 10, 3, 16]]) {
    // Later pages read the order the first one ranked, as the Worker's cache keeps it.
    const orders = new Map<string, unknown>();
    const cache = { get: async (key: string) => (orders.get(key) as never) ?? null, put: async (key: string, ranking: unknown) => { orders.set(key, ranking); } };
    const feed: Array<{ id: string; _notable?: boolean }> = [];
    for (let page = 0; page < 6; page += 1) {
      const corpusPage = await readFeedPage(env, parseFeedRequest({
        categories: ['cs.LG'], page, pageSize: 15, seen: feedSeenFilter(feed.map(paper => paper.id)), notable: notablePlaces(feed, 31),
      }), { now: NOW, cache });
      const others = [...corpusPage.filter(paper => !paper._notable), ...Array.from({ length: added[page % added.length] }, (_, index) => ({ id: `added-${page}-${index}` }))];
      feed.push(...placeNotableCards(others, corpusPage.filter(paper => paper._notable), feed));
    }
    assert.equal(feed.filter(paper => !paper._notable).length, 90 + [0, 1, 2, 3, 4, 5].reduce((sum, page) => sum + added[page % added.length], 0), 'every other card is shown');
    const places = feed.flatMap((paper, index) => (paper._notable ? [index + 1] : []));
    assert.deepEqual(places, Array.from({ length: Math.floor(feed.length / 15) }, (_, index) => 15 * (index + 1)), `pages adding ${added}`);
    assert.equal(new Set(feed.map(paper => paper.id)).size, feed.length, 'no card twice');
  }
});

test('in January the year that left the ten-year window gives no notable card, while its papers wait in the lane for their listing to lapse', async () => {
  const { env, db } = corpus();
  // Synthetic works in the recorded shape, listed by the last weekly run of
  // 2026 and kept two weeks from then.
  const listed = Date.parse('2026-12-30T03:00:00Z');
  await ingestPapers(env, [
    { paper: notableWork('W2016000001', 'A highly cited article from the first year of the window', '2016-03-01', 9000, true), lanes: ['notable:cs.LG'] },
    { paper: notableWork('W2017000001', 'A highly cited article from the second year of the window', '2017-02-01', 7000, true), lanes: ['notable:cs.LG'] },
  ], { now: listed, keepUntil: '2027-01-13T03:00:00.000Z' });
  const january = Date.parse('2027-01-10T03:00:00Z');
  await ingestPapers(env, recentPapers(30, january), { now: january });
  await evictExpired(env, january);
  assert.equal(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'notable:cs.LG'").length, 2);
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 30, seen: feedSeenFilter([]), notable: 3 }), { now: january });
  assert.deepEqual(page.filter(paper => paper._notable).map(paper => [paper.id, paper.year]), [['openalex:W2017000001', 2017]]);
  assert.ok(!page.some(paper => paper.id === 'openalex:W2016000001'));
});

test("with twelve categories asked, a notable lane holding more than its listing still offers the listing's oldest papers", async () => {
  const { env } = corpus();
  await ingestPapers(env, recentPapers(15), { now: NOW });
  // Synthetic works in the recorded shape: this week's listing of 100,
  // published from 2016 to 2018, and 60 newer papers an earlier listing had,
  // which the lane keeps for 14 days after it.
  const dated = (index: number, from: string, everyDays: number) => new Date(Date.parse(from) + index * everyDays * 86_400_000).toISOString().slice(0, 10);
  const listing = Array.from({ length: 100 }, (_, index) => notableWork(`W81${String(index).padStart(6, '0')}`, `Highly cited study ${index} of learning`, dated(index, '2016-02-01', 10), 20_000 - index, true));
  const droppedOut = Array.from({ length: 60 }, (_, index) => notableWork(`W82${String(index).padStart(6, '0')}`, `Once highly cited study ${index} of learning`, dated(index, '2023-02-01', 5), 900 - index, true));
  await ingestPapers(env, [...listing, ...droppedOut].map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  // The reader has seen the lane's hundred newest papers: the 60 that dropped
  // out and the listing's 40 latest.
  const seen = [...droppedOut, ...listing.slice(60)].map(paper => paper.id);
  const categories = ['cs.LG', 'cs.AI', 'cs.CL', 'cs.CV', 'cs.NE', 'cs.IR', 'cs.RO', 'stat.ML', 'math.OC', 'q-bio.NC', 'eess.SP', 'econ.EM'];
  const page = await readFeedPage(env, parseFeedRequest({ categories, pageSize: 15, seen: feedSeenFilter(seen), notable: 3 }), { now: NOW });
  const offered = page.filter(paper => paper._notable).map(paper => paper.id);
  const unseenListing = listing.slice(0, 60).map(paper => paper.id);
  assert.equal(offered.length, 3, 'the three asked for');
  assert.ok(offered.every(id => unseenListing.includes(id)), `${offered} are papers of the listing the reader has not seen`);
});

// Two papers of each year of the window in each of two leaves' notable lanes,
// the second one newer; the id is the year, the leaf (1 or 2) and the rank.
// The leaves are asked in this order, not in name order.
const LEAVES = ['cs.LG', 'cs.CV'];
const WINDOW_YEARS = Array.from({ length: 10 }, (_, index) => 2025 - index);
async function notableLeavesCorpus() {
  const store = corpus();
  await ingestPapers(store.env, recentPapers(60), { now: NOW });
  const listed = LEAVES.flatMap((leaf, leafIndex) => WINDOW_YEARS.flatMap(year => [0, 1].map(rank => ({
    paper: notableWork(`W${year}${leafIndex + 1}${rank}`, `Highly cited study ${rank} of ${year} in ${leaf}`, `${year}-0${3 + rank}-01`, 5000, true),
    lanes: [`notable:${leaf}`],
  }))));
  await ingestPapers(store.env, listed, { now: NOW, keepUntil: LISTED_UNTIL });
  return store;
}

test("a reader without likes gets the notable years in turns, newest first, and the asked leaves in turns, while their own papers stay newest first", async () => {
  const { env } = await notableLeavesCorpus();
  const shown: string[] = [];
  const notable: Array<{ id: string; year: number | null | undefined; leaves: string[] | undefined }> = [];
  for (let page = 0; page < 4; page += 1) {
    const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, page, pageSize: 15, seen: feedSeenFilter(shown), notable: 5 }), { now: NOW });
    assert.deepEqual(answer.filter(paper => !paper._notable).map(paper => paper.id), recentIds(15 * page, 15 * (page + 1)), `page ${page}: the ranks stay newest first`);
    for (const paper of answer.filter(card => card._notable)) notable.push({ id: paper.id, year: paper.year, leaves: paper._fetchedFor });
    shown.push(...answer.map(paper => paper.id));
  }
  // One paper of each year, newest first, then each year again; a year's
  // leaves take turns, and so do consecutive cards. Each comes with its
  // lane's newest paper of the year first.
  const expected = Array.from({ length: 20 }, (_, card) => {
    const year = WINDOW_YEARS[card % 10];
    const leaf = (card % 10 + Math.floor(card / 10)) % 2;
    return { id: `openalex:W${year}${leaf + 1}1`, year, leaves: [LEAVES[leaf]] };
  });
  assert.deepEqual(notable, expected);
});

// On every fresh load (a reload, a refresh, the next session) the app excludes
// the latest cards it showed, notable ones included: they count as turns already passed, so the
// years' turns go on rather than starting again from the first (ENG-166 review).
test('a fresh load that excludes the notable cards shown before continues the years in turns', async () => {
  const { env } = await notableLeavesCorpus();
  const shown: string[] = [];
  const excludedIds: string[] = [];
  const years: Array<Array<number | null | undefined>> = [];
  for (let load = 0; load < 3; load += 1) {
    // The third load rejects the cards of the second instead.
    const negativeIds = load === 2 ? excludedIds.splice(2) : [];
    const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, pageSize: 15, seen: feedSeenFilter(shown), excludedIds, negativeIds, notable: 2 }), { now: NOW });
    const cards = answer.filter(paper => paper._notable);
    years.push(cards.map(paper => paper.year));
    shown.push(...answer.map(paper => paper.id));
    excludedIds.push(...negativeIds, ...cards.map(paper => paper.id));
  }
  assert.deepEqual(years, [[2025, 2024], [2023, 2022], [2021, 2020]]);
});

// The app asks for the reader's established interests in its ranking of them
// (selected ones and the affinities it learned), then the ones added since.
test('the notable leaves take their turns in the order the request asks them in', async () => {
  const { env } = await notableLeavesCorpus();
  for (const categories of [LEAVES, [...LEAVES].reverse()]) {
    const answer = await readFeedPage(env, parseFeedRequest({ categories, pageSize: 15, seen: feedSeenFilter([]), notable: 3 }), { now: NOW });
    assert.deepEqual(answer.filter(paper => paper._notable).map(paper => paper._fetchedFor), [[categories[0]], [categories[1]], [categories[0]]], `asked ${categories}`);
  }
});

test('a notable paper several asked leaves list takes its turn with the first of them the request asks', async () => {
  const { env } = await notableLeavesCorpus();
  // cs.LG holds one more 2025 paper, so cs.CV's lane reaches the shared one first.
  await ingestPapers(env, [
    { paper: notableWork('W2025901', 'Highly cited study of 2025 in cs.LG only', '2025-06-01', 5000, true), lanes: ['notable:cs.LG'] },
    { paper: notableWork('W2025902', 'Highly cited study of 2025 in both leaves', '2025-03-15', 5000, true), lanes: ['notable:cs.LG', 'notable:cs.CV'] },
  ], { now: NOW, keepUntil: LISTED_UNTIL });
  const excludedIds = LEAVES.flatMap((_, leaf) => WINDOW_YEARS.slice(1).flatMap(year => [0, 1].map(rank => `openalex:W${year}${leaf + 1}${rank}`)));
  const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, excludedIds, pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  // 2025's turns: cs.LG's papers newest first, then cs.CV's, the shared one with cs.LG's.
  assert.deepEqual(answer.filter(paper => paper._notable).map(paper => paper.id), ['W2025901', 'W202521', 'W202511', 'W202520', 'W2025902'].map(id => `openalex:${id}`));
});

test("a notable paper another asked leaf reaches first still waits for its turn among the first leaf's papers of its year, newest first", async () => {
  const { env } = await notableLeavesCorpus();
  // cs.CV's lane reaches the shared paper first, cs.LG's after two newer ones.
  await ingestPapers(env, [
    { paper: notableWork('W2025903', 'Highly cited study A of 2025 in cs.LG only', '2025-09-01', 5000, true), lanes: ['notable:cs.LG'] },
    { paper: notableWork('W2025904', 'Highly cited study B of 2025 in cs.LG only', '2025-08-01', 5000, true), lanes: ['notable:cs.LG'] },
    { paper: notableWork('W2025905', 'Highly cited study of 2025 in both leaves', '2025-07-01', 5000, true), lanes: ['notable:cs.LG', 'notable:cs.CV'] },
  ], { now: NOW, keepUntil: LISTED_UNTIL });
  const excludedIds = LEAVES.flatMap((_, leaf) => WINDOW_YEARS.slice(1).flatMap(year => [0, 1].map(rank => `openalex:W${year}${leaf + 1}${rank}`)));
  const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, excludedIds, pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  assert.deepEqual(answer.filter(paper => paper._notable).map(paper => paper.id), ['W2025903', 'W202521', 'W2025904', 'W202520', 'W2025905'].map(id => `openalex:${id}`));
});

test('with a like, the notable cards follow the closest papers, whatever their year or leaf', async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00059'), vector([1, 0, 0, 0, 0, 0]));
  // Closest first, in an order neither the years nor the leaves give; their
  // likeness to each other stays under the diversity pass's threshold.
  const closest = ['W201811', 'W202420', 'W201610', 'W202511', 'W202120'];
  closest.forEach((id, index) => {
    const values = [0.8 - index * 0.15, 0, 0, 0, 0, 0];
    values[index + 1] = Math.sqrt(1 - values[0] ** 2);
    insert.run(idOf(`openalex:${id}`), vector(values));
  });
  const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, positiveIds: ['2610.00059'], pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  assert.deepEqual(answer.filter(paper => paper._notable).map(paper => paper.id), closest.map(id => `openalex:${id}`));
});

test('with a like, the notable papers it cannot tell apart stay newest first rather than taking the years in turns', async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00059'), vector([1, 0, 0, 0, 0, 0]));
  // Only one notable paper has a vector; the others tie.
  insert.run(idOf('openalex:W201811'), vector([0.8, 0.6, 0, 0, 0, 0]));
  const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, positiveIds: ['2610.00059'], pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  assert.deepEqual(answer.filter(paper => paper._notable).map(paper => paper.year), [2018, 2025, 2025, 2025, 2025]);
});

test('with a like, the diversity pass orders near copies of the notable papers as it does the page, ties newest first', async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00059'), vector([1, 0, 0, 0, 0, 0]));
  // A 2025 paper and a 2019 one are one vector, as close to the like as each
  // other: the 2025 one comes first, though without likes the years' turns
  // offer the 2019 one first. 2024's is closer to the like than 2016's but
  // also closer to them, so the diversity pass puts 2016's next and 2019's last.
  const copy = [0.9, 0.436, 0, 0, 0, 0];
  insert.run(idOf('openalex:W202510'), vector(copy));
  insert.run(idOf('openalex:W201911'), vector(copy));
  insert.run(idOf('openalex:W202420'), vector([0.88, 0.2, 0.43, 0, 0, 0]));
  insert.run(idOf('openalex:W201610'), vector([0.85, 0, 0, 0.527, 0, 0]));
  const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, positiveIds: ['2610.00059'], pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  assert.deepEqual(answer.filter(paper => paper._notable).slice(0, 4).map(paper => paper.id), ['openalex:W202510', 'openalex:W201610', 'openalex:W202420', 'openalex:W201911']);
});

// A rejection says nothing about the years the reader wants: "Not interested"
// on a card with a vector left every notable card of the newest year (ENG-166 review).
test('with only rejections, the notable papers take the years in turns, the near copies of the rejected papers last, the nearest last of all', async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00059'), vector([1, 0, 0, 0, 0, 0]));
  insert.run(idOf('2610.00058'), vector([0, 1, 0, 0, 0, 0]));
  // Five papers are offered, in the years' turns: one of 2025, 2024, 2023 and
  // 2022, then 2025's other one. The first is a copy of the first rejection,
  // the third a near copy of the second, the fourth far from both.
  const offered = ['W202511', 'W202421', 'W202311', 'W202221', 'W202510'];
  insert.run(idOf('openalex:W202511'), vector([1, 0, 0, 0, 0, 0]));
  insert.run(idOf('openalex:W202311'), vector([0, 0.9, 0.436, 0, 0, 0]));
  insert.run(idOf('openalex:W202221'), vector([0, 0, 1, 0, 0, 0]));
  const excludedIds = LEAVES.flatMap((_, leaf) => WINDOW_YEARS.flatMap(year => [0, 1].map(rank => `W${year}${leaf + 1}${rank}`)))
    .filter(id => !offered.includes(id)).map(id => `openalex:${id}`);
  const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, negativeIds: ['2610.00059', '2610.00058'], excludedIds, pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  assert.deepEqual(answer.filter(paper => paper._notable).map(paper => paper.id), ['W202421', 'W202221', 'W202510', 'W202311', 'W202511'].map(id => `openalex:${id}`));
  // With every notable paper offered, the near copies wait behind all others.
  const all = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, negativeIds: ['2610.00059', '2610.00058'], pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  assert.deepEqual(all.filter(paper => paper._notable).map(paper => paper.year), [2024, 2022, 2021, 2020, 2019]);
});

test('a reader without likes or rejections reads no vectors for the notable papers', async t => {
  const { env } = await notableLeavesCorpus();
  const trips = roundTrips(t, env.PAPER_STORE!);
  const answer = await readFeedPage(env, parseFeedRequest({ categories: LEAVES, pageSize: 15, seen: feedSeenFilter([]), notable: 5 }), { now: NOW });
  assert.equal(answer.filter(paper => paper._notable).length, 5);
  assert.deepEqual(trips.flat().filter(sql => sql.includes('work_vectors')), [], 'the years in turns need no vector');
});

// ─── A reload in one request ───

// The filter holds the papers earlier sessions showed the reader. A page that
// sends it and asks to skip them walks the reader's ranking from its start
// past the filter, so a reload needs no request per page the reader has seen
// (PAP-103).
test('a page that says what the reader has seen holds the next papers of their ranking they have not, whatever page it names, and its notable ones after them', async () => {
  const { env } = corpus();
  await ingestPapers(env, recentPapers(100), { now: NOW });
  await ingestPapers(env, NOTABLE.map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  // Five pages and the notable card among them, and two papers of the sixth page.
  const seen = feedSeenFilter([...recentIds(0, 75), ...recentIds(77, 79), NOTABLE[0].id]);
  for (const page of [0, 4]) {
    const answer = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], page, pageSize: 15, seen, skipsSeen: true, notable: 3 }), { now: NOW });
    assert.deepEqual(answer.map(paper => paper.id), [...recentIds(75, 77), ...recentIds(79, 92), NOTABLE[1].id, NOTABLE[2].id], `page ${page}`);
    assert.deepEqual(answer.map(paper => paper._notable === true), [...Array(15).fill(false), true, true]);
  }
});

test('a reader who has seen a thousand papers of their ranking costs a few reads of stored ids, not one per page they saw', async t => {
  const { env, db } = corpus();
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  // 1,200 papers in one lane, a minute apart, newest first.
  const paperId = (id: number) => `2610.${String(id).padStart(5, '0')}`;
  db.exec('BEGIN');
  for (let id = 1; id <= 1_200; id += 1) {
    const published = new Date(NOW - id * 60_000).toISOString();
    insertWork.run(id, JSON.stringify({ id: paperId(id), arxivId: paperId(id), title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertLane.run('cs.LG', id, published);
  }
  db.exec('COMMIT');
  const trips = roundTrips(t, env.PAPER_STORE!);
  const seen = feedSeenFilter(Array.from({ length: 1_000 }, (_, index) => paperId(index + 1)));
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 15, seen, skipsSeen: true }), { now: NOW });
  assert.deepEqual(page.map(paper => paper.id), Array.from({ length: 15 }, (_, index) => paperId(1_001 + index)));
  const idReads = trips.filter(trip => trip.some(sql => sql.includes("paper ->> '$.id'"))).length;
  assert.ok(idReads <= 4, `${idReads} reads of stored ids for 1,015 ranks`);
});

// The review of ENG-103's cap on the filter (2,000 ids): a page walked the
// ranking from its top, so the papers seen before the 2,000 newest came back
// on every page, and a long session ran out of new ones.
test('a page goes on from where the last walk stopped, so the papers seen before the 2,000 a filter holds are sent once', async () => {
  const { env, db } = corpus();
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  const paperId = (id: number) => `2610.${String(id).padStart(5, '0')}`;
  db.exec('BEGIN');
  for (let id = 1; id <= 1_200; id += 1) {
    const published = new Date(NOW - id * 60_000).toISOString();
    insertWork.run(id, JSON.stringify({ id: paperId(id), arxivId: paperId(id), title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertLane.run('cs.LG', id, published);
  }
  db.exec('COMMIT');
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => paperId(from + index));
  // The order as the Worker's cache keeps it for the session.
  const orders = new Map<string, KeptRanking>();
  const keep = async (key: string, ranking: KeptRanking) => { orders.set(key, ranking); };
  const cache: RankingCache = { get: async key => orders.get(key) ?? null, put: keep, update: keep };
  // The session's seen papers, oldest first: yesterday's views (the top 15 of
  // today's ranking), then 2,000 later ones (follows, exploration, notable cards).
  const later = (from: number) => Array.from({ length: 2_000 }, (_, index) => `later-${from + index}`);
  const seen = new Set([...range(1, 15), ...later(0)]);
  const page = async (number: number) => {
    const answer = (await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], page: number, pageSize: 15, seen: feedSeenFilter(feedSeenIds(seen, true)), skipsSeen: true }), { now: NOW, cache }))
      .map(paper => paper.id);
    // The app passes over a paper it has seen and makes it the newest of the
    // seen papers (markSeenLatest), and shows the others.
    for (const id of answer) {
      seen.delete(id);
      seen.add(id);
    }
    return answer;
  };
  assert.deepEqual(await page(3), range(1, 15), 'yesterday\'s views, which the filter no longer holds');
  assert.deepEqual(await page(4), range(16, 30));
  // 2,000 more cards from the other sources: the filter holds neither page.
  later(2_000).forEach(id => seen.add(id));
  assert.deepEqual(await page(5), range(16, 30), 'the papers the last page sent, not the ones the walk before it passed');
  const sixth = await page(6);
  assert.equal(sixth[0], paperId(31));
  assert.deepEqual(sixth.filter(id => id < paperId(31)), [], 'and none of the ones before them again');
});

test('a page that skips seen papers and has no candidate of its own reads no notable papers', async t => {
  const { env } = corpus();
  // A category whose notable lane is filed and whose recent papers are not yet.
  await ingestPapers(env, NOTABLE.map(paper => ({ paper, lanes: ['notable:cs.LG'] })), { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  const trips = roundTrips(t, env.PAPER_STORE!);
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 15, seen: feedSeenFilter([]), skipsSeen: true, notable: 3 }), { now: NOW });
  assert.deepEqual(page, []);
  assert.ok(!trips.some(trip => trip.some(sql => sql.includes("paper ->> '$.id'"))), 'no stored id is read for notable papers the page would not carry');
});

test('a page that skips seen papers, past a ranking the reader has seen whole, adds no notable papers alone', async () => {
  const { env } = corpus();
  await ingestPapers(env, recentPapers(14), { now: NOW });
  await ingestPapers(env, [{ paper: NOTABLE[1], lanes: ['notable:cs.LG'] }], { now: NOW, keepUntil: '2026-11-05T03:00:00.000Z' });
  // The fourteen shown, the notable one not yet: the page past them has nothing of its own.
  const request = parseFeedRequest({ categories: ['cs.LG'], page: 1, pageSize: 15, seen: feedSeenFilter(recentIds(0, 14)), skipsSeen: true, notable: 3 });
  assert.deepEqual(await readFeedPage(env, request, { now: NOW }), [], 'notable papers alone are no page');
});

test('a seen-paper filter the app did not write is refused', () => {
  // A filter of another size, here twice as many bits, is not the app's
  // either, nor the app's with whitespace in it.
  const spaced = feedSeenFilter([]).replace(/.{64}/g, '$& ');
  for (const seen of ['', 'not a filter', 42, feedSeenFilter([]).slice(1), feedSeenFilter([]).repeat(2), spaced]) {
    assert.throws(() => parseFeedRequest({ categories: ['cs.LG'], seen }), (error: Error & { status?: number; code?: string }) => error.status === 400 && error.code === 'SEEN_INVALID', String(seen).slice(0, 20));
  }
});

// Workers AI, as the store calls it: one vector of the model's size per text.
function embeddingModel() {
  const texts: string[] = [];
  const AI = {
    run: async (_model: string, { text }: { text: string[] }) => {
      texts.push(...text);
      await new Promise(resolve => setImmediate(resolve));
      return { data: text.map((_, index) => Array.from({ length: 1024 }, (__, dimension) => Math.sin(index + dimension + 1))) };
    },
  };
  return { AI, texts };
}

test('two embedding passes at once embed each paper once', async () => {
  const { binding } = testD1();
  const { AI, texts } = embeddingModel();
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, AI } as Parameters<typeof embedPending>[0];
  await ingestPapers(env, Array.from({ length: 64 }, (_, index) => ({
    paper: { ...arxivRecord, id: `2610.002${String(index).padStart(2, '0')}`, arxivId: `2610.002${String(index).padStart(2, '0')}`, title: `Paper ${index} waiting for its vector`, allCategories: [], categories: [] },
    lanes: ['cs.CL'],
  })), { now: NOW });
  // The daily run's pass, and a followed lanes' run started beside it.
  const embedded = await Promise.all([embedPending(env, 256), embedPending(env, 256)]);
  assert.equal(embedded[0] + embedded[1], 64);
  assert.equal(texts.length, 64);
  assert.equal(new Set(texts).size, 64);
});

test("one reader's lookups embed a small share of the day, and the harvest and other readers keep the rest", async () => {
  const { binding, db } = testD1();
  const { AI } = embeddingModel();
  // 200,000 estimated tokens a day; each paper below is about 670.
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, AI, EMBEDDING_DAILY_TOKEN_LIMIT: '200000' } as Parameters<typeof embedPending>[0];
  await ingestPapers(env, Array.from({ length: 400 }, (_, index) => ({
    paper: {
      ...arxivRecord, id: `2610.1${String(index).padStart(4, '0')}`, arxivId: `2610.1${String(index).padStart(4, '0')}`,
      title: `Liked paper ${index}`, abstract: `A long abstract of paper ${index}. `.repeat(100), allCategories: [], categories: [],
    },
    lanes: ['cs.CL'],
  })), { now: NOW });
  const ids = (db.prepare('SELECT id FROM works ORDER BY id').all() as Array<{ id: number }>).map(row => row.id);
  // A lookup embeds at most ten liked papers; this reader keeps asking with new ones.
  let readerEmbedded = 0;
  let refused: number[] = [];
  for (let lookup = 0; lookup < 30; lookup += 1) {
    const asked = ids.slice(lookup * 10, lookup * 10 + 10);
    const embedded = await embedWorks(env, asked, 'reader-1');
    if (embedded === 0) {
      refused = asked;
      break;
    }
    readerEmbedded += embedded;
  }
  assert.ok(readerEmbedded > 0 && readerEmbedded <= 100, `one reader embedded ${readerEmbedded}`);
  assert.equal(await embedWorks(env, refused, 'reader-2'), 10, "another reader's lookup of the same papers is embedded");
  assert.equal(await embedPending(env, 64), 64, 'the harvest still embeds');
});

test("many readers together embed a capped share of the day, and the daily run keeps the rest", async () => {
  const { binding, db } = testD1();
  const { AI } = embeddingModel();
  // 2M estimated tokens a day; each paper below is about 670. A reader's lookups
  // stop at 50,000 of them, and 41 readers at that share would be 2.05M.
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, AI, EMBEDDING_DAILY_TOKEN_LIMIT: '2000000' } as Parameters<typeof embedPending>[0];
  await ingestPapers(env, Array.from({ length: 3_200 }, (_, index) => ({
    paper: {
      ...arxivRecord, id: `2610.3${String(index).padStart(4, '0')}`, arxivId: `2610.3${String(index).padStart(4, '0')}`,
      title: `Liked paper ${index}`, abstract: `A long abstract of paper ${index}. `.repeat(100), allCategories: [], categories: [],
    },
    lanes: ['cs.CL'],
  })), { now: NOW });
  const ids = (db.prepare('SELECT id FROM works ORDER BY id').all() as Array<{ id: number }>).map(row => row.id);
  // Each reader asks for ten new liked papers at a time until the ledger refuses them.
  let asked = 0;
  for (let reader = 0; reader < 41; reader += 1) {
    while (await embedWorks(env, ids.slice(asked, asked + 10), `reader-${reader}`) > 0) asked += 10;
  }
  assert.ok(asked > 0 && asked < ids.length - 64, `readers embedded ${asked} of ${ids.length}`);
  assert.equal(await embedWorks(env, ids.slice(asked, asked + 10), 'reader-late'), 0, "past the readers' share, nobody's likes are embedded");
  assert.equal(await embedPending(env, 64), 64, 'the harvest still embeds');
});

test("runs for new follows embed within their own share of the day, and the daily run keeps the rest", async () => {
  const { binding } = testD1();
  const { AI } = embeddingModel();
  // 3M estimated tokens a day; each paper below is about 670, 2M in all.
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, AI, EMBEDDING_DAILY_TOKEN_LIMIT: '3000000' } as Parameters<typeof embedPending>[0];
  const followed = Array.from({ length: 3_000 }, (_, index) => ({
    paper: {
      ...arxivRecord, id: `2610.2${String(index).padStart(4, '0')}`, arxivId: `2610.2${String(index).padStart(4, '0')}`,
      title: `Followed paper ${index}`, abstract: `A long abstract of followed paper ${index}. `.repeat(60), allCategories: [], categories: [],
    },
    lanes: [`query:search ${index % 20}`],
  }));
  await ingestPapers(env, followed, { now: NOW });
  // Twenty readers' new follows, each run embedding its own lane until it is refused.
  let followRuns = 0;
  for (let lane = 0; lane < 20; lane += 1) {
    for (let embedded = -1; embedded !== 0;) {
      embedded = await embedPending(env, 256, { lanes: [`query:search ${lane}`] });
      followRuns += embedded;
    }
  }
  assert.ok(followRuns > 0 && followRuns < 3_000, `follow runs embedded ${followRuns} of 3,000`);
  assert.equal(await embedPending(env, 256), 256, 'the daily run still embeds');
});

test("a paper dated past tomorrow is not filed, and one filed before that rule leaves", async () => {
  const { env, db } = corpus();
  const issue = { ...arxivRecord, id: 'pmid:42900001', arxivId: undefined, pmid: '42900001', title: 'An article in December’s print issue', published: '2026-12-01T00:00:00.000Z' };
  await ingestPapers(env, [{ paper: issue, lanes: ['med.cardio'] }], { now: NOW });
  assert.equal(rows(db, 'SELECT id FROM works').length, 0);
  db.prepare("INSERT INTO works (id, paper, published, kept_until) VALUES (1, '{}', '2026-12-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO work_lanes (lane, work_id, published) VALUES ('med.cardio', 1, '2026-12-01T00:00:00.000Z')").run();
  await evictAll(env, NOW);
  assert.equal(rows(db, 'SELECT id FROM works').length, 0);
});

// Other readers share a category's lane, and an author's or a topic's; a paper
// a reader liked enters the corpus whatever its age, to rank their feed by.
const liked2019 = { ...arxivRecord, id: '1905.00001', arxivId: '1905.00001', title: 'A liked paper from 2019 on attention', published: '2019-05-01T00:00:00.000Z' };

test('a looked-up paper older than the corpus window enters none of the lanes its own record names', async () => {
  const { env, db } = corpus();
  const keepUntil = daysFromNow(30, NOW);
  await ingestPapers(env, [{ paper: liked2019, lanes: [] }], { now: NOW, keepUntil });
  assert.equal(rows(db, 'SELECT id FROM works').length, 1, 'stored for its reader');
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes'), []);
  // A recent one is filed under its categories, as the harvest would file it.
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }], { now: NOW, keepUntil });
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane), ['cs.CL', 'cs.LG']);
});

test("an enrichment that names an old paper's topic does not file it under that topic", async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: liked2019, lanes: [] }, { paper: arxivRecord, lanes: [] }], { now: NOW, keepUntil: daysFromNow(30, NOW) });
  const topic = { id: 'https://openalex.org/T10604', display_name: 'RNA Research and Splicing' };
  const stored = rows(db, 'SELECT id, paper FROM works').map(row => ({ id: Number(row.id), before: JSON.parse(String(row.paper)) }));
  await rewriteWorks(env, stored.map(({ id, before }) => ({ id, before, after: { ...before, primaryTopic: topic } })), NOW);
  const recent = stored.find(work => work.before.id === arxivRecord.id)!;
  assert.deepEqual(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'topic:T10604'").map(row => row.work_id), [recent.id], 'only the paper inside the window');
});

test('an erratum the enrichment reveals leaves every lane; a letter stays', async () => {
  const { env, db } = corpus();
  const record = { ...arxivRecord, allCategories: [], categories: [] };
  await ingestPapers(env, [{ paper: record, lanes: ['cs.LG'] }, { paper: { ...record, id: '2610.99999', arxivId: '2610.99999', title: 'A research letter' }, lanes: ['cs.LG'] }], { now: NOW });
  const stored = rows(db, 'SELECT id, paper FROM works').map(row => ({ id: Number(row.id), before: JSON.parse(String(row.paper)) as Paper }));
  await rewriteWorks(env, stored.map(({ id, before }) => ({ id, before, after: { ...before, publicationType: before.arxivId === '2610.99999' ? 'letter' : 'erratum' } })), NOW);
  assert.equal(rows(db, 'SELECT DISTINCT work_id FROM work_lanes').length, 1);
  assert.equal(rows(db, "SELECT id FROM works WHERE paper ->> 'publicationType' = 'letter' AND id IN (SELECT work_id FROM work_lanes)").length, 1);
});

test('a record that folds a retracted row into a filed one takes the paper out of every lane', async () => {
  const { env, db } = corpus();
  const journal = { ...mapOpenAlexWork({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/sparse', title: 'Sparse attention for long documents (journal version)', publication_date: '2026-10-12' })!, doi: '10.1000/sparse' };
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }, { paper: journal, lanes: ['bio.comp'] }], { now: NOW });
  // The enrichment finds the journal version retracted.
  const [retracted] = rows(db, "SELECT id, paper FROM works WHERE paper ->> '$.id' = 'openalex:W1'").map(row => ({ id: Number(row.id), before: JSON.parse(String(row.paper)) as Paper }));
  await rewriteWorks(env, [{ ...retracted, after: { ...retracted.before, publicationStatus: 'retracted' } }], NOW);
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane), ['cs.CL', 'cs.LG']);
  // Another source's record of both folds them into the arXiv row.
  await ingestPapers(env, [{ paper: { ...journal, id: 'openalex:W2', arxivId: '2610.11111' }, lanes: ['bio.comp'] }], { now: NOW });
  const works = rows(db, 'SELECT paper FROM works').map(row => JSON.parse(String(row.paper)) as Paper);
  assert.deepEqual(works.map(paper => [paper.id, paper.publicationStatus]), [['2610.11111', 'retracted']]);
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes'), []);
});

test('a review or a conference paper the enrichment reveals keeps every lane', async () => {
  const { env, db } = corpus();
  const record = { ...arxivRecord, allCategories: [], categories: [] };
  await ingestPapers(env, [{ paper: record, lanes: ['cs.LG'] }, { paper: { ...record, id: '2610.99999', arxivId: '2610.99999', title: 'A conference paper' }, lanes: ['cs.LG'] }], { now: NOW });
  const stored = rows(db, 'SELECT id, paper FROM works').map(row => ({ id: Number(row.id), before: JSON.parse(String(row.paper)) as Paper }));
  await rewriteWorks(env, stored.map(({ id, before }) => ({ id, before, after: { ...before, publicationType: before.arxivId === '2610.99999' ? 'conference-paper' : 'review' } })), NOW);
  assert.deepEqual(rows(db, "SELECT paper ->> 'publicationType' AS type FROM works WHERE id IN (SELECT work_id FROM work_lanes) ORDER BY type").map(row => row.type), ['conference-paper', 'review']);
});

test('a paper only an unfollowed entity names leaves; a category, the working-paper series or a follow keeps it', async () => {
  const { env, db } = corpus();
  const paper = (id: string, title: string) => ({ ...arxivRecord, id, arxivId: id, title, allCategories: [], categories: [] });
  await ingestPapers(env, [
    // As a paper its category's lane trimmed is: nearly every enriched paper names an author.
    { paper: paper('2610.00041', 'Named by an author nobody follows'), lanes: ['author:A9'] },
    { paper: paper('2610.00042', 'Listed for an author a reader follows'), lanes: ['author:A10'] },
    { paper: paper('2610.00043', 'In a category, named by an author'), lanes: ['cs.LG', 'author:A9'] },
    { paper: paper('2610.00044', 'In the working-paper series'), lanes: ['series:working-papers'] },
  ], { now: NOW });
  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('author:A10', ?)").run(new Date(NOW).toISOString());
  await evictAll(env, NOW);
  assert.deepEqual(rows(db, "SELECT key FROM work_keys WHERE key LIKE 'arxiv:%' ORDER BY key").map(row => row.key), ['arxiv:2610.00042', 'arxiv:2610.00043', 'arxiv:2610.00044']);
  assert.equal(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'author:A9'").length, 0, 'the author lane nobody follows no longer names the paper its category keeps');
});

test('an author, concept or institution lane is filed only while someone follows it; topic lanes always', async () => {
  const { env, db } = corpus();
  const paper = { ...arxivRecord, authors: [{ id: 'https://openalex.org/A10', name: 'A. Author' }], concepts: [{ id: 'C20', display_name: 'Graphs' }], institutions: [{ id: 'I30', name: 'Uni' }], topics: [{ id: 'T40', display_name: 'Combinatorics' }] };
  await ingestPapers(env, [{ paper, lanes: ['cs.LG'] }], { now: NOW });
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane), ['cs.CL', 'cs.LG', 'topic:T40']);
  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('concept:C20', ?)").run(new Date(NOW).toISOString());
  await ingestPapers(env, [{ paper: { ...paper, title: 'Listed again, v2' }, lanes: ['cs.LG'] }], { now: NOW });
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane), ['concept:C20', 'cs.CL', 'cs.LG', 'topic:T40']);
});

// ENG-123: the stored row keeps the OpenAlex id of the journal that published
// it (`venueId`), so a paper any lane lists joins a followed journal's lane,
// as it joins a followed author's, and no other journal's.
test("a journal's lane holds the papers that name it only while someone follows it, and eviction prunes it after", async () => {
  const { env, db } = corpus();
  const article = mapOpenAlexWork({
    id: 'https://openalex.org/W7000000001',
    doi: 'https://doi.org/10.1257/aer.20260001',
    title: 'Monetary policy and the term structure of interest rates',
    type: 'article',
    publication_date: '2026-10-12',
    abstract_inverted_index: { We: [0], study: [1], the: [2], term: [3], structure: [4], of: [5], interest: [6], rates: [7], after: [8], policy: [9], shocks: [10] },
    authorships: [{ author: { id: 'https://openalex.org/A10', display_name: 'Ana Economist' }, institutions: [] }],
    primary_location: { is_published: true, source: { id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' } },
  })!;
  const sourceLanes = () => rows(db, "SELECT lane FROM work_lanes WHERE lane LIKE 'source:%'").map(row => row.lane);
  await ingestPapers(env, [{ paper: article, lanes: ['area:econ'] }], { now: NOW });
  assert.equal(JSON.parse(String(rows(db, 'SELECT paper FROM works')[0].paper)).venueId, 'S23254222');
  assert.deepEqual(sourceLanes(), [], 'nobody follows the journal');

  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('source:S23254222', ?)").run(new Date(NOW).toISOString());
  await ingestPapers(env, [{ paper: article, lanes: ['area:econ'] }], { now: NOW });
  assert.deepEqual(sourceLanes(), ['source:S23254222']);

  db.prepare('DELETE FROM followed_lanes').run();
  await evictAll(env, NOW);
  assert.deepEqual(sourceLanes(), [], 'unfollowed, the lane lets the paper go');
  assert.equal(rows(db, 'SELECT id FROM works').length, 1, 'which its area lane keeps');
});

// ENG-123: the reader's journal name is the way to the journal's page and its
// Follow, so a paper the corpus serves keeps OpenAlex's name for the journal.
test("a journal article the corpus serves still names its journal for the reader's link", async () => {
  const { env } = corpus();
  await ingestPapers(env, [{ paper: physicsJournalArticle, lanes: ['area:physics'] }], { now: NOW });
  const [served] = await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'] }), { now: NOW });
  assert.deepEqual(journalExplorerLink(served), { name: 'Journal of the Physical Society of Japan', path: '/explorer/source/S119212824' });
});

// ENG-123: a journal's lane holds what its own listing asks for, articles and
// reviews. An editorial or letter another lane lists keeps out of it.
test("a followed journal's lane takes the reviews other lanes list, not their editorials or letters", async () => {
  const { env, db } = corpus();
  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('source:S23254222', ?)").run(new Date(NOW).toISOString());
  const work = (id: number, type: string, title: string) => mapOpenAlexWork({
    id: `https://openalex.org/W70000000${id}`,
    title,
    type,
    publication_date: '2026-10-12',
    abstract_inverted_index: { We: [0], study: [1], the: [2], term: [3], structure: [4], of: [5], interest: [6], rates: [7], after: [8], policy: [9], shocks: [10] },
    authorships: [{ author: { id: 'https://openalex.org/A10', display_name: 'Ana Economist' }, institutions: [] }],
    primary_location: { is_published: true, source: { id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' } },
  })!;
  const papers = [
    work(11, 'review', 'Fifty years of the term structure: a review'),
    work(12, 'editorial', 'Editorial: a new editor for the review'),
    work(13, 'letter', 'Letter to the editor on monetary policy'),
  ];
  await ingestPapers(env, papers.map(paper => ({ paper, lanes: ['area:econ'] })), { now: NOW });
  const filed = rows(db, "SELECT json_extract(works.paper, '$.title') AS title FROM work_lanes JOIN works ON works.id = work_lanes.work_id WHERE lane = 'source:S23254222'");
  assert.deepEqual(filed.map(row => row.title), ['Fifty years of the term structure: a review']);
});

// ENG-123: the type decides the journal's lane whenever the row is written
// again, not only when it is first filed. A row the journal's lane holds
// leaves it once a record or the enrichment calls it an editorial, keeps its
// other lanes, and comes back once it is an article again.
const aerWork = (type: string) => mapOpenAlexWork({
  id: 'https://openalex.org/W7000000021',
  doi: 'https://doi.org/10.1257/aer.20260021',
  title: 'Monetary policy and the term structure of interest rates, revisited',
  type,
  publication_date: '2026-10-12',
  abstract_inverted_index: { We: [0], study: [1], the: [2], term: [3], structure: [4], of: [5], interest: [6], rates: [7], after: [8], policy: [9], shocks: [10] },
  authorships: [{ author: { id: 'https://openalex.org/A10', display_name: 'Ana Economist' }, institutions: [] }],
  primary_location: { is_published: true, source: { id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' } },
})!;
const aerFollow = { type: 'journal', canonicalId: 'S23254222', displayName: 'American Economic Review' };
// A notable listing of the paper, which the journal's lane must not take along.
const aerNotable = { lanes: ['area:econ', 'notable:econ.GN'], keepUntil: '2026-11-05T03:00:00.000Z' };

// The paper's author is followed too: leaving the journal's lane keeps the author's.
function followedJournalCorpus() {
  const store = corpus();
  for (const lane of ['source:S23254222', 'author:A10']) {
    store.db.prepare('INSERT INTO followed_lanes (lane, requested_at) VALUES (?, ?)').run(lane, new Date(NOW).toISOString());
  }
  const lanes = () => rows(store.db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane);
  const journalPage = async () => (await readFeedPage(store.env, parseFeedRequest({ categories: [], follows: [aerFollow], page: 0, pageSize: 15 }), { now: NOW }))
    .map(entry => [entry.id, entry._followedEntityMatches]);
  return { ...store, lanes, journalPage };
}

test("an article a listing reclassifies as an editorial leaves its followed journal's lane, and comes back as an article", async () => {
  const { env, lanes, journalPage } = followedJournalCorpus();
  await ingestPapers(env, [{ paper: aerWork('article'), lanes: aerNotable.lanes }], { now: NOW, keepUntil: aerNotable.keepUntil });
  assert.deepEqual(lanes(), ['area:econ', 'author:A10', 'notable:econ.GN', 'source:S23254222']);
  assert.deepEqual(await journalPage(), [['openalex:W7000000021', [aerFollow]]]);

  await ingestPapers(env, [{ paper: aerWork('editorial'), lanes: ['area:econ'] }], { now: NOW });
  assert.deepEqual(lanes(), ['area:econ', 'author:A10', 'notable:econ.GN'], 'its other lanes keep it');
  assert.deepEqual(await journalPage(), []);

  await ingestPapers(env, [{ paper: aerWork('article'), lanes: ['area:econ'] }], { now: NOW });
  assert.deepEqual(lanes(), ['area:econ', 'author:A10', 'notable:econ.GN', 'source:S23254222']);
});

test("a journal's own listing does not keep in its lane a row another record of the batch calls an editorial", async () => {
  const { env, lanes } = followedJournalCorpus();
  await ingestPapers(env, [{ paper: aerWork('article'), lanes: ['source:S23254222'] }, { paper: aerWork('editorial'), lanes: ['area:econ'] }], { now: NOW });
  assert.deepEqual(lanes(), ['area:econ', 'author:A10']);
});

// The journal's row folds into the arXiv one, which then holds its lanes:
// the lane of the journal goes with the fold, the others stay.
test("a record that folds a journal's article into another row as an editorial takes it out of the journal's lane only", async () => {
  const { env, lanes, journalPage } = followedJournalCorpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }, { paper: aerWork('article'), lanes: aerNotable.lanes }], { now: NOW, keepUntil: aerNotable.keepUntil });
  assert.deepEqual(lanes(), ['area:econ', 'author:A10', 'cs.CL', 'cs.LG', 'notable:econ.GN', 'source:S23254222']);

  await ingestPapers(env, [{ paper: { ...aerWork('editorial'), arxivId: arxivRecord.arxivId }, lanes: [] }], { now: NOW });
  assert.deepEqual(lanes(), ['area:econ', 'author:A10', 'cs.CL', 'cs.LG', 'notable:econ.GN']);
  assert.deepEqual(await journalPage(), []);
});

test("an article the enrichment reclassifies as an editorial leaves its followed journal's lane, and comes back as an article", async () => {
  const { env, db, lanes, journalPage } = followedJournalCorpus();
  await ingestPapers(env, [{ paper: aerWork('article'), lanes: aerNotable.lanes }], { now: NOW, keepUntil: aerNotable.keepUntil });
  const stored = () => rows(db, 'SELECT id, paper FROM works').map(row => ({ id: Number(row.id), before: JSON.parse(String(row.paper)) as Paper }));
  await rewriteWorks(env, stored().map(({ id, before }) => ({ id, before, after: { ...before, publicationType: 'editorial' } })), NOW);
  assert.deepEqual(lanes(), ['area:econ', 'author:A10', 'notable:econ.GN']);
  assert.deepEqual(await journalPage(), []);

  await rewriteWorks(env, stored().map(({ id, before }) => ({ id, before, after: { ...before, publicationType: 'article' } })), NOW);
  assert.deepEqual(lanes(), ['area:econ', 'author:A10', 'notable:econ.GN', 'source:S23254222']);
  assert.deepEqual(await journalPage(), [['openalex:W7000000021', [aerFollow]]]);
});

test('eviction prunes entity lanes nobody follows and keeps topic lanes and followed ones', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: ['cs.LG'] }], { now: NOW });
  const [{ id }] = rows(db, 'SELECT id FROM works');
  for (const lane of ['author:A10', 'concept:C20', 'institution:I30', 'topic:T40', 'author:A11']) {
    db.prepare("INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)").run(lane, Number(id), arxivRecord.published!);
  }
  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('author:A11', ?)").run(new Date(NOW).toISOString());
  await evictAll(env, NOW);
  assert.deepEqual(rows(db, 'SELECT lane FROM work_lanes ORDER BY lane').map(row => row.lane), ['author:A11', 'cs.CL', 'cs.LG', 'topic:T40']);
});

test('a new follow is served nothing from the corpus until its own harvest files the lane', async () => {
  const { env, db } = corpus();
  const paper = { ...arxivRecord, authors: [{ id: 'https://openalex.org/A10', name: 'A. Author' }] };
  await ingestPapers(env, [{ paper, lanes: ['cs.LG'] }], { now: NOW });
  const follow = { type: 'author', canonicalId: 'A10', displayName: 'A. Author' };
  const before = await readFeedPage(env, parseFeedRequest({ categories: [], follows: [follow], page: 0, pageSize: 15 }), { now: NOW });
  assert.equal(before.length, 0);
  // What the follow's harvest does: lists the lane and files the paper under it.
  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('author:A10', ?)").run(new Date(NOW).toISOString());
  await ingestPapers(env, [{ paper, lanes: ['author:A10'] }], { now: NOW });
  const after = await readFeedPage(env, parseFeedRequest({ categories: [], follows: [follow], page: 0, pageSize: 15 }), { now: NOW });
  assert.deepEqual(after.map(entry => entry._followedEntityMatches?.length), [1]);
});

test('a batch files the followed lanes its papers name, those only its stored row names included, and no other follow', async () => {
  const { env, db } = corpus();
  const followLaneNow = (lane: string) => db.prepare('INSERT INTO followed_lanes (lane, requested_at) VALUES (?, ?)').run(lane, new Date(NOW).toISOString());
  const entityLanes = () => rows(db, "SELECT lane FROM work_lanes WHERE lane LIKE '%:%' ORDER BY lane").map(row => row.lane);
  followLaneNow('author:A11');
  followLaneNow('concept:C99');
  const paper = { ...arxivRecord, authors: [{ id: 'https://openalex.org/A10', name: 'Ana Pérez' }, { id: 'https://openalex.org/A11', name: 'Li Wei' }] };
  await ingestPapers(env, [{ paper, lanes: [] }], { now: NOW });
  assert.deepEqual(entityLanes(), ['author:A11']);
  // arXiv's next version names its authors without ids; the stored row keeps them.
  followLaneNow('author:A10');
  await ingestPapers(env, [{ paper: arxivRevision, lanes: [] }], { now: NOW });
  assert.deepEqual(entityLanes(), ['author:A10', 'author:A11']);
});

// Each D1 round trip a request makes, as the statements it sent.
function roundTrips(t: TestContext, binding: D1Database) {
  const trips: string[][] = [];
  const statement = Object.getPrototypeOf(binding.prepare('SELECT 1')) as Record<'all' | 'first' | 'run', (...args: unknown[]) => unknown>;
  for (const name of ['all', 'first', 'run'] as const) {
    const send = statement[name];
    t.mock.method(statement, name, function (this: { sql: string }, ...args: unknown[]) {
      trips.push([this.sql]);
      return send.apply(this, args);
    });
  }
  const batch = binding.batch.bind(binding);
  t.mock.method(binding, 'batch', (statements: D1PreparedStatement[]) => {
    trips.push(statements.map(sent => (sent as unknown as { sql: string }).sql));
    return batch(statements);
  });
  return trips;
}

test("a page reads vectors only to rank by a like, and the candidates' in one round trip", async t => {
  const { env, db } = corpus();
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertKey = db.prepare('INSERT INTO work_keys (key, work_id) VALUES (?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  const insertVector = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  // 2,200 candidates in two lanes, a minute apart. Two liked papers in no
  // lane: 2610.02201 with a vector like the oldest candidate's only, and
  // 2610.02202 without one.
  db.exec('BEGIN');
  for (let id = 1; id <= 2_202; id += 1) {
    const arxivId = `2610.${String(id).padStart(5, '0')}`;
    const published = new Date(NOW - id * 60_000).toISOString();
    insertWork.run(id, JSON.stringify({ id: arxivId, arxivId, title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertKey.run(`arxiv:${arxivId}`, id);
    if (id <= 2_200) insertLane.run(id % 2 ? 'cs.CL' : 'cs.LG', id, published);
    if (id <= 2_201) insertVector.run(id, Buffer.from(quantize(id >= 2_200 ? [1, 0] : [0, 1]).buffer));
  }
  db.exec('COMMIT');
  const trips = roundTrips(t, env.PAPER_STORE!);
  const vectorReads = () => trips.filter(trip => trip.some(sql => /^\s*SELECT\b[\s\S]*\bwork_vectors\b/i.test(sql))).length;
  const page = (positiveIds: string[]) => readFeedPage(env, parseFeedRequest({ categories: ['cs.CL', 'cs.LG'], positiveIds, pageSize: 1 }), { now: NOW });

  assert.deepEqual((await page([])).map(paper => paper.id), ['2610.00001']);
  assert.equal(vectorReads(), 0, 'newest first reads no vector');
  assert.deepEqual((await page(['2610.02202'])).map(paper => paper.id), ['2610.00001']);
  assert.equal(vectorReads(), 1, "a like without a vector: only its own is looked for");
  assert.deepEqual((await page(['2610.02201'])).map(paper => paper.id), ['2610.02200']);
  assert.equal(vectorReads(), 3, "the like's vector, then every candidate's in one round trip");
});

test("an enrichment step's papers are written back however long their text, within what one D1 call carries", async () => {
  const { env, db } = corpus();
  // 500 papers, an enrichment step's, with abstracts as long as the longest stored.
  const papers = Array.from({ length: 500 }, (_, index) => ({
    ...arxivRecord,
    id: `2610.${String(index).padStart(5, '0')}`,
    arxivId: `2610.${String(index).padStart(5, '0')}`,
    title: `Paper number ${index} with a long abstract`,
    abstract: 'A long abstract. '.repeat(1_000),
  }));
  await ingestPapers(env, papers.map(paper => ({ paper, lanes: ['cs.LG'] })), { now: NOW });
  const stored = rows(db, 'SELECT id, paper FROM works').map(row => ({ id: Number(row.id), before: JSON.parse(String(row.paper)) as Paper }));
  await rewriteWorks(env, stored.map(({ id, before }) => ({ id, before, after: { ...before, citationCount: 7, citationCountKnown: true } })));
  assert.equal(rows(db, "SELECT id FROM works WHERE paper ->> 'citationCount' = 7").length, 500);
});

test('a stored row keeps the merged citation count and drops the OpenAlex payload', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: ['cs.LG'] }], { now: NOW });
  const [stored] = rows(db, 'SELECT id, paper FROM works');
  const before = JSON.parse(String(stored.paper)) as Paper;
  // Enrichment merges OpenAlex's answer, which keeps its payload under `openAlex`.
  const openAlex = { citationCount: 7, related_works: ['W1'] };
  await rewriteWorks(env, [{ id: Number(stored.id), before, after: PaperBuilder.merge(before, openAlex, 'openalex') }], NOW);
  const [row] = rows(db, "SELECT paper ->> 'openAlex' AS openAlex, paper ->> 'citationCount' AS citations FROM works");
  assert.equal(row.openAlex, null);
  assert.equal(Number(row.citations), 7);
});

test('a stored row carries no summary; a new version replaces the abstract alone', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: { ...arxivRecord, summary: arxivRecord.abstract }, lanes: ['cs.LG'] }], { now: NOW });
  await ingestPapers(env, [{ paper: { ...arxivRecord, abstract: 'Version two abstract.', summary: 'Version two abstract.' }, lanes: ['cs.LG'] }], { now: NOW });
  const [row] = rows(db, "SELECT paper ->> 'summary' AS summary, paper ->> 'abstract' AS abstract FROM works");
  assert.equal(row.summary, null);
  assert.equal(row.abstract, 'Version two abstract.');
});

test('a refresh whose OpenAlex answer changes nothing the row stores does not rewrite it', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: ['cs.LG'] }], { now: NOW });
  const openAlex = { citationCount: 7, related_works: ['W1'] };
  const enrich = async () => {
    const [stored] = rows(db, 'SELECT id, paper FROM works');
    const before = JSON.parse(String(stored.paper)) as Paper;
    return rewriteWorks(env, [{ id: Number(stored.id), before, after: PaperBuilder.merge(before, openAlex, 'openalex') }], NOW);
  };
  assert.equal(await enrich(), 1);
  assert.equal(await enrich(), 0);
});

// ─── Cold first page (ENG-116 Phase 1a): the same ranking for less D1 and CPU ───

// D1 answers `hex(embedding)` as text: two characters a byte, 128-255 for the
// negative components, as the BLOB's unsigned bytes were.
test('a vector D1 answers as hex reads back as the stored int8 components', () => {
  assert.deepEqual([...readVector('007F80FF')], [0, 127, -128, -1]);
  assert.deepEqual([...readVector('007f80ff')], [0, 127, -128, -1]);
  const stored = quantize(Array.from({ length: 256 }, (_, index) => Math.sin(index * 1.7) - 0.2));
  assert.ok(stored.some(value => value < 0) && stored.some(value => value > 0));
  assert.deepEqual([...readVector(Buffer.from(stored.buffer).toString('hex').toUpperCase())], [...stored]);
  assert.deepEqual([...readVector('')], []);
});

// A deterministic generator, so a failure names the fixture that broke.
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// The ranking as origin/main f8bbd22d wrote it, copied as the oracle: each
// candidate normalized where it is ranked, and a diversity pass that compares
// every remaining candidate with each one it selects.
function rankedOnMain<T extends { embedding: Int8Array | null; published: string }>(rows: T[], positives: Int8Array[], { now, order = 'recent', negatives = [] }: { now: number; order?: 'recent' | 'relevance'; negatives?: Int8Array[] }) {
  const unit = (vector: Int8Array) => {
    const norm = Math.hypot(...vector) || 1;
    return Float64Array.from(vector, value => value / norm);
  };
  const cosine = (a: Float64Array, b: Float64Array) => {
    let dot = 0;
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) dot += a[index] * b[index];
    return Math.max(-1, Math.min(1, dot));
  };
  const weight = { recent: 0.15, relevance: 0 }[order];
  const likedVectors = positives.map(unit);
  const rejectedVectors = negatives.map(unit);
  const recency = (published: string) => 0.5 ** (Math.max(0, now - Date.parse(published)) / 86_400_000 / 7);
  const ranked = rows
    .map(row => {
      const embedding = row.embedding ? unit(row.embedding) : null;
      const similarity = positives.length && embedding ? likedVectors.reduce((best, positive) => Math.max(best, cosine(embedding, positive)), -1) : 0;
      const rejectedSimilarity = embedding ? rejectedVectors.reduce((best, negative) => Math.max(best, cosine(embedding, negative)), 0) : 0;
      const negative = Math.max(0, (rejectedSimilarity - 0.75) / (1 - 0.75));
      const semanticScore = Math.max(0, Math.min(1, (similarity - 0.4) / 0.4)) - negative;
      return { row, embedding, score: similarity - 0.5 * negative + weight * recency(row.published), semanticScore };
    })
    .sort((a, b) => b.score - a.score || b.row.published.localeCompare(a.row.published));
  if (!positives.length && !negatives.length) return ranked;
  const pool = ranked.slice(0, 500).map(candidate => ({ candidate, redundancy: 0 }));
  const selected: typeof ranked = [];
  while (pool.length && selected.length < 150) {
    let best = 0;
    for (let index = 1; index < pool.length; index += 1) {
      if (pool[index].candidate.score - 0.3 * pool[index].redundancy > pool[best].candidate.score - 0.3 * pool[best].redundancy) best = index;
    }
    const [{ candidate }] = pool.splice(best, 1);
    selected.push(candidate);
    if (candidate.embedding) {
      for (const entry of pool) {
        if (entry.candidate.embedding) entry.redundancy = Math.max(entry.redundancy, Math.max(0, (cosine(candidate.embedding, entry.candidate.embedding) - 0.75) / 0.25));
      }
    }
  }
  const chosen = new Set(selected);
  return [...selected, ...ranked.filter(candidate => !chosen.has(candidate))];
}

// Clustered vectors, so near copies, rejections and the diversity pass all
// matter: `spread` is how far a vector strays from its cluster's centre.
function clusteredVectors(random: () => number, clusters: number, dimensions = 32) {
  const centres = Array.from({ length: clusters }, () => Array.from({ length: dimensions }, () => random() - 0.5));
  return (cluster: number, spread: number) => quantize(centres[cluster % clusters].map(value => value + (random() - 0.5) * spread));
}

test('the ranking orders, scores and diversifies every candidate as main did, ties and missing vectors included', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  let compared = 0;
  for (let fixture = 0; fixture < 40; fixture += 1) {
    const random = seeded(fixture + 1);
    const vector = clusteredVectors(random, 1 + Math.floor(random() * 12));
    const size = [1, 2, 20, 149, 150, 151, 499, 500, 501, 900, 1_400][fixture % 11];
    const rows: Array<{ id: number; embedding: Int8Array | null; published: string }> = [];
    for (let id = 0; id < size; id += 1) {
      const previous = rows.at(-1);
      // Forced ties: a copy of the previous row's vector and date, the same
      // date with another vector, rows without a vector.
      const tie = previous !== undefined && random() < 0.15;
      const embedding = random() < 0.08 ? null : tie && random() < 0.6 ? previous.embedding : vector(Math.floor(random() * 50), random() * 1.5);
      const published = tie ? previous.published : new Date(now - Math.floor(random() * 90) * 86_400_000 - Math.floor(random() * 4) * 3_600_000).toISOString();
      rows.push({ id, embedding, published });
    }
    const likes = Array.from({ length: fixture % 4 }, () => vector(Math.floor(random() * 50), random()));
    const negatives = Array.from({ length: (fixture >> 2) % 3 }, () => vector(Math.floor(random() * 50), random()));
    for (const order of ['recent', 'relevance'] as const) {
      const expected = rankedOnMain(rows, likes, { now, order, negatives }).map(({ row, score, semanticScore }) => [row.id, score, semanticScore]);
      const actual = rankBySimilarity(rows, likes, { now, order, negatives }).map(({ row, score, semanticScore }) => [row.id, score, semanticScore]);
      assert.deepEqual(actual, expected, `fixture ${fixture}, ${order}: ${likes.length} likes, ${negatives.length} rejections, ${size} rows`);
      compared += 1;
    }
  }
  assert.equal(compared, 80);
});

// A corpus of 1,700 candidates in three categories, 60 notable papers, likes
// and rejections, each work's vector from its cluster: the pages, scores and
// kept orders below are what origin/main f8bbd22d served from it, before
// vectors came as hex and the diversity pass ran lazily. That change had to
// keep them; a change meant to rank differently computes them again.
function coldPageCorpus() {
  const { env, db } = corpus();
  const random = seeded(116);
  const vector = clusteredVectors(random, 12);
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertKey = db.prepare('INSERT INTO work_keys (key, work_id) VALUES (?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  const insertVector = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  let workId = 0;
  let previous: Int8Array | null = null;
  const add = (lanes: string[], published: string, embedding: Int8Array | null) => {
    workId += 1;
    const id = `2610.${String(workId).padStart(5, '0')}`;
    insertWork.run(workId, JSON.stringify({ id, arxivId: id, title: `Paper ${workId}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertKey.run(`arxiv:${id}`, workId);
    lanes.forEach(lane => insertLane.run(lane, workId, published));
    if (embedding) insertVector.run(workId, Buffer.from(embedding.buffer));
    previous = embedding ?? previous;
    return id;
  };
  db.exec('BEGIN');
  // Two papers a date, a copy of the previous vector now and then, and some
  // papers not yet embedded.
  for (let index = 0; index < 1_400; index += 1) {
    const lanes = index % 3 === 0 ? ['cs.LG', 'cs.CL'] : index % 2 ? ['cs.LG'] : ['cs.CL'];
    const embedding = index % 11 === 10 ? null : index % 7 === 6 && previous ? previous : vector(index % 12, random() * 1.2);
    add(lanes, new Date(NOW - Math.floor(index / 2) * 1_800_000).toISOString(), embedding);
  }
  for (let index = 0; index < 300; index += 1) add(['econ.GN'], new Date(NOW - index * 3_000_000 - 900_000).toISOString(), vector(5 + (index % 4), random() * 1.2));
  for (let index = 0; index < 60; index += 1) add(['notable:cs.LG'], `${2016 + (index % 10)}-0${1 + (index % 9)}-1${index % 10}T00:00:00.000Z`, vector(index % 12, random() * 1.2));
  const old = new Date(NOW - 60 * 86_400_000).toISOString();
  const likes = [add([], old, vector(0, 0.3)), add([], old, vector(3, 0.6)), add([], old, vector(6, 0.3))];
  const rejections = [add([], old, vector(1, 0.3)), add([], old, vector(3, 0.4)), add([], old, vector(7, 0.5))];
  db.exec('COMMIT');
  return { env, db, likes, rejections };
}

// What a request serves and what it keeps for the pages after it, as one
// digest of every rank and score: the kept order holds every candidate. With
// `decided`, of the kept order only its first `decided` ranks, without whether
// it is final: an exploration page without likes decides no more of it.
async function servedAndKept(env: Parameters<typeof readFeedPage>[0], body: Parameters<typeof parseFeedRequest>[0], { decided }: { decided?: number } = {}) {
  const kept: KeptRanking[] = [];
  const cache: RankingCache = { get: async () => null, put: async (_key, ranking) => { kept.push(ranking); } };
  const page = await readFeedPage(env, parseFeedRequest(body), { now: NOW, cache });
  const ranking = kept.map(({ ranks, notable, final }) => ({
    ...(decided === undefined ? { final } : {}),
    ranks: ranks.slice(0, decided).map(rank => rank && [rank.workId, rank.semanticScore ?? null]),
    notable: notable.map(rank => [rank.workId, rank.semanticScore ?? null]),
  }));
  return {
    ids: page.map(paper => paper.id),
    digest: createHash('sha256').update(JSON.stringify({ page: page.map(paper => [paper.id, paper._semanticScore ?? null, paper._notable === true]), ranking })).digest('hex'),
  };
}

test('a first page serves the papers, scores and kept order it did before the hex vectors and lazy diversity pass: likes in groups with rejections and notable papers', async () => {
  const { env, likes, rejections } = coldPageCorpus();
  const served = await servedAndKept(env, {
    groups: [
      { categories: ['cs.LG', 'cs.CL'], exampleCategories: ['cs.LG', 'cs.CL'], positiveIds: likes.slice(0, 2), weight: 1 },
      { categories: ['econ.GN'], exampleCategories: ['econ.GN'], positiveIds: likes.slice(2), weight: 2 },
    ],
    negativeIds: rejections,
    seen: feedSeenFilter([]),
    notable: 3,
    pageSize: 15,
  });
  assert.deepEqual(served, {
    ids: [
      '2610.01454', '2610.00013', '2610.01462', '2610.01478', '2610.00268', '2610.01482', '2610.01430', '2610.00424',
      '2610.01466', '2610.01450', '2610.00073', '2610.01410', '2610.01654', '2610.00037', '2610.01402',
      // The notable cards.
      '2610.01713', '2610.01755', '2610.01740',
    ],
    digest: '70caa410ab647533619e96048ccae4516c6fe79eec95bb9e2396ffa801ea6f45',
  });
});

test('a first page that skips seen papers serves what it did before the hex vectors and lazy diversity pass, ranked by relevance with one like', async () => {
  const { env, likes } = coldPageCorpus();
  const served = await servedAndKept(env, {
    categories: ['cs.LG', 'cs.CL', 'econ.GN'],
    positiveIds: likes.slice(0, 1),
    order: 'relevance',
    seen: feedSeenFilter(Array.from({ length: 40 }, (_, index) => `2610.${String(2 + index * 3).padStart(5, '0')}`)),
    skipsSeen: true,
    notable: 2,
  });
  assert.deepEqual(served, {
    ids: [
      '2610.00985', '2610.00757', '2610.00793', '2610.00901', '2610.01009', '2610.01213', '2610.00325', '2610.00625',
      '2610.00577', '2610.01357', '2610.01249', '2610.00229', '2610.00157', '2610.00073', '2610.00481',
      '2610.01713', '2610.01701',
    ],
    digest: '65c7d179e4fcdbbc91603708cb7de39633965cbdebac67ce9706ac74006f8caa',
  });
});

// Of the kept order, the diversity pool's 500 ranks: the ranks past it are
// what the page did not read (below).
test('an exploration page, with rejections and no likes, serves what it did before the hex vectors and lazy diversity pass', async () => {
  const { env, rejections } = coldPageCorpus();
  const served = await servedAndKept(env, { categories: ['cs.LG', 'cs.CL'], negativeIds: rejections, page: 3, pageSize: 5 }, { decided: 500 });
  assert.deepEqual(served, {
    ids: ['2610.00027', '2610.00031', '2610.00032', '2610.00033', '2610.00034'],
    digest: '4198875ee8401c7a897410b303d75982b44b15a8b5f428e844c948ba49a1517b',
  });
});

// A paper of cs.LG is ranked by both groups, and the second like by both: the
// request normalizes each once and both groups read the same vector.
test('groups that share a lane and a like serve what they did before the hex vectors and lazy diversity pass', async () => {
  const { env, likes, rejections } = coldPageCorpus();
  const served = await servedAndKept(env, {
    groups: [
      { categories: ['cs.LG', 'cs.CL'], exampleCategories: ['cs.LG', 'cs.CL'], positiveIds: likes.slice(0, 2), weight: 1 },
      { categories: ['cs.LG', 'econ.GN'], exampleCategories: ['cs.LG', 'econ.GN'], positiveIds: likes.slice(1), weight: 1 },
    ],
    negativeIds: rejections.slice(0, 1),
    pageSize: 15,
  });
  assert.deepEqual(served, {
    ids: [
      '2610.00013', '2610.01454', '2610.00004', '2610.00208', '2610.00073', '2610.01462', '2610.00037', '2610.01478',
      '2610.00025', '2610.00127', '2610.00229', '2610.01482', '2610.00289', '2610.00268', '2610.00001',
    ],
    digest: '4b92422998b2e6c427fc8a593ee76cc5b5462af168b5afedbf423b4a304f6410',
  });
});

test('a page without likes or rejections serves what it did before the hex vectors and lazy diversity pass, newest first', async () => {
  const { env } = coldPageCorpus();
  const served = await servedAndKept(env, { categories: ['cs.LG', 'econ.GN'], pageSize: 15 });
  assert.deepEqual(served, {
    ids: [
      '2610.00001', '2610.00002', '2610.01401', '2610.00004', '2610.00006', '2610.01402', '2610.00007', '2610.00008',
      '2610.01403', '2610.00010', '2610.00012', '2610.01404', '2610.00013', '2610.00014', '2610.00016',
    ],
    digest: '16f2e9a1614dcf5531cd85694b0144aef833b5811e50b11a5c5e00d42b4323de',
  });
});

test('a page that ranks by vectors asks D1 for them as hex text', async t => {
  const { env, likes } = coldPageCorpus();
  const binding = env.PAPER_STORE!;
  const answers: unknown[] = [];
  const batch = binding.batch.bind(binding);
  t.mock.method(binding, 'batch', async (statements: D1PreparedStatement[]) => {
    const results = await batch(statements);
    statements.forEach((sent, index) => {
      if (/\bwork_vectors\b/.test((sent as unknown as { sql: string }).sql)) answers.push(...results[index].results.map(row => (row as { embedding: unknown }).embedding));
    });
    return results;
  });
  await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], positiveIds: likes.slice(0, 1) }), { now: NOW });
  assert.ok(answers.length > 500, `${answers.length} vectors read`);
  for (const answer of answers) assert.match(String(answer), /^[0-9A-F]{64}$/, 'each vector is its 32 bytes as hex');
});

// ─── Pages without likes (ENG-116): the vectors their ranks need, newest first ───

// A ranking cache that keeps each order as JSON, as the Worker's does.
function jsonRankingCache(): RankingCache {
  const kept = new Map<string, string>();
  const put: RankingCache['put'] = async (key, ranking) => { kept.set(key, JSON.stringify(ranking)); };
  return {
    get: async key => {
      const json = kept.get(key);
      return json === undefined ? null : JSON.parse(json) as KeptRanking;
    },
    put,
    update: put,
  };
}

// The ids each page serves, asked by number in turn with one cache, as the
// app pages, and asked again alone from an empty cache, which must serve the same.
async function pagesByNumber(env: Parameters<typeof readFeedPage>[0], body: Parameters<typeof parseFeedRequest>[0], pages: number[]) {
  const cache = jsonRankingCache();
  const served: string[][] = [];
  for (const page of pages) {
    const ids = (await readFeedPage(env, parseFeedRequest({ ...body, page }), { now: NOW, cache })).map(paper => paper.id);
    const alone = (await readFeedPage(env, parseFeedRequest({ ...body, page }), { now: NOW, cache: jsonRankingCache() })).map(paper => paper.id);
    assert.deepEqual(alone, ids, `page ${page}, asked alone`);
    served.push(ids);
  }
  return served;
}

// The rows of `work_vectors` D1 answers a request with.
function vectorRowsRead(t: TestContext, binding: D1Database) {
  let rows = 0;
  const batch = binding.batch.bind(binding);
  t.mock.method(binding, 'batch', async (statements: D1PreparedStatement[]) => {
    const results = await batch(statements);
    statements.forEach((sent, index) => {
      if (/\bwork_vectors\b/.test((sent as unknown as { sql: string }).sql)) rows += results[index].results.length;
    });
    return results;
  });
  return () => rows;
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Pages of 30 through the diversity pool's 500 ranks and two far past it,
// and exploration's own: pages of 2 within its first 30 ranks. The digests are
// what 65a9b5c5 served, reading every candidate's vector.
test('pages without likes serve what a read of every vector did, across lanes, interest groups, orders and pages', async () => {
  const { env, rejections } = coldPageCorpus();
  const groups = [
    { categories: ['cs.LG', 'cs.CL'], exampleCategories: ['cs.LG', 'cs.CL'], positiveIds: [], weight: 1 },
    { categories: ['cs.LG', 'econ.GN'], exampleCategories: ['cs.LG', 'econ.GN'], positiveIds: [], weight: 2 },
  ];
  const deep = [...Array.from({ length: 18 }, (_, page) => page), 30, 46];
  const served = {
    rejections: await pagesByNumber(env, { categories: ['cs.LG', 'cs.CL'], negativeIds: rejections, pageSize: 30 }, deep),
    byRelevance: await pagesByNumber(env, { categories: ['cs.LG', 'econ.GN'], negativeIds: rejections.slice(1), order: 'relevance', pageSize: 30 }, deep),
    groups: await pagesByNumber(env, { groups, negativeIds: rejections, pageSize: 30 }, deep),
    noSignal: await pagesByNumber(env, { groups, pageSize: 30 }, deep),
    exploration: await pagesByNumber(env, { categories: ['cs.CL', 'econ.GN'], negativeIds: rejections, pageSize: 2 }, Array.from({ length: 15 }, (_, page) => page)),
  };
  assert.equal(served.rejections[0].length, 30);
  assert.equal(served.exploration[14].length, 2);
  assert.deepEqual(Object.fromEntries(Object.entries(served).map(([name, pages]) => [name, sha(pages)])), {
    rejections: '3d86ed5c8b122616d27fdc80e15f136f5e3bca7c7842805e6d7f1904140b15c3',
    byRelevance: 'a12ef1b863a294127f79295311f2df64c2c0b29dc6a4e23fb6c527e013b1c0f8',
    groups: '4ccc59148db408ad5a5e2c3592c3cbab441e630ffa35b92d2fd7e04a4331cc2e',
    noSignal: '2fc3b6bde0726b46d0a6c38e1f544993cd079582037b89d66ebbc57461c73f22',
    exploration: '7eced58ca13cfc196f5570b9b9c2274980a925d40acb32deb197ebc0998302fe',
  });
});

// cs.LG and cs.CL hold 1,400 candidates, of which 1,273 have a vector (one in
// eleven is not embedded). The page's 5 papers and the diversity pool's 500
// ranks are decided by the 600 newest, 546 of them embedded, and the 3
// rejections' own vectors. Ranks past them are not, so the order kept is not
// final: it says it decided 500 ranks, and a page past them ranks again.
test('a page without likes reads the vectors of its newest candidates only, and keeps its order as decided through the diversity pool', async t => {
  const { env, rejections } = coldPageCorpus();
  const rows = vectorRowsRead(t, env.PAPER_STORE!);
  const kept: KeptRanking[] = [];
  const cache: RankingCache = { get: async () => null, put: async (_key, ranking) => { kept.push(ranking); } };
  await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG', 'cs.CL'], negativeIds: rejections, page: 3, pageSize: 5 }), { now: NOW, cache });
  assert.equal(rows(), 546 + 3);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].final, false);
  assert.equal(kept[0].decided, 500);
});

// The slow-request line (`FeedTimings`) of a page without likes: each round
// trip for candidate vectors takes 400 ms here, and every round is in the
// `vectors` step and counted, so a line shows a page that needed more than one.
test('a slow page without likes times every round of its vector reads as vectors, and counts the rounds', async t => {
  const { env, rejections } = coldPageCorpus();
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const binding = env.PAPER_STORE!;
  const batch = binding.batch.bind(binding);
  t.mock.method(binding, 'batch', async (statements: D1PreparedStatement[]) => {
    const results = await batch(statements);
    if (statements.some(sent => /\bwork_vectors\b/.test((sent as unknown as { sql: string }).sql))) t.mock.timers.tick(400);
    return results;
  });
  const line = async (body: Parameters<typeof parseFeedRequest>[0]) => {
    const timings = new FeedTimings();
    await readFeedPage(env, parseFeedRequest(body), { now: NOW, timings });
    const logged = t.mock.method(console, 'log', () => undefined);
    timings.logIfSlow('/store/papers', 2_000, { status: 200 });
    logged.mock.restore();
    const { steps, counts } = JSON.parse(String(logged.mock.calls[0].arguments[0]));
    return { vectors: steps.vectors, wave1: steps.wave1, rounds: counts.vectorRounds, read: counts.vectors };
  };
  const body = { categories: ['cs.LG', 'cs.CL'], negativeIds: rejections };
  // The newest 600 decide the page and the diversity pool.
  assert.deepEqual(await line({ ...body, page: 3, pageSize: 5 }), { vectors: 400, wave1: 400, rounds: 1, read: 546 });
  // Ranks 930 to 960: the newest 1,030 do not decide them, and a second round reads the rest.
  assert.deepEqual(await line({ ...body, page: 31, pageSize: 30 }), { vectors: 800, wave1: 400, rounds: 2, read: 1_273 });
  // A like reads every candidate's vector in one round.
  assert.deepEqual(await line({ ...body, positiveIds: rejections.slice(0, 1), negativeIds: rejections.slice(1), page: 31, pageSize: 30 }), { vectors: 400, wave1: 400, rounds: 1, read: 1_273 });
  // Without a like or a rejection, no candidate vector is read.
  assert.deepEqual(await line({ categories: ['cs.LG', 'cs.CL'], page: 3, pageSize: 5 }), { vectors: 0, wave1: 0, rounds: undefined, read: 0 });
});

// Exploration asks a random page of 5 within its first 30 ranks, under one
// key through a session: a later page within the ranks the first decided is
// served from the order it kept, reading no lane or vector, as main served it
// from a final order. A page past them ranks again.
test('a later page without likes, within the ranks the first decided, is served from the kept order without reading lanes or vectors', async t => {
  const { env, rejections } = coldPageCorpus();
  const trips = roundTrips(t, env.PAPER_STORE!);
  const corpusReads = () => trips.flat().filter(sql => /\bwork_(lanes|vectors)\b/.test(sql)).length;
  const cache = jsonRankingCache();
  const body = { categories: ['cs.LG', 'cs.CL'], negativeIds: rejections, pageSize: 5 };
  const page = async (number: number, from = cache) => (await readFeedPage(env, parseFeedRequest({ ...body, page: number }), { now: NOW, cache: from })).map(paper => paper.id);
  const alone = async (number: number) => page(number, jsonRankingCache());
  const expected = { 2: await alone(2), 4: await alone(4), 1: await alone(1), 100: await alone(100) };
  assert.deepEqual(await page(3), await alone(3));
  for (const number of [2, 4, 1] as const) {
    const before = corpusReads();
    assert.deepEqual(await page(number), expected[number], `page ${number}`);
    assert.equal(corpusReads(), before, `page ${number} reads no lane or vector`);
  }
  // Ranks 500 to 505: past the 500 the first page decided.
  const before = corpusReads();
  assert.deepEqual(await page(100), expected[100]);
  assert.ok(corpusReads() > before, 'a page past the decided ranks ranks again');
});

// Candidates on a few dates, so the newest 600 end inside a run of ties, many
// of them near a rejection, so the rounds go on: the ranks a page decides are
// those a page that skips seen papers ranks, which reads every vector.
test('the ranks a page without likes decides are the ones a read of every vector gives, ties at the edge of a round included', async () => {
  for (const seed of [1, 2, 3]) {
    const { env, db } = corpus();
    const random = seeded(seed);
    const vector = clusteredVectors(random, 6);
    const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
    const insertKey = db.prepare('INSERT INTO work_keys (key, work_id) VALUES (?, ?)');
    const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
    const insertVector = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
    const add = (workId: number, lanes: string[], published: string, embedding: Int8Array | null) => {
      const id = `2610.${String(workId).padStart(5, '0')}`;
      insertWork.run(workId, JSON.stringify({ id, arxivId: id, title: `Paper ${workId}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
      insertKey.run(`arxiv:${id}`, workId);
      lanes.forEach(lane => insertLane.run(lane, workId, published));
      if (embedding) insertVector.run(workId, Buffer.from(embedding.buffer));
      return id;
    };
    db.exec('BEGIN');
    for (let workId = 1; workId <= 1_600; workId += 1) {
      const lanes = [['cs.LG'], ['cs.CL'], ['cs.LG', 'cs.CL'], ['econ.GN']][Math.floor(random() * 4)];
      // A cluster of the rejections' for one in three.
      const embedding = random() < 0.1 ? null : vector(random() < 0.35 ? 0 : 1 + Math.floor(random() * 5), random() * 0.8);
      add(workId, lanes, new Date(NOW - Math.floor(random() * 12) * 86_400_000).toISOString(), embedding);
    }
    const old = new Date(NOW - 60 * 86_400_000).toISOString();
    const rejections = [add(1_601, [], old, vector(0, 0.2)), add(1_602, [], old, vector(0, 0.4))];
    db.exec('COMMIT');
    const groups = [
      { categories: ['cs.LG', 'cs.CL'], exampleCategories: ['cs.LG', 'cs.CL'], positiveIds: [], weight: 1 },
      { categories: ['cs.CL', 'econ.GN'], exampleCategories: ['cs.CL', 'econ.GN'], positiveIds: [], weight: 3 },
    ];
    for (const order of ['recent', 'relevance'] as const) {
      const keptBy = async (body: Parameters<typeof parseFeedRequest>[0]) => {
        const kept: KeptRanking[] = [];
        await readFeedPage(env, parseFeedRequest(body), { now: NOW, cache: { get: async () => null, put: async (_key, ranking) => { kept.push(ranking); } } });
        return kept[0].ranks.map(rank => rank && [rank.workId, rank.semanticScore]);
      };
      const everyVector = await keptBy({ groups, negativeIds: rejections, order, seen: feedSeenFilter([]), skipsSeen: true, pageSize: 30 });
      for (const page of [0, 3, 20]) {
        const decided = Math.max(500, (page + 1) * 30);
        assert.deepEqual((await keptBy({ groups, negativeIds: rejections, order, page, pageSize: 30 })).slice(0, decided), everyVector.slice(0, decided), `seed ${seed}, ${order}, page ${page}`);
      }
    }
  }
});

// A like ranks every candidate by its closeness, and a page that skips seen
// papers can walk past any rank: both read every candidate's vector, as before.
test('a page with likes, or one that skips seen papers, reads every candidate vector as before', async t => {
  const { env, likes, rejections } = coldPageCorpus();
  const rows = vectorRowsRead(t, env.PAPER_STORE!);
  await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG', 'cs.CL'], positiveIds: likes.slice(0, 1), negativeIds: rejections, pageSize: 5 }), { now: NOW });
  assert.equal(rows(), 1_273 + 1 + 3);
  await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG', 'cs.CL'], negativeIds: rejections, seen: feedSeenFilter([]), skipsSeen: true, pageSize: 5 }), { now: NOW });
  assert.equal(rows(), 2 * (1_273 + 3) + 1);
});
