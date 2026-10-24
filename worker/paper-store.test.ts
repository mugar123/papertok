import type { Paper, PaperFollowMatch } from '../src/models/Paper.ts';
import type { OpenAlexLocation } from '../src/services/adapters/openAlexTypes.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  arxivIdOf, daysFromNow, evictExpired, followLane, ingestPapers, keysForPaperId, parseFeedRequest, quantize, rankBySimilarity, readFeedPage, readVector,
  rewriteWorks,
} from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { PaperBuilder } from '../src/services/PaperBuilder.ts';
import { mapAdsPaper } from '../src/services/domainSourceRecords.ts';
import { mapHuggingFacePaper } from '../src/services/huggingFaceRecords.ts';
import { mapPubmedSummary } from '../src/services/adapters/pubmedRecords.ts';
import { mapOpenAlexWork } from '../src/utils/openAlexWork.ts';
import { feedSeenFilter } from '../src/utils/seenPaperFilter.ts';
import { notablePlaces, placeNotableCards } from '../src/utils/feedEnrichment.ts';
import { testD1 } from './test-support/sqliteD1.ts';

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

test('a reader who has seen every notable paper, a request that does not say what was seen or one that asks for none gets none', async () => {
  const { env } = await notableCorpus();
  const seenAll = feedSeenFilter(NOTABLE.map(paper => paper.id!));
  for (const query of [{ seen: seenAll, notable: 3 }, { notable: 3 }, { seen: feedSeenFilter([]) }]) {
    const page = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 30, ...query }), { now: NOW });
    assert.deepEqual(page.map(paper => paper.id), recentIds(0, 30));
    assert.ok(!page.some(paper => paper._notable));
  }
  // An order ranked with notable papers serves only requests that ask for them.
  const stored = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => (stored.get(key) as never) ?? null,
    put: async (key: string, ranking: unknown) => { stored.set(key, ranking); },
  };
  const first = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], pageSize: 30, seen: feedSeenFilter([]), notable: 3 }), { now: NOW, cache });
  assert.equal(first.filter(paper => paper._notable).length, 3);
  const later = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], page: 1, pageSize: 10 }), { now: NOW, cache });
  assert.ok(!later.some(paper => paper._notable));
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
  const seen = [...droppedOut, ...listing.slice(60)].map(paper => paper.id!);
  const categories = ['cs.LG', 'cs.AI', 'cs.CL', 'cs.CV', 'cs.NE', 'cs.IR', 'cs.RO', 'stat.ML', 'math.OC', 'q-bio.NC', 'eess.SP', 'econ.EM'];
  const page = await readFeedPage(env, parseFeedRequest({ categories, pageSize: 15, seen: feedSeenFilter(seen), notable: 3 }), { now: NOW });
  const offered = page.filter(paper => paper._notable).map(paper => paper.id!);
  const unseenListing = listing.slice(0, 60).map(paper => paper.id!);
  assert.equal(offered.length, 3, 'the three asked for');
  assert.ok(offered.every(id => unseenListing.includes(id)), `${offered} are papers of the listing the reader has not seen`);
});

test('a seen-paper filter the app did not write is refused', () => {
  for (const seen of ['', 'not a filter', 42, feedSeenFilter([]).slice(1)]) {
    assert.throws(() => parseFeedRequest({ categories: ['cs.LG'], seen }), (error: Error & { status?: number; code?: string }) => error.status === 400 && error.code === 'SEEN_INVALID', String(seen).slice(0, 20));
  }
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
