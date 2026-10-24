import type { Paper, PaperFollowMatch } from '../src/models/Paper.ts';
import type { OpenAlexLocation } from '../src/services/adapters/openAlexTypes.ts';
import type { KeptRanking, RankingCache } from './paper-store.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  arxivIdOf, daysFromNow, embedPending, embedWorks, evictExpired, followLane, ingestPapers, keysForPaperId, parseFeedRequest, quantize, rankBySimilarity,
  readFeedPage, readVector, rewriteWorks,
} from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { PaperBuilder } from '../src/services/PaperBuilder.ts';
import { mapAdsPaper } from '../src/services/domainSourceRecords.ts';
import { mapHuggingFacePaper } from '../src/services/huggingFaceRecords.ts';
import { mapPubmedSummary } from '../src/services/adapters/pubmedRecords.ts';
import { mapOpenAlexWork } from '../src/utils/openAlexWork.ts';
import { testD1 } from './test-support/sqliteD1.ts';
import { inMemoryQuotaLedger } from './test-support/quotaLedger.ts';

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
  assert.deepEqual([stored('2610.11111').title, stored('2610.11111').abstract, stored('2610.11111').summary], [arxivRevision.title, arxivRevision.abstract, arxivRevision.abstract]);
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
  await evictExpired(env, Date.parse('2027-01-09T00:00:00Z'));
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
  await evictExpired(env, Date.parse('2026-11-01T00:00:00Z'));
  assert.deepEqual(rows(db, "SELECT key FROM work_keys WHERE key = 'arxiv:2610.00001'").length, 1, 'past its date, still ranked by');
});

test('a follow is served from the lane its entity names, and a followed category from the category itself', () => {
  assert.equal(followLane({ type: 'author', canonicalId: 'https://openalex.org/A5023888391' }), 'author:A5023888391');
  assert.equal(followLane({ type: 'institution', canonicalId: 'I1321305853' }), 'institution:I1321305853');
  assert.equal(followLane({ type: 'topic', canonicalId: 'T10604' }), 'topic:T10604');
  assert.equal(followLane({ type: 'topic', canonicalId: 'C41008148' }), 'concept:C41008148');
  assert.equal(followLane({ type: 'topic', canonicalId: 'cs.LG' }), '', 'asked for as the category');
  assert.equal(followLane({ type: 'topic', canonicalId: 'query:abc', displayName: 'Graph Neural Networks', metadata: { query: 'graph neural networks' } }), 'query:graph neural networks');
  assert.equal(followLane({ type: 'author', canonicalId: 'yann-lecun', displayName: 'Yann LeCun' }), 'author-name:yann lecun');
  assert.equal(followLane({ type: 'project', canonicalId: '101034344', metadata: { funder: 'EC' } }), 'project:EC|101034344');
  assert.equal(followLane({ type: 'author', canonicalId: 'T10604' }), '', 'a topic id is no author, and there is no name to search');
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
  await evictExpired(env, NOW);
  assert.deepEqual(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'area:physics'").length, 1);
  assert.equal(rows(db, 'SELECT id FROM works').length, 2, 'the area lane keeps its paper in the corpus');
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
test("at least 3 of every 15 cards are the area's journal articles while its lane holds any, and more where they rank higher", async () => {
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
  // Newest first: the 12 newest preprints and the 3 newest articles, then the rest.
  assert.deepEqual(await page(0), { preprints: preprintIds.slice(0, 12), articles: articleIds.slice(0, 3) });
  assert.deepEqual(await page(1), { preprints: preprintIds.slice(12), articles: articleIds.slice(3) });
  // By a like that puts every preprint first, the same.
  assert.deepEqual(await page(0, [likedPreprint.id]), { preprints: preprintIds.slice(0, 12), articles: articleIds.slice(0, 3) });
  // By one that puts the articles first, all five lead: the floor has no maximum.
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
test("a page of another size than the feed's 15 cards is ranked as it is: the floor holds the feed's own page", async () => {
  const { env, preprintIds, articleIds } = await preprintsAndArticles();
  const ids = async (page: number, pageSize: number) => (await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], page, pageSize }), { now: NOW }))
    .map(item => item.id);
  const pages = async (count: number, pageSize: number) => (await Promise.all(Array.from({ length: count }, (_, page) => ids(page, pageSize)))).flat();
  // Newest first, the 30 preprints come before every article.
  assert.deepEqual(await pages(6, 5), preprintIds);
  assert.deepEqual(await pages(3, 8), preprintIds.slice(0, 24));
  assert.deepEqual((await ids(0, 15)).filter(id => id.startsWith('openalex:')), articleIds.slice(0, 3));
});

test("each page of a ranking ranked again after the ranks served keeps the floor, and no paper comes back", async () => {
  const { env, preprintIds, articleIds } = await preprintsAndArticles();
  // As the corpus feed keeps an order until its follow-up work ends: the ranks served only.
  const kept = new Map<string, KeptRanking>();
  const cache: RankingCache = {
    get: async key => kept.get(key) ?? null,
    put: async (key, ranking) => { kept.set(key, { ranks: ranking.ranks.slice(0, ranking.served), served: ranking.served, final: false }); },
  };
  const page = async (number: number) => (await readFeedPage(env, parseFeedRequest({ categories: ['quant-ph'], page: number }), { now: NOW, cache }))
    .map(item => item.id);
  const first = await page(0);
  // A preprint the harvest files before the next page.
  const newest = { ...arxivRecord, id: '2610.49999', arxivId: '2610.49999', title: 'Quantum error correction, the newest finding', allCategories: ['quant-ph'], categories: ['quant-ph'], primaryCategory: 'quant-ph', published: new Date(NOW - 1_800_000).toISOString() };
  await ingestPapers(env, [{ paper: newest, lanes: [] }], { now: NOW });
  const [second, third] = [await page(1), await page(2)];
  const articlesOf = (ids: string[]) => ids.filter(id => id.startsWith('openalex:'));
  assert.deepEqual([first, second, third].map(articlesOf), [articleIds.slice(0, 3), articleIds.slice(3, 6), articleIds.slice(6)]);
  assert.deepEqual(second.slice(0, 1), [newest.id], 'the paper that arrived starts the next page');
  assert.deepEqual([...first, ...second, ...third].sort(), [...preprintIds, newest.id, ...articleIds].sort(), 'every paper once');
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
  await evictExpired(env, NOW);
  assert.equal(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'cs.LG'").length, 4_000);
  assert.equal(rows(db, 'SELECT id FROM works').length, 4_000, 'the three oldest, in no lane now, are gone');
  assert.equal(rows(db, "SELECT key FROM work_keys WHERE key = 'arxiv:2610.04002'").length, 0);
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
  await evictExpired(env, NOW);
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
  await evictExpired(env, NOW);
  assert.deepEqual(rows(db, "SELECT key FROM work_keys WHERE key LIKE 'arxiv:%' ORDER BY key").map(row => row.key), ['arxiv:2610.00042', 'arxiv:2610.00043', 'arxiv:2610.00044']);
  assert.equal(rows(db, "SELECT work_id FROM work_lanes WHERE lane = 'author:A9'").length, 1, 'the author lane still names the paper its category keeps');
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
