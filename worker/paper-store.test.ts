import { mergeFeedEvidence } from '../src/models/paper-evidence.ts';
import type { Paper, PaperFollowMatch } from '../src/models/paper.ts';
import type { OpenAlexLocation } from '../src/services/adapters/open-alex-types.ts';
import type { KeptRanking, RankingCache } from './paper-store.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  FEED_CANDIDATE_LIMIT, arxivIdOf, daysFromNow, embedPending, embedWorks, evictExpired, inKeywordTurns, ingestPapers, interleaveByWeight, keysForPaperId, parseFeedRequest, quantize, rankBySimilarity,
  notableSince, readFeedPage, readNotableCandidates, readVector, reserveFeedRequest, rewriteWorks, thinLeaves, thinLeavesReport, unitVector, writeLaneRanks,
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
import { createQueryTopic } from '../src/utils/topic-navigation.ts';
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

test('a record that names two stored papers folds them into one, keeping the arXiv acceptance, one id and every lane', async () => {
  const { env, db } = corpus();
  const journal = { ...mapOpenAlexWork({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/sparse', title: 'Sparse attention for long documents (journal version)', publication_date: '2026-10-12' })!, doi: '10.1000/sparse' };
  const mark = { id: 'S4363606243', label: 'NeurIPS', year: 2026, evidence: 'arxiv-comment' as const };
  await ingestPapers(env, [{ paper: { ...arxivRecord, acceptedConference: mark }, lanes: [] }], { now: NOW });
  await ingestPapers(env, [{ paper: journal, lanes: ['bio.comp'] }], { now: NOW + 1 });
  assert.equal(rows(db, 'SELECT id FROM works').length, 2, 'nothing yet says they are one paper');
  const bridge = { ...journal, id: 'openalex:W2', arxivId: '2610.11111' };
  await ingestPapers(env, [{ paper: bridge, lanes: [] }], { now: NOW + 2 });
  const works = rows(db, 'SELECT id, paper FROM works');
  assert.equal(works.length, 1);
  assert.deepEqual(JSON.parse(String(works[0].paper)).acceptedConference, mark);
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

test('a paper filed after its lane was first loaded arrives the day it is filed; the first load keeps its publication date', async () => {
  const { env, db } = corpus();
  // Titles of their own: one title and author would make them one paper.
  const paper = (id: string, published: string) => ({ ...arxivRecord, id, arxivId: id, title: `Sparse attention, part ${id}`, published });
  await ingestPapers(env, [{ paper: paper('2610.00001', '2026-10-01T00:00:00.000Z'), lanes: ['author:A1'] }], { now: NOW, firstLoad: true });
  const later = NOW + 3 * 86_400_000;
  await ingestPapers(env, [
    { paper: paper('2610.00002', '2026-10-02T00:00:00.000Z'), lanes: ['author:A1'] },
    { paper: paper('2610.00001', '2026-10-01T00:00:00.000Z'), lanes: ['author:A1'] },
  ], { now: later });
  const arrived = Object.fromEntries(rows(db, `SELECT k.key, l.arrived FROM work_lanes l JOIN work_keys k ON k.work_id = l.work_id WHERE k.key LIKE 'arxiv:2610.0000_'`).map(row => [row.key, row.arrived]));
  assert.equal(arrived['arxiv:2610.00001'], null);
  assert.equal(arrived['arxiv:2610.00002'], new Date(later).toISOString());
});

// An author's first load can bring a paper new to the corpus, which its
// categories file too: those lanes are not loading, and get it as news when
// it is this week's. One from further back is those lanes' past.
test("a lane's first load files its papers with no arrival, and the paper's other lanes get this week's papers as arrivals", async () => {
  const arrivals = async (published: string) => {
    const { env, db } = corpus();
    await ingestPapers(env, [{ paper: { ...arxivRecord, published }, lanes: ['author:A1'] }], { now: NOW, firstLoad: 'author:A1' });
    return Object.fromEntries(rows(db, 'SELECT lane, arrived FROM work_lanes ORDER BY lane').map(row => [row.lane, row.arrived]));
  };
  assert.deepEqual(await arrivals(new Date(NOW - 2 * 86_400_000).toISOString()), {
    'author:A1': null,
    'cs.CL': new Date(NOW).toISOString(),
    'cs.LG': new Date(NOW).toISOString(),
  });
  assert.deepEqual(await arrivals(new Date(NOW - 30 * 86_400_000).toISOString()), { 'author:A1': null, 'cs.CL': null, 'cs.LG': null });
});

// No arrival means the paper was already in the lane: a fold with such a row
// is not news, whichever of the two rows it is.
test('a fold of two rows of one lane keeps the earlier arrival, or none when either has none', async () => {
  const journal = { ...mapOpenAlexWork({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/sparse', title: 'Sparse attention for long documents (journal version)', publication_date: '2026-10-12' })!, doi: '10.1000/sparse' };
  const later = NOW + 86_400_000;
  for (const [journalLoad, arxivLoad, arrived] of [
    [undefined, undefined, new Date(NOW).toISOString()],
    [true, undefined, null],
    [undefined, true, null],
  ] as const) {
    const { env, db } = corpus();
    await ingestPapers(env, [{ paper: journal, lanes: ['bio.comp'] }], { now: NOW, firstLoad: journalLoad });
    await ingestPapers(env, [{ paper: arxivRecord, lanes: ['bio.comp'] }], { now: later, firstLoad: arxivLoad });
    // Another source's record of both folds the journal's row into the arXiv one.
    await ingestPapers(env, [{ paper: { ...journal, id: 'openalex:W2', arxivId: '2610.11111' }, lanes: [] }], { now: later });
    assert.deepEqual(rows(db, "SELECT arrived FROM work_lanes WHERE lane = 'bio.comp'").map(row => row.arrived), [arrived], `journal ${journalLoad}, arXiv ${arxivLoad}`);
  }
});

test('a daily page goes day by day by arrival, the closest to the likes first within a day', async () => {
  const { env, db } = corpus();
  // Titles of their own: one title and author would make them one paper.
  const paper = (id: string, published: string) => ({ ...arxivRecord, id, arxivId: id, title: `Sparse attention, part ${id}`, published });
  // Liked, and two papers of the lane's first load.
  await ingestPapers(env, [
    { paper: paper('2610.00001', '2026-09-01T00:00:00.000Z'), lanes: [] },
    { paper: paper('2610.00002', '2026-10-20T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: paper('2610.00003', '2026-10-21T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW, firstLoad: true });
  // Published weeks ago, filed today.
  await ingestPapers(env, [{ paper: paper('2610.00004', '2026-10-02T00:00:00.000Z'), lanes: ['quant-ph'] }], { now: NOW });
  const idOf = (paperId: string) => rows(db, `SELECT work_id FROM work_keys WHERE key = 'arxiv:${paperId}'`)[0].work_id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00001'), vector([1, 0]));
  insert.run(idOf('2610.00002'), vector([1, 0.05]));
  insert.run(idOf('2610.00003'), vector([0, 1]));
  insert.run(idOf('2610.00004'), vector([0, 1]));
  const ask = (positiveIds: string[]) => readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], order: 'daily', positiveIds, pageSize: 5 }), { now: NOW });
  // Today's arrival first though it is the oldest by date and far from the like.
  assert.deepEqual((await ask(['arxiv:2610.00001'])).map(item => item.id), ['2610.00004', '2610.00003', '2610.00002']);
  assert.deepEqual((await ask([])).map(item => item.id), ['2610.00004', '2610.00003', '2610.00002']);
});

test('within a day of a daily page, the paper closest to the likes comes first', async () => {
  const { env, db } = corpus();
  const paper = (id: string, published: string) => ({ ...arxivRecord, id, arxivId: id, title: `Sparse attention, part ${id}`, published });
  await ingestPapers(env, [{ paper: paper('2610.00001', '2026-09-01T00:00:00.000Z'), lanes: [] }], { now: NOW, firstLoad: true });
  // Both arrive today: the one near the like was published before the other.
  await ingestPapers(env, [
    { paper: paper('2610.00002', '2026-10-05T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: paper('2610.00003', '2026-10-15T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW });
  const idOf = (paperId: string) => rows(db, `SELECT work_id FROM work_keys WHERE key = 'arxiv:${paperId}'`)[0].work_id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00001'), vector([1, 0]));
  insert.run(idOf('2610.00002'), vector([1, 0.05]));
  insert.run(idOf('2610.00003'), vector([0, 1]));
  const ask = (positiveIds: string[]) => readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], order: 'daily', positiveIds, pageSize: 5 }), { now: NOW });
  assert.deepEqual((await ask(['arxiv:2610.00001'])).map(item => item.id), ['2610.00002', '2610.00003']);
  assert.deepEqual((await ask([])).map(item => item.id), ['2610.00003', '2610.00002'], 'without likes, the later publication first');
});

test("a daily page reads its candidates by arrival: today's arrival is one past a lane's newest by publication", async () => {
  const { env, db } = corpus();
  // A lane full of papers published after the one that arrives today.
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let id = 1; id <= FEED_CANDIDATE_LIMIT; id += 1) {
    const published = new Date(NOW - 86_400_000 - id * 60_000).toISOString();
    insertWork.run(id, JSON.stringify({ id: `2610.${String(id).padStart(5, '0')}`, title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertLane.run('quant-ph', id, published);
  }
  db.exec('COMMIT');
  await ingestPapers(env, [{ paper: { ...arxivRecord, id: '2609.99999', arxivId: '2609.99999', title: 'Filed today', published: '2026-09-01T00:00:00.000Z' }, lanes: ['quant-ph'] }], { now: NOW });
  const first = async (order: string) => (await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], order, pageSize: 1 }), { now: NOW })).map(item => item.id);
  assert.deepEqual(await first('daily'), ['2609.99999']);
  assert.deepEqual(await first('recent'), ['2610.00001']);
});

// A full lane that stays past its limit with nothing to trim: `evictAll`
// returns rather than going round it again.
test("a full lane keeps a paper filed late for two weeks past its limit, and trims one filed on time or with the lane's first load", async () => {
  const { env, db } = corpus();
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  const add = (id: number, published: string) => {
    insertWork.run(id, JSON.stringify({ id: `2610.${String(id).padStart(5, '0')}`, title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertLane.run('quant-ph', id, published);
  };
  db.exec('BEGIN');
  // The limit's papers, all published the day before: inside a day, a daily
  // page orders by publication date.
  for (let id = 1; id <= FEED_CANDIDATE_LIMIT; id += 1) add(id, new Date(NOW - 4 * 3_600_000 - id * 10_000).toISOString());
  // Past the limit, with the lane's first load: no arrival.
  add(FEED_CANDIDATE_LIMIT + 1, '2026-08-30T00:00:00.000Z');
  db.exec('COMMIT');
  // Filed today, past the limit: one published weeks before, one two days before.
  await ingestPapers(env, [
    { paper: { ...arxivRecord, id: '2609.99999', arxivId: '2609.99999', title: 'Filed late', published: '2026-09-01T00:00:00.000Z' }, lanes: ['quant-ph'] },
    { paper: { ...arxivRecord, id: '2610.99998', arxivId: '2610.99998', title: 'Filed on time', published: new Date(NOW - 2 * 86_400_000).toISOString() }, lanes: ['quant-ph'] },
  ], { now: NOW });
  const inLane = () => rows(db, "SELECT w.paper ->> '$.id' AS id FROM work_lanes l JOIN works w ON w.id = l.work_id WHERE l.lane = 'quant-ph' AND l.published < '2026-10-21'").map(row => row.id);
  await evictAll(env, NOW);
  assert.deepEqual(inLane(), ['2609.99999'], 'the paper filed late stays; the one filed on time and the one of the first load go');
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM work_lanes WHERE lane = 'quant-ph'")[0].n, FEED_CANDIDATE_LIMIT + 1);
  const daily = await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], order: 'daily', pageSize: 1 }), { now: NOW });
  assert.deepEqual(daily.map(item => item.id), ['2609.99999']);
  await evictAll(env, NOW + 15 * 86_400_000);
  assert.deepEqual(inLane(), [], 'two weeks on, the lane is back to its limit');
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM work_lanes WHERE lane = 'quant-ph'")[0].n, FEED_CANDIDATE_LIMIT);
});

// A walk is kept by follows alone (`readFeedPage`), so another order's walk
// could go on from a daily one's: a page past the first would start at the
// other order's ranks.
test("a daily walk and another order's walk over the same lanes go on from their own pages", async () => {
  const { env } = corpus();
  const paper = (id: string, published: string) => ({ ...arxivRecord, id, arxivId: id, title: `Sparse attention, part ${id}`, published });
  await ingestPapers(env, [
    { paper: paper('2610.00001', '2026-10-21T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: paper('2610.00002', '2026-10-20T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW, firstLoad: true });
  await ingestPapers(env, [{ paper: paper('2610.00003', '2026-10-02T00:00:00.000Z'), lanes: ['quant-ph'] }], { now: NOW });
  const orders = new Map<string, KeptRanking>();
  const keep = async (key: string, ranking: KeptRanking) => { orders.set(key, ranking); };
  const cache: RankingCache = { get: async key => orders.get(key) ?? null, put: keep, update: keep };
  // Each feed's own seen papers and page numbers.
  const seen = { recent: new Set<string>(), daily: new Set<string>() };
  const pages = { recent: 0, daily: 0 };
  const page = async (order: 'recent' | 'daily') => {
    const answer = (await readFeedPage(env, parseFeedRequest({
      categories: ['quant-ph'], order, page: pages[order]++, pageSize: 1, seen: feedSeenFilter(feedSeenIds(seen[order], true)), skipsSeen: true,
    }), { now: NOW, cache })).map(item => item.id);
    answer.forEach(id => seen[order].add(id));
    return answer;
  };
  assert.deepEqual(await page('recent'), ['2610.00001']);
  assert.deepEqual(await page('daily'), ['2610.00003']);
  assert.deepEqual(await page('recent'), ['2610.00002']);
  assert.deepEqual(await page('daily'), ['2610.00001']);
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

// ENG-165: the row shows the journal article's type, but its review answer
// still reads the type its records give it. One batch makes a row of the
// article, NASA ADS's non-refereed record of it and OpenAlex's record of the
// eprint listing the journal copy; merged into the stored arXiv row, that
// batch's row must carry the eprint's reopening, and OpenAlex's record of the
// journal DOI without a source then leaves the answer unknown. Synthetic
// records shaped as the mappers return them.
test("a batch's row that shows the article's type still reopens the stored row's review answer as its eprint record does", async () => {
  const { env, db } = corpus();
  const journalDoi = '10.1016/j.jinteco.2026.103900';
  const title = 'Bank capital and the transmission of monetary policy';
  const journalLocation: OpenAlexLocation = { is_published: true, landing_page_url: `https://doi.org/${journalDoi}`, source: { id: 'https://openalex.org/S111', display_name: 'Journal of International Economics', type: 'journal' } };
  const arxivLocation: OpenAlexLocation = { is_published: false, landing_page_url: 'https://arxiv.org/abs/2610.00007', source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' } };
  const work = (id: string, doi: string, type: string, locations: OpenAlexLocation[]) => mapOpenAlexWork({
    id: `https://openalex.org/${id}`, doi: `https://doi.org/${doi}`, title, type, publication_date: '2026-10-12',
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }], primary_location: locations[0], locations,
  })!;
  const notRefereed = mapAdsPaper({
    bibcode: '2026JIntE.160j3900E', title: [title], author: ['Economist, Ana'], doi: [journalDoi], identifier: ['arXiv:2610.00007'],
    property: ['ARTICLE', 'OPENACCESS'], doctype: 'article', pub: 'Journal of International Economics', pubdate: '2026-10-12', year: '2026', abstract: 'Bank capital.',
  })!;
  const arxivListing = arxivRecordPaper({ arxivId: '2610.00007', title, abstract: 'Bank capital.', authors: ['Ana Economist'], categories: ['econ.GN'], doi: null, journalRef: null, comments: null, published: '2026-10-12T12:00:00.000Z', updated: '2026-10-12T12:00:00.000Z' });
  const stored = () => rows(db, 'SELECT paper FROM works').map(row => JSON.parse(String(row.paper)) as Paper);
  await ingestPapers(env, [{ paper: arxivListing, lanes: [] }], { now: NOW });
  await ingestPapers(env, [work('W502', journalDoi, 'article', [journalLocation, arxivLocation]), notRefereed, work('W503', '10.48550/arXiv.2610.00007', 'preprint', [arxivLocation, journalLocation])]
    .map(paper => ({ paper, lanes: [] })), { now: NOW });
  assert.deepEqual(stored().map(paper => [paper.publicationType, paper.peerReviewed]), [['article', true]]);
  await ingestPapers(env, [{ paper: work('W507', journalDoi, 'article', [{ ...journalLocation, source: null }, arxivLocation]), lanes: [] }], { now: NOW });
  assert.deepEqual(stored().map(paper => [paper.publicationType, paper.peerReviewed]), [['article', undefined]]);
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

// ENG-251: the reader's publications rank as likes, and a paper one of them
// scores best says so, so the app names no like as the reason for it.
test("a paper closest to one of the reader's publications says so, and one closest to a like does not", async () => {
  const { env, db } = corpus();
  const paper = (id: string, title: string, published: string) => ({ ...arxivRecord, id, arxivId: id, title, published });
  await ingestPapers(env, [
    { paper: paper('2610.00001', 'Liked paper', '2026-07-30T00:00:00.000Z'), lanes: ['q-bio.BM'] },
    { paper: paper('2610.00004', 'The reader’s own paper', '2026-07-30T00:00:00.000Z'), lanes: ['q-bio.BM'] },
    { paper: paper('2610.00002', 'Close to the like', '2026-10-02T00:00:00.000Z'), lanes: ['q-bio.BM'] },
    { paper: paper('2610.00003', 'Close to the publication', '2026-10-03T00:00:00.000Z'), lanes: ['q-bio.BM'] },
  ], { now: NOW });
  const idOf = (paperId: string) => rows(db, `SELECT work_id FROM work_keys WHERE key = 'arxiv:${paperId}'`)[0].work_id;
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  insert.run(idOf('2610.00001') as number, vector([1, 0]));
  insert.run(idOf('2610.00004') as number, vector([0, 1]));
  insert.run(idOf('2610.00002') as number, vector([1, 0.05]));
  insert.run(idOf('2610.00003') as number, vector([0.05, 1]));
  const ask = (seedIds?: string[]) => readFeedPage(env, parseFeedRequest({
    categories: ['q-bio.BM'], positiveIds: ['2610.00001', '2610.00004'], pageSize: 5, ...(seedIds ? { seedIds } : {}),
  }), { now: NOW });
  const marks = (page: Awaited<ReturnType<typeof ask>>) => Object.fromEntries(page.map(item => [item.id, item._semanticFromSeed === true]));
  assert.deepEqual(marks(await ask(['2610.00004'])), { '2610.00002': false, '2610.00003': true });
  // Without seeds nothing is marked, and the same papers rank in the same order.
  const plain = await ask();
  assert.deepEqual(marks(plain), { '2610.00002': false, '2610.00003': false });
  assert.deepEqual(plain.map(item => item.id), (await ask(['2610.00004'])).map(item => item.id));
  // A seed that is not among the examples is ignored.
  assert.deepEqual(parseFeedRequest({ positiveIds: ['a'], seedIds: ['a', 'b', 7] }).seedIds, ['a']);
  assert.deepEqual(parseFeedRequest({ positiveIds: ['a'] }).seedIds, []);
});

// D3 (Pablo, 2026-10-25): at most 10 journals a request. A journal's lane
// costs the harvest a list call a night whichever feed asks for it, so the cap
// holds where the lanes are made, whatever a client sent.
test('a request serves at most 10 journals, and still its other follows', () => {
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

// A paper filed only under the lanes given, by its own title.
const lanePaper = (id: string, title: string, published = '2026-10-15T00:00:00.000Z') => ({ ...arxivRecord, id, arxivId: id, title, published, allCategories: [], categories: [] });

// Three candidates with the same date and vector. The liked work is outside their lane.
async function qualityCorpus() {
  const { env, db } = corpus();
  const ids = ['2610.00081', '2610.00082', '2610.00083'];
  const liked = '2610.00084';
  const published = daysFromNow(-2, NOW);
  const titles = ['Graph coloring', 'Random walks', 'Network flows', 'Sparse matrices'];
  await ingestPapers(env, [...ids, liked].map((id, index) => ({
    paper: lanePaper(id, titles[index], published), lanes: id === liked ? [] : ['cs.LG'],
  })), { now: NOW });
  for (const id of [...ids, liked]) {
    db.prepare('INSERT INTO work_vectors (work_id, embedding) SELECT work_id, ? FROM work_keys WHERE key = ?')
      .run(quantize(id === liked ? [1, 0] : [3, 4]), `arxiv:${id}`);
  }
  const groups = [{ categories: ['cs.LG'], weight: 1 }];
  const read = (body: Parameters<typeof parseFeedRequest>[0], now = NOW) =>
    readFeedPage(env, parseFeedRequest(body), { now });
  const addQuality = () => db.prepare(`INSERT INTO work_quality (work_id, published, hf_upvotes, author_bonus, hf_bonus, score)
    SELECT work_id, ?, 1, 0, 0.01, 0.01 FROM work_keys WHERE key = ?`).run(published, `arxiv:${ids[2]}`);
  return { env, db, ids, liked, published, groups, read, addQuality };
}

test('For You raises a tied paper with quality while preserving the other ties and each semantic score', async () => {
  for (const withLikes of [false, true]) {
    const { ids, liked, groups, read, addQuality } = await qualityCorpus();
    const request = { groups: groups.map(group => ({ ...group, positiveIds: withLikes ? [liked] : [] })) };
    const before = await read(request);
    assert.deepEqual(before.map(paper => paper.id), ids);
    if (withLikes) assert.ok(before.every(paper => paper._semanticScore! > 0));
    addQuality();
    assert.deepEqual(await read(request), [before[2], before[0], before[1]]);
  }
});

test('a full quality signal bridges one day of recency but leaves a paper published today ahead', async () => {
  const { env, db } = corpus();
  const ids = ['2610.00091', '2610.00092', '2610.00093'];
  await ingestPapers(env, ids.map((id, index) => ({
    paper: lanePaper(id, ['Sparse matrices', 'Network flows', 'Random walks'][index], daysFromNow(-index, NOW)),
    lanes: ['cs.LG'],
  })), { now: NOW });
  db.prepare(`INSERT INTO work_quality (work_id, published, max_h_index, hf_upvotes, author_bonus, hf_bonus, score)
    SELECT work_id, published, 91, 20, 0.034, 0.016, 0.05 FROM work_lanes
    WHERE lane = 'cs.LG' AND work_id = (SELECT work_id FROM work_keys WHERE key = ?)`).run(`arxiv:${ids[2]}`);
  const page = await readFeedPage(env, parseFeedRequest({ groups: [{ categories: ['cs.LG'], weight: 1 }] }), { now: NOW });
  assert.deepEqual(page.map(paper => paper.id), [ids[0], ids[2], ids[1]]);
});

test('a fresh For You ranking drops the bonus when a paper reaches five citations between harvests', async () => {
  const { env, ids, published, groups, read, addQuality } = await qualityCorpus();
  addQuality();
  for (const citationCount of [4, 5]) {
    const paper = { ...lanePaper(ids[2], 'Network flows', published), citationCount, citationCountKnown: true };
    await ingestPapers(env, [{ paper, lanes: ['cs.LG'] }], { now: NOW });
    const page = await read({ groups });
    assert.equal(page.find(row => row.id === ids[2])?.citationCount, citationCount);
    assert.deepEqual(page.map(row => row.id), citationCount === 4 ? [ids[2], ids[0], ids[1]] : ids);
  }
});

test('only the recent main feed uses quality, until exactly 90 days after publication', async () => {
  const { db, ids, groups, read, published, addQuality } = await qualityCorpus();
  addQuality();
  const categories = ['cs.LG'];
  const follows = [{ type: 'topic', canonicalId: 'cs.LG', displayName: 'Machine learning' }];
  for (const request of [
    { categories, exact: true }, { groups, order: 'daily' }, { groups, order: 'relevance' },
    { categories, follows }, { groups, follows }, { categories },
  ]) {
    assert.deepEqual((await read(request)).map(paper => paper.id), ids, JSON.stringify(request));
  }
  // Folding a journal listing into an arXiv work can leave a later date in its lane.
  db.prepare("UPDATE work_lanes SET published = ? WHERE lane = 'cs.LG'").run(daysFromNow(1, Date.parse(published)));
  const cutoff = Date.parse(published) + 90 * 86_400_000;
  assert.deepEqual((await read({ groups }, cutoff - 1)).map(paper => paper.id), [ids[2], ids[0], ids[1]]);
  for (const now of [cutoff, cutoff + 86_400_000]) {
    assert.deepEqual((await read({ groups }, now)).map(paper => paper.id), ids);
  }
});

test('a main feed resumed after the quality change keeps the served paper and ranks the rest again', async () => {
  const { env, ids, groups, addQuality } = await qualityCorpus();
  const stored = new Map<string, KeptRanking>();
  const cache: RankingCache = { get: async key => stored.get(key) ?? null, put: async (key, ranking) => { stored.set(key, ranking); } };
  const page = async (number: number) => (await readFeedPage(env, parseFeedRequest({ groups, pageSize: 1, page: number }), { now: NOW, cache })).map(paper => paper.id);
  assert.deepEqual(await page(0), [ids[0]]);
  // The digest the deployed Worker gave this request before it read quality.
  for (const entry of stored.values()) entry.rankedBy = '4ba86b047e6bc29d0e619896b249f1dcd8052146eb58dcea72f23b6b2d2673fd';
  addQuality();
  assert.deepEqual(await page(1), [ids[2]]);
  assert.deepEqual(await page(2), [ids[1]]);
});

// A feed shows a paper on the first day any of its lanes held it: a followed
// author's lane listing it days after the category did does not bring it back on top.
test('a daily page places a paper several of its lanes hold on the earliest day they got it', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00071', 'A surface code decoder', '2026-10-01T00:00:00.000Z'), lanes: ['quant-ph', 'author:A1'] },
    { paper: lanePaper('2610.00072', 'A bosonic code', '2026-10-02T00:00:00.000Z'), lanes: ['quant-ph', 'author:A1'] },
  ], { now: NOW });
  const setArrival = (paperId: string, lane: string, daysBefore: number) => db.prepare(`UPDATE work_lanes SET arrived = ? WHERE lane = ?
    AND work_id = (SELECT work_id FROM work_keys WHERE key = 'arxiv:${paperId}')`).run(new Date(NOW - daysBefore * 86_400_000).toISOString(), lane);
  setArrival('2610.00071', 'quant-ph', 5);
  setArrival('2610.00071', 'author:A1', 0);
  setArrival('2610.00072', 'quant-ph', 2);
  setArrival('2610.00072', 'author:A1', 2);
  const author = { type: 'author', canonicalId: 'https://openalex.org/A1', displayName: 'Ana Pérez' };
  const served = async (body: Parameters<typeof parseFeedRequest>[0]) => (await readFeedPage(env, parseFeedRequest({ ...body, order: 'daily' }), { now: NOW })).map(item => item.id);
  assert.deepEqual(await served({ categories: ['quant-ph'], follows: [author] }), ['2610.00072', '2610.00071'], 'the category had it five days ago');
  assert.deepEqual(await served({ categories: [], follows: [author] }), ['2610.00071', '2610.00072'], 'the author lane alone got it today');
});

// Each lane's harvest stamps its own instant: inside a day, a reader without
// likes gets the day's papers newest publication first, not a lane's block.
test('inside a day of a daily page, papers of several lanes come by publication date, not by the instant each lane was harvested', async () => {
  const { env } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00081', 'A quantum walk', '2026-10-10T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00082', 'A quantum channel', '2026-10-12T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW });
  await ingestPapers(env, [
    { paper: lanePaper('2610.00083', 'A string vacuum', '2026-10-11T00:00:00.000Z'), lanes: ['hep-th'] },
    { paper: lanePaper('2610.00084', 'A holographic dual', '2026-10-13T00:00:00.000Z'), lanes: ['hep-th'] },
  ], { now: NOW + 3_600_000 });
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph', 'hep-th'], order: 'daily' }), { now: NOW + 7_200_000 });
  assert.deepEqual(page.map(item => item.id), ['2610.00084', '2610.00082', '2610.00083', '2610.00081']);
});

test('an exact request reads the lanes it names and nothing beside them', async () => {
  const { env } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00031', 'An econometrics preprint'), lanes: ['econ.EM'] },
    { paper: lanePaper('2610.00032', 'A working paper of a series'), lanes: ['series:working-papers'] },
    { paper: lanePaper('2610.00033', 'An economics journal article'), lanes: ['area:econ'] },
  ], { now: NOW });
  const served = async (body: Parameters<typeof parseFeedRequest>[0]) => (await readFeedPage(env, parseFeedRequest(body), { now: NOW })).map(item => item.id).sort();
  assert.deepEqual(await served({ categories: ['econ.EM'], exact: true }), ['2610.00031']);
  assert.deepEqual(await served({ categories: ['econ.EM'] }), ['2610.00031', '2610.00032', '2610.00033'], "today's request");
});

test('an exact request for an area reads every leaf of it and the area lane, and no other area', async () => {
  const { env } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00041', 'A quantum error-correcting code'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00042', 'A string compactification'), lanes: ['hep-th'] },
    { paper: lanePaper('2610.00043', 'A physics journal article'), lanes: ['area:physics'] },
    { paper: lanePaper('2610.00044', 'A learning-rate schedule'), lanes: ['cs.LG'] },
  ], { now: NOW });
  const page = await readFeedPage(env, parseFeedRequest({ areas: ['physics'], exact: true }), { now: NOW });
  assert.deepEqual(page.map(item => item.id).sort(), ['2610.00041', '2610.00042', '2610.00043']);
});

// A journal's lane holds only articles and reviews.
const journalArticle = (id: string, title: string) => ({ ...lanePaper(id, title), publicationType: 'article' });
const journalFollow = (sourceId: string) => ({ type: 'journal', canonicalId: sourceId, displayName: `Journal ${sourceId}` });

test('an exact request with a category and a journal reads both, and nothing beside them', async () => {
  const { env } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00045', 'A quantum error-correcting code'), lanes: ['quant-ph'] },
    { paper: journalArticle('2610.00046', 'A journal article'), lanes: ['source:S123'] },
    { paper: lanePaper('2610.00047', 'A learning-rate schedule'), lanes: ['cs.LG'] },
  ], { now: NOW });
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], follows: [journalFollow('S123')], exact: true }), { now: NOW });
  assert.deepEqual(page.map(item => item.id).sort(), ['2610.00045', '2610.00046']);
});

test('an exact request with eleven journals reads the first ten', async () => {
  const { env } = corpus();
  const sources = Array.from({ length: 11 }, (_, index) => `S${2000 + index}`);
  await ingestPapers(env, sources.map((source, index) => ({
    paper: journalArticle(`2610.${String(100 + index).padStart(5, '0')}`, `An article of journal ${source}`), lanes: [`source:${source}`],
  })), { now: NOW });
  const page = await readFeedPage(env, parseFeedRequest({ follows: sources.map(journalFollow), exact: true }), { now: NOW });
  assert.deepEqual(page.map(item => item.id).sort(), sources.slice(0, 10).map((_, index) => `2610.${String(100 + index).padStart(5, '0')}`));
});

test('an exact request keeps on the page the papers the reader liked', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00051', 'The liked paper', '2026-10-01T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00052', 'Another paper of the lane', '2026-10-20T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW });
  const idOf = (paperId: string) => rows(db, `SELECT work_id FROM work_keys WHERE key = 'arxiv:${paperId}'`)[0].work_id as number;
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  insert.run(idOf('2610.00051'), vector([1, 0]));
  insert.run(idOf('2610.00052'), vector([0, 1]));
  const served = async (excludedIds: string[]) => (await readFeedPage(env, parseFeedRequest({
    categories: ['quant-ph'], exact: true, positiveIds: ['2610.00051'], excludedIds, order: 'relevance',
  }), { now: NOW })).map(item => item.id);
  assert.deepEqual(await served([]), ['2610.00051', '2610.00052']);
  assert.deepEqual(await served(['2610.00051']), ['2610.00052']);
});

// The request a custom feed sends.
test('an exact daily request goes day by day by arrival and keeps the liked paper on its day', async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00091', 'The liked paper', '2026-10-01T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00092', 'A paper of the first load', '2026-10-20T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW, firstLoad: true });
  await ingestPapers(env, [{ paper: lanePaper('2610.00093', 'A paper that arrived today', '2026-10-05T00:00:00.000Z'), lanes: ['quant-ph'] }], { now: NOW });
  const idOf = (paperId: string) => rows(db, `SELECT work_id FROM work_keys WHERE key = 'arxiv:${paperId}'`)[0].work_id as number;
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  insert.run(idOf('2610.00091'), vector([1, 0]));
  insert.run(idOf('2610.00092'), vector([1, 0.05]));
  insert.run(idOf('2610.00093'), vector([0, 1]));
  const page = await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], exact: true, order: 'daily', positiveIds: ['2610.00091'] }), { now: NOW });
  assert.deepEqual(page.map(item => item.id), ['2610.00093', '2610.00092', '2610.00091']);
});

// One ingest files its papers at one instant. An exact request for every area
// reads 27 of a leaf's rows, and a read in arrival order alone would keep 27
// of the tied rows in work id order, a hash of the paper id.
test("an exact daily request for every area opens with the newest publications of a harvest that filed more than a leaf's share", async () => {
  const { env } = corpus();
  // Paper n is published n minutes before 23:00.
  const papers = Array.from({ length: 80 }, (_, index) => lanePaper(`2610.${String(index + 1).padStart(5, '0')}`, `Harvested paper number ${index + 1} on a distinct subject`,
    new Date(Date.parse('2026-10-21T23:00:00Z') - (index + 1) * 60_000).toISOString()));
  await ingestPapers(env, papers.map(paper => ({ paper, lanes: ['quant-ph'] })), { now: NOW });
  const areas = [...new Set(getAllLeafCategories().map(leaf => leaf.area))];
  const page = await readFeedPage(env, parseFeedRequest({ areas, exact: true, order: 'daily' }), { now: NOW });
  assert.deepEqual(page.map(item => item.id), papers.slice(0, 15).map(paper => paper.id));
});

// A walk is kept by follows alone, which two exact feeds made only of
// categories share: each would go on from the other's pages.
test('two exact walks that differ only in their categories go on from their own pages', async () => {
  const { env } = corpus();
  await ingestPapers(env, [
    { paper: lanePaper('2610.00061', 'A quantum error-correcting code', '2026-10-21T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00062', 'A quantum walk on a graph', '2026-10-20T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00063', 'A string compactification', '2026-10-21T00:00:00.000Z'), lanes: ['hep-th'] },
    { paper: lanePaper('2610.00064', 'A holographic dual', '2026-10-20T00:00:00.000Z'), lanes: ['hep-th'] },
  ], { now: NOW });
  const orders = new Map<string, KeptRanking>();
  const keep = async (key: string, ranking: KeptRanking) => { orders.set(key, ranking); };
  const cache: RankingCache = { get: async key => orders.get(key) ?? null, put: keep, update: keep };
  // Each feed's own seen papers and page numbers.
  const seen = { 'quant-ph': new Set<string>(), 'hep-th': new Set<string>() };
  const pages = { 'quant-ph': 0, 'hep-th': 0 };
  const page = async (category: 'quant-ph' | 'hep-th') => {
    const answer = (await readFeedPage(env, parseFeedRequest({
      categories: [category], exact: true, page: pages[category]++, pageSize: 1, seen: feedSeenFilter(feedSeenIds(seen[category], true)), skipsSeen: true,
    }), { now: NOW, cache })).map(item => item.id);
    answer.forEach(id => seen[category].add(id));
    return answer;
  };
  assert.deepEqual(await page('quant-ph'), ['2610.00061']);
  assert.deepEqual(await page('hep-th'), ['2610.00063']);
  assert.deepEqual(await page('quant-ph'), ['2610.00062']);
  assert.deepEqual(await page('hep-th'), ['2610.00064']);
});

// An exact request can name every leaf of its areas: their notable lanes would
// be up to 149 reads of about 1,000 rows.
test('an exact request asks for no notable papers', () => {
  const body = { categories: ['quant-ph'], seen: feedSeenFilter([]), notable: 3 };
  assert.deepEqual([parseFeedRequest({ ...body, exact: true }).notable, parseFeedRequest(body).notable], [0, 3]);
});

test('an exact request reads up to twenty categories; any other request still reads twelve', () => {
  const thirteen = getAllLeafCategories().slice(0, 13).map(leaf => leaf.id);
  assert.equal(parseFeedRequest({ categories: thirteen, exact: true }).categories.length, 13);
  assert.equal(parseFeedRequest({ categories: thirteen }).categories.length, 12);
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

test('a 9-to-1 weighting gives a sparse group its turn and fills the rest of the page', () => {
  const heavy = Array.from({ length: 15 }, (_, index) => ({ workId: index + 1, lanes: [] }));
  const sparse = [{ workId: 101, lanes: [] }];
  const page = interleaveByWeight([heavy, sparse], [9, 1]).slice(0, 15);
  assert.deepEqual(page.map(candidate => candidate.workId), [1, 2, 3, 4, 5, 101, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
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

// Pablo's ruling of 2026-11-13: a thin leaf beside busy ones in a group
// without likes is not buried under their newer papers.
const leafPreprint = (id: string, category: string, hoursAgo: number) => ({
  ...arxivRecord, id, arxivId: id, title: `A ${category} preprint, ${id}`, allCategories: [category], categories: [category], primaryCategory: category,
  published: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
});

test('a group without likes takes its categories in turns, each newest first, and near copies of a rejected paper last within theirs', async () => {
  const store = corpus();
  const learning = [1, 2, 3, 4, 5, 6].map(hours => leafPreprint(`2610.7000${hours}`, 'cs.LG', hours));
  const language = [1.5, 2.5, 3.5].map((hours, index) => leafPreprint(`2610.7100${index + 1}`, 'cs.CL', hours));
  const neural = [240, 480].map((hours, index) => leafPreprint(`2609.7200${index + 1}`, 'cs.NE', hours));
  const rejected = leafPreprint('2609.79999', 'cs.RO', 900);
  await ingestPapers(store.env, [...learning, ...language, ...neural, rejected].map(paper => ({ paper, lanes: [] })), { now: NOW });
  const embed = (id: string) => store.db.prepare('INSERT INTO work_vectors (work_id, embedding) SELECT work_id, ? FROM work_keys WHERE key = ?')
    .run(Buffer.from(quantize([1, 0, 0]).buffer), `id:${id.toLowerCase()}`);
  embed(rejected.id);
  embed(learning[0].id);
  const [lg1, lg2, lg3, lg4, lg5, lg6] = learning.map(paper => paper.id);
  const [cl1, cl2, cl3] = language.map(paper => paper.id);
  const [ne1, ne2] = neural.map(paper => paper.id);
  const categories = ['cs.LG', 'cs.CL', 'cs.NE'];
  const served = async (body: Parameters<typeof parseFeedRequest>[0]) => (await readFeedPage(store.env, parseFeedRequest({ pageSize: 15, ...body }), { now: NOW })).map(paper => paper.id);
  const groups = [{ categories, exampleCategories: categories, positiveIds: [], weight: 1 }];
  assert.deepEqual(await served({ groups }), [lg1, cl1, ne1, lg2, cl2, ne2, lg3, cl3, lg4, lg5, lg6]);
  assert.deepEqual(await served({ groups, negativeIds: [rejected.id] }), [lg2, cl1, ne1, lg3, cl2, ne2, lg4, cl3, lg5, lg6, lg1]);
  const newestFirst = [lg1, cl1, lg2, cl2, lg3, cl3, lg4, lg5, lg6, ne1, ne2];
  assert.deepEqual(await served({ categories }), newestFirst, 'a request without groups stays newest first');
  assert.deepEqual(await served({ groups, order: 'daily' }), newestFirst, 'and so does a daily page');
});

test("a paper found only in an area's journal lane keeps the place its date gives it among a group's categories taking turns", async () => {
  const store = corpus();
  const learning = [1, 2, 30, 31].map((hours, index) => leafPreprint(`2610.7300${index + 1}`, 'cs.LG', hours));
  const neural = leafPreprint('2609.74001', 'cs.NE', 240);
  // Published on 21 October, 27 hours before NOW.
  const article = mapOpenAlexWork({ ...physicsWork, id: 'https://openalex.org/W8300001', doi: 'https://doi.org/10.1000/ai.1', title: 'A journal article of the ai area', publication_date: '2026-10-21' })!;
  await ingestPapers(store.env, [...[...learning, neural].map(paper => ({ paper, lanes: [] })), { paper: article, lanes: ['area:ai'] }], { now: NOW });
  const categories = ['cs.LG', 'cs.NE'];
  const page = await readFeedPage(store.env, parseFeedRequest({ groups: [{ categories, exampleCategories: categories, positiveIds: [], weight: 1 }] }), { now: NOW });
  assert.deepEqual(page.map(paper => paper.id), [learning[0].id, neural.id, article.id, learning[1].id, learning[2].id, learning[3].id]);
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

// The `rankedBy` the Worker before the groups' ranking (945538f9) kept for the
// first pages of the requests below. It digests the request, not the papers,
// so it is the same on any corpus, and not whether the page asks for notable
// papers, so a page's is the same with and without them.
const RANKED_BY_BEFORE_GROUPS_RANKING = {
  exact: '79efdc8a4436f0ffaa14575867ac1c2e647279ccdfda0b78f338677a9e64fc6b',
  withoutGroups: '039851e02169c778da48705374eaa4dfa6ad3029b238316d6eaa961ba7372005',
  withoutGroupsNotable: '039851e02169c778da48705374eaa4dfa6ad3029b238316d6eaa961ba7372005',
  withoutGroupsDailyNotable: '21820a38a11bf894d9d03a66db4706efe81eb51a1802667726acbeb8d838bea2',
  daily: 'bca8648302b158fc9b2323501d95dd3008e10282c56e4988fca589b25a08c818',
  dailyNotable: 'bca8648302b158fc9b2323501d95dd3008e10282c56e4988fca589b25a08c818',
  groups: '1a1dfa177d67c2b4f446a96ab2ed9223f19fe6ac9c80e44ee2401abc610abba7',
};

test("after the groups' ranking is deployed, a page of groups that is not daily or asks for notable papers ranks again, and a custom feed, a page without groups and a daily page without notable papers go on with the order the Worker before kept", async () => {
  const categories = ['quant-ph', 'econ.GN'];
  const served: Record<string, number> = {};
  for (const name of ['exact', 'withoutGroups', 'withoutGroupsNotable', 'withoutGroupsDailyNotable', 'daily', 'dailyNotable', 'groups'] as const) {
    const { env, db, liked } = await physicsAndEconomics();
    const body = {
      exact: { categories, exact: true },
      withoutGroups: { categories },
      // One group of every category ranks its notable papers by every like, as before.
      withoutGroupsNotable: { categories, seen: feedSeenFilter([]), notable: 3 },
      withoutGroupsDailyNotable: { categories, order: 'daily', seen: feedSeenFilter([]), notable: 3 },
      daily: { groups: interestGroups([liked]), order: 'daily' },
      // The Worker before ranked its notable papers by every like, not by group.
      dailyNotable: { groups: interestGroups([liked]), order: 'daily', seen: feedSeenFilter([]), notable: 3 },
      groups: { groups: interestGroups([liked]) },
    }[name];
    const stored = new Map<string, KeptRanking>();
    const cache: RankingCache = { get: async key => stored.get(key) ?? null, put: async (key, ranking) => { stored.set(key, ranking); } };
    const request = (page: number) => parseFeedRequest({ ...body, positiveIds: [liked], page, pageSize: 4 });
    await readFeedPage(env, request(0), { now: NOW, cache });
    // The first page's order as the Worker before kept it.
    for (const ranking of stored.values()) ranking.rankedBy = RANKED_BY_BEFORE_GROUPS_RANKING[name];
    db.exec('DELETE FROM work_lanes');
    served[name] = (await readFeedPage(env, request(1), { now: NOW, cache })).length;
  }
  assert.deepEqual(served, { exact: 4, withoutGroups: 4, withoutGroupsNotable: 4, withoutGroupsDailyNotable: 4, daily: 4, dailyNotable: 0, groups: 0 });
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
  return (await (await readNotableCandidates(env.PAPER_STORE!, lanes, now)).offered()).map(({ workId, ...candidate }) => ({ id: paperIds.get(workId)!, ...candidate }));
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
      assert.deepEqual(await read.offered(), inTurns(asked, expected.map(rows => rows.filter(row => row.offered))), label);
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
async function notableLeavesCorpus(leaves = LEAVES) {
  const store = corpus();
  await ingestPapers(store.env, recentPapers(60), { now: NOW });
  const listed = leaves.flatMap((leaf, leafIndex) => WINDOW_YEARS.flatMap(year => [0, 1].map(rank => ({
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

// The app asks for the reader's established interests area by area, each in
// its ranking of them (selected ones and the affinities it learned), then the
// ones added since.
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

// A group with likes ranks its notable papers by closeness, not by the years
// in turns, so it leaves out the liked, rejected and excluded ones on its own
// path.
test('with a like, a notable paper the reader liked or rejected, or the app excludes, is not offered, and the next closest ones are', async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00059'), vector([1, 0, 0, 0, 0, 0]));
  // The five closest to the like, closest first. The reader likes the first,
  // rejects the second and the app excludes the third: three of 2025's, which
  // would lead the papers that tie even if their vectors were not read.
  const closest = ['W202511', 'W202521', 'W202510', 'W201811', 'W201610'];
  closest.forEach((id, index) => {
    const values = [0.8 - index * 0.15, 0, 0, 0, 0, 0];
    values[index + 1] = Math.sqrt(1 - values[0] ** 2);
    insert.run(idOf(`openalex:${id}`), vector(values));
  });
  const answer = await readFeedPage(env, parseFeedRequest({
    categories: LEAVES, positiveIds: ['2610.00059', 'openalex:W202511'], negativeIds: ['openalex:W202521'], excludedIds: ['openalex:W202510'],
    pageSize: 15, seen: feedSeenFilter([]), notable: 5,
  }), { now: NOW });
  const notable = answer.filter(paper => paper._notable).map(paper => paper.id);
  assert.equal(notable.length, 5, 'the five asked for');
  // The two closest left, then the newest without a vector: 2025's last one.
  assert.deepEqual(notable.slice(0, 3), ['openalex:W201811', 'openalex:W201610', 'openalex:W202520']);
  assert.deepEqual(notable.filter(id => ['openalex:W202511', 'openalex:W202521', 'openalex:W202510'].includes(id)), []);
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

// Pablo's ruling of 2026-11-13: with a like, the notable cards follow the
// interest groups, as the page does.
test("with a like, each interest group ranks its own notable papers by its own likes, a group without likes takes its years in turns, and the groups take turns by weight", async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00059'), vector([1, 0, 0, 0, 0, 0]));
  // cs.LG's notable papers closest to the like first; cs.CV's 2025 paper is
  // closer still, but cs.CV's group has no like to rank it by.
  [['W201811', 0.8], ['W202410', 0.65], ['W201610', 0.5]].forEach(([id, share], index) => {
    const values = [Number(share), 0, 0, 0, 0, 0];
    values[index + 1] = Math.sqrt(1 - Number(share) ** 2);
    insert.run(idOf(`openalex:${id}`), vector(values));
  });
  insert.run(idOf('openalex:W202520'), vector([0.95, 0, 0, 0, 0, 0.312]));
  const notable = async (weights: number[]) => (await readFeedPage(env, parseFeedRequest({
    groups: [
      { categories: ['cs.LG'], exampleCategories: ['cs.LG'], positiveIds: ['2610.00059'], weight: weights[0] },
      { categories: ['cs.CV'], exampleCategories: ['cs.CV'], positiveIds: [], weight: weights[1] },
    ],
    pageSize: 15, seen: feedSeenFilter([]), notable: 5,
  }), { now: NOW })).filter(paper => paper._notable).map(paper => paper.id);
  assert.deepEqual(await notable([1, 1]), ['W201811', 'W202521', 'W202410', 'W202421', 'W201610'].map(id => `openalex:${id}`));
  assert.deepEqual(await notable([2, 1]), ['W201811', 'W202521', 'W202410', 'W201610', 'W202421'].map(id => `openalex:${id}`));
});

test("each liked group's notable papers are ranked by that group's likes alone, not by another group's", async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  const insert = db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)');
  const vector = (values: number[]) => Buffer.from(quantize(values).buffer);
  insert.run(idOf('2610.00059'), vector([1, 0, 0, 0, 0, 0]));
  insert.run(idOf('2610.00058'), vector([0, 0, 0, 0, 0, 1]));
  // cs.LG's 2024 paper is closer to cs.CV's like (0.85) than its 2018 paper
  // is to cs.LG's (0.8), and cs.CV's 2024 paper is close to cs.LG's like
  // alone (0.9): ranked by every like, each would lead its group.
  insert.run(idOf('openalex:W201811'), vector([0.8, 0.6, 0, 0, 0, 0]));
  insert.run(idOf('openalex:W202410'), vector([0.5, 0, 0.166, 0, 0, 0.85]));
  insert.run(idOf('openalex:W202420'), vector([0.9, 0, 0, 0.436, 0, 0]));
  const answer = await readFeedPage(env, parseFeedRequest({
    groups: [
      { categories: ['cs.LG'], exampleCategories: ['cs.LG'], positiveIds: ['2610.00059'], weight: 1 },
      { categories: ['cs.CV'], exampleCategories: ['cs.CV'], positiveIds: ['2610.00058'], weight: 1 },
    ],
    pageSize: 15, seen: feedSeenFilter([]), notable: 5,
  }), { now: NOW });
  // cs.LG's by its like, then the ones without a vector newest first; cs.CV's
  // like is near none of cs.CV's papers, so they go newest first. The groups
  // take turns.
  assert.deepEqual(answer.filter(paper => paper._notable).map(paper => paper.id), ['W201811', 'W202521', 'W202410', 'W202520', 'W202511'].map(id => `openalex:${id}`));
});

// The cards a fresh load excludes count as turns already passed for a group
// without likes too, though the group beside it leaves them out before ranking.
test('a fresh load continues the years in turns of a group without likes beside a group with likes', async () => {
  const { env, db } = await notableLeavesCorpus();
  const idOf = (paperId: string) => rows(db, `SELECT id FROM works WHERE paper ->> '$.id' = '${paperId}'`)[0].id as number;
  db.prepare('INSERT INTO work_vectors (work_id, embedding) VALUES (?, ?)').run(idOf('2610.00059'), Buffer.from(quantize([1, 0, 0, 0, 0, 0]).buffer));
  const shown: string[] = [];
  const excludedIds: string[] = [];
  const years: Array<Array<number | null | undefined>> = [];
  for (let load = 0; load < 3; load += 1) {
    const answer = await readFeedPage(env, parseFeedRequest({
      groups: [
        { categories: ['cs.LG'], exampleCategories: ['cs.LG'], positiveIds: ['2610.00059'], weight: 1 },
        { categories: ['cs.CV'], exampleCategories: ['cs.CV'], positiveIds: [], weight: 1 },
      ],
      pageSize: 15, seen: feedSeenFilter(shown), excludedIds, notable: 4,
    }), { now: NOW });
    const cards = answer.filter(paper => paper._notable);
    // Two cards a load from each group: cs.CV's are the ones without likes.
    years.push(cards.filter(paper => paper._fetchedFor?.includes('cs.CV')).map(paper => paper.year));
    shown.push(...answer.map(paper => paper.id));
    excludedIds.push(...cards.map(paper => paper.id));
  }
  assert.deepEqual(years, [[2025, 2024], [2023, 2022], [2021, 2020]]);
});

// cs.LG's and economics' notable papers (`notableLeavesCorpus`), a group for
// each, and a liked paper with a vector for each group. The notable papers
// have no vector, so a group with likes ranks its own newest first.
const AREA_LEAVES = ['cs.LG', 'econ.GN'];
const AREA_LIKES = ['2610.00059', '2610.00058'];
async function notableAreasCorpus() {
  const { env, db } = await notableLeavesCorpus(AREA_LEAVES);
  const embed = db.prepare("INSERT INTO work_vectors (work_id, embedding) SELECT id, ? FROM works WHERE paper ->> '$.id' = ?");
  AREA_LIKES.forEach((id, index) => embed.run(Buffer.from(quantize(index === 0 ? [1, 0] : [0, 1]).buffer), id));
  return env;
}
const areaGroups = (positiveIds: string[][], weights = [1, 1]) => AREA_LEAVES.map((category, index) => (
  { categories: [category], exampleCategories: [category], positiveIds: positiveIds[index], weight: weights[index] }
));

// A page of fifteen has one notable place: the app asks for its card and two
// spares, shows the first it gets and, on the next fresh load, holds the cards
// it showed in the seen filter and names them in `excludedIds`. A card the
// reader liked comes among its group's likes, and one they rejected in
// `negativeIds`. The answer: the category and year of the card each load shows.
async function notablePlaceByLoad(
  loads: number,
  { likes = AREA_LIKES.map(id => [id]), weights = [1, 1], shownAs = 'excludedIds' }: { likes?: string[][]; weights?: number[]; shownAs?: 'excludedIds' | 'positiveIds' | 'negativeIds' | 'seen' } = {},
) {
  const env = await notableAreasCorpus();
  const shown: Array<{ id: string; category: string }> = [];
  const places: Array<[category: string, year: number | null | undefined]> = [];
  for (let load = 0; load < loads; load += 1) {
    const named = shown.map(card => card.id);
    const liked = AREA_LEAVES.map(category => (shownAs === 'positiveIds' ? shown.filter(card => card.category === category).map(card => card.id) : []));
    const answer = await readFeedPage(env, parseFeedRequest({
      groups: areaGroups(likes.map((ids, index) => [...ids, ...liked[index]]), weights),
      ...(shownAs === 'excludedIds' ? { excludedIds: named } : {}),
      ...(shownAs === 'negativeIds' ? { negativeIds: named } : {}),
      pageSize: 15, seen: feedSeenFilter(named), skipsSeen: true, notable: 3,
    }), { now: NOW });
    const [card] = answer.filter(paper => paper._notable);
    assert.equal(card._fetchedFor?.length, 1, `load ${load}: the card names its category`);
    shown.push({ id: card.id, category: card._fetchedFor[0] });
    places.push([card._fetchedFor[0], card.year]);
  }
  return places;
}

// The verifier's finding on PR #520 (2026-11-15): each group left out the
// papers the request names before the groups took their turns, so every fresh
// load gave its notable place to the first group again.
test('successive fresh loads give their notable place to the interest groups in turns, whether the app excludes the cards shown, the reader liked or rejected them, or the filter alone holds them', async () => {
  const categories: Record<string, string[]> = {};
  for (const shownAs of ['excludedIds', 'positiveIds', 'negativeIds', 'seen'] as const) {
    categories[shownAs] = (await notablePlaceByLoad(4, { shownAs })).map(([category]) => category);
  }
  const inTurns = ['cs.LG', 'econ.GN', 'cs.LG', 'econ.GN'];
  assert.deepEqual(categories, { excludedIds: inTurns, positiveIds: inTurns, negativeIds: inTurns, seen: inTurns });
});

test("over successive fresh loads the notable place follows the groups' weights, a group of twice the weight taking two loads in three", async () => {
  const categories = async (weights: number[]) => (await notablePlaceByLoad(6, { weights })).map(([category]) => category);
  assert.deepEqual(await categories([2, 1]), ['cs.LG', 'econ.GN', 'cs.LG', 'cs.LG', 'econ.GN', 'cs.LG']);
  assert.deepEqual(await categories([1, 2]), ['econ.GN', 'cs.LG', 'econ.GN', 'econ.GN', 'cs.LG', 'econ.GN']);
});

test('over successive fresh loads a group without likes takes the notable place in its turn, with its years in turns, beside a group with likes', async () => {
  // cs.LG's group ranks by its like, newest first on a tie: 2025's two papers, then 2024's.
  assert.deepEqual(await notablePlaceByLoad(6, { likes: [[AREA_LIKES[0]], []] }),
    [['cs.LG', 2025], ['econ.GN', 2025], ['cs.LG', 2025], ['econ.GN', 2024], ['cs.LG', 2024], ['econ.GN', 2023]]);
  // The group without likes first.
  assert.deepEqual(await notablePlaceByLoad(4, { likes: [[], [AREA_LIKES[1]]] }),
    [['cs.LG', 2025], ['econ.GN', 2025], ['cs.LG', 2024], ['econ.GN', 2025]]);
});

test("a group gives up one of its first turns for each of its own notable papers the request names, none for another group's, and a paper two groups hold costs one turn", async () => {
  const env = await notableAreasCorpus();
  const notableOf = async (excludedIds: string[]) => (await readFeedPage(env, parseFeedRequest({
    groups: areaGroups(AREA_LIKES.map(id => [id])), excludedIds, pageSize: 15, seen: feedSeenFilter([]), notable: 5,
  }), { now: NOW })).filter(paper => paper._notable).map(paper => paper._fetchedFor);
  // The app showed cs.LG's two newest and none of economics'.
  assert.deepEqual(await notableOf(['openalex:W202511', 'openalex:W202510']), [['econ.GN'], ['econ.GN'], ['cs.LG'], ['econ.GN'], ['cs.LG']]);
  // The newest paper of both lanes: cs.LG's first turn showed it, so economics' group comes next.
  await ingestPapers(env, [
    { paper: notableWork('W2025909', 'Highly cited study of 2025 in both areas', '2025-06-01', 5000, true), lanes: AREA_LEAVES.map(leaf => `notable:${leaf}`) },
  ], { now: NOW, keepUntil: LISTED_UNTIL });
  assert.deepEqual(await notableOf(['openalex:W2025909']), [['econ.GN'], ['cs.LG'], ['econ.GN'], ['cs.LG'], ['econ.GN']]);
});

// Notable papers that the categories of two groups list (the verifier's P2 on
// PR #520, 2026-11-16). Each group has a liked paper along its own axis; the
// notable papers of each lane have no vector, so a group ranks its own newest
// first. A shared paper is the newest of both its lanes, the first one newest,
// and its vector leans toward the like of the group named `rankedFirstBy` and
// away from the other's: that group ranks it first, the other last. So a
// shared card is that group's paper, and each other group's best paper is one
// of its own. Only `ownLeaves` have notable papers of their own.
const SHARED_LEAVES = ['cs.LG', 'econ.GN', 'math.ST'];
const SHARED_LIKES = ['2610.00059', '2610.00058', '2610.00057'];
const sharedVector = (axes: Record<number, number>) => quantize(Array.from({ length: 12 }, (_, axis) => axes[axis] ?? 0));
const sharedPaperId = (index: number) => `openalex:W20259${index}`;

async function sharedNotableCorpus(leaves: string[], shared: Array<{ groups: [number, number]; rankedFirstBy: number }>, ownLeaves = leaves) {
  const { env, db } = await notableLeavesCorpus(ownLeaves);
  const embed = db.prepare("INSERT INTO work_vectors (work_id, embedding) SELECT id, ? FROM works WHERE paper ->> '$.id' = ?");
  leaves.forEach((_, index) => embed.run(Buffer.from(sharedVector({ [index]: 1 }).buffer), SHARED_LIKES[index]));
  await ingestPapers(env, shared.map(({ groups }, index) => ({
    paper: notableWork(`W20259${index}`, `Highly cited study ${index} of two areas`, `2025-${String(9 - index).padStart(2, '0')}-01`, 5000, true),
    lanes: groups.map(group => `notable:${leaves[group]}`),
  })), { now: NOW, keepUntil: LISTED_UNTIL });
  shared.forEach(({ groups, rankedFirstBy }, index) => {
    const other = groups.find(group => group !== rankedFirstBy)!;
    embed.run(Buffer.from(sharedVector({ [rankedFirstBy]: 0.3, [other]: -0.5, [leaves.length + index]: 1 }).buffer), sharedPaperId(index));
  });
  // Whose paper each card is: a shared one is the group's that ranks it first.
  const groupOf = new Map(shared.map(({ rankedFirstBy }, index) => [sharedPaperId(index), leaves[rankedFirstBy]]));
  return { env, groupOf: (card: { id: string; _fetchedFor?: string[] }) => groupOf.get(card.id) ?? card._fetchedFor?.join('+') };
}

// A group for each leaf, with its like unless `withoutLikes` lists the leaf.
const sharedGroups = (leaves: string[], weights: number[], withoutLikes: string[] = []) => leaves.map((category, index) => (
  { categories: [category], exampleCategories: [category], positiveIds: withoutLikes.includes(category) ? [] : [SHARED_LIKES[index]], weight: weights[index] }
));

// Successive fresh loads with one notable place each: the app shows the first
// notable card, then holds the cards shown in the seen filter and names them in
// `excludedIds`, the latest first. `groups` can differ from load to load. The
// answer: the card each load shows.
async function notableCardByLoad(env: Parameters<typeof readFeedPage>[0], loads: number, groups: unknown[] | ((load: number) => unknown[])) {
  const cards: Array<{ id: string; _fetchedFor?: string[] }> = [];
  for (let load = 0; load < loads; load += 1) {
    const shown = cards.map(card => card.id);
    const answer = await readFeedPage(env, parseFeedRequest({
      groups: typeof groups === 'function' ? groups(load) : groups,
      excludedIds: [...shown].reverse(), pageSize: 15, seen: feedSeenFilter(shown), skipsSeen: true, notable: 3,
    }), { now: NOW });
    const [card] = answer.filter(paper => paper._notable);
    assert.ok(card, `load ${load} has a notable card`);
    assert.ok(!shown.includes(card.id), `load ${load} shows a card not shown before`);
    cards.push(card);
  }
  return cards;
}

// Whose paper each fresh load shows.
async function groupByLoad({ env, groupOf }: Awaited<ReturnType<typeof sharedNotableCorpus>>, loads: number, leaves: string[], weights: number[]) {
  return (await notableCardByLoad(env, loads, sharedGroups(leaves, weights))).map(groupOf);
}

test("a notable paper two groups hold, shown in the turn of the group that ranks it first, leaves the next fresh load to the other group's own paper", async () => {
  const leaves = SHARED_LEAVES.slice(0, 2);
  const corpus = await sharedNotableCorpus(leaves, [{ groups: [0, 1], rankedFirstBy: 1 }]);
  assert.deepEqual(await groupByLoad(corpus, 8, leaves, [1, 1]),
    ['cs.LG', 'econ.GN', 'cs.LG', 'econ.GN', 'cs.LG', 'econ.GN', 'cs.LG', 'econ.GN']);
});

test('four notable papers two groups hold keep two groups of equal weight in turns over successive fresh loads', async () => {
  const leaves = SHARED_LEAVES.slice(0, 2);
  const corpus = await sharedNotableCorpus(leaves, [0, 1, 2, 3].map(() => ({ groups: [0, 1] as [number, number], rankedFirstBy: 1 })));
  assert.deepEqual(await groupByLoad(corpus, 10, leaves, [1, 1]),
    ['cs.LG', 'econ.GN', 'cs.LG', 'econ.GN', 'cs.LG', 'econ.GN', 'cs.LG', 'econ.GN', 'cs.LG', 'econ.GN']);
});

test('with notable papers two groups hold, a group of twice the weight still takes two fresh loads in three', async () => {
  const leaves = SHARED_LEAVES.slice(0, 2);
  const corpus = await sharedNotableCorpus(leaves, [0, 1].map(() => ({ groups: [0, 1] as [number, number], rankedFirstBy: 1 })));
  assert.deepEqual(await groupByLoad(corpus, 9, leaves, [2, 1]),
    ['cs.LG', 'econ.GN', 'cs.LG', 'cs.LG', 'econ.GN', 'cs.LG', 'cs.LG', 'econ.GN', 'cs.LG']);
});

test('three groups of equal weight keep their turns over successive fresh loads when each pair of them shares a notable paper', async () => {
  const corpus = await sharedNotableCorpus(SHARED_LEAVES, [
    { groups: [0, 1], rankedFirstBy: 1 },
    { groups: [1, 2], rankedFirstBy: 2 },
    { groups: [0, 2], rankedFirstBy: 2 },
  ]);
  assert.deepEqual(await groupByLoad(corpus, 9, SHARED_LEAVES, [1, 1, 1]),
    ['cs.LG', 'econ.GN', 'math.ST', 'cs.LG', 'econ.GN', 'math.ST', 'cs.LG', 'econ.GN', 'math.ST']);
});

// Pablo's decision of 2026-11-17: such a paper is the group's whose ranking
// places it highest for its length. Given to the group asking for the first
// category by id, papers that only the other group's likes ranked high sat
// behind every notable paper of that group and were not shown in 12 loads
// (PR #520's review, 2026-11-17).
test("notable papers of both groups' categories that economics' likes rank first and cs.LG's last come on economics' turns", async () => {
  const leaves = SHARED_LEAVES.slice(0, 2);
  const { env } = await sharedNotableCorpus(leaves, [0, 1, 2, 3].map(() => ({ groups: [0, 1] as [number, number], rankedFirstBy: 1 })));
  assert.deepEqual((await notableCardByLoad(env, 8, sharedGroups(leaves, [1, 1]))).map(card => card.id),
    ['W202511', 'W202590', 'W202510', 'W202591', 'W202411', 'W202592', 'W202410', 'W202593'].map(id => `openalex:${id}`));
});

test("a group whose every notable paper another group's category lists too takes its turns while its likes rank those papers higher", async () => {
  const leaves = ['cs.LG', 'q-fin.GN'];
  // Finance has no notable paper of its own; its likes rank first the four that cs.LG's likes rank last.
  const corpus = await sharedNotableCorpus(leaves, [0, 1, 2, 3].map(() => ({ groups: [0, 1] as [number, number], rankedFirstBy: 1 })), ['cs.LG']);
  assert.deepEqual((await notableCardByLoad(corpus.env, 10, sharedGroups(leaves, [1, 1]))).map(corpus.groupOf),
    ['cs.LG', 'q-fin.GN', 'cs.LG', 'q-fin.GN', 'cs.LG', 'q-fin.GN', 'cs.LG', 'q-fin.GN', 'cs.LG', 'cs.LG']);
});

// Notable papers at chosen cosines to cs.LG's and economics' likes
// (SHARED_LIKES, each along an axis of its own; PR #520's review, 2026-11-17).
// `own` gives the cosine of each of a leaf's papers to that leaf's like; paper
// i is of 2025 - i % 10, and the higher index is the newer within a year.
// `shared` gives each paper of both lanes its cosine to each like. The rest of
// a vector lies along the paper's own axis, so no two papers are near copies.
// A card's label: A or B and the index for a paper of cs.LG or economics alone,
// S and the index for a shared one.
async function cosineNotableCorpus(own: [number[], number[]], shared: Array<{ cosines: number[]; date: string }>) {
  const { env, db } = corpus();
  await ingestPapers(env, recentPapers(60), { now: NOW });
  const papers = [
    ...own.flatMap((cosines, leaf) => cosines.map((cosine, index) => ({
      id: `W7${leaf}${String(index).padStart(2, '0')}`, label: `${'AB'[leaf]}${index}`, date: `${2025 - (index % 10)}-0${1 + Math.floor(index / 10)}-15`,
      leaves: [SHARED_LEAVES[leaf]], cosines: leaf ? [0, cosine] : [cosine, 0],
    }))),
    ...shared.map(({ cosines, date }, index) => ({ id: `W80${index}`, label: `S${index}`, date, leaves: SHARED_LEAVES.slice(0, 2), cosines })),
  ];
  await ingestPapers(env, papers.map(({ id, label, date, leaves }) => (
    { paper: notableWork(id, `Highly cited study ${label}`, date, 5000, true), lanes: leaves.map(leaf => `notable:${leaf}`) }
  )), { now: NOW, keepUntil: LISTED_UNTIL });
  const embed = db.prepare("INSERT INTO work_vectors (work_id, embedding) SELECT id, ? FROM works WHERE paper ->> '$.id' = ?");
  const vector = (axes: Record<number, number>) => Buffer.from(quantize(Array.from({ length: 64 }, (_, axis) => axes[axis] ?? 0)).buffer);
  SHARED_LIKES.slice(0, 2).forEach((id, axis) => embed.run(vector({ [axis]: 1 }), id));
  papers.forEach(({ id, cosines: [csLG, economics] }, index) => (
    embed.run(vector({ 0: csLG, 1: economics, [2 + index]: Math.sqrt(1 - csLG ** 2 - economics ** 2) }), `openalex:${id}`)
  ));
  const labels = new Map(papers.map(({ id, label }) => [`openalex:${id}`, label]));
  return { env, label: (card: { id: string }) => labels.get(card.id) };
}

// Pablo's decision of 2026-11-17 places a paper for the ranking's length. cs.LG
// ranks 34 papers, economics 14. S0 is 8th of both (7/34 against 7/14):
// cs.LG's. S1 is economics' first: economics'. S2 is closer to cs.LG's like
// (0.61 against 0.47) but 15th of 34 there and 3rd of 14 for economics:
// economics'. S3 is 11th of 34 for cs.LG and 6th of 14 for economics: cs.LG's,
// though economics places it lower. Each group ranks the papers the request
// names too: ranked without them, S3 came on economics' turn at load 12 and
// counted for cs.LG once named, so economics showed loads 20 to 22.
test("a notable paper two groups hold counts for the group whose ranking places it highest for the ranking's length, before and after a load names it", async () => {
  const { env, label } = await cosineNotableCorpus(
    [Array.from({ length: 30 }, (_, index) => 0.84 - 0.02 * index), Array.from({ length: 10 }, (_, index) => 0.5 - 0.06 * index)],
    [[0.71, 0.29], [0.31, 0.83], [0.61, 0.47], [0.67, 0.33]].map((cosines, index) => ({ cosines, date: `2024-10-1${index}` })),
  );
  // cs.LG: A0 to A6, S0, A7, A8, S3, A9; economics: S1, B0, S2, B1 to B9.
  assert.deepEqual((await notableCardByLoad(env, 24, sharedGroups(SHARED_LEAVES.slice(0, 2), [1, 1]))).map(label), [
    'A0', 'S1', 'A1', 'B0', 'A2', 'S2', 'A3', 'B1', 'A4', 'B2', 'A5', 'B3',
    'A6', 'B4', 'S0', 'B5', 'A7', 'B6', 'A8', 'B7', 'S3', 'B8', 'A9', 'B9',
  ]);
});

// A group without likes ranks by its years in turns: its place for a paper
// says how soon its turns reach the paper's year, not how close it is to a like.
test('a notable paper of a group with likes and a group without goes to the one whose ranking places it higher for its length, however close it is to the like', async () => {
  // Economics, without likes, has 2025's newest paper first, then S0, the
  // newest of 2024: its 2nd of 22. S0 is cs.LG's last of 12: economics',
  // though only cs.LG's like scores it (cosine 0.1). S1, the newest of 2016,
  // is economics' 10th and cs.LG's 2nd: cs.LG's.
  const { env, label } = await cosineNotableCorpus(
    [Array.from({ length: 10 }, (_, index) => 0.84 - 0.03 * index), Array.from({ length: 20 }, () => 0)],
    [{ cosines: [0.1, 0], date: '2024-10-10' }, { cosines: [0.825, 0], date: '2016-10-11' }],
  );
  // cs.LG: A0, S1, A1, A2; economics: B10 (2025), S0 (2024), B12 (2023), B13.
  assert.deepEqual((await notableCardByLoad(env, 8, sharedGroups(SHARED_LEAVES.slice(0, 2), [1, 1], ['econ.GN']))).map(label),
    ['A0', 'B10', 'S1', 'S0', 'A1', 'B12', 'A2', 'B13']);
});

// Pablo's decision of 2026-11-18: a group without likes finds each paper's
// group with its categories in id order. cs.LG's like ranks S0, a paper of
// cs.LG and econ.EM, 2nd of 11 (1/11). Economics, without likes, ranks it 1st
// of 7 with econ.EM first (0/7), the id order, and 2nd with econ.GN first
// (1/7). When the order asked decided, S0 was cs.LG's while economics asked
// for econ.GN first: a swap after S0 was shown gave cs.LG the next three
// cards, and a swap on every load gave economics two in a row.
test("a notable paper that a group without likes shares stays with one group however the app orders that group's categories, which order only its cards", async () => {
  const { env, db } = corpus();
  await ingestPapers(env, recentPapers(60), { now: NOW });
  // cs.LG's papers by cosine to its like; economics' all of 2025, S0 the newest of econ.EM.
  const papers = [
    ...Array.from({ length: 10 }, (_, index) => ({ label: `A${index}`, leaves: ['cs.LG'], date: `${2025 - index}-05-01`, cosine: 0.84 - 0.03 * index })),
    ...['econ.GN', 'econ.EM'].flatMap((leaf, leafIndex) => [0, 1, 2].map(index => ({ label: `${'GE'[leafIndex]}${index}`, leaves: [leaf], date: `2025-0${3 - index}-0${1 + leafIndex}`, cosine: 0 }))),
    { label: 'S0', leaves: ['cs.LG', 'econ.EM'], date: '2025-06-01', cosine: 0.83 },
  ].map((paper, index) => ({ ...paper, id: `W90${String(index).padStart(2, '0')}` }));
  await ingestPapers(env, papers.map(({ id, label, date, leaves }) => (
    { paper: notableWork(id, `Highly cited study ${label}`, date, 5000, true), lanes: leaves.map(leaf => `notable:${leaf}`) }
  )), { now: NOW, keepUntil: LISTED_UNTIL });
  const embed = db.prepare("INSERT INTO work_vectors (work_id, embedding) SELECT id, ? FROM works WHERE paper ->> '$.id' = ?");
  const vector = (axes: Record<number, number>) => Buffer.from(quantize(Array.from({ length: 32 }, (_, axis) => axes[axis] ?? 0)).buffer);
  embed.run(vector({ 0: 1 }), SHARED_LIKES[0]);
  papers.forEach(({ id, cosine }, index) => embed.run(vector({ 0: cosine, [1 + index]: Math.sqrt(1 - cosine ** 2) }), `openalex:${id}`));
  const labels = new Map(papers.map(({ id, label }) => [`openalex:${id}`, label]));
  const groups = (economics: string[]) => [
    { categories: ['cs.LG'], exampleCategories: ['cs.LG'], positiveIds: [SHARED_LIKES[0]], weight: 1 },
    { categories: economics, exampleCategories: economics, positiveIds: [], weight: 1 },
  ];
  const asked = ['econ.GN', 'econ.EM'];
  const swapped = ['econ.EM', 'econ.GN'];
  const cards = async (economicsAt: (load: number) => string[]) => (await notableCardByLoad(env, 8, load => groups(economicsAt(load))))
    .map(card => labels.get(card.id));
  // Economics shows its cards in the order asked: G0, S0, G1, E0; swapped: S0, G0, E0, G1.
  assert.deepEqual(await cards(() => asked), ['A0', 'G0', 'A1', 'S0', 'A2', 'G1', 'A3', 'E0']);
  assert.deepEqual(await cards(load => (load < 4 ? asked : swapped)), ['A0', 'G0', 'A1', 'S0', 'A2', 'E0', 'A3', 'G1'], 'swapped once after S0 was shown');
  assert.deepEqual(await cards(load => (load % 2 ? swapped : asked)), ['A0', 'S0', 'A1', 'G0', 'A2', 'E0', 'A3', 'G1'], 'swapped on every load');
});

test("a notable paper of both groups' categories that the request names, though no load showed it, takes a turn of the group that ranks it higher", async () => {
  const leaves = SHARED_LEAVES.slice(0, 2);
  const { env } = await sharedNotableCorpus(leaves, [{ groups: [0, 1], rankedFirstBy: 1 }]);
  const notableOf = async (body: object) => (await readFeedPage(env, parseFeedRequest({ pageSize: 15, seen: feedSeenFilter([]), notable: 5, ...body }), { now: NOW }))
    .filter(paper => paper._notable).map(paper => paper._fetchedFor);
  // Economics' first turn is the named paper's, so cs.LG takes two places running.
  const economicsFirstTurnPassed = [['cs.LG'], ['cs.LG'], ['econ.GN'], ['cs.LG'], ['econ.GN']];
  assert.deepEqual(await notableOf({ groups: sharedGroups(leaves, [1, 1]), excludedIds: [sharedPaperId(0)] }), economicsFirstTurnPassed);
  // Liked in economics, in Lists say, it is one of economics' likes, which rank it first.
  const [csLG, economics] = sharedGroups(leaves, [1, 1]);
  assert.deepEqual(await notableOf({ groups: [csLG, { ...economics, positiveIds: [...economics.positiveIds, sharedPaperId(0)] }] }), economicsFirstTurnPassed);
});

test("listing the groups in another order leaves each notable paper of both groups' categories with the same group, a tie included", async () => {
  const leaves = SHARED_LEAVES.slice(0, 2);
  const { env } = await sharedNotableCorpus(leaves, [0, 1, 2, 3].map(() => ({ groups: [0, 1] as [number, number], rankedFirstBy: 1 })));
  // Listed first, economics takes the first turn, and still shows the papers its likes rank first.
  assert.deepEqual((await notableCardByLoad(env, 8, sharedGroups(leaves, [1, 1]).reverse())).map(card => card.id),
    ['W202590', 'W202511', 'W202591', 'W202510', 'W202592', 'W202411', 'W202593', 'W202410'].map(id => `openalex:${id}`));
  // Both groups rank the newest paper of both lanes first: it is cs.LG's,
  // which asks for the first of its categories by id, in either order.
  const areas = await notableAreasCorpus();
  await ingestPapers(areas, [
    { paper: notableWork('W2025909', 'Highly cited study of 2025 in both areas', '2025-06-01', 5000, true), lanes: AREA_LEAVES.map(leaf => `notable:${leaf}`) },
  ], { now: NOW, keepUntil: LISTED_UNTIL });
  const notableOf = async (groups: unknown[]) => (await readFeedPage(areas, parseFeedRequest({
    groups, excludedIds: ['openalex:W2025909'], pageSize: 15, seen: feedSeenFilter([]), notable: 5,
  }), { now: NOW })).filter(paper => paper._notable).map(paper => paper._fetchedFor);
  assert.deepEqual(await notableOf(areaGroups(AREA_LIKES.map(id => [id]))), [['econ.GN'], ['cs.LG'], ['econ.GN'], ['cs.LG'], ['econ.GN']]);
  assert.deepEqual(await notableOf(areaGroups(AREA_LIKES.map(id => [id])).reverse()), [['econ.GN'], ['econ.GN'], ['cs.LG'], ['econ.GN'], ['cs.LG']]);
});

// Notable papers without a vector: a group with likes scores them all alike,
// so it orders them by date, and the papers of one date tie. `papers` gives
// each its label, categories and date. Each group's like lies along an axis of
// its own (SHARED_LIKES).
async function tiedNotableCorpus(papers: Array<{ label: string; leaves: string[]; date: string }>) {
  const { env, db } = corpus();
  await ingestPapers(env, recentPapers(60), { now: NOW });
  const ids = papers.map((_, index) => `W96${String(index).padStart(2, '0')}`);
  await ingestPapers(env, papers.map(({ label, leaves, date }, index) => (
    { paper: notableWork(ids[index], `Highly cited study ${label}`, date, 5000, true), lanes: leaves.map(leaf => `notable:${leaf}`) }
  )), { now: NOW, keepUntil: LISTED_UNTIL });
  const embed = db.prepare("INSERT INTO work_vectors (work_id, embedding) SELECT id, ? FROM works WHERE paper ->> '$.id' = ?");
  SHARED_LIKES.forEach((id, axis) => embed.run(Buffer.from(sharedVector({ [axis]: 1 }).buffer), id));
  const labels = new Map(papers.map(({ label }, index) => [`openalex:${ids[index]}`, label]));
  return { env, label: (card: { id: string }) => labels.get(card.id)! };
}

// The verifier's finding on 8af91906 (PR #520, 2026-11-18). Computer science
// asks for cs.LG and cs.CV, economics for econ.GN, each with a like, of equal
// weight. S, of cs.CV and econ.GN, is economics' newest paper and ties with L0,
// cs.LG's newest, in computer science. When a group with likes found each
// paper's group with the papers in the order the request asks its categories
// in, S was economics' with cs.LG asked first (2nd of 4 against 1st of 3) and
// computer science's with cs.CV first (1st of 4, a tie that cs.CV wins over
// econ.GN). Swapping the two after S was shown on economics' turn charged it to
// computer science: L0, S, E0, E1 instead of L0, S, C1, E0. Computer science
// now ranks L0 and S in work id order, a hash of the paper id, which puts S
// 2nd in either order, so S is economics'.
test("a notable paper two groups hold stays with one group when the app swaps the order of a group's categories, though it ties with that group's other papers", async () => {
  const { env, label } = await tiedNotableCorpus([
    { label: 'L0', leaves: ['cs.LG'], date: '2025-06-01' },
    { label: 'L1', leaves: ['cs.LG'], date: '2025-03-01' },
    { label: 'C1', leaves: ['cs.CV'], date: '2025-04-01' },
    { label: 'S', leaves: ['cs.CV', 'econ.GN'], date: '2025-06-01' },
    { label: 'E0', leaves: ['econ.GN'], date: '2025-05-01' },
    { label: 'E1', leaves: ['econ.GN'], date: '2025-02-01' },
  ]);
  const groups = (computing: string[]) => [
    { categories: computing, exampleCategories: computing, positiveIds: [SHARED_LIKES[0]], weight: 1 },
    { categories: ['econ.GN'], exampleCategories: ['econ.GN'], positiveIds: [SHARED_LIKES[1]], weight: 1 },
  ];
  const asked = ['cs.LG', 'cs.CV'];
  const swapped = ['cs.CV', 'cs.LG'];
  const cards = async (computingAt: (load: number) => string[]) => (await notableCardByLoad(env, 6, load => groups(computingAt(load)))).map(label);
  const inOneOrder = await cards(() => asked);
  assert.deepEqual(await cards(load => (load < 2 ? asked : swapped)), inOneOrder, 'swapped after two loads');
  assert.deepEqual(inOneOrder, ['L0', 'S', 'C1', 'E0', 'L1', 'E1']);
  assert.deepEqual(await cards(load => (load < 2 ? swapped : asked)), await cards(() => swapped), 'swapped back after two loads');
});

// Every order in which the request can list three groups of equal weight and
// each group's categories: computer science's two, economics' two, and
// statistics' one. Each category has a notable paper of 2025-06-01 and eight
// older ones; four papers of that date are listed by two groups' categories
// and two by all three. Each group has a like, and no notable paper has a
// vector, so a group ranks its papers of that date alike and only the tie
// decides each shared paper's group. With equal weights and no group running
// out, the fresh loads give the notable place to the groups in the order
// listed, so each load's card is the group's whose turn it is. Every order
// gives each shared paper the same group, whatever order `excludedIds` lists
// the cards in, and every other card comes on its own group's turn.
test("every order of the groups and of each group's categories leaves each notable paper that two or three groups hold with the same group, ties included", async () => {
  const tie = '2025-06-01';
  const areas: Record<string, string[]> = { computing: ['cs.LG', 'cs.CV'], economics: ['econ.GN', 'econ.EM'], statistics: ['math.ST'] };
  const shared = [
    { label: 'S0', leaves: ['cs.LG', 'econ.GN'] },
    { label: 'S1', leaves: ['cs.CV', 'econ.EM'] },
    { label: 'S2', leaves: ['cs.CV', 'math.ST'] },
    { label: 'S3', leaves: ['econ.GN', 'math.ST'] },
    { label: 'T0', leaves: ['cs.LG', 'econ.EM', 'math.ST'] },
    { label: 'T1', leaves: ['cs.CV', 'econ.GN', 'math.ST'] },
  ];
  const { env, label } = await tiedNotableCorpus([
    ...Object.values(areas).flat().flatMap((leaf, leafIndex) => [
      { label: `${leaf} 0`, leaves: [leaf], date: tie },
      ...Array.from({ length: 8 }, (_, rank) => ({ label: `${leaf} ${rank + 1}`, leaves: [leaf], date: `${2024 - rank}-0${1 + leafIndex}-01` })),
    ]),
    ...shared.map(paper => ({ ...paper, date: tie })),
  ]);
  const likeOf: Record<string, string> = { computing: SHARED_LIKES[0], economics: SHARED_LIKES[1], statistics: SHARED_LIKES[2] };
  const orders = <T>(items: T[]): T[][] => (items.length <= 1 ? [items]
    : items.flatMap((item, index) => orders([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])));
  const owners: Array<Record<string, string>> = [];
  let walk = 0;
  for (const groupOrder of orders(Object.keys(areas))) {
    for (const computing of orders(areas.computing)) {
      for (const economics of orders(areas.economics)) {
        const categoriesOf: Record<string, string[]> = { computing, economics, statistics: areas.statistics };
        const groups = groupOrder.map(name => ({ categories: categoriesOf[name], exampleCategories: categoriesOf[name], positiveIds: [likeOf[name]], weight: 1 }));
        const shown: string[] = [];
        const owner: Record<string, string> = {};
        // Until every shared paper is shown: at most 7 papers of the tied date a group.
        for (let load = 0; load < 21 && Object.keys(owner).length < shared.length; load += 1) {
          const answer = await readFeedPage(env, parseFeedRequest({
            groups, excludedIds: walk % 2 ? [...shown] : [...shown].reverse(), pageSize: 15, seen: feedSeenFilter(shown), skipsSeen: true, notable: 3,
          }), { now: NOW });
          const [card] = answer.filter(paper => paper._notable);
          const turn = groupOrder[load % groupOrder.length];
          const name = label(card);
          if (shared.some(paper => paper.label === name)) owner[name] = turn;
          else assert.ok(areas[turn].includes(name.split(' ')[0]), `${groupOrder}, ${computing}, ${economics}: load ${load} shows ${name} on ${turn}'s turn`);
          shown.push(card.id);
        }
        owners.push(owner);
        walk += 1;
      }
    }
  }
  assert.equal(owners.length, 24);
  assert.deepEqual(Object.keys(owners[0]).sort(), shared.map(paper => paper.label));
  for (const owner of owners) assert.deepEqual(owner, owners[0]);
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

// The feed's request ceiling, counted by the real ledger. `ask` answers
// `accepted` or the error the page would answer with.
function feedCeiling(t: TestContext, limits: { user: string; global: string }) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T12:00:00Z') });
  const ledger = inMemoryQuotaLedger();
  const env = {
    REQUEST_QUOTA_LEDGER: ledger.binding, PROVIDER_USER_MINUTE_LIMIT: limits.user, PROVIDER_GLOBAL_MINUTE_LIMIT: limits.global,
  } as Parameters<typeof reserveFeedRequest>[0];
  const ask = (uid: string, at: string) => {
    t.mock.timers.setTime(Date.parse(at));
    return reserveFeedRequest(env, uid).then(() => 'accepted', (error: { status: number; code: string }) => `${error.status} ${error.code}`);
  };
  const askTimes = async (count: number, uid: (index: number) => string, at: string) => {
    const answers: string[] = [];
    for (let index = 0; index < count; index += 1) answers.push(await ask(uid(index), at));
    return answers;
  };
  return { ask, askTimes, objects: () => new Set(ledger.calls).size };
}

const accepted = (count: number) => Array.from({ length: count }, () => 'accepted');

// A new ledger object takes about 0.5 s to answer its first call (`reserveFeedRequest`).
test("the feed's request ceiling opens one ledger object an hour, whatever minute a request comes in", async t => {
  const ceiling = feedCeiling(t, { user: '60', global: '2000' });
  for (const at of ['2026-10-30T12:00:05Z', '2026-10-30T12:01:30Z', '2026-10-30T12:37:00Z', '2026-10-30T12:59:59.999Z']) {
    assert.equal(await ceiling.ask('reader-1', at), 'accepted');
  }
  assert.equal(ceiling.objects(), 1);
  assert.equal(await ceiling.ask('reader-1', '2026-10-30T13:00:00Z'), 'accepted');
  assert.equal(ceiling.objects(), 2);
});

test("a reader's 61st feed request in a UTC minute is a 429, another reader's is not, and the next minute accepts the reader again", async t => {
  const ceiling = feedCeiling(t, { user: '60', global: '2000' });
  assert.deepEqual(await ceiling.askTimes(61, () => 'reader-1', '2026-10-30T12:05:00Z'), [...accepted(60), '429 RATE_LIMITED']);
  assert.equal(await ceiling.ask('reader-1', '2026-10-30T12:05:59.999Z'), '429 RATE_LIMITED');
  assert.equal(await ceiling.ask('reader-2', '2026-10-30T12:05:59.999Z'), 'accepted');
  assert.deepEqual(await ceiling.askTimes(60, () => 'reader-1', '2026-10-30T12:06:00Z'), accepted(60));
});

test("the app's 2,001st feed request in a UTC minute is a 429 whoever sends it, and the next minute accepts again", async t => {
  const ceiling = feedCeiling(t, { user: '60', global: '2000' });
  assert.deepEqual(await ceiling.askTimes(2_001, index => `reader-${index}`, '2026-10-30T12:05:30Z'), [...accepted(2_000), '429 RATE_LIMITED']);
  assert.equal(await ceiling.ask('reader-0', '2026-10-30T12:05:59Z'), '429 RATE_LIMITED');
  assert.equal(await ceiling.ask('reader-new', '2026-10-30T12:06:00Z'), 'accepted');
});

test("every minute of an hour gets the whole app-wide feed ceiling, however full the minutes before it were", async t => {
  const ceiling = feedCeiling(t, { user: '60', global: '2' });
  for (let minute = 0; minute < 60; minute += 1) {
    const at = `2026-10-30T12:${String(minute).padStart(2, '0')}:30Z`;
    assert.deepEqual(await ceiling.askTimes(3, index => `reader-${index}`, at), ['accepted', 'accepted', '429 RATE_LIMITED'], at);
  }
});

// An hour of 20,000 a minute is more than the 1,000,000 the ledger counts at
// most, and a ledger that refuses to count lets every page through.
test("an app-wide feed ceiling of 20,000 a minute still counts each reader's requests", async t => {
  const ceiling = feedCeiling(t, { user: '1', global: '20000' });
  assert.deepEqual(await ceiling.askTimes(2, () => 'reader-1', '2026-10-30T12:05:00Z'), ['accepted', '429 RATE_LIMITED']);
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

test("a lane an enrichment adds takes the paper's earliest arrival, or none when a lane holds it with none", async () => {
  const { env, db } = corpus();
  await ingestPapers(env, [{ paper: arxivRecord, lanes: [] }], { now: NOW });
  const [earlier, later] = [new Date(NOW - 86_400_000).toISOString(), new Date(NOW).toISOString()];
  db.prepare("UPDATE work_lanes SET arrived = CASE lane WHEN 'cs.CL' THEN ? ELSE ? END").run(earlier, later);
  const enrich = async (topicId: string) => {
    const [stored] = rows(db, 'SELECT id, paper FROM works').map(row => ({ id: Number(row.id), before: JSON.parse(String(row.paper)) }));
    await rewriteWorks(env, [{ ...stored, after: { ...stored.before, primaryTopic: { id: `https://openalex.org/${topicId}`, display_name: `Topic ${topicId}` } } }], NOW);
    return rows(db, `SELECT arrived FROM work_lanes WHERE lane = 'topic:${topicId}'`).map(row => row.arrived);
  };
  assert.deepEqual(await enrich('T10604'), [earlier]);
  db.prepare("UPDATE work_lanes SET arrived = NULL WHERE lane = 'cs.LG'").run();
  assert.deepEqual(await enrich('T10605'), [null], 'a lane that holds it with no arrival dates it by its publication');
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

// Every D1 call a request makes, held until the test lets all the pending ones
// go at once. Each release is a round trip the request had to wait for before
// it could go on, so `rounds` counts its round trips one after another.
function sequentialRoundTrips(t: TestContext, binding: D1Database) {
  const pending: Array<() => void> = [];
  const held = <A extends unknown[], R>(send: (...args: A) => Promise<R>) => function (this: unknown, ...args: A) {
    return new Promise<void>(resolve => { pending.push(resolve); }).then(() => send.apply(this, args));
  };
  const statement = Object.getPrototypeOf(binding.prepare('SELECT 1')) as Record<'all' | 'first' | 'run', (...args: unknown[]) => Promise<unknown>>;
  for (const name of ['all', 'first', 'run'] as const) t.mock.method(statement, name, held(statement[name]));
  t.mock.method(binding, 'batch', held(binding.batch.bind(binding)));
  const turn = () => new Promise(resolve => { setImmediate(resolve); });
  return async <T>(request: Promise<T>) => {
    let settled = false;
    const answer = request.finally(() => { settled = true; });
    let rounds = 0;
    for (;;) {
      // The request runs on until it waits on D1 or answers. A digest
      // (`rankingInputs`) settles some turns later.
      for (let turns = 0; !settled && pending.length === 0; turns += 1) {
        if (turns === 10_000) throw new Error('the request neither answered nor called D1');
        await turn();
      }
      if (pending.length === 0) break;
      rounds += 1;
      for (const release of pending.splice(0)) release();
    }
    return { rounds, answer: await answer };
  };
}

// A main feed page reads, in one round trip, the works its ids name with the
// vectors of its likes and rejections, its candidates and its notable lanes;
// in the next, the candidates' vectors beside the notable check; then it walks
// past the seen papers and reads its own rows.
test('a main feed page, with likes or without, waits on four D1 round trips one after another', async t => {
  const { env, likes, rejections } = coldPageCorpus();
  const body = { categories: ['cs.LG', 'cs.CL'], excludedIds: ['2610.00001'], seen: feedSeenFilter(['2610.00002']), skipsSeen: true, notable: 3, pageSize: 15 };
  const requests = {
    liked: { ...body, positiveIds: likes, negativeIds: rejections },
    rejections: { ...body, negativeIds: rejections },
    cold: body,
  };
  const ids = (papers: Paper[]) => papers.map(paper => paper.id);
  const unheld = {
    liked: ids(await readFeedPage(env, parseFeedRequest(requests.liked), { now: NOW })),
    rejections: ids(await readFeedPage(env, parseFeedRequest(requests.rejections), { now: NOW })),
    cold: ids(await readFeedPage(env, parseFeedRequest(requests.cold), { now: NOW })),
  };
  const rounds = sequentialRoundTrips(t, env.PAPER_STORE!);
  for (const name of ['liked', 'rejections', 'cold'] as const) {
    const held = await rounds(readFeedPage(env, parseFeedRequest(requests[name]), { now: NOW }));
    assert.equal(held.answer.length, 18, `${name}: 15 papers and 3 notable ones`);
    assert.deepEqual(ids(held.answer), unheld[name], `${name}: the same papers as a page whose calls nothing holds`);
    assert.equal(held.rounds, 4, name);
  }
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

test('a late rewrite advances beyond the intermediate row already on a card', async () => {
  const { env, db } = corpus();
  const mark = { id: 'S4306419637', label: 'ICLR', evidence: 'openreview' as const };
  await ingestPapers(env, [{ paper: { ...arxivRecord, acceptedConference: mark }, lanes: [] }], { now: NOW });
  const [row] = rows(db, 'SELECT id, paper FROM works');
  const id = Number(row.id);
  const before = JSON.parse(String(row.paper)) as Paper;
  const read = () => JSON.parse(String(rows(db, 'SELECT paper FROM works')[0].paper)) as Paper;
  await rewriteWorks(env, [{ id, before, after: { ...before, citationCount: 4 } }], NOW + 1000);
  const shown = read();
  assert.equal(shown.corpusUpdatedAt, NOW + 1000);
  assert.deepEqual(shown.acceptedConference, mark);
  await rewriteWorks(env, [{ id, before, after: { ...before, acceptedConference: undefined } }], NOW + 1);
  const late = read();
  assert.equal(late.corpusUpdatedAt, NOW + 1001);
  assert.equal(mergeFeedEvidence([shown], [late])[0].acceptedConference, undefined);
  await rewriteWorks(env, [{ id, before, after: { ...before, citationCount: 5 } }], NOW + 2);
  assert.equal(read().acceptedConference, undefined, 'an unrelated stale enrichment keeps the withdrawal');
  await rewriteWorks(env, [{ id, before: late, after: { ...late, acceptedConference: mark } }], NOW + 3);
  await rewriteWorks(env, [{ id, before: late, after: { ...late, citationCount: 6 } }], NOW + 4);
  assert.deepEqual(read().acceptedConference, mark, 'an unrelated stale enrichment keeps a later confirmation');
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

// The orders and digests in this file were served with each stored vector
// divided by the norm Math.hypot gives over its components. The square root
// of the sum of squares differs from it in the last bit for some vectors,
// which can swap two candidates that tie.
test('a unit vector divides each component by the norm Math.hypot gives, bit for bit, on random int8 vectors', () => {
  const random = seeded(171);
  const vectors = Array.from({ length: 2_000 }, () => Int8Array.from({ length: 256 }, () => Math.floor(random() * 256) - 128));
  const squareRoot = (vector: Int8Array) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  assert.ok(vectors.some(vector => squareRoot(vector) !== Math.hypot(...vector)), 'the two norms differ for some of these vectors');
  for (const vector of vectors) {
    const norm = Math.hypot(...vector);
    assert.deepEqual([...unitVector(vector)], [...vector].map(value => value / norm));
  }
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
      // The notable cards. Since 2026-11-13 only the cs.LG group's likes rank
      // cs.LG's notable lane; ranked by all three likes, they were 01713,
      // 01755 and 01740, and the digest 70caa410…
      '2610.01713', '2610.01740', '2610.01752',
    ],
    digest: '1c5484289b126c8740bc3e40385fe7f8d7375cec467572cfdc57f781fd1d48a0',
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
// what 65a9b5c5 served, reading every candidate's vector, but for the pages of
// groups: since 2026-11-13 a group without likes takes its categories in
// turns (before, 4ccc5914… and 2fc3b6bd…), and the ranks a page decides are
// still the ones a read of every vector gives (below).
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
    groups: '1a7cbb1e8ae01c0438666ff27c83214434dfb8fe37f2bc2d198d029bc339dd4a',
    noSignal: 'a143f974c9052330cf1b7876b6b2d418210898db046e724955ee09391dca8c8f',
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

test('deciding vectors account for quality even when a rejected copy is last by date', async t => {
  const { env, db, rejections } = coldPageCorpus();
  // Quality can put the oldest paper in the diversity pool until its vector
  // reveals that it duplicates the rejection.
  const last = db.prepare("SELECT work_id FROM work_lanes WHERE lane = 'cs.LG' ORDER BY published, work_id DESC LIMIT 1").get()!.work_id;
  db.prepare(`INSERT OR REPLACE INTO work_vectors (work_id, embedding)
    SELECT ?, embedding FROM work_vectors JOIN work_keys USING (work_id) WHERE key = ?`).run(last, `arxiv:${rejections[0]}`);
  db.prepare(`INSERT INTO work_quality (work_id, published, max_h_index, hf_upvotes, author_bonus, hf_bonus, score)
    SELECT work_id, published, 91, 20, 0.034, 0.016, 0.05 FROM work_lanes WHERE work_id = ? AND lane = 'cs.LG'`).run(last);
  const count = vectorRowsRead(t, env.PAPER_STORE!);
  const request = { groups: [{ categories: ['cs.LG'], weight: 1 }], negativeIds: [rejections[0]] };
  const kept: KeptRanking[] = [];
  const cache: RankingCache = { get: async () => null, put: async (_key, ranking) => { kept.push(ranking); } };
  await readFeedPage(env, parseFeedRequest(request), { now: NOW, cache });
  const partialReads = count();
  await readFeedPage(env, parseFeedRequest({ ...request, seen: feedSeenFilter([]), skipsSeen: true }), { now: NOW, cache });
  assert.ok(partialReads < count() - partialReads, 'the numbered page skipped vectors');
  const through = kept[0].decided;
  assert.ok(through && through < kept[0].ranks.length);
  const prefix = (ranking: KeptRanking) => ranking.ranks.slice(0, through).map(rank => [rank?.workId, rank?.semanticScore]);
  assert.deepEqual(prefix(kept[0]), prefix(kept[1]));
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

// A daily page puts each day's ranks together, so the ranks the vectors of the
// newest candidates decide by score are not its first ranks.
test('a daily page without likes ranks what a read of every vector gives', async () => {
  const { env, rejections } = coldPageCorpus();
  const keptBy = async (body: Parameters<typeof parseFeedRequest>[0]) => {
    const kept: KeptRanking[] = [];
    await readFeedPage(env, parseFeedRequest(body), { now: NOW, cache: { get: async () => null, put: async (_key, ranking) => { kept.push(ranking); } } });
    return kept[0].ranks.map(rank => rank && [rank.workId, rank.semanticScore]);
  };
  const body = { categories: ['cs.LG', 'cs.CL'], negativeIds: rejections, order: 'daily', pageSize: 30 };
  const everyVector = await keptBy({ ...body, seen: feedSeenFilter([]), skipsSeen: true });
  for (const page of [0, 3, 20]) assert.deepEqual(await keptBy({ ...body, page }), everyVector, `page ${page}`);
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

// ─── Keyword lanes (`query:<text>`) ───

const KAGOME = 'query:kagome superconductors';
// The rank each paper of a lane holds, by the id readers hold.
const ranksOf = (db: ReturnType<typeof testD1>['db'], lane: string) => Object.fromEntries((db.prepare(
  "SELECT w.paper ->> '$.id' AS id, l.rank FROM work_lanes l JOIN works w ON w.id = l.work_id WHERE l.lane = ?",
).all(lane) as Array<{ id: string; rank: number | null }>).map(row => [row.id, row.rank]));

test('a weekly listing ranks the papers it names and unranks the ones it dropped', async () => {
  const { env, db } = corpus();
  const [idA, idB, idC] = ['2610.00301', '2610.00302', '2610.00303'];
  await ingestPapers(env, [idA, idB, idC].map(id => ({ paper: lanePaper(id, `A kagome superconductor ${id}`), lanes: [KAGOME] })), { now: NOW });
  await writeLaneRanks(env, KAGOME, [idB, idA]);
  assert.deepEqual(ranksOf(db, KAGOME), { [idB]: 1, [idA]: 2, [idC]: null });
  // A record the ingest turned away keeps its place in the listing: the ranks have a gap.
  await writeLaneRanks(env, KAGOME, [idC, 'W-not-stored', idB]);
  assert.deepEqual(ranksOf(db, KAGOME), { [idC]: 1, [idB]: 3, [idA]: null });
});

test('ranking one keyword lane leaves the other lanes of its papers alone', async () => {
  const { env, db } = corpus();
  const idA = '2610.00311';
  await ingestPapers(env, [{ paper: lanePaper(idA, 'A kagome superconductor'), lanes: [KAGOME, 'cs.LG'] }], { now: NOW });
  await writeLaneRanks(env, KAGOME, [idA]);
  await writeLaneRanks(env, 'query:other keyword', [idA]);
  assert.equal(ranksOf(db, KAGOME)[idA], 1);
  assert.equal(ranksOf(db, 'cs.LG')[idA], null);
});

test('a listing that names one paper twice, by two of its ids, gives it the better rank', async () => {
  const { env, db } = corpus();
  const [idA, idB] = ['2610.00321', '2610.00322'];
  await ingestPapers(env, [
    { paper: { ...lanePaper(idA, 'A kagome superconductor'), doi: '10.1000/kagome.321' }, lanes: [KAGOME] },
    { paper: lanePaper(idB, 'Another kagome superconductor'), lanes: [KAGOME] },
  ], { now: NOW });
  await writeLaneRanks(env, KAGOME, ['doi:10.1000/kagome.321', idB, idA]);
  assert.deepEqual(ranksOf(db, KAGOME), { [idA]: 1, [idB]: 2 });
});

// A custom feed's keyword and a followed search share the lane; the follow is
// built as the app builds a keyword ingredient's (`corpusRequestOf`).
const keywordFollow = (query: string) => ({ type: 'topic', canonicalId: createQueryTopic(query)!.id, displayName: query, metadata: { query } });
// Papers of a keyword lane's listings, filed as its harvest files them: old ones kept, none as news.
const fileKeywordPapers = (env: Parameters<typeof ingestPapers>[0], lane: string, papers: Array<[id: string, published: string]>) => ingestPapers(env,
  papers.map(([id, published]) => ({ paper: lanePaper(id, `A study ${id} of ${lane.slice('query:'.length)}`, `${published}T00:00:00.000Z`), lanes: [lane] })),
  { now: NOW, keepUntil: daysFromNow(28, NOW), firstLoad: lane });

test('a keyword lane gives Following its last 90 days and a custom feed all of it', async () => {
  const { env } = corpus();
  const [from2019, lastWeek] = ['1906.00401', '2610.00402'];
  await fileKeywordPapers(env, KAGOME, [[from2019, '2019-06-11'], [lastWeek, '2026-10-16']]);
  await writeLaneRanks(env, KAGOME, [from2019]);
  const follows = [keywordFollow('kagome superconductors')];
  for (const order of ['recent', 'daily']) {
    const following = await readFeedPage(env, parseFeedRequest({ follows, order }), { now: NOW });
    assert.deepEqual(following.map(item => item.id), [lastWeek], order);
  }
  const feed = await readFeedPage(env, parseFeedRequest({ follows, exact: true, order: 'daily' }), { now: NOW });
  assert.deepEqual(feed.map(item => item.id), [lastWeek, from2019]);
});

// "Best match" of a custom feed (`exact`, `order: 'relevance'`): the keyword
// decides the order and the reader's likes only reorder each ten of its ranks
// (Nicolás, 2026-11-14).
const ranked = (workId: number, semanticScore = 0) => ({ workId, lanes: [], semanticScore });

test('keyword papers come in their rank order, the likes only reordering inside each ten', () => {
  const placed = new Map(Array.from({ length: 12 }, (_, index) => [index + 1, { lane: 'query:a', rank: index + 1 }]));
  const ranks = [ranked(12, 0.9), ranked(7, 0.8), ranked(3, 0.5), ...[1, 2, 4, 5, 6, 8, 9, 10, 11].map(id => ranked(id))];
  assert.deepEqual(inKeywordTurns(ranks, placed, ['query:a'], false).map(rank => rank.workId), [7, 3, 1, 2, 4, 5, 6, 8, 9, 10, 12, 11]);
});

test('without likes the order is the rank, then the unranked papers as they came', () => {
  const placed = new Map([[1, { lane: 'query:a', rank: 2 }], [2, { lane: 'query:a', rank: 1 }]]);
  assert.deepEqual(inKeywordTurns([ranked(9), ranked(1), ranked(8), ranked(2)], placed, ['query:a'], false).map(rank => rank.workId), [2, 1, 9, 8]);
});

test('a keyword takes turns with the rest of a mixed feed, and two keywords with each other', () => {
  const placed = new Map([[1, { lane: 'query:a', rank: 1 }], [2, { lane: 'query:a', rank: 2 }], [3, { lane: 'query:b', rank: 1 }]]);
  const ranks = [ranked(7), ranked(8), ranked(9), ranked(1), ranked(2), ranked(3)];
  assert.deepEqual(inKeywordTurns(ranks, placed, ['query:a', 'query:b'], true).map(rank => rank.workId), [1, 3, 7, 2, 8, 9]);
  assert.deepEqual(inKeywordTurns(ranks, placed, ['query:a', 'query:b'], false).map(rank => rank.workId), [1, 3, 2, 7, 8, 9]);
});

const KAGOME_FOLLOW = keywordFollow('kagome superconductors');
const [FROM_2015, FROM_2021, LAST_WEEK] = ['1503.00411', '2104.00412', '2610.00413'];
// The lane a week into its life: two papers of its any-age listing and a novelty outside it.
async function kagomeFeed() {
  const { env, db } = corpus();
  await fileKeywordPapers(env, KAGOME, [[FROM_2015, '2015-03-02'], [LAST_WEEK, '2026-10-16'], [FROM_2021, '2021-04-19']]);
  await writeLaneRanks(env, KAGOME, [FROM_2015, FROM_2021]);
  const served = async (body: Parameters<typeof parseFeedRequest>[0]) => (await readFeedPage(env, parseFeedRequest({ exact: true, ...body }), { now: NOW })).map(item => item.id);
  return { env, db, served };
}

test('Best match of a keyword feed is the catalogue in its rank order, whatever the dates', async () => {
  const { served } = await kagomeFeed();
  assert.deepEqual(await served({ follows: [KAGOME_FOLLOW], order: 'relevance' }), [FROM_2015, FROM_2021, LAST_WEEK]);
});

test('a paper two keywords rank comes once, at its better rank', async () => {
  const { env } = corpus();
  const WAVES = 'query:charge density waves';
  const [onlyKagome, shared, onlyWaves] = ['1503.00421', '1704.00422', '1905.00423'];
  await fileKeywordPapers(env, KAGOME, [[onlyKagome, '2015-03-02'], [shared, '2017-04-03']]);
  await fileKeywordPapers(env, WAVES, [[shared, '2017-04-03'], [onlyWaves, '2019-05-06']]);
  // Third of the first keyword's listing, behind a record the ingest turned away; first of the second's.
  await writeLaneRanks(env, KAGOME, [onlyKagome, 'W-not-stored', shared]);
  await writeLaneRanks(env, WAVES, [shared, onlyWaves]);
  const page = await readFeedPage(env, parseFeedRequest({ follows: [KAGOME_FOLLOW, keywordFollow('charge density waves')], exact: true, order: 'relevance' }), { now: NOW });
  // In the second keyword's turn, ahead of that keyword's second paper: at its third place in the first's it would come last.
  assert.deepEqual(page.map(item => item.id), [onlyKagome, shared, onlyWaves]);
});

test("a keyword's paper that one of the feed's categories also holds comes once, in the keyword's turn", async () => {
  const { env, served } = await kagomeFeed();
  await ingestPapers(env, [
    { paper: lanePaper(FROM_2021, `A study ${FROM_2021} of kagome superconductors`, '2021-04-19T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00431', 'A quantum walk', '2026-10-20T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00432', 'A quantum channel', '2026-10-19T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW, keepUntil: daysFromNow(28, NOW), firstLoad: true });
  assert.deepEqual(await served({ categories: ['quant-ph'], follows: [KAGOME_FOLLOW], order: 'relevance' }), [FROM_2015, '2610.00431', FROM_2021, '2610.00432', LAST_WEEK]);
});

test("a ranked paper older than the lane's share of candidates is still offered", async () => {
  const { db, served } = await kagomeFeed();
  // More unranked papers of the last weeks than a page reads of one lane.
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let id = 1; id <= FEED_CANDIDATE_LIMIT; id += 1) {
    const published = new Date(NOW - id * 600_000).toISOString();
    insertWork.run(1_000_000 + id, JSON.stringify({ id: `2610.9${String(id).padStart(4, '0')}`, title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertLane.run(KAGOME, 1_000_000 + id, published);
  }
  db.exec('COMMIT');
  assert.deepEqual((await served({ follows: [KAGOME_FOLLOW], order: 'relevance' })).slice(0, 3), [FROM_2015, FROM_2021, '2610.90001']);
});

test('a rejection alone does not move a keyword feed off its rank order', async () => {
  const { db, served } = await kagomeFeed();
  // The best match is a near copy of the rejected paper: without likes it stays first.
  const insert = db.prepare("INSERT INTO work_vectors (work_id, embedding) SELECT work_id, ? FROM work_keys WHERE key = ?");
  insert.run(Buffer.from(quantize([1, 0]).buffer), `arxiv:${LAST_WEEK}`);
  insert.run(Buffer.from(quantize([1, 0]).buffer), `arxiv:${FROM_2015}`);
  insert.run(Buffer.from(quantize([0, 1]).buffer), `arxiv:${FROM_2021}`);
  assert.deepEqual(await served({ follows: [KAGOME_FOLLOW], order: 'relevance', negativeIds: [LAST_WEEK] }), [FROM_2015, FROM_2021, LAST_WEEK]);
});

// Without likes a page reads only the vectors that decide its first ranks by
// score (`readDecidingVectors`); the keyword's turns reorder them.
test('a keyword feed with rejections and no likes ranks what a read of every vector gives', async () => {
  const { env, rejections } = coldPageCorpus();
  await fileKeywordPapers(env, KAGOME, [[FROM_2015, '2015-03-02']]);
  await writeLaneRanks(env, KAGOME, [FROM_2015]);
  const keptBy = async (body: Parameters<typeof parseFeedRequest>[0]) => {
    const kept: KeptRanking[] = [];
    await readFeedPage(env, parseFeedRequest(body), { now: NOW, cache: { get: async () => null, put: async (_key, ranking) => { kept.push(ranking); } } });
    return { decided: kept[0].decided, ranks: kept[0].ranks.map(rank => rank && [rank.workId, rank.semanticScore]) };
  };
  const body = { categories: ['cs.LG', 'cs.CL'], follows: [KAGOME_FOLLOW], exact: true, order: 'relevance', negativeIds: rejections, pageSize: 30 };
  const everyVector = await keptBy({ ...body, seen: feedSeenFilter([]), skipsSeen: true });
  for (const page of [0, 3, 20]) assert.deepEqual(await keptBy({ ...body, page }), everyVector, `page ${page}`);
});

test('Newest first of a keyword feed, and Best match of a feed without keywords, are unchanged', async () => {
  const { env, served } = await kagomeFeed();
  assert.deepEqual(await served({ follows: [KAGOME_FOLLOW], order: 'daily' }), [LAST_WEEK, FROM_2021, FROM_2015]);
  await ingestPapers(env, [
    { paper: lanePaper('2610.00441', 'A quantum walk', '2026-10-18T00:00:00.000Z'), lanes: ['quant-ph'] },
    { paper: lanePaper('2610.00442', 'A quantum channel', '2026-10-20T00:00:00.000Z'), lanes: ['quant-ph'] },
  ], { now: NOW });
  assert.deepEqual(await served({ categories: ['quant-ph'], order: 'relevance' }), ['2610.00442', '2610.00441']);
});
