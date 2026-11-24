import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import type { ArxivRecord } from './paper-sources.ts';
import type { Paper } from '../src/models/paper.ts';
import { NOTABLE_LANES_PER_NIGHT, SOURCES, SourceRefused, WORKING_PAPER_SERIES_IDS, arxivRecordPaper, backfillLane, categoryLaneJobs, followedLaneJob, harvestArxivPage, harvestLane, ingestPaperIds, notableLaneJobs, paperIdLookup, notableLanesPerNight, notableListedYear, openAlexNotableListingFilter, openAlexVenueFilterForLeaf, parseOaiPage, splitRawAuthors } from './paper-sources.ts';
import { FEED_CANDIDATE_LIMIT, KEEP_LIKED_DAYS, NOTABLE_YEARS, daysFromNow, embedPending, evictExpired, findWorks, ingestPapers, keepLiked, parseFeedRequest, readFeedPage } from './paper-store.ts';
import { mapAdsPaper, mapBioRxivPaper } from '../src/services/domain-source-records.ts';
import { enrichPending } from './paper-enrichment.ts';
import { fileAreaPapers } from './leaf-filing.ts';
import { handleHarvestOpenAlex, handleOpenAlex } from './openalex-api.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { OPENALEX_TIER_PERCENT, readOpenAlexBudget } from './provider-runtime.ts';
import { parseXmlDocument } from './xml-dom.ts';
import { handlePubmed } from './source-api.ts';
import { testD1 } from './test-support/sqlite-d1.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { parseXmlDocument as parseWithShim } from '../src/test-support/xml-dom-shim.ts';
import { readPubmedEfetch } from '../src/utils/pubmed-efetch.ts';
import { areaLabelForPaper, leavesForOpenAlexTopic, openAlexNotableFilterForLeaf, openAlexTopicFilterForLeaf } from '../src/utils/area-accent.ts';
import { OPENALEX_NOTABLE_LEAF_TOPICS } from '../src/data/open-alex-notable-leaf-topics.generated.ts';
import { OPENALEX_NOTABLE_VENUE_LEAVES } from './openalex-leaf-venues.generated.ts';
import { getCategoryArea } from '../src/data/category-taxonomy.ts';
import { mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { mapHuggingFacePaper } from '../src/services/hugging-face-records.ts';
import { mapPubmedSummary } from '../src/services/adapters/pubmed-records.ts';
import { mapCoreWork, mapEuropePmcSearchResult, mapOstiRecord } from '../src/services/domain-source-records.ts';
import { hasUsableAIAbstract } from '../src/utils/ai-explanation-access.ts';
import { mergeFeedAbstracts } from '../src/utils/feed-enrichment.ts';
import { feedSeenFilter } from '../src/utils/seen-paper-filter.ts';

// Captured from oaipmh.arxiv.org (ListRecords, arXivRaw, set=cs) on 2026-10-22,
// trimmed to one record, its abstract shortened, plus a deleted record.
const OAI_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <ListRecords>
    <record>
      <header><identifier>oai:arXiv.org:1605.00928</identifier><datestamp>2026-10-21</datestamp><setSpec>cs:cs:DC</setSpec></header>
      <metadata>
        <arXivRaw xmlns="http://arxiv.org/OAI/arXivRaw/">
          <id>1605.00928</id>
          <version version="v1"><date>Tue, 03 May 2016 14:30:05 GMT</date></version>
          <version version="v4"><date>Mon, 19 Oct 2026 19:09:32 GMT</date></version>
          <title>Fault Tolerance for
            Stream Processing Engines</title>
          <authors>Muhammad Anis Uddin Nasir (KTH), Ana Pérez and Li Wei</authors>
          <categories>cs.DC cs.DB cs.DC</categories>
          <comments>Revised version</comments>
          <abstract>Distributed Stream Processing Engines (DSPEs) target applications related to continuous computation.</abstract>
        </arXivRaw>
      </metadata>
    </record>
    <record>
      <header status="deleted"><identifier>oai:arXiv.org:2610.00001</identifier><datestamp>2026-10-21</datestamp></header>
    </record>
    <resumptionToken expirationDate="2026-10-23T00:00:00Z">verb%3DListRecords%26skip%3D1300</resumptionToken>
  </ListRecords>
</OAI-PMH>`;

// arXiv's limit covers its OAI-PMH endpoint, so a page takes a seat on the
// beat: with the ledger that keeps it unable to answer, nothing goes out.
test('an OAI page is not requested while the arXiv beat cannot answer, and is waited out', async t => {
  // The start of a three-second period the harvest may take, so it does not
  // wait for one.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 3, 0, 0, 3) });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(OAI_PAGE));
  const env = {
    REQUEST_QUOTA_LEDGER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('unavailable', { status: 503 }) }),
    },
  } as unknown as Parameters<typeof harvestArxivPage>[0];
  const page = await harvestArxivPage(env, { set: 'cs', from: '2026-10-20' });
  assert.deepEqual(page, { stored: 0, listed: 0, resumptionToken: '', retryAfterSeconds: 6 });
  assert.equal(fetchMock.mock.callCount(), 0);
});

const reloadDate = Date.UTC(2026, 10, 23, 0, 0, 3);
const icmlMark = { id: 'S4306419644', label: 'ICML', year: 2025, evidence: 'arxiv-comment' as const };
const neuripsMark = { id: 'S4363606243', label: 'NeurIPS', evidence: 'arxiv-comment' as const };
const acceptedAtIcml = 'Accepted at ICML 2025';

function conferenceReload(t: import('node:test').TestContext, works: {
  mark?: Paper['acceptedConference']; stamp?: number; comments: (string | null)[];
}[]) {
  t.mock.timers.enable({ apis: ['Date'], now: reloadDate });
  const { db, binding } = testD1();
  const records: string[] = [];
  for (const [index, work] of works.entries()) {
    const id = index + 1;
    const paper = { title: `Stored title ${id}`, citationCount: 17, acceptedConference: work.mark, corpusUpdatedAt: work.stamp };
    db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)').run(id, JSON.stringify(paper), '2026-10-01', '2027-01-01');
    for (const comment of work.comments) {
      const arxivId = `2601.${String(records.length + 1).padStart(5, '0')}`;
      db.prepare('INSERT INTO work_keys (key, work_id) VALUES (?, ?)').run('arxiv:' + arxivId, id);
      records.push(`<record><metadata><arXivRaw><id>${arxivId}</id><title>Revised title</title>
        <abstract>Revised text</abstract><categories>cs.LG</categories><version><date>2026-01-02</date></version>
        ${comment === null ? '' : `<comments>${comment}</comments>`}</arXivRaw></metadata></record>`);
    }
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(`<OAI-PMH><ListRecords>${records.join('')}</ListRecords></OAI-PMH>`));
  const env = { PAPER_STORE: binding } as Parameters<typeof harvestArxivPage>[0];
  const run = () => harvestArxivPage(env, { set: 'cs', from: '2026-10-25', conferenceBackfillUntil: '2026-11-23' });
  const rows = () => db.prepare('SELECT * FROM works ORDER BY id').all().map(row => ({
    ...row, paper: JSON.parse(String(row.paper)) as Paper,
  }));
  return { db, binding, run, rows };
}

test('the reload re-derives only the mark and stamp once per stored work', async t => {
  const openreview = { ...icmlMark, evidence: 'openreview' as const };
  const { db, run, rows } = conferenceReload(t, [
    { comments: [acceptedAtIcml] },
    { mark: icmlMark, stamp: reloadDate + 10, comments: ['Accepted at NeurIPS'] },
    { mark: icmlMark, stamp: reloadDate, comments: [null] },
    { mark: openreview, stamp: 123, comments: ['Accepted at NeurIPS'] },
    { mark: icmlMark, stamp: 123, comments: [acceptedAtIcml, 'Accepted at NeurIPS'] },
    { comments: ['Accepted at NeurIPS', acceptedAtIcml] },
    { mark: icmlMark, stamp: 123, comments: [acceptedAtIcml, null] },
    { comments: [acceptedAtIcml, acceptedAtIcml] },
    { mark: { evidence: 'arxiv-comment', year: 2025, label: 'ICML', id: icmlMark.id }, stamp: 123, comments: [acceptedAtIcml] },
  ]);
  const expected = rows();
  for (const index of [0, 7]) Object.assign(expected[index].paper, { acceptedConference: icmlMark, corpusUpdatedAt: reloadDate });
  Object.assign(expected[1].paper, { acceptedConference: neuripsMark, corpusUpdatedAt: reloadDate + 11 });
  for (const index of [2, 4, 6]) {
    delete expected[index].paper.acceptedConference;
    expected[index].paper.corpusUpdatedAt = index === 2 ? reloadDate + 1 : reloadDate;
  }
  const page = { listed: 13, resumptionToken: '', retryAfterSeconds: 0 };
  assert.deepEqual(await run(), { ...page, stored: 6, set: 2, changed: 1, cleared: 3 });
  assert.deepEqual(rows(), expected);
  const changes = () => db.prepare('SELECT total_changes() AS n').get()?.n;
  const after = changes();
  assert.deepEqual(await run(), { ...page, stored: 0, set: 0, changed: 0, cleared: 0 });
  assert.equal(changes(), after);
});

test('a listing between the reload read and write keeps its mark and stamp', async t => {
  const { db, binding, run, rows } = conferenceReload(t, [
    { mark: neuripsMark, stamp: 101, comments: [acceptedAtIcml] },
    { comments: [acceptedAtIcml] },
  ]);
  const openreview = { ...neuripsMark, evidence: 'openreview' as const };
  const expected = rows();
  expected[0].paper.corpusUpdatedAt = 102;
  expected[1].paper.acceptedConference = openreview;
  const prepare = binding.prepare.bind(binding);
  t.mock.method(binding, 'prepare', (sql: string) => {
    // SQLite reads synchronously. Queue a confirmation and a separate mark change
    // after that read, before the reload resumes from its first await.
    queueMicrotask(() => {
      db.exec("UPDATE works SET paper = json_set(paper, '$.corpusUpdatedAt', 102) WHERE id = 1");
      db.prepare("UPDATE works SET paper = json_set(paper, '$.acceptedConference', json(?)) WHERE id = 2").run(JSON.stringify(openreview));
    });
    return prepare(sql);
  }, { times: 1 });
  assert.deepEqual(await run(), { listed: 2, stored: 0, set: 0, changed: 0, cleared: 0, resumptionToken: '', retryAfterSeconds: 0 });
  assert.deepEqual(rows(), expected);
});

test('an OAI page yields its live records with v1 as the publication date', () => {
  const { papers, resumptionToken } = parseOaiPage(OAI_PAGE);
  assert.equal(resumptionToken, 'verb%3DListRecords%26skip%3D1300');
  assert.deepEqual(papers, [{
    arxivId: '1605.00928',
    title: 'Fault Tolerance for Stream Processing Engines',
    abstract: 'Distributed Stream Processing Engines (DSPEs) target applications related to continuous computation.',
    authors: ['Muhammad Anis Uddin Nasir', 'Ana Pérez', 'Li Wei'],
    categories: ['cs.DC', 'cs.DB'],
    doi: null,
    journalRef: null,
    comments: 'Revised version',
    published: '2016-05-03T14:30:05.000Z',
    updated: '2026-10-19T19:09:32.000Z',
  }]);
});

// arXiv announces a paper within about four days of its v1. A record the set
// lists later is a revision, which brought a paper back to a full lane that had
// trimmed it, dated today and kept two weeks on top of its day-by-day feed.
test('an OAI record of a paper submitted more than a week before is filed with no arrival; a recent one arrives today', async t => {
  // The start of a three-second period the harvest may take.
  const now = Date.UTC(2026, 10, 3, 0, 0, 3);
  t.mock.timers.enable({ apis: ['Date'], now });
  const day = 86_400_000;
  const record = (arxivId: string, title: string, submitted: number) => `<record>
      <header><identifier>oai:arXiv.org:${arxivId}</identifier><datestamp>2026-11-02</datestamp><setSpec>cs</setSpec></header>
      <metadata><arXivRaw xmlns="http://arxiv.org/OAI/arXivRaw/">
        <id>${arxivId}</id>
        <version version="v1"><date>${new Date(submitted).toUTCString()}</date></version>
        <version version="v2"><date>${new Date(now - day).toUTCString()}</date></version>
        <title>${title}</title><authors>Ana Pérez</authors><categories>cs.LG</categories>
        <abstract>We study ${title.toLowerCase()} in depth.</abstract>
      </arXivRaw></metadata>
    </record>`;
  const revised = record('2609.01234', 'Gradient noise in wide networks', now - 50 * day);
  const fresh = record('2611.00001', 'Sparse mixtures of experts', now - 2 * day);
  t.mock.method(globalThis, 'fetch', async () => new Response(`<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>${revised}${fresh}</ListRecords></OAI-PMH>`));
  const { binding, db } = testD1();
  const env = { PAPER_STORE: binding } as Parameters<typeof harvestArxivPage>[0];
  const evictAll = async () => {
    let after: number | null = 0;
    while (after !== null) after = await evictExpired(env, now, after);
  };
  const inLane = (arxivId: string) => db.prepare(`SELECT l.arrived FROM work_lanes l JOIN work_keys k ON k.work_id = l.work_id
    WHERE l.lane = 'cs.LG' AND k.key = 'arxiv:${arxivId}'`).all().map(row => (row as { arrived: string | null }).arrived);
  // The revised paper, filed when it was announced, then trimmed from a full lane.
  await ingestPapers(env, [{ paper: arxivRecordPaper(parseOaiPage(`<OAI-PMH><ListRecords>${revised}</ListRecords></OAI-PMH>`).papers[0]), lanes: [] }], { now: now - 49 * day });
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let id = 1; id <= FEED_CANDIDATE_LIMIT; id += 1) {
    const published = new Date(now - id * 10_000).toISOString();
    insertWork.run(1_000_000 + id, JSON.stringify({ id: `2611.${String(id).padStart(5, '0')}`, title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertLane.run('cs.LG', 1_000_000 + id, published);
  }
  db.exec('COMMIT');
  await evictAll();
  assert.deepEqual(inLane('2609.01234'), [], 'trimmed from the full lane');

  assert.equal((await harvestArxivPage(env, { set: 'cs', from: '2026-11-02' })).listed, 2);
  assert.deepEqual(inLane('2609.01234'), [null], 'the revision is no arrival');
  assert.deepEqual(inLane('2611.00001'), [new Date(now).toISOString()], 'a paper announced on time arrives today');
  const daily = await readFeedPage(env, parseFeedRequest({ categories: ['cs.LG'], order: 'daily', pageSize: 2 }), { now });
  assert.equal(daily.some(paper => paper.id === '2609.01234'), false, "the revision is not on top of the lane's day-by-day feed");
  await evictAll();
  assert.deepEqual(inLane('2609.01234'), [], 'the lane trims it again');
});

test('a page past the last record is empty rather than an error', () => {
  const xml = '<OAI-PMH><error code="noRecordsMatch">No records</error></OAI-PMH>';
  assert.deepEqual(parseOaiPage(xml), { papers: [], resumptionToken: '' });
});

test('nested affiliations do not become authors', () => {
  assert.deepEqual(splitRawAuthors('A. Smith (Univ. X (Dept. Y)), B. Jones and C. Lee'), ['A. Smith', 'B. Jones', 'C. Lee']);
});

// On the #272 review, 27 of 66 live arXiv abstracts kept `&#NN;` references,
// and authors read `Gon\c{c}alves`: arXivRaw writes names in TeX. A synthetic
// record in those forms.
test('an OAI record reads its character references and TeX author names, and keeps its formulas as written', () => {
  const xml = `<OAI-PMH><ListRecords><record><header><identifier>oai:arXiv.org:2610.33333</identifier></header><metadata><arXivRaw>
    <id>2610.33333</id>
    <version version="v1"><date>Mon, 19 Oct 2026 19:09:32 GMT</date></version>
    <title>Bounds on $\\langle x^{2} \\rangle$ for O&#39;Neil&#39;s &quot;sparse&quot; model</title>
    <authors>Jo&#227;o Gon\\c{c}alves (Universidade de S&#227;o Paulo), {\\"O}zg\\"{u}r Erd\\H{o}s, \\L{}ukasz Bj{\\o}rnsson, Pawe\\l Kowalski, Jos\\'e Garc\\'{\\i}a, \\v{S}t\\v{e}p\\'an Ko\\v{s}ak and R. M\\"uller for the $\\mathcal{N}=4$ team</authors>
    <categories>math.PR</categories>
    <abstract>We show $a &lt; b$ when $\\mathrm{d}x &gt; 0$ &#8212; for all &#34;large&#34; $n$.</abstract>
  </arXivRaw></metadata></record></ListRecords></OAI-PMH>`;
  const [paper] = parseOaiPage(xml).papers;
  assert.equal(paper.title, 'Bounds on $\\langle x^{2} \\rangle$ for O\'Neil\'s "sparse" model');
  assert.equal(paper.abstract, 'We show $a < b$ when $\\mathrm{d}x > 0$ — for all "large" $n$.');
  assert.deepEqual(paper.authors, ['João Gonçalves', 'Özgür Erdős', 'Łukasz Bjørnsson', 'Paweł Kowalski', 'José García', 'Štěpán Košak', 'R. Müller for the $\\mathcal{N}=4$ team']);
});

// Vietnamese names put two accents on one letter, and the outer one stayed as
// a command ("Nguy\~ên"). Dropping every brace glued a command the converter
// does not know to its text ("\textitet al.").
test('stacked TeX accents make one letter, and a TeX command the converter does not know stays as written', () => {
  assert.deepEqual(
    splitRawAuthors('Nguy\\~{\\^e}n V\\u{a}n Th\\`{\\^a}n, Ph\\d{a}m Th\\d{\\^e} and A. Smith \\textit{et al.}'),
    ['Nguyễn Văn Thần', 'Phạm Thệ', 'A. Smith \\textit{et al.}'],
  );
  assert.deepEqual(splitRawAuthors('B. Jones {\\it et al}'), ['B. Jones {\\it et al}']);
});


// Trimmed from efetch for PMID 42775314 (2026-09-24), as in pubmed-efetch.test.ts:
// a structured abstract beside a translation, MeSH terms and an author.
const EFETCH = `<?xml version="1.0" ?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM">
    <PMID Version="1">42775314</PMID>
    <Article PubModel="Print">
      <ArticleTitle>H-FABP in heart failure.</ArticleTitle>
      <Abstract>
        <AbstractText Label="BACKGROUND" NlmCategory="UNASSIGNED">Heart failure is common.</AbstractText>
        <AbstractText Label="METHODS" NlmCategory="UNASSIGNED">We measured H-FABP in <i>serum</i>.</AbstractText>
        <AbstractText Label="RESULTS" NlmCategory="UNASSIGNED">Levels were higher (P &lt; 0.05).</AbstractText>
      </Abstract>
      <AuthorList><Author><LastName>Pérez</LastName><ForeName>Ana</ForeName><Initials>A</Initials>
        <Identifier Source="ORCID">0000-0002-1825-0097</Identifier>
        <AffiliationInfo><Affiliation>University of Valencia.</Affiliation></AffiliationInfo></Author></AuthorList>
    </Article>
    <OtherAbstract Type="Publisher" Language="srp">
      <AbstractText Label="UVOD" NlmCategory="UNASSIGNED">Cilj je bio da se analizira zna&#x10d;aj H-FABP.</AbstractText>
    </OtherAbstract>
    <MeshHeadingList>
      <MeshHeading><DescriptorName UI="D006333" MajorTopicYN="Y">Heart Failure</DescriptorName></MeshHeading>
    </MeshHeadingList>
  </MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>`;

test('the Worker reads PubMed efetch XML as the browser does', () => {
  const inWorker = readPubmedEfetch(parseXmlDocument(EFETCH));
  assert.deepEqual(inWorker, readPubmedEfetch(parseWithShim(EFETCH)));
  assert.equal(inWorker['pmid:42775314'].abstract, 'BACKGROUND: Heart failure is common. METHODS: We measured H-FABP in serum. RESULTS: Levels were higher (P < 0.05).');
});

// ─── OpenAlex lanes, through the Worker's relay with the provider stubbed ───

// Works as OpenAlex returned them on 2026-10-19 (trimmed): a San Francisco Fed
// working paper filed as a journal article, a CESifo working paper typed
// `report`, here without its abstract, and the one CESifo work typed `article`
// in a journal, W7144132107.
const invertedIndex = (text: string) => {
  const index: Record<string, number[]> = {};
  text.split(' ').forEach((word, position) => { (index[word] ||= []).push(position); });
  return index;
};
const seriesWork = (id: string, doi: string, type: string, source: { id: string; display_name: string }, abstract: string | null) => ({
  id: `https://openalex.org/${id}`,
  doi: `https://doi.org/${doi}`,
  title: `Working paper ${id}`,
  type,
  publication_date: '2026-10-14',
  publication_year: 2026,
  authorships: [{ author: { id: `https://openalex.org/A${id.slice(1)}`, display_name: `Author ${id}` }, institutions: [] }],
  abstract_inverted_index: abstract ? invertedIndex(abstract) : null,
  primary_location: {
    landing_page_url: `https://doi.org/${doi}`,
    is_published: true,
    version: 'publishedVersion',
    source: { id: `https://openalex.org/${source.id}`, display_name: source.display_name, type: 'journal' },
  },
  locations: [],
  open_access: { is_oa: true, oa_url: null },
  cited_by_count: 0,
});
const FRBSF = { id: 'S4306510381', display_name: 'Federal Reserve Bank of San Francisco, Working Paper Series' };
const CESIFO = { id: 'S7407053623', display_name: 'CESifo' };
const NBER = { id: 'S2809516038', display_name: 'National Bureau of Economic Research' };
// OpenAlex's primary topic for this NBER paper, as saved on 2026-10-19.
const TYLENOL_TOPIC = {
  id: 'https://openalex.org/T11633',
  display_name: 'Prenatal Substance Exposure Effects',
  subfield: { id: 'https://openalex.org/subfields/2735', display_name: 'Pediatrics, Perinatology and Child Health' },
  field: { id: 'https://openalex.org/fields/27', display_name: 'Medicine' },
  domain: { id: 'https://openalex.org/domains/4', display_name: 'Health Sciences' },
};

// OpenAlex W7222916812 as returned on 2026-10-21 (trimmed): a Genetics article
// whose primary topic, RNA Research and Splicing, is one of bio.mol's.
const splicingWork = {
  ...seriesWork('W7222916812', '10.1093/genetics/iyag290', 'article', { id: 'S65932378', display_name: 'Genetics' },
    'Pathogenic variants in SNRPB, a common core spliceosomal factor, cause Cerebrocostomandibular Syndrome (CCMS).'),
  title: 'A Novel CCMS Model Reveals a Critical Intronic Sequence in the Snrpb Gene that is Required for Normal Development',
  publication_date: '2026-10-20',
  primary_topic: {
    id: 'https://openalex.org/T10604',
    display_name: 'RNA Research and Splicing',
    subfield: { id: 'https://openalex.org/subfields/1312', display_name: 'Molecular Biology' },
    field: { id: 'https://openalex.org/fields/13', display_name: 'Biochemistry, Genetics and Molecular Biology' },
    domain: { id: 'https://openalex.org/domains/1', display_name: 'Life Sciences' },
  },
};


function relay(t: import('node:test').TestContext, answer: (url: URL) => unknown) {
  const urls: URL[] = [];
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    urls.push(url);
    const body = answer(url);
    return body instanceof Response ? body : Response.json(body);
  });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  const env = { REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, OPENALEX_API_KEY: 'test-key' } as unknown as WorkerEnv;
  return { urls, env };
}
const filtersOf = (url: URL) => url.searchParams.get('filter')!.split(',');

test('an Atom error entry leaves the arXiv corpus lane unharvested', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 3, 0, 0, 3) });
  const xml = readFileSync(new URL('./test-support/arxiv-error.xml', import.meta.url), 'utf8');
  const { urls, env } = relay(t, () => new Response(xml));
  const { db, binding } = testD1();
  const job = { source: 'arxiv-search', lane: 'author-name:Example' } as const;
  await assert.rejects(harvestLane({ ...env, PAPER_STORE: binding }, job), /arXiv API error/);
  assert.deepEqual(db.prepare('SELECT harvested_through FROM lane_state WHERE source = ? AND lane = ?').all(job.source, job.lane), []);
  assert.equal(urls.length, 1);
});
// What a keyword lane's request searches titles and abstracts for.
const keywordSearchOf = (url: URL) => filtersOf(url).find(filter => filter.startsWith('title_and_abstract.search:'));

test('the working-paper series lane asks OpenAlex for the series in the window and files unreviewed Economics cards', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  const { urls, env } = relay(t, () => ({ results: [
    seriesWork('W7221947410', '10.24148/wp2026-23', 'article', FRBSF, 'These findings help inform debates surrounding how unauthorized immigration impacts labor and housing markets and public finances in the U.S.'),
    seriesWork('W7222541626', '10.65864/jochq5qfxv', 'report', CESIFO, null),
    { ...seriesWork('W7220380262', '10.3386/w35873', 'report', NBER, null), primary_topic: TYLENOL_TOPIC },
  ] }));
  const { items } = await SOURCES['openalex-series'].fetchPage(env, { lane: 'series:working-papers', page: 2, since: '', waits: { seconds: 0 } });
  const [url] = urls;
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.openalex.org/works');
  const filters = filtersOf(url);
  assert.deepEqual(filters.find(filter => filter.startsWith('primary_location.source.id:'))!.split(':')[1].split('|'), WORKING_PAPER_SERIES_IDS);
  assert.ok(filters.includes('type:article|report'));
  assert.ok(filters.includes('from_publication_date:2026-07-23') && filters.includes('to_publication_date:2026-10-21'));
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc');
  assert.deepEqual(items.map(item => item.lanes), [['series:working-papers'], ['series:working-papers'], ['series:working-papers']]);
  for (const { paper } of items) {
    // What shows the Working paper tag (paper-status.ts).
    assert.equal(paper.workingPaper, true, paper.id);
    assert.equal(paper.peerReviewed, false, paper.id);
    // The series make every card economics, the NBER paper OpenAlex files under
    // Medicine included, and name no subcategory.
    assert.equal(areaLabelForPaper(paper), 'Economics', paper.id);
    assert.deepEqual([paper.primaryCategory, ...(paper.categories || [])].filter(category => getCategoryArea(category!)), []);
  }
});

test('a work whose DOI no link can carry leaves the rest of its page to the lane', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  // Synthetic: the middle work has no landing page of its own and a lone
  // surrogate in its DOI, which no URL can encode.
  const { env } = relay(t, () => ({ results: [
    seriesWork('W7221947410', '10.24148/wp2026-23', 'article', FRBSF, null),
    { ...seriesWork('W7222541626', '10.65864/jochq5qfxv\uD800', 'report', CESIFO, null), primary_location: { is_published: true, source: { id: `https://openalex.org/${CESIFO.id}`, display_name: CESIFO.display_name, type: 'journal' } } },
    seriesWork('W7220380262', '10.3386/w35873', 'report', NBER, null),
  ] }));
  const { items } = await SOURCES['openalex-series'].fetchPage(env, { lane: 'series:working-papers', page: 1, since: '', waits: { seconds: 0 } });
  assert.deepEqual(items.map(({ paper }) => paper.id), ['openalex:W7221947410', 'openalex:W7222541626', 'openalex:W7220380262']);
  // It keeps the link OpenAlex gave, as before.
  assert.equal(items[1].paper.landingPageUrl, 'https://doi.org/10.65864/jochq5qfxv\uD800');
});

test("every series the lane names is on the review rule's list, so its journal articles carry the Working paper tag", () => {
  for (const id of WORKING_PAPER_SERIES_IDS) {
    // An `article` in a `journal` source: only the rule's list tells it apart.
    const card = mapOpenAlexWork(seriesWork('W1', '10.1/w1', 'article', { id, display_name: 'A series' }, null));
    assert.equal(card?.workingPaper, true, `${id} is on the review rule's list`);
  }
});

test("a category's OpenAlex lane asks by its measured topic IDs, not by text, and keeps OpenAlex's own classification", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  const { urls, env } = relay(t, () => ({ results: [splicingWork] }));
  const { items } = await SOURCES['openalex-topics'].fetchPage(env, { lane: 'bio.mol', page: 1, since: '', waits: { seconds: 0 } });
  const filters = filtersOf(urls[0]);
  assert.equal(urls[0].searchParams.has('search'), false);
  const topics = filters.find(filter => filter.startsWith('primary_topic.id:'))!.slice('primary_topic.id:'.length).split('|');
  assert.ok(topics.length > 0 && topics.every(id => leavesForOpenAlexTopic(id).join() === 'bio.mol'));
  for (const filter of ['type:article', 'is_retracted:false', 'primary_location.source.is_core:true', 'to_publication_date:2026-10-21']) {
    assert.ok(filters.includes(filter), filter);
  }
  assert.equal(filters.some(filter => filter.startsWith('has_abstract')), false, 'an article without an abstract is listed too');
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W7222916812', ['bio.mol']]]);
  assert.equal(items[0].paper.primaryCategory, undefined, 'filed under the lane, not given it as its field');

  // Aerospace conference papers were 19 of 20 relevant in the gate; structural ones 0 of 2.
  await SOURCES['openalex-topics'].fetchPage(env, { lane: 'mech.aero', page: 1, since: '', waits: { seconds: 0 } });
  assert.ok(filtersOf(urls[1]).includes('type:article|conference-paper'));
});

test("a topic lane's article without an abstract is filed saying it has none, and embedded by its title", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  const { env } = relay(t, () => ({ results: [{ ...splicingWork, abstract_inverted_index: null }] }));
  const { items } = await SOURCES['openalex-topics'].fetchPage(env, { lane: 'bio.mol', page: 1, since: '', waits: { seconds: 0 } });
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W7222916812', ['bio.mol']]]);
  const [{ paper }] = items;
  assert.equal(paper.abstract, 'No abstract available.');
  assert.equal(hasUsableAIAbstract(paper.abstract), false, 'its abstract stays unknown');

  const { binding, db } = testD1();
  const embedded: string[] = [];
  const AI = { run: async (_model: string, { text }: { text: string[] }) => {
    embedded.push(...text);
    return { data: text.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))) };
  } };
  const store = { ...env, PAPER_STORE: binding, AI } as Parameters<typeof embedPending>[0];
  await ingestPapers(store, items);
  assert.equal(await embedPending(store, 10), 1);
  assert.deepEqual(embedded, [splicingWork.title]);
  const filed = db.prepare("SELECT work_id FROM work_lanes WHERE lane = 'bio.mol'").all();
  assert.equal(filed.length, 1);
  assert.deepEqual(db.prepare('SELECT work_id FROM work_vectors').all(), filed, 'the filed article has a vector');
});

// ─── Which leaves get an OpenAlex topic lane: the precision gate's decisions ───

const gateFile = (name: string) => JSON.parse(readFileSync(new URL(`../scripts/data/${name}`, import.meta.url), 'utf8'));
const topicLanes = () => categoryLaneJobs().filter(job => job.source === 'openalex-topics').map(job => job.lane);
// The leaves with a notable lane: those with a topic lane and those the topic
// or journal notable sample admitted.
const notableLeaves = () => [...topicLanes(), ...Object.keys(OPENALEX_NOTABLE_LEAF_TOPICS), ...OPENALEX_NOTABLE_VENUE_LEAVES].sort();
const topicsOf = (filters: string[]) => filters.find(filter => filter.startsWith('primary_topic.id:'))!.slice('primary_topic.id:'.length).split('|');

// OpenAlex W7223183626 as returned to the gate's q-fin.GN sample on 2026-10-23
// (trimmed, abstract shortened): a subscription journal article.
const subscriptionArticle = {
  id: 'https://openalex.org/W7223183626',
  doi: 'https://doi.org/10.33423/0t4j8j85',
  title: 'The Performance of Passively Managed Index Portfolios Versus Complementary Non-Index Portfolios: Evidence from the H-Share Market',
  type: 'article',
  publication_date: '2026-10-22',
  publication_year: 2026,
  abstract_inverted_index: invertedIndex('This paper investigates the performance of the Hang Seng China Enterprises Index.'),
  primary_location: {
    is_oa: false,
    landing_page_url: 'https://doi.org/10.33423/0t4j8j85',
    version: 'publishedVersion',
    source: { id: 'https://openalex.org/S4210192355', display_name: 'Journal of Applied Business and Economics', type: 'journal', is_core: true },
  },
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  primary_topic: {
    id: 'https://openalex.org/T10047',
    display_name: 'Financial Markets and Investment Strategies',
    subfield: { id: 'https://openalex.org/subfields/2003', display_name: 'Finance' },
    field: { id: 'https://openalex.org/fields/20', display_name: 'Economics, Econometrics and Finance' },
    domain: { id: 'https://openalex.org/domains/2', display_name: 'Social Sciences' },
  },
};

test('an arXiv leaf the precision gate admitted gets a journal-article lane for the sampled topics found on target', async t => {
  const reviews = gateFile('openalex-topic-reviews.json');
  const { urls, env } = relay(t, url => ({ results: topicsOf(filtersOf(url)).includes('T10047') ? [subscriptionArticle] : [] }));
  // Sorted, as sampled, without the topics no sampled article was on target
  // for: q-fin.GN's green bonds T13146 (0 of 5) and four it never returned,
  // cs.SE's T10456 (0 of 1) and six it never returned, cond-mat.stat-mech's
  // T12261 (0 of 2) and one it never returned, and two cs.CV never returned.
  const asked = {
    'q-fin.GN': ['T10047', 'T10127'],
    'cs.CV': ['T10036'],
    'cs.SE': ['T10260', 'T10430', 'T10743'],
    'cond-mat.stat-mech': ['T11520'],
  };
  for (const [leaf, topics] of Object.entries(asked)) {
    assert.ok(topicLanes().includes(leaf), `${leaf} has a lane in the nightly harvest`);
    await SOURCES['openalex-topics'].fetchPage(env, { lane: leaf, page: 1, since: '', waits: { seconds: 0 } });
    const filters = filtersOf(urls.at(-1)!);
    const sampled = new URL(reviews[leaf].query).searchParams.get('filter')!.split(',');
    assert.deepEqual(topicsOf(filters), topics, leaf);
    assert.ok(topics.every(id => topicsOf(sampled).includes(id)), `${leaf} asks only for topics its sample asked for`);
    for (const filter of ['type:article', 'is_retracted:false', 'primary_location.source.is_core:true']) {
      assert.ok(filters.includes(filter) && sampled.includes(filter), `${leaf}: ${filter}`);
    }
    // Labelling the sample needed abstracts; the lane takes articles without one.
    assert.ok(sampled.includes('has_abstract:true'), leaf);
    assert.equal(filters.some(filter => filter.startsWith('has_abstract')), false, leaf);
  }
  const { items } = await SOURCES['openalex-topics'].fetchPage(env, { lane: 'q-fin.GN', page: 1, since: '', waits: { seconds: 0 } });
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W7223183626', ['q-fin.GN']]]);
  assert.equal(items[0].paper.publicationType, 'article');
  assert.equal(items[0].paper.sourceType, 'journal');
  assert.equal(items[0].paper.openAccess, false, 'the explicit subscription access is kept');
});

test('a leaf the gate did not admit sends no topic request, and every lane is an inherited or admitted leaf', () => {
  const coverage = gateFile('openalex-leaf-topics-coverage.json') as Array<{ leaf: string; status: string; sampleSize?: number }>;
  const statusOf = (leaf: string) => coverage.find(row => row.leaf === leaf)!;
  // Too few on target in a full sample, or too few recent core articles to judge.
  // physics.plasm-ph had 13 of 15 on target, 6 of them calls its labeller doubted.
  // The seven last: 10 or 11 of 15 on target without recorded doubt, then 3 to 9
  // in a blind relabel that recorded it.
  const relabelled = ['astro-ph.SR', 'cs.LG', 'cs.SY', 'math.GT', 'eess.SY', 'civil.mat', 'med.tox'].map(leaf => [leaf, 'rejected']);
  for (const [leaf, status] of [['cs.AI', 'rejected'], ['econ.EM', 'rejected'], ['physics.plasm-ph', 'rejected'], ['chemeng.metal', 'insufficient-sample'], ['math.OC', 'insufficient-sample'], ...relabelled]) {
    assert.equal(statusOf(leaf).status, status, leaf);
    assert.equal(typeof statusOf(leaf).sampleSize, 'number', `${leaf} records its sample`);
    assert.equal(openAlexTopicFilterForLeaf(leaf), null, leaf);
    assert.ok(!topicLanes().includes(leaf), leaf);
  }
  assert.deepEqual(topicLanes().sort(), coverage.filter(row => row.status === 'inherited' || row.status === 'passed').map(row => row.leaf).sort());
});

test('the 14 inherited leaves keep their lanes and the topics accepted in #236', async t => {
  const inherited = [
    'bio.biochem', 'bio.cell', 'bio.comp', 'bio.eco', 'bio.gen', 'bio.mol', 'bio.neuro',
    'bio.physio', 'civil.env', 'civil.hydro', 'civil.struct', 'mech.aero', 'med.neuro', 'med.psych',
  ];
  const { urls, env } = relay(t, () => ({ results: [] }));
  const asked: Array<[string, string[]]> = [];
  for (const leaf of inherited) {
    assert.ok(topicLanes().includes(leaf), leaf);
    await SOURCES['openalex-topics'].fetchPage(env, { lane: leaf, page: 1, since: '', waits: { seconds: 0 } });
    asked.push([leaf, topicsOf(filtersOf(urls.at(-1)!))]);
  }
  assert.deepEqual(asked.find(([leaf]) => leaf === 'bio.mol')![1],
    ['T10123', 'T10268', 'T10521', 'T10604', 'T10878', 'T11041', 'T11237', 'T11482', 'T11765', 'T12534']);
  // The 14 lists as merged in #236 (area-accent.ts on main before PAP-99), each
  // sorted: an edit to the baseline file cannot also move this expectation.
  assert.equal(createHash('sha256').update(JSON.stringify(asked)).digest('hex'),
    'd712fc6dd9b51123876e8bbf61022a0172cde893fa03bb7aa394bfa16cd14d5f');
});

// ─── Journal articles of a whole area (PAP-107) ───

// OpenAlex W7223244690 as returned on 2026-10-23 to the physics area's newest
// articles (trimmed, abstract shortened): a closed article with no free copy.
const closedPhysicsArticle = {
  id: 'https://openalex.org/W7223244690',
  doi: 'https://doi.org/10.7566/jpsj.95.111002',
  title: 'High-harmonic Generation Spectroscopy in van der Waals Materials: Accessing Bloch Wavefunctions and Their Scattering Processes',
  type: 'article',
  publication_date: '2026-10-23',
  publication_year: 2026,
  authorships: [{ author: { id: 'https://openalex.org/A5102845839', display_name: 'Kento Uchida' }, institutions: [{ id: 'https://openalex.org/I22299242', display_name: 'Kyoto University' }] }],
  abstract_inverted_index: invertedIndex('High-harmonic generation (HHG) has emerged as a promising tool for probing femtosecond-to-attosecond electron dynamics in crystalline solids.'),
  primary_location: {
    is_oa: false,
    landing_page_url: 'https://doi.org/10.7566/jpsj.95.111002',
    version: 'publishedVersion',
    is_published: true,
    source: { id: 'https://openalex.org/S119212824', display_name: 'Journal of the Physical Society of Japan', type: 'journal', is_core: true },
  },
  locations: [],
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  cited_by_count: 0,
  primary_topic: {
    id: 'https://openalex.org/T10566',
    display_name: 'Laser-Matter Interactions and Applications',
    subfield: { id: 'https://openalex.org/subfields/3107', display_name: 'Atomic and Molecular Physics, and Optics' },
    field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' },
    domain: { id: 'https://openalex.org/domains/3', display_name: 'Physical Sciences' },
  },
};

test("an area's journal lane asks OpenAlex for the core journal articles labelled as that area, with or without an abstract, and files them under the area, paywall and review as recorded", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  // The same article as OpenAlex lists one whose abstract it does not hold.
  const withoutAbstract = { ...closedPhysicsArticle, id: 'https://openalex.org/W7223244691', doi: 'https://doi.org/10.7566/jpsj.95.111003', abstract_inverted_index: null };
  const { urls, env } = relay(t, () => ({ results: [closedPhysicsArticle, withoutAbstract] }));
  const { items } = await SOURCES['openalex-areas'].fetchPage(env, { lane: 'area:physics', page: 1, since: '', waits: { seconds: 0 } });
  const [url] = urls;
  for (const filter of ['primary_topic.field.id:31', 'type:article', 'is_retracted:false', 'primary_location.source.is_core:true', 'from_publication_date:2026-07-25', 'to_publication_date:2026-10-23']) {
    assert.ok(filtersOf(url).includes(filter), filter);
  }
  assert.equal(filtersOf(url).some(filter => filter.startsWith('has_abstract')), false, 'an article without an abstract is listed too');
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc');
  assert.equal(url.searchParams.has('search'), false);
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W7223244690', ['area:physics']], ['openalex:W7223244691', ['area:physics']]]);
  assert.equal(hasUsableAIAbstract(items[1].paper.abstract), false, 'its abstract stays unknown');
  const [{ paper }] = items;
  // What the card's access chip reads (paper-status.ts): an explicit `false`,
  // and no arXiv copy or PDF to call it open.
  assert.deepEqual([paper.openAccess, paper.arxivId, paper.pdfUrl], [false, undefined, null]);
  assert.equal(paper.peerReviewed, true, 'a journal article, by the review rule');
  assert.equal(paper.workingPaper, undefined);
  assert.equal(areaLabelForPaper(paper), 'Physics');
  assert.deepEqual([paper.primaryCategory, ...(paper.categories || [])].filter(category => getCategoryArea(category!)), [], 'no leaf is claimed for it');

  // Engineering is read as electrical engineering unless a subfield names
  // mechanical or civil work, Economics as economics unless it is finance, and
  // Computer Science as such unless it is AI or computer vision:
  // each lane asks for what its label reads, and no paper twice. Electrical
  // engineering's lane also leaves out Biomedical Engineering (2204), 60 of its
  // 200 newest on 2026-10-23: sensor materials, biomass conversion, tissue
  // scaffolds and cancer nanomedicine among them.
  const areaFilters = async (lane: string) => {
    await SOURCES['openalex-areas'].fetchPage(env, { lane, page: 1, since: '', waits: { seconds: 0 } });
    return filtersOf(urls.at(-1)!).filter(filter => filter.startsWith('primary_topic.')).sort();
  };
  assert.deepEqual(await areaFilters('area:eess'), [
    'primary_topic.field.id:22',
    ...['2202', '2203', '2204', '2205', '2206', '2210', '2211', '2212', '2215'].map(id => `primary_topic.subfield.id:!${id}`),
  ]);
  assert.deepEqual(await areaFilters('area:mech'), ['primary_topic.subfield.id:2202|2203|2206|2210|2211']);
  assert.deepEqual(await areaFilters('area:econ'), ['primary_topic.field.id:20', 'primary_topic.subfield.id:!2003']);
  assert.deepEqual(await areaFilters('area:q-fin'), ['primary_topic.subfield.id:2003']);
  assert.deepEqual(await areaFilters('area:cs'), ['primary_topic.field.id:17', 'primary_topic.subfield.id:!1702', 'primary_topic.subfield.id:!1707']);
  assert.deepEqual(await areaFilters('area:ai'), ['primary_topic.subfield.id:1702|1707']);
});

test("an area's journal lane leaves out the working-paper series OpenAlex lists as core journal articles, whose cards say Working paper", async t => {
  // The listed series that held such articles in economics' and finance's
  // 90 days to 2026-10-24: 64 of economics' 8,538 and 31 of finance's.
  const series = [
    { id: 'S4210171147', display_name: 'IMF Working Papers' },
    { id: 'S4210225578', display_name: 'FEDS Notes' },
    { id: 'S4210212089', display_name: 'Finance and Economics Discussion Series' },
    FRBSF,
    { id: 'S4210173933', display_name: 'Federal Reserve Bank of Kansas City, Research Working Papers' },
  ];
  const { urls, env } = relay(t, () => ({ results: [] }));
  for (const lane of ['area:econ', 'area:q-fin', 'area:physics']) {
    await SOURCES['openalex-areas'].fetchPage(env, { lane, page: 1, since: '', waits: { seconds: 0 } });
    const filters = filtersOf(urls.at(-1)!);
    for (const source of series) {
      assert.equal(mapOpenAlexWork(seriesWork('W1', '10.1/w1', 'article', source, null))?.workingPaper, true, `an article of ${source.display_name} is a working paper`);
      assert.ok(filters.includes(`primary_location.source.id:!${source.id}`), `${lane} leaves out ${source.display_name}`);
    }
  }
});

// Statistics' label covers OpenAlex's Decision Sciences: of its 200 newest
// articles on 2026-10-23, 107 were operations research and 40 information
// systems, all labelled Statistics.
test('the areas the feed fills from arXiv and chemistry get a journal lane, but statistics; medicine and biology, whose every leaf PubMed serves, do not', () => {
  const lanes = categoryLaneJobs().filter(job => job.source === 'openalex-areas').map(job => job.lane).sort();
  assert.deepEqual(lanes, ['area:ai', 'area:chem', 'area:chemeng', 'area:civil', 'area:cs', 'area:econ', 'area:eess', 'area:math', 'area:mech', 'area:physics', 'area:q-fin']);
});

// The cost of the lanes: one list call an area a night, two on a lane's first run.
test("an area's journal lane asks one page of 200 a night, and two on its first run", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const page = (number: number) => Array.from({ length: 200 }, (_, index) => ({
    ...closedPhysicsArticle, id: `https://openalex.org/W${number}${String(index).padStart(3, '0')}`, doi: `https://doi.org/10.1/${number}.${index}`, title: `Journal article ${number}-${index} on high-harmonic spectroscopy`,
  }));
  const { urls, env } = relay(t, url => ({ results: page(Number(url.searchParams.get('page'))) }));
  const { binding } = testD1();
  await harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-areas', lane: 'area:physics' });
  assert.deepEqual(urls.map(url => [url.searchParams.get('page'), url.searchParams.get('per-page')]), [['1', '200'], ['2', '200']]);
  await harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-areas', lane: 'area:physics' });
  assert.equal(urls.length, 3, 'a later run reads the newest page only');
});

test("a lane's first harvest files its papers with no arrival; a paper a later harvest brings arrives at that run", async t => {
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const article = (id: string) => ({ ...closedPhysicsArticle, id: `https://openalex.org/W${id}`, doi: `https://doi.org/10.1/${id}`, title: `Journal article ${id} on high-harmonic spectroscopy` });
  let listed = [article('7000001'), article('7000002')];
  const { env } = relay(t, () => ({ results: listed }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  const arrivals = () => (db.prepare("SELECT w.paper ->> '$.id' AS id, l.arrived FROM work_lanes l JOIN works w ON w.id = l.work_id WHERE l.lane = 'area:physics' ORDER BY id").all() as Array<{ id: string; arrived: string | null }>)
    .map(row => [row.id, row.arrived]);
  await harvestLane(store, { source: 'openalex-areas', lane: 'area:physics' });
  assert.deepEqual(arrivals(), [['openalex:W7000001', null], ['openalex:W7000002', null]]);
  const later = first + 86_400_000;
  t.mock.timers.setTime(later);
  listed = [article('7000003'), ...listed];
  await harvestLane(store, { source: 'openalex-areas', lane: 'area:physics' });
  assert.deepEqual(arrivals(), [['openalex:W7000001', null], ['openalex:W7000002', null], ['openalex:W7000003', new Date(later).toISOString()]]);
});

// A followed author's lane lists the author's newest papers every night. One a
// busy category trimmed came back to that category as an arrival of the night:
// kept past the lane's limit and on top of its day-by-day feed every 15 days.
test("a followed author's nightly listing gives a paper a busy category trimmed no arrival there", async t => {
  const day = 86_400_000;
  const tonight = Date.parse('2026-11-01T03:00:00Z');
  const paper = arxivRecordPaper({
    arxivId: '2610.00500', title: 'Sparse attention for long documents', abstract: 'We make attention sparse for long documents and study its cost.',
    authors: ['Ana Pérez'], categories: ['cs.LG'], doi: '10.1000/sparse', journalRef: null, comments: null,
    published: '2026-10-01T12:00:00.000Z', updated: '2026-10-01T12:00:00.000Z',
  });
  const { env } = relay(t, () => ({ results: [{
    id: 'https://openalex.org/W7000000500', doi: 'https://doi.org/10.1000/sparse', title: paper.title, type: 'preprint', publication_date: '2026-10-01', publication_year: 2026,
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Pérez' }, institutions: [] }],
    primary_location: { is_oa: true, landing_page_url: 'https://arxiv.org/abs/2610.00500', version: 'submittedVersion', is_published: false, source: { id: 'https://openalex.org/S4306400194', display_name: 'arXiv', type: 'repository', is_core: false } },
    locations: [], open_access: { is_oa: true, oa_status: 'green', oa_url: 'https://arxiv.org/abs/2610.00500' }, cited_by_count: 0,
  }] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  const evictAll = async (now: number) => {
    let after: number | null = 0;
    while (after !== null) after = await evictExpired(store, now, after);
  };
  const inCategory = () => (db.prepare(`SELECT l.arrived FROM work_lanes l JOIN work_keys k ON k.work_id = l.work_id
    WHERE l.lane = 'cs.LG' AND k.key = 'arxiv:2610.00500'`).all() as Array<{ arrived: string | null }>).map(row => row.arrived);
  // Announced on 10-03; the author's lane had its first load on 10-10.
  await ingestPapers(store, [{ paper, lanes: [] }], { now: Date.parse('2026-10-03T03:00:00Z') });
  db.prepare("INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES ('author:A1', '2026-10-31T00:00:00.000Z', '2026-10-10T03:00:00.000Z')").run();
  await ingestPapers(store, [{ paper, lanes: ['author:A1'] }], { now: Date.parse('2026-10-10T03:00:00Z'), firstLoad: 'author:A1' });
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-follows', 'author:A1', '2026-10-10T03:00:00.000Z')").run();
  // cs.LG fills with newer papers and trims it.
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published, arrived) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let id = 1; id <= FEED_CANDIDATE_LIMIT; id += 1) {
    const published = new Date(Date.parse('2026-10-05T00:00:00Z') + id * 500_000).toISOString();
    insertWork.run(1_000_000 + id, JSON.stringify({ id: `2610.9${String(id).padStart(4, '0')}`, title: `Paper ${id}`, authors: [] }), published, '2027-03-01T00:00:00.000Z');
    insertLane.run('cs.LG', 1_000_000 + id, published, new Date(Date.parse(published) + 2 * day).toISOString());
  }
  db.exec('COMMIT');
  await evictAll(Date.parse('2026-10-31T03:00:00Z'));
  assert.deepEqual(inCategory(), [], 'trimmed from the full lane');

  t.mock.timers.enable({ apis: ['Date'], now: tonight });
  await harvestLane(store, { source: 'openalex-follows', lane: 'author:A1' });
  assert.deepEqual(inCategory(), [null], 'filed again with no arrival');
  await evictAll(tonight);
  assert.deepEqual(inCategory(), [], 'and trimmed again');
  const first = await readFeedPage(store, parseFeedRequest({ categories: ['cs.LG'], exact: true, order: 'daily', pageSize: 1 }), { now: tonight });
  assert.deepEqual(first.map(item => item.id), [`2610.9${String(FEED_CANDIDATE_LIMIT).padStart(4, '0')}`], 'the newest arrival heads the day');
});

// ─── ChemRxiv's Chemistry preprints ───

// As OpenAlex returned it on 2026-10-27 (trimmed, its abstract shortened): one
// of the 89 ChemRxiv Chemistry preprints of the 90 days before that it calls
// closed.
const chemRxivLocation = {
  is_oa: false,
  landing_page_url: 'https://doi.org/10.26434/chemrxiv.15010999/v1',
  pdf_url: null,
  version: 'acceptedVersion',
  is_published: false,
  source: { id: 'https://openalex.org/S4393918830', display_name: 'ChemRxiv', type: 'repository', is_core: false },
};
const chemRxivPreprint = {
  id: 'https://openalex.org/W7223561333',
  doi: 'https://doi.org/10.26434/chemrxiv.15010999/v1',
  title: 'Computational Interactions between the Endohedral Metallofullerene Gd@C60 and Human Toll-Like Receptor 3: A Molecular Docking and Molecular Dynamics Study',
  type: 'preprint',
  publication_date: '2026-10-25',
  publication_year: 2026,
  authorships: [{ author: { id: 'https://openalex.org/A5052942510', display_name: 'Satyavani Kaliamurthi' }, institutions: [] }],
  abstract_inverted_index: invertedIndex('Endohedral metallofullerenes (EMFs), such as the gadolinium fullerene Gd@C60, are being explored as kinetically stable alternatives to gadolinium chelate contrast agents.'),
  primary_location: chemRxivLocation,
  locations: [chemRxivLocation],
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  cited_by_count: 0,
  is_retracted: false,
  primary_topic: {
    id: 'https://openalex.org/T10956',
    display_name: 'Fullerene Chemistry and Applications',
    subfield: { id: 'https://openalex.org/subfields/1605', display_name: 'Organic Chemistry' },
    field: { id: 'https://openalex.org/fields/16', display_name: 'Chemistry' },
    domain: { id: 'https://openalex.org/domains/3', display_name: 'Physical Sciences' },
  },
};

test("chemistry's lane also lists ChemRxiv's newest Chemistry preprints, filed under the area as preprints", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T03:00:00Z') });
  const { urls, env } = relay(t, () => ({ results: [chemRxivPreprint] }));
  const { items } = await SOURCES['openalex-chemrxiv'].fetchPage(env, { lane: 'area:chem', page: 1, since: '', waits: { seconds: 0 } });
  const [url] = urls;
  for (const filter of ['primary_location.source.id:S4393918830', 'primary_topic.field.id:16', 'type:preprint', 'is_retracted:false', 'from_publication_date:2026-07-29', 'to_publication_date:2026-10-27']) {
    assert.ok(filtersOf(url).includes(filter), filter);
  }
  assert.equal(filtersOf(url).some(filter => filter.startsWith('primary_location.source.is_core')), false, 'a preprint server is not a core source');
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc');
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W7223561333', ['area:chem']]]);
  const [{ paper }] = items;
  // OpenAlex's answer on access is stored as it came; the card reads the
  // ChemRxiv DOI as open (paper-status.ts).
  assert.deepEqual([paper.doi, paper.openAccess, paper.pdfUrl, paper.publicationType, paper.publicationStatus], ['10.26434/chemrxiv.15010999/v1', false, null, 'preprint', 'preprint']);
  assert.equal(areaLabelForPaper(paper), 'Chemistry');
});

// The cost: one list call a night, the lane's first night included.
test("ChemRxiv's preprints are listed for chemistry alone, one page of 200 a night", async t => {
  assert.deepEqual(categoryLaneJobs().filter(job => job.source === 'openalex-chemrxiv'), [{ source: 'openalex-chemrxiv', lane: 'area:chem' }]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T03:00:00Z') });
  const page = (number: number) => Array.from({ length: 200 }, (_, index) => ({
    ...chemRxivPreprint, id: `https://openalex.org/W${number}${String(index).padStart(3, '0')}`, doi: `https://doi.org/10.26434/chemrxiv.${number}${index}/v1`, title: `Preprint ${number}-${index} on fullerene docking`,
  }));
  const { urls, env } = relay(t, url => ({ results: page(Number(url.searchParams.get('page'))) }));
  const { binding } = testD1();
  await harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-chemrxiv', lane: 'area:chem' });
  assert.deepEqual(urls.map(url => [url.searchParams.get('page'), url.searchParams.get('per-page')]), [['1', '200']], 'a full first page is not followed by another');
  await harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-chemrxiv', lane: 'area:chem' });
  assert.equal(urls.length, 2, 'a later run reads the newest page only');
});

// ─── Journal articles of a leaf's venues (PAP-104) ───

const venueLanes = () => categoryLaneJobs().filter(job => job.source === 'openalex-venues').map(job => job.lane);
const sourcesOf = (filters: string[]) => filters.find(filter => filter.startsWith('primary_location.source.id:'))!.slice('primary_location.source.id:'.length).split('|');
const venueRequest = { page: 1, since: '', waits: { seconds: 0 } };

// OpenAlex W7221756071 and W7222586136 as returned to the econ.EM and econ.TH
// samples on 2026-10-23 (trimmed, abstract shortened, author made up): closed
// articles, the second without an abstract in OpenAlex.
const journalArticle = (id: string, doi: string, title: string, date: string, source: { id: string; display_name: string }, abstract: string | null) => ({
  id: `https://openalex.org/${id}`,
  doi: `https://doi.org/${doi}`,
  title,
  type: 'article',
  publication_date: date,
  publication_year: 2026,
  authorships: [{ author: { id: 'https://openalex.org/A5000000104', display_name: 'Ana Economist' }, institutions: [] }],
  abstract_inverted_index: abstract ? invertedIndex(abstract) : null,
  primary_location: {
    is_oa: false,
    landing_page_url: `https://doi.org/${doi}`,
    version: 'publishedVersion',
    is_published: true,
    source: { id: `https://openalex.org/${source.id}`, display_name: source.display_name, type: 'journal', is_core: true },
  },
  locations: [],
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  cited_by_count: 0,
});
const JBES = { id: 'S18095783', display_name: 'Journal of Business and Economic Statistics' };
const ECONOMIC_THEORY = { id: 'S579031', display_name: 'Economic Theory' };
const gmmArticle = journalArticle('W7221756071', '10.1080/07350015.2026.2743244', 'The Efficiency vs. Pricing Accuracy Trade-Off in GMM Estimation of Multifactor Linear Asset Pricing Models', '2026-10-14', JBES,
  'Even though a multifactor linear asset pricing model can be written equivalently in Beta or Stochastic Discount Factor form, the two representations need not deliver the same inferential properties.');
const paretoArticle = journalArticle('W7222586136', '10.1007/s00199-026-01757-6', 'Generalizing the Pareto principle with endogenous populations', '2026-10-15', ECONOMIC_THEORY, null);

test('a leaf the venue gate admitted asks OpenAlex for the sources its sample found on target, as the sample asked, with or without an abstract', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  const reviews = gateFile('openalex-venue-reviews.json');
  const { urls, env } = relay(t, () => ({ results: [] }));
  // Sorted. cs.AI leaves out the AAAI, IJCAI and AAMAS proceedings and
  // cond-mat.supr-con three journals, none with an article among the sample's
  // 15 newest; q-fin.GN leaves out the Journal of Financial and Quantitative
  // Analysis, which they did not reach either. econ.GN asks for four of its 15
  // curated journals: three with an article on target among its sample's 15
  // newest (Review of Economics and Statistics, Quarterly Journal of Economics
  // and Economic Journal) and the American Economic Review, whose own sample
  // passed. Its sample asked has_abstract:true, as the other areas' did; the
  // lane does not.
  const asked = {
    'econ.EM': [['S127742747', 'S18095783', 'S33519306', 'S49389958'], ['type:article']],
    'econ.GN': [['S180061323', 'S203860005', 'S23254222', 'S45992627'], ['type:article']],
    'q-fin.GN': [['S131117787', 'S149240962', 'S170137484', 'S5353659'], ['type:article']],
    'cs.AI': [['S139930977', 'S196139623'], ['type:article|conference-paper']],
    'cond-mat.supr-con': [['S24807848', 'S4210237713', 'S93909106'], ['type:article', 'primary_topic.id:T10037']],
    'hep-ex': [['S173952182', 'S187585107', 'S4210238307', 'S94052278'], ['type:article', 'authors_count:>99']],
    // Its curator's filter: JHEP's large collaborations' results are hep-ex's.
    'hep-th': [['S187585107'], ['type:article', 'authors_count:<100']],
  };
  for (const [leaf, [sources, sampledFilters]] of Object.entries(asked)) {
    assert.ok(venueLanes().includes(leaf), `${leaf} has a venue lane in the nightly harvest`);
    await SOURCES['openalex-venues'].fetchPage(env, { ...venueRequest, lane: leaf });
    const filters = filtersOf(urls.at(-1)!);
    const sampled = new URL(reviews.leaves[leaf].sample.query).searchParams.get('filter')!.split(',');
    assert.deepEqual(sourcesOf(filters), sources, leaf);
    assert.ok(sources.every(id => sourcesOf(sampled).includes(id)), `${leaf} asks only for sources its sample asked for`);
    assert.deepEqual(filters.slice(1).sort(), [...sampledFilters, 'from_publication_date:2026-07-26', 'is_retracted:false', 'to_publication_date:2026-10-24'].sort(), leaf);
    assert.ok(sampledFilters.every(filter => sampled.includes(filter)), `${leaf} filters as its sample did`);
    assert.equal(urls.at(-1)!.searchParams.get('sort'), 'publication_date:desc');
  }
});

test('a leaf whose venue sample fell short of the gate, or that has none, sends no venue request', () => {
  const coverage = gateFile('openalex-leaf-venues-coverage.json') as Array<{ leaf: string; status: string }>;
  const statusOf = (leaf: string) => coverage.find(row => row.leaf === leaf);
  // cs.DS's sources held 13 recent articles with an abstract, cs.GT's 11.
  // q-fin.RM's two insurance journals were 10 of 15 on target, but its curator
  // excluded both.
  const short = [['math.AG', 'rejected'], ['math.GR', 'rejected'], ['q-fin.PM', 'rejected'], ['cs.DS', 'insufficient-sample'], ['cs.GT', 'insufficient-sample'], ['q-fin.PR', 'insufficient-sample'], ['q-fin.TR', 'insufficient-sample'], ['q-fin.RM', 'not-curated']];
  for (const [leaf, status] of short) {
    assert.equal(statusOf(leaf)?.status, status, leaf);
    assert.equal(openAlexVenueFilterForLeaf(leaf), null, leaf);
    assert.ok(!venueLanes().includes(leaf), leaf);
  }
  for (const leaf of ['q-fin.ST', 'med.onco', 'constructor']) assert.equal(openAlexVenueFilterForLeaf(leaf), null, `${leaf} was never sampled`);
  assert.deepEqual(venueLanes().sort(), coverage.filter(row => row.status === 'passed').map(row => row.leaf).sort());
});

test("a venue lane's articles reach the readers of its leaf alone, a paywalled one marked closed access and one without an abstract saying it has none", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  const { env } = relay(t, url => {
    const sources = sourcesOf(filtersOf(url));
    return { results: [...(sources.includes(JBES.id) ? [gmmArticle] : []), ...(sources.includes(ECONOMIC_THEORY.id) ? [paretoArticle] : [])] };
  });
  const { binding } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  await harvestLane(store, { source: 'openalex-venues', lane: 'econ.EM' });
  await harvestLane(store, { source: 'openalex-venues', lane: 'econ.TH' });
  const page = await readFeedPage(store, parseFeedRequest({ categories: ['econ.EM', 'econ.TH'] }));
  assert.deepEqual(page.map(paper => [paper.id, paper._fetchedFor]), [['openalex:W7222586136', ['econ.TH']], ['openalex:W7221756071', ['econ.EM']]]);
  for (const paper of page) {
    // What accessStatusForPaper (src/utils/paper-status.ts) reads as
    // `subscription`, the card's Closed access chip: an explicit `false`, and
    // no arXiv id or PDF to call it open. The Worker's test project cannot
    // import paper-status.ts, whose Unpaywall types need Vite's.
    assert.equal(paper.openAccess, false, paper.id);
    assert.deepEqual([paper.arxivId, paper.pdfUrl, paper.openAccessPdfUrl].filter(Boolean), [], paper.id);
    assert.equal(paper.peerReviewed, true, `${paper.id}: a journal article, by the review rule`);
    assert.equal(paper.workingPaper, undefined);
  }
  assert.equal(hasUsableAIAbstract(page[0].abstract), false, 'its abstract stays unknown');
  assert.equal(page[0].abstract, 'No abstract available.');
  assert.equal(hasUsableAIAbstract(page[1].abstract), true);
  // A reader of another leaf of the area gets neither.
  assert.deepEqual(await readFeedPage(store, parseFeedRequest({ categories: ['econ.GN'] })), []);
});

// leaf-filing.ts takes a paper a leaf of its area holds out of the area's lane,
// as it does a topic lane's: the readers of the area's other leaves, who got it
// from the area lane, no longer do.
test("a venue lane's article leaves its area's lane, so readers of the area's other leaves no longer get it", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  const econometrics = {
    id: 'https://openalex.org/T10000', display_name: 'Asset pricing',
    subfield: { id: 'https://openalex.org/subfields/2002', display_name: 'Economics and Econometrics' },
    field: { id: 'https://openalex.org/fields/20', display_name: 'Economics, Econometrics and Finance' },
    domain: { id: 'https://openalex.org/domains/2', display_name: 'Social Sciences' },
  };
  const { env } = relay(t, () => ({ results: [{ ...gmmArticle, primary_topic: econometrics }] }));
  const { binding } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  const reader = async (leaf: string) => (await readFeedPage(store, parseFeedRequest({ categories: [leaf] }))).map(paper => paper.id);
  await harvestLane(store, { source: 'openalex-areas', lane: 'area:econ' });
  assert.equal(await fileAreaPapers(store), 0);
  assert.deepEqual(await reader('econ.GN'), ['openalex:W7221756071']);
  await harvestLane(store, { source: 'openalex-venues', lane: 'econ.EM' });
  assert.equal(await fileAreaPapers(store), 1);
  assert.deepEqual(await reader('econ.GN'), []);
  assert.deepEqual(await reader('econ.EM'), ['openalex:W7221756071']);
});

// The nightly run harvests the venue lanes before the series, so a journal
// article and its working paper that arrive the same night meet in this order.
test('a working paper the series lists after its journal article from a venue lane joins the reviewed journal row', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  // The NBER version of the same paper, typed `report` as OpenAlex types them.
  const workingPaper = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, null), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
  const { env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(NBER.id) ? [workingPaper] : sourcesOf(filtersOf(url)).includes(JBES.id) ? [gmmArticle] : [] }));
  const { binding, db } = testD1();
  const jobs = categoryLaneJobs().filter(job => (job.source === 'openalex-venues' && job.lane === 'econ.EM') || job.source === 'openalex-series');
  assert.deepEqual(jobs.map(job => job.source), ['openalex-venues', 'openalex-series']);
  for (const job of jobs) await harvestLane({ ...env, PAPER_STORE: binding }, job);
  const works = db.prepare('SELECT paper FROM works').all().map(row => JSON.parse(String((row as { paper: string }).paper)));
  assert.equal(works.length, 1);
  assert.deepEqual([works[0].doi, works[0].peerReviewed, works[0].workingPaper], ['10.1080/07350015.2026.2743244', true, undefined]);
  const lanes = db.prepare('SELECT lane FROM work_lanes ORDER BY lane').all().map(row => (row as { lane: string }).lane);
  assert.deepEqual(lanes.filter(lane => !lane.startsWith('author:')), ['econ.EM', 'series:working-papers']);
});

// Working papers usually come first: the series stores the NBER version a
// night or more before the venue lane lists the journal article (ENG-133).
test('a journal article a venue lane lists a night after its working paper makes the stored working-paper row the reviewed journal row, under the id readers hold', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const nberAbstract = 'The NBER version of this paper compares the efficiency and the pricing accuracy of GMM estimators of linear factor models.';
  const workingPaper = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, nberAbstract), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
  const { env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(NBER.id) ? [workingPaper] : sourcesOf(filtersOf(url)).includes(JBES.id) ? [gmmArticle] : [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  const series = categoryLaneJobs().find(job => job.source === 'openalex-series')!;
  const venue = categoryLaneJobs().find(job => job.source === 'openalex-venues' && job.lane === 'econ.EM')!;
  const rows = () => db.prepare('SELECT id, paper, liked_until FROM works').all() as Array<{ id: number; paper: string; liked_until: string | null }>;

  await harvestLane(store, series);
  const [stored] = rows();
  assert.equal(JSON.parse(stored.paper).workingPaper, true);
  await keepLiked(binding, [stored.id]);
  const likedUntil = rows()[0].liked_until;
  assert.ok(likedUntil);

  t.mock.timers.setTime(Date.parse('2026-10-24T03:00:00Z'));
  await harvestLane(store, venue);
  const after = rows();
  assert.equal(after.length, 1);
  const paper = JSON.parse(after[0].paper);
  assert.deepEqual(
    [after[0].id, paper.id, paper.doi, paper.landingPageUrl, paper.peerReviewed, paper.workingPaper],
    [stored.id, 'openalex:W7220000104', '10.1080/07350015.2026.2743244', 'https://doi.org/10.1080/07350015.2026.2743244', true, undefined],
  );
  assert.equal(after[0].liked_until, likedUntil);
  // The working paper's answer stays on record under its own DOI.
  assert.equal(paper.sources.peerReviewedByDoi['10.3386/w35104'], false);
  const found = await findWorks(binding, ['openalex:W7220000104', 'openalex:W7221756071']);
  assert.deepEqual([...found.values()], [stored.id, stored.id]);

  // The series listing the working paper again does not put its text back on
  // the journal row.
  t.mock.timers.setTime(Date.parse('2026-10-25T03:00:00Z'));
  await harvestLane(store, series);
  const again = JSON.parse(rows()[0].paper);
  assert.deepEqual([again.doi, again.peerReviewed, again.workingPaper], ['10.1080/07350015.2026.2743244', true, undefined]);
  assert.match(again.abstract, /^Even though a multifactor/);
});

// The article can name a coauthor the working paper did not; a reader who
// follows that coauthor finds the upgraded row on its first listing.
test("a journal article that adds a followed coauthor to a stored working paper reaches that coauthor's followers on its first listing", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const ben = { author: { id: 'https://openalex.org/A5000000777', display_name: 'Ben Coauthor' }, institutions: [] };
  const article = { ...gmmArticle, authorships: [...gmmArticle.authorships, ben] };
  const workingPaper = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, null), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
  const { env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(NBER.id) ? [workingPaper] : sourcesOf(filtersOf(url)).includes(JBES.id) ? [article] : [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('author:A5000000777', ?)").run(new Date().toISOString());
  const following = async () => (await readFeedPage(store, parseFeedRequest({ categories: [], follows: [{ type: 'author', canonicalId: 'A5000000777', displayName: 'Ben Coauthor' }] })))
    .map(paper => [paper.id, paper.peerReviewed]);

  await harvestLane(store, categoryLaneJobs().find(job => job.source === 'openalex-series')!);
  assert.deepEqual(await following(), []);
  t.mock.timers.setTime(Date.parse('2026-10-24T03:00:00Z'));
  await harvestLane(store, categoryLaneJobs().find(job => job.source === 'openalex-venues' && job.lane === 'econ.EM')!);
  assert.deepEqual(await following(), [['openalex:W7220000104', true]]);
});

// Beside a coauthor, the article can name an institution, a topic and a
// concept the working paper did not, and it can come a night after the working
// paper or on one page with it, in either order.
test('a journal article that adds a coauthor, an institution, a topic or a concept to its working paper reaches their followers on its first listing, a night later or in one batch', async t => {
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const topic = { id: 'https://openalex.org/T10999', display_name: 'Asset pricing' };
  const article = mapOpenAlexWork({
    ...gmmArticle,
    authorships: [
      { ...gmmArticle.authorships[0], institutions: [{ id: 'https://openalex.org/I5000000888', display_name: 'Ana University' }] },
      { author: { id: 'https://openalex.org/A5000000777', display_name: 'Ben Coauthor' }, institutions: [] },
    ],
    primary_topic: topic,
    topics: [topic],
    concepts: [{ id: 'https://openalex.org/C5000000999', display_name: 'Stochastic discount factor', score: 0.8 }],
  })!;
  // The working paper names an institution and a concept of its own, and no topic.
  const workingPaper = mapOpenAlexWork({
    ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, null),
    title: gmmArticle.title,
    authorships: [{ ...gmmArticle.authorships[0], institutions: [{ id: 'https://openalex.org/I5000000111', display_name: 'NBER' }] }],
    publication_date: '2026-09-28',
    concepts: [{ id: 'https://openalex.org/C5000000222', display_name: 'Interest rates', score: 0.8 }],
  })!;
  const follows = [
    { type: 'author', canonicalId: 'A5000000777', displayName: 'Ben Coauthor' },
    { type: 'institution', canonicalId: 'I5000000888', displayName: 'Ana University' },
    { type: 'topic', canonicalId: 'T10999', displayName: 'Asset pricing' },
    { type: 'topic', canonicalId: 'C5000000999', displayName: 'Stochastic discount factor' },
  ];
  for (const [name, nights] of [
    ['a night later', [[workingPaper], [article]]],
    ['working paper first in one batch', [[workingPaper, article]]],
    ['article first in one batch', [[article, workingPaper]]],
  ] as const) {
    const { binding, db } = testD1();
    const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
    for (const lane of ['author:A5000000777', 'institution:I5000000888', 'concept:C5000000999']) {
      db.prepare('INSERT INTO followed_lanes (lane, requested_at) VALUES (?, ?)').run(lane, new Date(first).toISOString());
    }
    for (const [night, papers] of nights.entries()) {
      t.mock.timers.setTime(first + night * 86_400_000);
      await ingestPapers(store, papers.map(paper => ({ paper, lanes: ['econ.EM'] })), { now: first + night * 86_400_000 });
    }
    for (const follow of follows) {
      const page = await readFeedPage(store, parseFeedRequest({ categories: [], follows: [follow] }));
      assert.deepEqual(page.map(paper => [paper.doi, paper.peerReviewed]), [[gmmArticle.doi.slice('https://doi.org/'.length), true]], `${name}: ${follow.canonicalId}`);
    }
  }
});

test("a lane a journal article's upgrade adds arrives with the listing that brought the article, or with no arrival on the lane's first load", async () => {
  const first = Date.parse('2026-10-23T03:00:00Z');
  const workingPaper = mapOpenAlexWork({ ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, null), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' })!;
  // The upgrade follows the listing: the lane being loaded, or every lane,
  // gives no arrival, and another lane's first load dates only this week's
  // articles (gmmArticle is dated 2026-10-14, ten days before the listing).
  for (const [firstLoad, published, arrived] of [
    [undefined, '2026-10-14', new Date(first + 86_400_000).toISOString()],
    ['econ.EM', '2026-10-22', new Date(first + 86_400_000).toISOString()],
    ['econ.EM', '2026-10-14', null],
    ['author:A5000000777', '2026-10-22', null],
    [true, '2026-10-22', null],
  ] as const) {
    const article = mapOpenAlexWork({ ...gmmArticle, publication_date: published, authorships: [...gmmArticle.authorships, { author: { id: 'https://openalex.org/A5000000777', display_name: 'Ben Coauthor' }, institutions: [] }] })!;
    const { binding, db } = testD1();
    const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
    db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('author:A5000000777', ?)").run(new Date(first).toISOString());
    await ingestPapers(store, [{ paper: workingPaper, lanes: ['series:working-papers'] }], { now: first });
    await ingestPapers(store, [{ paper: article, lanes: ['econ.EM'] }], { now: first + 86_400_000, firstLoad });
    assert.deepEqual((db.prepare("SELECT arrived FROM work_lanes WHERE lane = 'author:A5000000777'").all() as Array<{ arrived: string | null }>).map(row => row.arrived), [arrived], `firstLoad: ${firstLoad}, published ${published}`);
  }
});

// The 14-day refresh can recover a working paper's abstract from Semantic
// Scholar. An article without one leaves that text on the upgraded row, and
// the credit the card's attribution reads stays with it.
test("a working-paper row upgraded by a journal article without an abstract keeps the abstract Semantic Scholar recovered, and its credit", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const recovered = 'We compare the efficiency and the pricing accuracy of GMM estimators of multifactor linear asset pricing models in two representations.';
  const workingPaper = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, null), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
  const article = { ...gmmArticle, abstract_inverted_index: null };
  const { env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(NBER.id) ? [workingPaper] : sourcesOf(filtersOf(url)).includes(JBES.id) ? [article] : [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  const stored = () => JSON.parse(String((db.prepare('SELECT paper FROM works').all()[0] as { paper: string }).paper)) as Paper;
  await harvestLane(store, categoryLaneJobs().find(job => job.source === 'openalex-series')!);
  const [withAbstract] = mergeFeedAbstracts([stored()], [{ doi: '10.3386/w35104', abstract: recovered, sources: { primary: 'semanticscholar', enrichedBy: [] } }]);
  assert.ok(withAbstract.sources.enrichedBy.includes('semanticscholar'));
  db.prepare('UPDATE works SET paper = ?').run(JSON.stringify(withAbstract));

  t.mock.timers.setTime(Date.parse('2026-10-24T03:00:00Z'));
  await harvestLane(store, categoryLaneJobs().find(job => job.source === 'openalex-venues' && job.lane === 'econ.EM')!);
  const paper = stored();
  assert.deepEqual([paper.doi, paper.peerReviewed, paper.abstract], ['10.1080/07350015.2026.2743244', true, recovered]);
  assert.ok(paper.sources.enrichedBy.includes('semanticscholar'), `enrichedBy: ${paper.sources.enrichedBy}`);
});

// The row keeps the working paper's id, yet its text is the article's, so the
// article's corrected title and abstract reach it in either order of arrival.
test('OpenAlex listing a journal article again with a corrected title and abstract updates its row whichever of the article and its working paper arrived first', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const workingPaper = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, 'The NBER version of this paper compares the efficiency and the pricing accuracy of GMM estimators of linear factor models.'), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
  const corrected = { ...gmmArticle, title: 'The Efficiency and Pricing Accuracy Trade-Off in GMM Estimation of Linear Asset Pricing Models', abstract_inverted_index: invertedIndex('A corrected abstract: the two representations of a multifactor linear asset pricing model need not deliver the same inferential properties.') };
  let article: typeof gmmArticle = gmmArticle;
  const { env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(NBER.id) ? [workingPaper] : sourcesOf(filtersOf(url)).includes(JBES.id) ? [article] : [] }));
  const series = categoryLaneJobs().find(job => job.source === 'openalex-series')!;
  const venue = categoryLaneJobs().find(job => job.source === 'openalex-venues' && job.lane === 'econ.EM')!;
  const texts: unknown[] = [];
  for (const order of [[series, venue], [venue, series]]) {
    const { binding, db } = testD1();
    const store = { ...env, PAPER_STORE: binding };
    article = gmmArticle;
    t.mock.timers.setTime(Date.parse('2026-10-23T03:00:00Z'));
    await harvestLane(store, order[0]);
    t.mock.timers.setTime(Date.parse('2026-10-24T03:00:00Z'));
    await harvestLane(store, order[1]);
    article = corrected;
    t.mock.timers.setTime(Date.parse('2026-10-25T03:00:00Z'));
    await harvestLane(store, venue);
    const works = db.prepare('SELECT paper FROM works').all().map(row => JSON.parse(String((row as { paper: string }).paper)));
    assert.equal(works.length, 1);
    assert.equal(works[0].peerReviewed, true);
    texts.push([works[0].title, works[0].abstract]);
  }
  assert.deepEqual(texts[0], [corrected.title, 'A corrected abstract: the two representations of a multifactor linear asset pricing model need not deliver the same inferential properties.']);
  assert.deepEqual(texts[1], texts[0]);
});

// ENG-105 beside ENG-133: the upgraded row's own listing, an article whose
// abstract OpenAlex gives as a funding note, replaces a note an earlier Worker
// stored, and the working paper's abstract does not stand in for it.
test("an upgraded row that stored a funding note as its abstract loses it when the article's listing has none, without taking the working paper's text", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const note = 'The author gratefully acknowledges the financial support of the Swiss Finance Institute.';
  const workingPaper = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, 'The NBER version of this paper compares the efficiency and the pricing accuracy of GMM estimators of linear factor models.'), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
  let article: typeof gmmArticle = gmmArticle;
  const { env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(NBER.id) ? [workingPaper] : sourcesOf(filtersOf(url)).includes(JBES.id) ? [article] : [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  const series = categoryLaneJobs().find(job => job.source === 'openalex-series')!;
  const venue = categoryLaneJobs().find(job => job.source === 'openalex-venues' && job.lane === 'econ.EM')!;
  const stored = () => JSON.parse(String((db.prepare('SELECT paper FROM works').all()[0] as { paper: string }).paper));
  await harvestLane(store, series);
  t.mock.timers.setTime(Date.parse('2026-10-24T03:00:00Z'));
  await harvestLane(store, venue);
  assert.equal(stored().peerReviewed, true);
  db.prepare("UPDATE works SET paper = json_set(paper, '$.abstract', ?)").run(note);
  db.exec(`INSERT INTO work_vectors (work_id, embedding) SELECT id, x'01' FROM works`);

  article = { ...gmmArticle, abstract_inverted_index: invertedIndex(note) };
  t.mock.timers.setTime(Date.parse('2026-10-25T03:00:00Z'));
  await harvestLane(store, venue);
  assert.deepEqual([stored().peerReviewed, stored().workingPaper, stored().abstract], [true, undefined, 'No abstract available.']);
  assert.equal(db.prepare('SELECT work_id FROM work_vectors').all().length, 0, 'the paper is embedded again, by its title');
});

test("the enrichment of a working-paper row that became its journal article asks OpenAlex for the article's work", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const workingPaper = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, null), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
  const { urls, env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(NBER.id) ? [workingPaper] : sourcesOf(filtersOf(url)).includes(JBES.id) ? [gmmArticle] : [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  await harvestLane(store, categoryLaneJobs().find(job => job.source === 'openalex-series')!);
  t.mock.timers.setTime(first + DAY);
  await harvestLane(store, categoryLaneJobs().find(job => job.source === 'openalex-venues' && job.lane === 'econ.EM')!);
  db.prepare('UPDATE works SET enriched_at = ?').run(new Date(first).toISOString());

  t.mock.timers.setTime(first + 16 * DAY);
  urls.length = 0;
  await enrichPending(store, 50, first + 16 * DAY);
  assert.deepEqual(urls.filter(url => url.hostname === 'api.openalex.org').map(url => url.searchParams.get('filter')), ['openalex:W7221756071']);
});

// An economics paper often circulates as several OpenAlex working papers
// (NBER, CESifo). The row its article upgraded can fold with a second working
// paper's row later, and the row the fold keeps, set by the rows' numbers, can
// be either. The upgrade reads OpenAlex's record of the article, never a
// merged row, so a fold that keeps the second working paper's row leaves it
// the working paper's until the venue lane lists the article again, which it
// does each night of the article's first 90 days. The row then follows the
// article's work, so the first working paper listed again does not put its
// text on the reviewed row.
test("an upgraded row folded with a second working paper's row is the article's once OpenAlex lists the article again, and keeps following its work", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const otherTitle = 'Efficiency or Pricing Accuracy: Choosing Between Beta and SDF Representations in Linear Factor Models';
  const article = mapOpenAlexWork(gmmArticle)!;
  // Each pair of work ids in both orders: two of the four keep the second
  // working paper's row.
  for (const [nberId, cesifoId] of [['W7220000104', 'W7220000301'], ['W7220000301', 'W7220000104'], ['W7220000111', 'W7220000222'], ['W7220000222', 'W7220000111']]) {
    const name = `NBER ${nberId}, CESifo ${cesifoId}`;
    const nber = { ...seriesWork(nberId, '10.3386/w35104', 'report', NBER, 'The NBER version of this paper compares the efficiency and the pricing accuracy of GMM estimators of linear factor models.'), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
    const cesifo = { ...seriesWork(cesifoId, '10.2139/cesifo.11111', 'report', CESIFO, 'The CESifo version of this paper compares the efficiency and the pricing accuracy of GMM estimators of linear factor models.'), title: otherTitle, authorships: gmmArticle.authorships, publication_date: '2026-09-29' };
    const { binding, db } = testD1();
    const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
    const rows = () => db.prepare('SELECT paper FROM works').all().map(row => JSON.parse(String((row as { paper: string }).paper)) as Paper);
    // The two working papers, two rows; the article upgrades the NBER one;
    // CESifo retitles its paper as the article, which folds the two rows; the
    // venue lane lists the article again; the NBER series lists its working
    // paper again under a revised title.
    for (const [night, works] of [[nber, cesifo], [gmmArticle], [{ ...cesifo, title: gmmArticle.title }], [gmmArticle], [{ ...nber, title: 'A revised title of the NBER working paper' }]].entries()) {
      t.mock.timers.setTime(first + night * DAY);
      await ingestPapers(store, works.map(work => ({ paper: mapOpenAlexWork(work)!, lanes: ['econ.EM'] })), { now: first + night * DAY });
      if (night === 0) assert.equal(rows().length, 2, name);
    }
    const works = rows();
    assert.equal(works.length, 1, name);
    assert.deepEqual(
      [works[0].doi, works[0].peerReviewed, works[0].workingPaper, works[0].openAlexId, works[0].title, works[0].abstract],
      ['10.1080/07350015.2026.2743244', true, undefined, 'W7221756071', article.title, article.abstract],
      name,
    );
  }
});

// The NBER working paper of `gmmArticle`, and its arXiv eprint.
const gmmWorkingPaperWork = { ...seriesWork('W7220000104', '10.3386/w35104', 'report', NBER, 'The NBER version of this paper compares the efficiency and the pricing accuracy of GMM estimators of linear factor models.'), title: gmmArticle.title, authorships: gmmArticle.authorships, publication_date: '2026-09-28' };
const gmmEprint = (record: Partial<ArxivRecord>) => arxivRecordPaper({
  arxivId: '2610.01234', title: gmmArticle.title, abstract: 'The arXiv version of this paper compares the efficiency and the pricing accuracy of GMM estimators.',
  authors: ['Ana Economist'], categories: ['econ.EM'], doi: null, journalRef: null, comments: null,
  published: '2026-10-20T12:00:00.000Z', updated: '2026-10-20T12:00:00.000Z', ...record,
});
const JBES_REFERENCE = 'Journal of Business and Economic Statistics 44 (2026) 1-20';
const JBES_DOI = '10.1080/07350015.2026.2743244';

// The row the working paper makes, then `paper` joins: a night later, or on
// the same page after it. Without `paper`, the working paper's row alone.
async function workingPaperRowWith(t: import('node:test').TestContext, paper: Paper | null, samePage: boolean) {
  const { binding, db } = testD1();
  const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
  const night = (day: string, papers: Paper[]) => {
    t.mock.timers.setTime(Date.parse(day));
    return ingestPapers(store, papers.map(listed => ({ paper: listed, lanes: ['econ.EM'] })), { now: Date.parse(day) });
  };
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  if (samePage) await night('2026-10-24T03:00:00Z', paper ? [workingPaper, paper] : [workingPaper]);
  else {
    await night('2026-10-23T03:00:00Z', [workingPaper]);
    if (paper) await night('2026-10-24T03:00:00Z', [paper]);
  }
  return (db.prepare('SELECT paper, published FROM works').all() as Array<{ paper: string; published: string }>)
    .map(row => ({ ...JSON.parse(row.paper) as Paper, storedPublished: row.published }));
}

// An arXiv eprint reads reviewed on a publisher's DOI it lists, or on a
// comment saying it was published, and a preprint under arXiv's own DOI. Only OpenAlex's journal article makes
// OpenAlex's working-paper row the journal's; an eprint naming its journal and
// the journal's DOI does not either (ENG-145). `merge` keeps the working
// paper's `false`.
test("an arXiv eprint leaves a working paper row as it was, whatever DOI, comment or journal reference it lists, stored or on the same page", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const shown = (paper: Awaited<ReturnType<typeof workingPaperRowWith>>[number]) => [paper.id, paper.sources.primary, paper.doi, paper.landingPageUrl, paper.storedPublished, paper.journal, paper.peerReviewed, paper.workingPaper, paper.title, paper.abstract];
  for (const record of [
    { doi: '10.3386/w35104' },
    { doi: '10.1080/07350015.2026.2743244' },
    { doi: '10.48550/arXiv.2610.01234' },
    { comments: 'Published in the Journal of Business and Economic Statistics' },
    { journalRef: JBES_REFERENCE },
    { journalRef: JBES_REFERENCE, doi: '10.3386/w35104' },
    { journalRef: JBES_REFERENCE, doi: '10.48550/arXiv.2610.01234' },
    { journalRef: JBES_REFERENCE, doi: '10.1080/07350015.2026.2743244' },
  ]) {
    for (const samePage of [false, true]) {
      const name = `${JSON.stringify(record)}, ${samePage ? 'on the same page' : 'stored first'}`;
      const [before] = await workingPaperRowWith(t, null, samePage);
      const after = await workingPaperRowWith(t, gmmEprint(record), samePage);
      assert.equal(after.length, 1, name);
      assert.deepEqual(shown(after[0]), shown(before), name);
    }
  }
});

// A repository's record reads reviewed by its `published` type alone: CORE's
// copy of an author's deposit and OSTI's record, under an SSRN or Zenodo DOI
// or the journal's. Europe PMC's record with a PubMed id can be a preprint
// PubMed indexes; its PPR record maps as a preprint. Only OpenAlex's journal article
// makes OpenAlex's working-paper row the journal's; PubMed's and Europe PMC's
// records of the article do not either (ENG-145).
test("a record from a source other than OpenAlex leaves a working paper's row as it was, stored or on the same page, even one naming the journal and its DOI", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const shown = (paper: Awaited<ReturnType<typeof workingPaperRowWith>>[number]) => [paper.id, paper.sources.primary, paper.doi, paper.landingPageUrl, paper.storedPublished, paper.journal, paper.peerReviewed, paper.workingPaper, paper.title, paper.abstract];
  const deposit = (doi: string, journal?: string) => mapCoreWork({
    id: 99887766, title: gmmArticle.title, doi, publishedDate: '2026-10-10', authors: [{ name: 'Ana Economist' }], documentType: 'research',
    abstract: 'A copy of this paper that its author deposited in her university repository, with the same results.',
    links: [{ type: 'display', url: 'https://core.ac.uk/works/99887766' }], journals: journal ? [{ title: journal }] : undefined,
  })!;
  const europePmc = (doi: string, source: string, pmid?: string) => mapEuropePmcSearchResult({
    id: pmid || 'PPR123456', pmid, source, title: gmmArticle.title, doi, firstPublicationDate: '2026-10-10', authorString: 'Economist A',
    abstractText: 'The record Europe PMC keeps of this paper, which compares the efficiency and the pricing accuracy of GMM estimators.',
    journalInfo: pmid ? { journal: { title: 'Journal of Business and Economic Statistics' } } : undefined,
  })!;
  const osti = (doi: string, journal: string) => mapOstiRecord({
    osti_id: '1234567', title: gmmArticle.title, doi, publication_date: '2026-10-10', authors: ['Ana Economist'],
    description: 'The record OSTI keeps of this paper, which compares the efficiency and the pricing accuracy of GMM estimators.',
    product_type: 'Journal Article', journal_name: journal,
  })!;
  const pubmed = mapPubmedSummary({
    uid: '41000000', title: gmmArticle.title, source: 'J Bus Econ Stat', pubdate: '2026 Oct 14', pubtype: ['Journal Article'],
    authors: [{ name: 'Ana Economist' }], articleids: [{ idtype: 'doi', value: JBES_DOI }],
  });
  for (const [name, record] of [
    ['CORE, SSRN DOI', deposit('10.2139/ssrn.4999999')],
    ['CORE, Zenodo DOI', deposit('10.5281/zenodo.123456')],
    ['CORE, SSRN Electronic Journal', deposit('10.2139/ssrn.4999999', 'SSRN Electronic Journal')],
    ['CORE, the journal and its DOI', deposit(JBES_DOI, 'Journal of Business and Economic Statistics')],
    ['Europe PMC preprint, SSRN DOI', europePmc('10.2139/ssrn.4999999', 'PPR')],
    ['Europe PMC with a PubMed id, the journal and its DOI', europePmc(JBES_DOI, 'MED', '41000001')],
    ['Europe PMC with a PubMed id, SSRN DOI', europePmc('10.2139/ssrn.4999999', 'MED', '41000001')],
    ['PubMed, the journal and its DOI', pubmed],
    ['OSTI, SSRN Electronic Journal', osti('10.2139/ssrn.4999999', 'SSRN Electronic Journal')],
    ['OSTI, the journal and its DOI', osti(JBES_DOI, 'Journal of Business and Economic Statistics')],
  ] as const) {
    // PubMed's summary leaves review to the merge, which read its journal
    // record reviewed before ENG-145 took it out of the upgrade. Europe PMC's
    // PPR record is a preprint.
    if (name === 'Europe PMC preprint, SSRN DOI') assert.equal(record.publicationStatus, 'preprint', name);
    else if (record.sources.primary !== 'pubmed') assert.equal(record.peerReviewed, true, `${name} reads reviewed by itself`);
    for (const samePage of [false, true]) {
      const label = `${name}, ${samePage ? 'on the same page' : 'stored first'}`;
      const [before] = await workingPaperRowWith(t, null, samePage);
      const after = await workingPaperRowWith(t, record, samePage);
      assert.equal(after.length, 1, label);
      assert.deepEqual(shown(after[0]), shown(before), label);
    }
  }
});

// A journal record without a DOI would give the reviewed row the working
// paper's DOI, so the card's link and public key would open the unreviewed
// version. Such a record leaves the row the working paper's.
test("a journal record without a DOI leaves a working paper's row as it was, stored or on the same page", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const shown = (paper: Awaited<ReturnType<typeof workingPaperRowWith>>[number]) => [paper.id, paper.sources.primary, paper.doi, paper.landingPageUrl, paper.storedPublished, paper.journal, paper.peerReviewed, paper.workingPaper, paper.title, paper.abstract, paper.openAlexId];
  const landingPage = 'https://www.tandfonline.com/doi/abs/07350015.2026.2743244';
  for (const [name, record] of [
    ['OpenAlex', mapOpenAlexWork({ ...gmmArticle, doi: null, primary_location: { ...gmmArticle.primary_location, landing_page_url: landingPage } })!],
    ['PubMed', mapPubmedSummary({ uid: '41000000', title: gmmArticle.title, source: 'J Bus Econ Stat', pubdate: '2026 Oct 14', pubtype: ['Journal Article'], authors: [{ name: 'Ana Economist' }] })],
  ] as const) {
    for (const samePage of [false, true]) {
      const label = `${name}, ${samePage ? 'on the same page' : 'stored first'}`;
      const [before] = await workingPaperRowWith(t, null, samePage);
      const after = await workingPaperRowWith(t, record, samePage);
      assert.equal(after.length, 1, label);
      assert.deepEqual(shown(after[0]), shown(before), label);
    }
  }
});

// A working paper can join the row of an eprint that lists no DOI, which arXiv
// or Hugging Face started. Only OpenAlex's own working-paper row becomes its
// journal article's, so that row stays the working paper's when the article
// arrives (ENG-145), and arXiv's next version replaces its title and abstract.
test("an eprint's row that a working paper joined stays the working paper's when its journal article arrives, and takes arXiv's new version", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-21T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const article = mapOpenAlexWork(gmmArticle)!;
  const revision = gmmEprint({
    title: 'GMM Estimation of Linear Asset Pricing Models: Efficiency against Pricing Accuracy',
    abstract: 'The second version of this paper adds a test of the trade-off between the efficiency and the pricing accuracy of GMM estimators.',
    updated: '2026-10-24T12:00:00.000Z',
  });
  const huggingFace = mapHuggingFacePaper({
    paper: { id: '2610.01234', title: gmmArticle.title, summary: 'The arXiv version of this paper compares the efficiency and the pricing accuracy of GMM estimators.', publishedAt: '2026-10-20T12:00:00.000Z', upvotes: 3, authors: [{ name: 'Ana Economist' }] },
  }, ['econ.EM'])!;
  const shown = (paper: Paper) => [paper.id, paper.sources.primary, paper.title, paper.abstract, paper.doi, paper.peerReviewed, paper.workingPaper];
  for (const eprint of [gmmEprint({}), huggingFace]) {
    const name = eprint.sources.primary;
    const rows: Paper[] = [];
    for (const nights of [[eprint, workingPaper, article, revision], [eprint, workingPaper, revision]]) {
      const { binding, db } = testD1();
      const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
      for (const [night, paper] of nights.entries()) {
        t.mock.timers.setTime(first + night * DAY);
        await ingestPapers(store, [{ paper, lanes: ['econ.EM'] }], { now: first + night * DAY });
      }
      const works = db.prepare('SELECT paper FROM works').all().map(row => JSON.parse(String((row as { paper: string }).paper)) as Paper);
      assert.equal(works.length, 1, name);
      rows.push(works[0]);
    }
    assert.deepEqual(shown(rows[0]), shown(rows[1]), name);
    assert.deepEqual(shown(rows[0]).slice(1), [name, revision.title, revision.abstract, '10.3386/w35104', false, true], name);
  }
});

// One page can hold both records, the working paper first, and the merge of
// the page's records reads as a working paper. The row is the journal's
// either way, under the id of the row the working paper is in: stored, or
// the one the page starts. An eprint on the page that names the journal and
// its DOI is never the journal's record, so the row shows the article's
// landing page and text whichever comes first.
test('a journal article and its working paper listed in one batch, in either order, make the reviewed journal row, over a stored working paper or none', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const article = mapOpenAlexWork(gmmArticle)!;
  const eprint = gmmEprint({ journalRef: JBES_REFERENCE });
  const eprintWithJournalDoi = gmmEprint({ journalRef: JBES_REFERENCE, doi: '10.1080/07350015.2026.2743244' });
  const { env } = relay(t, () => ({ results: [gmmWorkingPaperWork] }));
  const series = categoryLaneJobs().find(job => job.source === 'openalex-series')!;
  // The row's [id, openAlexId] when nothing was stored: the id of the page's
  // first record. A page that does not open with OpenAlex's records makes no
  // OpenAlex working-paper row to upgrade, so it is tried over a stored one
  // only; the next test covers the eprint's row.
  for (const [label, batch, unstored] of [
    ['working paper first', [workingPaper, article], ['openalex:W7220000104', 'W7221756071']],
    ['article first', [article, workingPaper], ['openalex:W7221756071', undefined]],
    ['an eprint naming the journal, then the working paper', [eprint, workingPaper, article], null],
    ['the working paper, then an eprint naming the journal and its DOI', [workingPaper, eprintWithJournalDoi, article], ['openalex:W7220000104', 'W7221756071']],
    ['an eprint naming the journal and its DOI, then the article', [eprintWithJournalDoi, article], null],
  ] as const) {
    for (const storedFirst of unstored ? [true, false] : [true]) {
      const name = `${storedFirst ? 'stored working paper' : 'nothing stored'}, ${label}`;
      const { binding, db } = testD1();
      const store = { ...env, PAPER_STORE: binding };
      const rows = () => db.prepare('SELECT id, paper FROM works').all() as Array<{ id: number; paper: string }>;
      t.mock.timers.setTime(Date.parse('2026-10-23T03:00:00Z'));
      if (storedFirst) await harvestLane(store, series);
      const before = rows();
      t.mock.timers.setTime(Date.parse('2026-10-24T03:00:00Z'));
      await ingestPapers(store, batch.map(paper => ({ paper, lanes: ['econ.EM'] })), { now: Date.parse('2026-10-24T03:00:00Z') });
      const after = rows();
      assert.equal(after.length, 1, name);
      const paper = JSON.parse(after[0].paper);
      assert.deepEqual(
        [paper.doi, paper.landingPageUrl, paper.peerReviewed, paper.workingPaper, paper.abstract],
        ['10.1080/07350015.2026.2743244', 'https://doi.org/10.1080/07350015.2026.2743244', true, undefined, article.abstract],
        name,
      );
      assert.deepEqual(
        [after[0].id, paper.id, paper.openAlexId],
        // `openAlexId` is the bare work id, as on every other paper.
        storedFirst ? [before[0].id, 'openalex:W7220000104', 'W7221756071'] : [after[0].id, ...unstored!],
        name,
      );
    }
  }
});

// The row a working paper joins can be one another source started: an arXiv
// or Hugging Face eprint without a DOI. Only OpenAlex's own working-paper row
// becomes its journal article's, so that row stays the working paper's
// (ENG-145), on separate nights, with the working paper and its article on
// one page, all three on one page, or with a record that folds a separately
// stored working paper's row into the eprint's.
test("an eprint row that a working paper joins stays the working paper's when its article arrives, on one page, on separate nights or folded from its own row", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-21T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const shown = (paper: Paper & { storedPublished: string }) => [paper.id, paper.sources.primary, paper.doi, paper.landingPageUrl, paper.storedPublished, paper.peerReviewed, paper.workingPaper, paper.title, paper.abstract, paper.openAlexId];
  async function rowAfter(nights: Paper[][]) {
    const { binding, db } = testD1();
    const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
    for (const [night, papers] of nights.entries()) {
      t.mock.timers.setTime(first + night * DAY);
      await ingestPapers(store, papers.map(paper => ({ paper, lanes: ['econ.EM'] })), { now: first + night * DAY });
    }
    const rows = (db.prepare('SELECT paper, published FROM works').all() as Array<{ paper: string; published: string }>)
      .map(row => ({ ...JSON.parse(row.paper) as Paper, storedPublished: row.published }));
    assert.equal(rows.length, 1);
    return rows[0];
  }
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const article = mapOpenAlexWork(gmmArticle)!;
  const huggingFace = mapHuggingFacePaper({
    paper: { id: '2610.01234', title: gmmArticle.title, summary: 'The arXiv version of this paper compares the efficiency and the pricing accuracy of GMM estimators.', publishedAt: '2026-10-20T12:00:00.000Z', upvotes: 3, authors: [{ name: 'Ana Economist' }] },
  }, ['econ.EM'])!;
  for (const eprint of [gmmEprint({}), huggingFace]) {
    const name = eprint.sources.primary;
    const separate = await rowAfter([[eprint], [workingPaper], [article]]);
    assert.deepEqual([separate.sources.primary, separate.doi, separate.peerReviewed, separate.workingPaper], [name, '10.3386/w35104', false, true], name);
    assert.deepEqual(shown(await rowAfter([[eprint], [workingPaper, article]])), shown(separate), `${name}, working paper first`);
    assert.deepEqual(shown(await rowAfter([[eprint], [article, workingPaper]])), shown(await rowAfter([[eprint], [article], [workingPaper]])), `${name}, article first`);
  }
  const onePage = await rowAfter([[gmmEprint({ journalRef: JBES_REFERENCE }), mapOpenAlexWork(gmmWorkingPaperWork)!, mapOpenAlexWork(gmmArticle)!]]);
  assert.deepEqual([onePage.id, onePage.sources.primary, onePage.doi, onePage.peerReviewed, onePage.workingPaper], ['2610.01234', 'arxiv', '10.3386/w35104', false, true]);

  // The working paper's first author is spelled otherwise, and the eprint's
  // title differs, so the two are stored as two rows. The article joins both:
  // the eprint's by its arXiv id, the working paper's by title and author.
  const smith = { authorships: [{ author: { id: 'https://openalex.org/A9', display_name: 'A. Economist-Smith' }, institutions: [] }] };
  const bridged = await rowAfter([
    [mapOpenAlexWork({ ...gmmWorkingPaperWork, ...smith })!],
    [gmmEprint({ title: 'GMM estimators: efficiency against pricing accuracy' })],
    [mapOpenAlexWork({ ...gmmArticle, ...smith, ids: { arxiv: 'https://arxiv.org/abs/2610.01234' } })!],
  ]);
  assert.deepEqual([bridged.id, bridged.sources.primary, bridged.doi, bridged.peerReviewed, bridged.workingPaper], ['2610.01234', 'arxiv', '10.3386/w35104', false, true]);
});

// What a reader sees of the paper's row, its stored date and the dates of the
// lanes it holds, after `nights` of listings, one batch a night. `afterNight`
// can change the stored rows between nights.
async function journalRowAfter(t: import('node:test').TestContext, nights: Paper[][], afterNight?: (night: number, db: ReturnType<typeof testD1>['db']) => void) {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-21T03:00:00Z');
  const { binding, db } = testD1();
  const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
  for (const [night, papers] of nights.entries()) {
    t.mock.timers.setTime(first + night * DAY);
    await ingestPapers(store, papers.map(paper => ({ paper, lanes: paper.workingPaper ? ['series:working-papers'] : ['econ.EM'] })), { now: first + night * DAY });
    afterNight?.(night, db);
  }
  const works = db.prepare('SELECT id, paper, published FROM works').all() as Array<{ id: number; paper: string; published: string }>;
  assert.equal(works.length, 1);
  const paper = JSON.parse(works[0].paper) as Paper;
  const laneDates = (db.prepare('SELECT lane, published FROM work_lanes WHERE work_id = ? ORDER BY lane').all(works[0].id) as Array<{ lane: string; published: string }>)
    .map(row => `${row.lane} ${row.published}`);
  return {
    id: works[0].id,
    json: works[0].paper,
    shown: [paper.doi, paper.landingPageUrl, paper.title, paper.abstract, paper.journal, paper.peerReviewed, paper.workingPaper, works[0].published],
    laneDates,
  };
}

// The upgrade is a step of its own over the stored row once the batch is
// saved (Pablo, 2026-10-26), so the order of the records, within one batch or
// across nights, does not decide what the row shows; neither does listing them
// again.
test('a journal article and its OpenAlex working paper give the same journal row in either order, in one batch or on two nights, and listing them again changes nothing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const article = mapOpenAlexWork(gmmArticle)!;
  const expected = [JBES_DOI, `https://doi.org/${JBES_DOI}`, article.title, article.abstract, article.journal, true, undefined, '2026-10-14T00:00:00.000Z'];
  for (const [name, nights] of [
    ['working paper, then article, one batch', [[workingPaper, article]]],
    ['article, then working paper, one batch', [[article, workingPaper]]],
    ['working paper, then article, two nights', [[workingPaper], [article]]],
    ['article, then working paper, two nights', [[article], [workingPaper]]],
  ] as const) {
    const once = await journalRowAfter(t, nights.map(night => [...night]));
    assert.deepEqual(once.shown, expected, name);
    // Every lane the row holds, the working-paper series' included, carries
    // the article's date, the one the newest-first feed orders by.
    assert.ok(once.laneDates.length >= 2, name);
    assert.deepEqual(once.laneDates.filter(row => !row.endsWith(' 2026-10-14T00:00:00.000Z')), [], name);
    const repeated = await journalRowAfter(t, [...nights.map(night => [...night]), [workingPaper, article], [article, workingPaper], [workingPaper], [article]]);
    assert.deepEqual(repeated.shown, expected, `${name}, listed again`);
    assert.deepEqual(repeated.laneDates, once.laneDates, `${name}, listed again`);
  }
});

// arXiv's categories are the paper's own classification, and `merge` takes
// them only from an arXiv record. An eprint can join OpenAlex's working-paper
// row before the journal article upgrades it (ENG-205).
test("a working-paper row keeps its arXiv eprint's categories through the journal article's upgrade, in any order, in one batch or on separate nights, and listed again", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const eprint = gmmEprint({ categories: ['econ.EM', 'q-fin.ST'] });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const article = mapOpenAlexWork(gmmArticle)!;
  const names = new Map([[eprint, 'eprint'], [workingPaper, 'working paper'], [article, 'article']]);
  const categories = (json: string) => {
    const paper = JSON.parse(json) as Paper;
    return [paper.primaryCategory, paper.categories, paper.allCategories];
  };
  const expected = ['econ.EM', ['econ.EM', 'q-fin.ST'], ['econ.EM', 'q-fin.ST']];
  for (const order of [
    [eprint, workingPaper, article], [eprint, article, workingPaper],
    [workingPaper, eprint, article], [workingPaper, article, eprint],
    [article, eprint, workingPaper], [article, workingPaper, eprint],
  ]) {
    for (const nights of [[order], order.map(paper => [paper])]) {
      const name = `${order.map(paper => names.get(paper)).join(', ')}, ${nights.length === 1 ? 'one batch' : 'separate nights'}`;
      const once = await journalRowAfter(t, nights);
      assert.deepEqual(categories(once.json), expected, name);
      // A row the working paper started is the journal's once its article is listed.
      if (order[0] === workingPaper) assert.equal((JSON.parse(once.json) as Paper).peerReviewed, true, name);
      const relisted = await journalRowAfter(t, [...nights, ...nights]);
      assert.deepEqual(categories(relisted.json), expected, `${name}, listed again`);
    }
  }
});

// Europe PMC's enrichment adds MeSH terms to a row's categories beside arXiv's
// codes. The upgrade keeps the codes, and keeps the primary only when it is
// one of them: an unknown primary stays unknown, and the series lane's area
// key `econ` is no arXiv category.
test("a working-paper row whose categories mix arXiv's codes with other terms keeps the codes through the upgrade, and its primary only when it is one of them", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const mixed = ['econ.EM', 'q-fin.ST', 'Models, Economic'];
  for (const [stored, shown] of [['econ.EM', 'econ.EM'], ['', ''], ['econ', '']]) {
    const storeMixed = (night: number, db: ReturnType<typeof testD1>['db']) => {
      if (night > 0) return;
      const row = db.prepare('SELECT id, paper FROM works').get() as { id: number; paper: string };
      db.prepare('UPDATE works SET paper = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.paper) as Paper, primaryCategory: stored, categories: mixed, allCategories: mixed }), row.id);
    };
    const nights = [[mapOpenAlexWork(gmmWorkingPaperWork)!, gmmEprint({ categories: ['econ.EM', 'q-fin.ST'] })], [mapOpenAlexWork(gmmArticle)!]];
    const paper = JSON.parse((await journalRowAfter(t, nights, storeMixed)).json) as Paper;
    assert.deepEqual(
      [paper.peerReviewed, paper.primaryCategory, paper.categories, paper.allCategories],
      [true, shown, ['econ.EM', 'q-fin.ST'], ['econ.EM', 'q-fin.ST']],
      `stored primary ${JSON.stringify(stored)}`,
    );
  }
});

// A batch that lists OpenAlex's working paper before its eprint merges the
// eprint into OpenAlex's record, and `merge` takes categories only from an
// arXiv record: the batch must still give the stored working-paper row the
// eprint's categories, as the reverse order does (ENG-206).
test("a stored working-paper row takes its arXiv eprint's categories in either order, in one batch or on separate nights, and listed again", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const eprint = gmmEprint({ categories: ['econ.EM', 'q-fin.ST'] });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const categories = (json: string) => {
    const paper = JSON.parse(json) as Paper;
    return [paper.primaryCategory, paper.categories, paper.allCategories];
  };
  const expected = ['econ.EM', ['econ.EM', 'q-fin.ST'], ['econ.EM', 'q-fin.ST']];
  for (const [name, later] of [
    ['working paper, then eprint, one batch', [[workingPaper, eprint]]],
    ['eprint, then working paper, one batch', [[eprint, workingPaper]]],
    ['working paper, then eprint, separate nights', [[workingPaper], [eprint]]],
    ['eprint, then working paper, separate nights', [[eprint], [workingPaper]]],
  ] as const) {
    const nights = [[workingPaper], ...later.map(night => [...night])];
    assert.deepEqual(categories((await journalRowAfter(t, nights)).json), expected, name);
    assert.deepEqual(categories((await journalRowAfter(t, [...nights, ...nights.slice(1)])).json), expected, `${name}, listed again`);
  }
});

// A stored row's list can lack the eprint's codes, as this loss left it with
// the working paper's own list, or hold them beside MeSH terms Europe PMC's
// enrichment added, with no primary. Listing the eprint again gives the row
// the eprint's categories in either order; a batch without the eprint
// changes no category, and the unknown primary stays unknown.
test("a stored working-paper row whose categories lost or mixed its eprint's codes takes them back when the eprint is listed again", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const eprint = gmmEprint({ categories: ['econ.EM', 'q-fin.ST'] });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const categories = (json: string) => {
    const paper = JSON.parse(json) as Paper;
    return [paper.primaryCategory, paper.categories, paper.allCategories];
  };
  for (const [name, stored] of [['lost', workingPaper.categories], ['mixed', ['econ.EM', 'q-fin.ST', 'Models, Economic']]] as const) {
    const storeList = (night: number, db: ReturnType<typeof testD1>['db']) => {
      if (night !== 1) return;
      const row = db.prepare('SELECT id, paper FROM works').get() as { id: number; paper: string };
      db.prepare('UPDATE works SET paper = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.paper) as Paper, primaryCategory: '', categories: stored, allCategories: stored }), row.id);
    };
    for (const later of [[workingPaper, eprint], [eprint, workingPaper]]) {
      const relisted = await journalRowAfter(t, [[workingPaper], [eprint], later], storeList);
      assert.deepEqual(categories(relisted.json), ['econ.EM', ['econ.EM', 'q-fin.ST'], ['econ.EM', 'q-fin.ST']], `${name}, ${later[0] === eprint ? 'eprint' : 'working paper'} first`);
    }
    const withoutEprint = await journalRowAfter(t, [[workingPaper], [eprint], [workingPaper]], storeList);
    assert.deepEqual(categories(withoutEprint.json), ['', stored, stored], `${name}, working paper alone`);
  }
});

// ADS copies arXiv's classes into its own list, beside its keywords, and can
// leave some out. Its record listed alone is no eprint: it changes no
// category of a row the eprint started, nor of one ADS started.
test("an ADS record listed alone keeps the categories of a row the eprint or ADS started", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const eprint = gmmEprint({ categories: ['econ.EM', 'q-fin.ST'] });
  const ads = mapAdsPaper({
    bibcode: '2026arXiv261001234E', title: [gmmArticle.title], author: ['Economist, Ana'], abstract: 'The ADS copy of the arXiv version of this paper.',
    identifier: ['arXiv:2610.01234'], arxiv_class: ['econ.EM'], keyword: ['Econometrics'], doctype: 'eprint', pubdate: '2026-10-00', year: '2026',
  })!;
  const categories = (json: string) => {
    const paper = JSON.parse(json) as Paper;
    return [paper.primaryCategory, paper.categories, paper.allCategories];
  };
  for (const [first, list] of [[eprint, ['econ.EM', 'q-fin.ST']], [ads, ['econ.EM', 'Econometrics']]] as const) {
    const name = first.sources.primary;
    assert.deepEqual(categories((await journalRowAfter(t, [[first]])).json), ['econ.EM', list, list], `${name} alone`);
    assert.deepEqual(categories((await journalRowAfter(t, [[first], [ads]])).json), ['econ.EM', list, list], `${name}, then ADS`);
  }
});

// arXiv's abstract recovery names arXiv among a row's sources but brings no
// category. The series lane files a working paper under the area key 'econ',
// with OpenAlex's concept names as its categories.
test("a working-paper row whose abstract arXiv recovered shows its journal article's categories once upgraded", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const concept = (id: string, name: string) => [{ id: `https://openalex.org/${id}`, display_name: name, score: 0.9 }];
  const workingPaper = { ...mapOpenAlexWork({ ...gmmWorkingPaperWork, abstract_inverted_index: null, ids: { arxiv: 'https://arxiv.org/abs/2610.01234' }, concepts: concept('C1', 'Econometrics') })!, primaryCategory: 'econ' };
  const article = mapOpenAlexWork({ ...gmmArticle, concepts: concept('C2', 'Estimator') })!;
  const recoverFromArxiv = (night: number, db: ReturnType<typeof testD1>['db']) => {
    if (night > 0) return;
    const row = db.prepare('SELECT id, paper FROM works').get() as { id: number; paper: string };
    const [recovered] = mergeFeedAbstracts([JSON.parse(row.paper) as Paper], [gmmEprint({})]);
    db.prepare('UPDATE works SET paper = ? WHERE id = ?').run(JSON.stringify(recovered), row.id);
  };
  const paper = JSON.parse((await journalRowAfter(t, [[workingPaper], [article]], recoverFromArxiv)).json) as Paper;
  assert.deepEqual(
    [paper.peerReviewed, paper.sources.enrichedBy.includes('arxiv'), paper.primaryCategory, paper.categories, paper.allCategories],
    [true, true, '', ['Estimator'], ['Estimator']],
  );
});

// ENG-165: the topics, primary topic and type of the row are the journal
// article's, whichever record arrives first and however often the working
// paper is listed again. Synthetic topics: the article's T10999 and the
// working paper's T20001, as in the example of the ENG-133 review (PR #365).
const econTopic = (id: string, name: string) => ({
  id: `https://openalex.org/${id}`,
  display_name: name,
  subfield: { id: 'https://openalex.org/subfields/2002', display_name: 'Economics and Econometrics' },
  field: { id: 'https://openalex.org/fields/20', display_name: 'Economics, Econometrics and Finance' },
  domain: { id: 'https://openalex.org/domains/2', display_name: 'Social Sciences' },
});
const ARTICLE_TOPIC = econTopic('T10999', 'Asset pricing models');
const WORKING_PAPER_TOPIC = econTopic('T20001', 'Financial econometrics');
const classificationOf = (json: string) => {
  const paper = JSON.parse(json) as Paper;
  return [paper.primaryTopic?.id, paper.topics?.map(topic => topic.id), paper.publicationType, paper.peerReviewed, paper.doi];
};

test("a journal article's topics, primary topic and type are its row's in every order: one batch, separate nights, or the working paper listed again", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const workingPaper = mapOpenAlexWork({ ...gmmWorkingPaperWork, primary_topic: WORKING_PAPER_TOPIC, topics: [WORKING_PAPER_TOPIC] })!;
  const article = mapOpenAlexWork({ ...gmmArticle, primary_topic: ARTICLE_TOPIC, topics: [ARTICLE_TOPIC] })!;
  const expected = [ARTICLE_TOPIC.id, [ARTICLE_TOPIC.id], 'article', true, JBES_DOI];
  for (const [name, nights] of [
    ['working paper, then article, one batch', [[workingPaper, article]]],
    ['article, then working paper, one batch', [[article, workingPaper]]],
    ['working paper, then article, two nights', [[workingPaper], [article]]],
    ['article, then working paper, two nights', [[article], [workingPaper]]],
    ['working paper, article, working paper, three nights', [[workingPaper], [article], [workingPaper]]],
    ['article and working paper in one batch, then the working paper again', [[article, workingPaper], [workingPaper]]],
    ['working paper and article in one batch, then the working paper again', [[workingPaper, article], [workingPaper]]],
  ] as const) {
    const row = await journalRowAfter(t, nights.map(night => [...night]));
    assert.deepEqual(classificationOf(row.json), expected, name);
  }
});

// A row merged before ENG-165 can show the working paper's topics and type.
// Nothing rewrites it: the article's next listing does, and the working paper
// listed after that leaves the article's.
test("a stored row that shows its working paper's topics and type takes the article's when the article is listed again, and keeps them", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const workingPaper = mapOpenAlexWork({ ...gmmWorkingPaperWork, primary_topic: WORKING_PAPER_TOPIC, topics: [WORKING_PAPER_TOPIC] })!;
  const article = mapOpenAlexWork({ ...gmmArticle, primary_topic: ARTICLE_TOPIC, topics: [ARTICLE_TOPIC] })!;
  // The row as an earlier Worker stored [article, working paper] in one batch.
  const storedBefore = (night: number, db: ReturnType<typeof testD1>['db']) => {
    if (night !== 0) return;
    const row = JSON.parse(String((db.prepare('SELECT paper FROM works').all()[0] as { paper: string }).paper)) as Paper;
    const sources = { ...row.sources };
    delete sources.journalRecordDoi;
    db.prepare('UPDATE works SET paper = ?').run(JSON.stringify({ ...row, primaryTopic: WORKING_PAPER_TOPIC, topics: [WORKING_PAPER_TOPIC], publicationType: 'report', sources }));
  };
  const row = await journalRowAfter(t, [[article, workingPaper], [workingPaper], [article], [workingPaper]], storedBefore);
  assert.deepEqual(classificationOf(row.json), [ARTICLE_TOPIC.id, [ARTICLE_TOPIC.id], 'article', true, JBES_DOI]);
});

// A batch merges its records of one paper into one row first, which replaces
// nothing in a row the article leads; OpenAlex's own record of the article in
// the batch still does, whatever else the batch lists beside it.
test("OpenAlex retyping the article as an editorial reaches its stored row from a batch that also lists its working paper", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const workingPaper = mapOpenAlexWork({ ...gmmWorkingPaperWork, primary_topic: WORKING_PAPER_TOPIC, topics: [WORKING_PAPER_TOPIC] })!;
  const article = mapOpenAlexWork({ ...gmmArticle, primary_topic: ARTICLE_TOPIC, topics: [ARTICLE_TOPIC] })!;
  const editorialTopic = econTopic('T50001', 'Economic policy commentary');
  const editorial = mapOpenAlexWork({ ...gmmArticle, type: 'editorial', primary_topic: editorialTopic, topics: [editorialTopic] })!;
  for (const batch of [[editorial, workingPaper], [workingPaper, editorial]]) {
    const row = await journalRowAfter(t, [[article, workingPaper], batch]);
    assert.deepEqual(classificationOf(row.json), [editorialTopic.id, [editorialTopic.id], 'editorial', true, JBES_DOI], batch.map(paper => paper.id).join(', '));
  }
});

test('a stored working-paper row upgraded once is not written again when the same records are listed again', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const article = mapOpenAlexWork(gmmArticle)!;
  const { binding, db } = testD1();
  const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
  const now = Date.parse('2026-10-22T03:00:00Z');
  await ingestPapers(store, [{ paper: workingPaper, lanes: ['series:working-papers'] }], { now });
  assert.equal(await ingestPapers(store, [{ paper: article, lanes: ['econ.EM'] }], { now }), 2, 'the merge, then the upgrade');
  const stored = () => (db.prepare('SELECT paper, published FROM works').all() as Array<{ paper: string; published: string }>)[0];
  const upgraded = stored();
  assert.equal(JSON.parse(upgraded.paper).peerReviewed, true);
  assert.equal(await ingestPapers(store, [{ paper: article, lanes: ['econ.EM'] }], { now }), 0);
  assert.deepEqual(stored(), upgraded);
});

// A row that already knows the ids of both versions forms two groups when the
// article comes back retitled beside the working paper: they share no key. Each
// group merges the same stored row, and the last one written stands, so the
// upgrade must not depend on which group comes last. The row can be upgraded
// already, or be one stored before ENG-133 that merged its article and stayed
// the working paper's (here: the working paper's row put back after the
// article's night, its keys left).
test('a row that knows both versions becomes the reviewed journal row when one batch lists its retitled article and its working paper, in either order', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T03:00:00Z') });
  const workingPaper = mapOpenAlexWork(gmmWorkingPaperWork)!;
  const article = mapOpenAlexWork(gmmArticle)!;
  const retitled = mapOpenAlexWork({ ...gmmArticle, title: 'The Efficiency and Pricing Accuracy Trade-Off in GMM Estimation of Linear Asset Pricing Models' })!;
  let workingPaperRow = '';
  const beforeEng133 = (night: number, db: ReturnType<typeof testD1>['db']) => {
    if (night === 0) workingPaperRow = String((db.prepare('SELECT paper FROM works').all()[0] as { paper: string }).paper);
    if (night === 1) db.prepare('UPDATE works SET paper = ?').run(workingPaperRow);
  };
  const rows = [];
  for (const [stored, afterNight] of [['upgraded', undefined], ['stored before ENG-133', beforeEng133]] as const) {
    for (const batch of [[retitled, workingPaper], [workingPaper, retitled]]) {
      const name = `${stored}, ${batch[0].id} first`;
      const row = await journalRowAfter(t, [[workingPaper], [article], batch], afterNight);
      assert.deepEqual(row.shown, [JBES_DOI, `https://doi.org/${JBES_DOI}`, retitled.title, article.abstract, article.journal, true, undefined, '2026-10-14T00:00:00.000Z'], name);
      assert.equal(JSON.parse(row.json).sources.peerReviewedByDoi?.['10.3386/w35104'], false, name);
      rows.push(row.shown);
    }
  }
  assert.deepEqual(rows.slice(1), [rows[0], rows[0], rows[0]]);
});

// The evidence is OpenAlex's own record of the journal article. An OpenAlex
// preprint whose row PubMed's record of it made read reviewed keeps
// `sources.primary: 'openalex'`, yet it is no such record: folded into the
// working paper's row, it leaves the row the working paper's.
test("an OpenAlex preprint's row that PubMed made read reviewed never makes a working paper's row the journal's", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-21T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const preprintDoi = '10.1101/2026.10.01.123456';
  const preprintTitle = 'GMM estimators of linear asset pricing models: the trade-off between efficiency and pricing accuracy';
  const pubmed = (title: string) => mapPubmedSummary({
    uid: '41000000', title, source: 'J Bus Econ Stat', pubdate: '2026 Oct 14', pubtype: ['Journal Article'],
    authors: [{ name: 'Ana Economist' }], articleids: [{ idtype: 'doi', value: preprintDoi }],
  });
  // The working paper's work id decides which of the two stored rows the fold
  // keeps: the preprint's for W7220000104, the working paper's for W7220000105.
  const kept: string[] = [];
  for (const workingPaperId of ['W7220000104', 'W7220000105']) {
    const preprint = mapOpenAlexWork({
      ...seriesWork('W7229990001', preprintDoi, 'preprint', { id: 'S4306402567', display_name: 'medRxiv' }, 'The preprint of this paper compares the efficiency and the pricing accuracy of GMM estimators of linear factor models.'),
      title: preprintTitle, authorships: gmmArticle.authorships, primary_location: { landing_page_url: `https://doi.org/${preprintDoi}`, is_published: false, source: { id: 'https://openalex.org/S4306402567', display_name: 'medRxiv', type: 'repository' } },
    })!;
    const { binding, db } = testD1();
    const store = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
    const nights = [
      [mapOpenAlexWork({ ...gmmWorkingPaperWork, id: `https://openalex.org/${workingPaperId}` })!],
      [preprint, pubmed(preprintTitle)],
      // PubMed lists the paper again under the working paper's title, which
      // joins the two rows.
      [pubmed(gmmArticle.title)],
    ];
    for (const [night, papers] of nights.entries()) {
      t.mock.timers.setTime(first + night * DAY);
      await ingestPapers(store, papers.map(paper => ({ paper, lanes: ['econ.EM'] })), { now: first + night * DAY });
      if (night === 1) {
        const reviewed = (db.prepare('SELECT paper FROM works').all() as Array<{ paper: string }>).map(row => JSON.parse(row.paper) as Paper).find(paper => paper.id === preprint.id)!;
        assert.deepEqual([reviewed.sources.primary, reviewed.peerReviewed, reviewed.workingPaper], ['openalex', true, undefined], 'PubMed made the preprint row read reviewed');
      }
    }
    const works = (db.prepare('SELECT paper FROM works').all() as Array<{ paper: string }>).map(row => JSON.parse(row.paper) as Paper);
    assert.equal(works.length, 1, workingPaperId);
    assert.equal(works[0].openAlexId, undefined, workingPaperId);
    kept.push(works[0].id);
    if (works[0].id !== preprint.id) {
      assert.deepEqual([works[0].doi, works[0].peerReviewed, works[0].workingPaper], ['10.3386/w35104', false, true], workingPaperId);
    }
  }
  assert.deepEqual(kept, ['openalex:W7229990001', 'openalex:W7220000105']);
});

// The cost: up to five pages of 200 on a lane's first night and three on a
// later one, one request a page for all of a leaf's sources.
test("a venue lane reads five pages on its first night and three at most after, and every category lane's first night fits the categories' share", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  const full = (page: number) => Array.from({ length: 200 }, (_, index) => ({
    ...gmmArticle, id: `https://openalex.org/W${page}${String(index).padStart(3, '0')}`, doi: `https://doi.org/10.1/${page}.${index}`, title: `Econometrics of asset pricing, part ${page}-${index}`,
  }));
  // econ.EM's sources list a full page of 200 each time; econ.TH's one article.
  const { urls, env } = relay(t, url => ({ results: sourcesOf(filtersOf(url)).includes(JBES.id) ? full(Number(url.searchParams.get('page'))) : [paretoArticle] }));
  const { binding } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  await harvestLane(store, { source: 'openalex-venues', lane: 'econ.EM' });
  assert.deepEqual(urls.map(url => [url.searchParams.get('page'), url.searchParams.get('per-page')]), [1, 2, 3, 4, 5].map(page => [String(page), '200']));
  t.mock.timers.setTime(Date.parse('2026-10-25T03:00:00Z'));
  await harvestLane(store, { source: 'openalex-venues', lane: 'econ.EM' });
  assert.equal(urls.length, 8, 'a later night reads three pages at most');
  await harvestLane(store, { source: 'openalex-venues', lane: 'econ.TH' });
  assert.equal(urls.length, 9, 'a page short of 200 is the last');
  // Every OpenAlex category lane's first night and the weekly notable lanes',
  // in units of one list call a page, within the 3,000 they may spend a night.
  const firstNight = [...categoryLaneJobs(), ...await notableLaneJobs(binding)].filter(job => job.source.startsWith('openalex-'))
    .reduce((sum, job) => sum + SOURCES[job.source].firstPages, 0);
  assert.ok(firstNight <= 3_000, `${firstNight} units`);
});

// OpenAlex dates every Physics of Fluids article of a month's issue by its
// first day and lists a tied date oldest record first (its own sample in the
// venue evidence: all 2026-10-01, ids ascending), so one indexed late comes
// behind its issue.
test("a venue lane reads its three pages whatever their dates, so an issue's article indexed late, behind two pages of its issue date, is kept", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  const FLUIDS = { id: 'S22862804', display_name: 'Physics of Fluids' };
  const JFM = { id: 'S152000018', display_name: 'Journal of Fluid Mechanics' };
  const article = (n: number, date: string, source: typeof JFM) => journalArticle(`W71${n}`, `10.1063/${n}`, `Turbulent boundary layer study number ${n}`, date, source, null);
  // 200 articles dated within the 14 days before the last run, then the 1
  // October issue, older than those 14 days: 200 records listed before the
  // last run and 50 indexed since.
  const listing = [
    ...Array.from({ length: 200 }, (_, index) => article(10_000 + index, `2026-10-${23 - Math.floor(index / 15)}`, JFM)),
    ...Array.from({ length: 250 }, (_, index) => article(20_000 + index, '2026-10-01', FLUIDS)),
  ];
  const { urls, env } = relay(t, url => {
    const page = Number(url.searchParams.get('page'));
    return { results: listing.slice((page - 1) * 200, page * 200) };
  });
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-venues', 'physics.flu-dyn', '2026-10-23T03:00:00.000Z')").run();
  await harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-venues', lane: 'physics.flu-dyn' });
  assert.deepEqual(urls.map(url => url.searchParams.get('page')), ['1', '2', '3']);
  const stored = new Set(db.prepare('SELECT paper FROM works').all().map(row => (JSON.parse(String((row as { paper: string }).paper)) as { id: string }).id));
  assert.equal(stored.size, 450);
  assert.ok(stored.has('openalex:W7120249'), 'the issue article indexed last');
});

test('a lane pages until the source reaches what the last run had, and records how far it got', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  const work = (id: string, date: string) => ({ ...splicingWork, id: `https://openalex.org/${id}`, doi: `https://doi.org/10.1/${id}`, title: `Paper ${id}`, publication_date: date });
  const pages: Record<string, unknown[]> = {
    // A full first page (200) whose newest paper is new, then a page older than the last run.
    1: Array.from({ length: 200 }, (_, index) => work(`W${1000 + index}`, '2026-10-20')),
    2: [work('W2', '2026-09-01')],
    3: [work('W3', '2026-08-01')],
  };
  const { urls, env } = relay(t, url => ({ results: pages[url.searchParams.get('page')!] || [] }));
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-topics', 'bio.mol', '2026-10-01T00:00:00.000Z')").run();
  await harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-topics', lane: 'bio.mol' });
  assert.deepEqual(urls.map(url => url.searchParams.get('page')), ['1', '2'], 'the second page reached the overlap before the last run');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM works').get() as { n: number }).n, 201);
  assert.deepEqual(db.prepare('SELECT harvested_through FROM lane_state').all().map(row => (row as { harvested_through: string }).harvested_through), ['2026-10-21T05:21:00.000Z']);
});

// Synthetic E-utilities answers: 41 full pages of zoology papers printed this
// month, then a page printed before the corpus window, or this month's papers
// without end. The clock stands still and the pauses between pages end at once.
function pubmedListing(t: import('node:test').TestContext, { endless = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T03:00:00Z') });
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
    queueMicrotask(callback);
    return 0;
  });
  const terms: string[] = [];
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith('/efetch.fcgi')) return new Response('<PubmedArticleSet></PubmedArticleSet>', { headers: { 'content-type': 'text/xml' } });
    if (url.pathname.endsWith('/esearch.fcgi')) {
      terms.push(url.searchParams.get('term')!);
      const page = Number(url.searchParams.get('retstart')) / 50 + 1;
      const idlist = page > 42 && !endless ? [] : Array.from({ length: 50 }, (_, index) => String(100_000 + page * 100 + index));
      return Response.json({ esearchresult: { count: '2100', idlist } });
    }
    const ids = url.searchParams.get('id')!.split(',');
    return Response.json({ result: Object.fromEntries(ids.map(uid => [uid, {
      uid,
      title: `Animal behavior of the hedgehog, study ${uid}`,
      pubdate: Number(uid) >= 104_200 && !endless ? '2026 Mar 1' : '2026 Oct 1',
      pubtype: ['Journal Article'],
      articleids: [{ idtype: 'pubmed', value: uid }],
    }])) });
  });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  return { terms, env: { REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding } as unknown as WorkerEnv };
}

test("a PubMed lane's backfill reads back from where the last run stopped, in a listing that ends at the day it began", async t => {
  const { terms, env } = pubmedListing(t);
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  const job = { source: 'pubmed', lane: 'bio.zoo' } as const;
  const backfill = () => db.prepare('SELECT backfill_until, backfill_page FROM lane_state').get();

  assert.equal(await backfillLane(store, job), 0, 'not before the daily harvest has run the lane');
  assert.equal(terms.length, 0);
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z')").run();

  await backfillLane(store, job);
  assert.equal(terms.length, 5);
  assert.deepEqual({ ...backfill() }, { backfill_until: '2026-10-24', backfill_page: 6 });
  for (let step = 0; step < 7; step += 1) await backfillLane(store, job);
  assert.equal(terms.length, 40);
  // Any record with an abstract, and one without unless it is an editorial, a letter or a comment; the backfill's day last.
  const admitted = ' NOT ((editorial[pt] OR letter[pt] OR comment[pt]) NOT hasabstract)';
  assert.ok(terms.every(term => term.endsWith(`)${admitted} AND 1800/01/01:2026/10/24[edat]`)), terms[0]);
  assert.deepEqual({ ...backfill() }, { backfill_until: '2026-10-24', backfill_page: 41 });

  t.mock.timers.setTime(Date.parse('2026-10-25T03:00:00Z'));
  terms.length = 0;
  await backfillLane(store, job);
  assert.equal(terms.length, 2, 'pages 41 and 42, where the listing passed the corpus window');
  assert.ok(terms.every(term => term.endsWith('1800/01/01:2026/10/24[edat]')), 'the listing still ends at the first day');
  assert.deepEqual({ ...backfill() }, { backfill_until: '2026-10-24', backfill_page: null });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_lanes WHERE lane = 'bio.zoo'").get() as { n: number }).n, 41 * 50);

  terms.length = 0;
  await backfillLane(store, job);
  assert.equal(terms.length, 0, 'a finished backfill asks nothing more');
});

test("a lane's backfill files the older papers it reads with no arrival", async t => {
  const { env } = pubmedListing(t);
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z')").run();
  await backfillLane(store, { source: 'pubmed', lane: 'bio.zoo' });
  const arrivals = (db.prepare("SELECT arrived FROM work_lanes WHERE lane = 'bio.zoo'").all() as Array<{ arrived: string | null }>).map(row => row.arrived);
  assert.ok(arrivals.length > 0, 'filed under the lane');
  assert.deepEqual(arrivals, arrivals.map(() => null));
});

// `/sources/pubmed` turns away a query over 500 characters (`safeSourceQuery`).
test("every PubMed lane's query, a backfill's included, fits the route's 500 characters", async t => {
  const { urls, env } = relay(t, url => (url.pathname.endsWith('/esearch.fcgi') ? { esearchresult: { count: '0', idlist: [] } } : { result: {} }));
  const lanes = categoryLaneJobs().filter(job => job.source === 'pubmed').map(job => job.lane);
  Object.assign(env, { PUBMED_GLOBAL_MINUTE_LIMIT: String(lanes.length) });
  for (const lane of lanes) await SOURCES.pubmed.fetchPage(env, { lane, page: 1, since: '', waits: { seconds: 0 }, until: '2026-10-24' });
  const terms = urls.filter(url => url.pathname.endsWith('/esearch.fcgi')).map(url => url.searchParams.get('term')!);
  assert.equal(terms.length, lanes.length);
  const longest = terms.reduce((a, b) => (b.length > a.length ? b : a));
  assert.ok(longest.length <= 500, `${longest.length} characters: ${longest}`);
});

test("a refused page ends the lane's backfill for the run, which goes on from that page next run", async t => {
  const { terms, env } = pubmedListing(t);
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z')").run();
  await backfillLane({ ...env, PUBMED_GLOBAL_MINUTE_LIMIT: '3', PAPER_STORE: binding }, { source: 'pubmed', lane: 'bio.zoo' });
  assert.equal(terms.length, 3, "the minute's three");
  assert.equal((db.prepare('SELECT backfill_page FROM lane_state').get() as { backfill_page: number }).backfill_page, 4);
});

for (const failure of ['answers with an error', 'cannot be reached'] as const) {
  test(`a backfill whose quota ledger ${failure} asks PubMed nothing and ends at its page, where the next run goes on`, async t => {
    const { terms, env } = pubmedListing(t);
    t.mock.method(console, 'warn', () => {});
    const ledger = env.REQUEST_QUOTA_LEDGER!;
    let down = true;
    const failing = {
      idFromName: (name: string) => ledger.idFromName(name),
      get: (id: Parameters<typeof ledger.get>[0]) => ({
        fetch: async (url: string, init?: RequestInit) => {
          if (down && failure === 'cannot be reached') throw new Error('the ledger cannot be reached');
          if (down) return new Response('down', { status: 500 });
          return ledger.get(id).fetch(url, init);
        },
      }),
    } as unknown as WorkerEnv['REQUEST_QUOTA_LEDGER'];
    const { binding, db } = testD1();
    db.prepare("INSERT INTO lane_state (source, lane, harvested_through, backfill_until, backfill_page) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z', '2026-10-24', 7)").run();
    const store = { ...env, REQUEST_QUOTA_LEDGER: failing, PAPER_STORE: binding } as never;
    const job = { source: 'pubmed', lane: 'bio.zoo' } as const;
    assert.equal(await backfillLane(store, job), 0);
    assert.equal(terms.length, 0);
    assert.equal((db.prepare('SELECT backfill_page FROM lane_state').get() as { backfill_page: number }).backfill_page, 7);
    down = false;
    await backfillLane(store, job);
    assert.equal(terms.length, 5, 'pages 7 to 11: a step releases resources after five pages');
  });
}

for (const failure of ['Worker exceeded CPU time limit.', 'D1_ERROR: out of memory: SQLITE_NOMEM']) {
  test(`a backfill resumes without losing papers after ${failure}`, async t => {
    const { terms, env } = pubmedListing(t);
    const { binding, db } = testD1();
    db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z')").run();
    // A step the Worker stops partway, as its CPU limit does: here a write that throws.
    let batches = 0;
    const cut = { ...binding, prepare: binding.prepare.bind(binding), batch: (statements: D1PreparedStatement[]) => {
      batches += 1;
      if (batches === 5) throw new Error(failure);
      return binding.batch(statements);
    } } as unknown as D1Database;
    await assert.rejects(backfillLane({ ...env, PAPER_STORE: cut }, { source: 'pubmed', lane: 'bio.zoo' }), /Backfill pubmed bio.zoo page 5 could not store 50 records/);
    const reached = terms.length;
    assert.equal(reached, 5);
    assert.equal((db.prepare('SELECT backfill_page FROM lane_state').get() as { backfill_page: number }).backfill_page, reached, 'the page it was cut on');
    await backfillLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'bio.zoo' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM works').get()?.n, 450, 'pages one to nine are stored exactly once');
  });
}

test("a backfill ends at the last page the PubMed route serves, which answers any later one with it", async t => {
  const { terms, env } = pubmedListing(t, { endless: true });
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through, backfill_until, backfill_page) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z', '2026-10-20', 95)").run();
  await backfillLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'bio.zoo' });
  assert.equal(terms.length, 5, 'pages 95 to 99');
  await backfillLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'bio.zoo' });
  assert.equal(terms.length, 6, 'the next step reaches page 100');
  assert.equal((db.prepare('SELECT backfill_page FROM lane_state').get() as { backfill_page: number | null }).backfill_page, null);
});

test('a backfill stops once its lane holds as many papers as the feed reads', async t => {
  const { terms, env } = pubmedListing(t);
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z')").run();
  const insert = db.prepare("INSERT INTO work_lanes (lane, work_id, published) VALUES ('bio.zoo', ?, '2026-10-20')");
  for (let id = 1; id <= FEED_CANDIDATE_LIMIT; id += 1) insert.run(id);
  await backfillLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'bio.zoo' });
  assert.equal(terms.length, 0);
  assert.equal((db.prepare('SELECT backfill_page FROM lane_state').get() as { backfill_page: number | null }).backfill_page, null);
});

// The newest publications Graph lists for a project, as it spells their
// identifiers (synthetic record): a DOI to look up, a handle that is not one.
const PROJECT_PUBLICATIONS = { header: { numFound: 2 }, results: [{ pids: [{ scheme: 'doi', value: '10.1093/Genetics/IYAG290' }, { scheme: 'pmid', value: '41234567' }] }, { pids: [{ scheme: 'handle', value: '11585/952308' }] }] };

test("a followed project's lane asks Graph for its newest publications by id, with the funder only for a bare grant code, then OpenAlex by DOI", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu' ? PROJECT_PUBLICATIONS : { results: [splicingWork] }));
  await SOURCES.openaire.fetchPage(env, { lane: 'project:EC|corda__h2020::0123456789abcdef', page: 1, since: '', waits: { seconds: 0 } });
  await SOURCES.openaire.fetchPage(env, { lane: 'project:NSF|2047484', page: 1, since: '', waits: { seconds: 0 } });
  const openAire = urls.filter(url => url.hostname === 'api.openaire.eu');
  assert.equal(openAire[0].pathname, '/graph/v3/research-products');
  assert.deepEqual(Object.fromEntries(openAire[0].searchParams), {
    relProjectId: 'corda__h2020::0123456789abcdef', type: 'publication', sortBy: 'publicationDate DESC', page: '1', pageSize: '30',
  }, 'an OpenAIRE id names its funder already');
  assert.equal(openAire[1].searchParams.get('relProjectCode'), '2047484');
  assert.equal(openAire[1].searchParams.get('relProjectFundingShortName'), 'NSF');
  assert.ok(urls.some(url => url.hostname === 'api.openalex.org' && url.searchParams.get('filter') === 'doi:10.1093/genetics/iyag290'));
});

test("a project lane whose OpenAIRE answer is not a Graph page fails its turn instead of finding no papers", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu'
    ? { response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:result': { pid: [{ '@classname': 'doi', $: '10.1093/genetics/iyag290' }] } } } }] } } }
    : { results: [splicingWork] }));
  await assert.rejects(SOURCES.openaire.fetchPage(env, { lane: 'project:NSF|2047484', page: 1, since: '', waits: { seconds: 0 } }), /Invalid OpenAIRE response/);
  assert.equal(urls.filter(url => url.hostname === 'api.openalex.org').length, 0);
});

/**
 * Lets `work` finish on the mocked clock. Real event-loop turns let work that
 * takes real time finish (the quota ledger hashes its key on a thread pool).
 * After each turn every pending mocked timer runs and the clock moves to the
 * furthest, so `work` must wait on one timer at a time. Ticking the clock
 * while turns pass counts a slow hash as waiting: a CI run measured 222 s for
 * a lane that waits 60 s.
 */
async function settleOnMockedClock<T>(t: import('node:test').TestContext, work: Promise<T>) {
  let settled = false;
  work.then(() => { settled = true; }, () => { settled = true; });
  // `performance` is not mocked: work that never settles fails here, by name.
  const giveUp = performance.now() + 10_000;
  while (!settled) {
    assert.ok(performance.now() < giveUp, 'the work did not settle in 10 s of real time');
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.runAll();
  }
  return work;
}

test("a lane whose source's minute is full waits for the next minute instead of failing", async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  const { urls, env } = relay(t, () => ({ esearchresult: { idlist: [] } }));
  Object.assign(env, { PUBMED_GLOBAL_MINUTE_LIMIT: '1' });
  const { binding, db } = testD1();
  // A reader's PubMed search takes this minute's one request.
  assert.equal((await handlePubmed(new Request('https://papertok.internal/sources/pubmed?q=heart'), env)).status, 200);
  // The route refuses with a 60 s retry-after, which the lane waits out.
  await settleOnMockedClock(t, harvestLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'med.cardio' }));
  assert.equal(urls.filter(url => url.pathname.endsWith('/esearch.fcgi')).length, 2);
  assert.deepEqual(db.prepare('SELECT source, lane FROM lane_state').all().map(row => ({ ...row })), [{ source: 'pubmed', lane: 'med.cardio' }]);
});

test("a lane waits out one minute's ceiling, not one a page, so a ten-page lane ends inside its harvest step", async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  // Full pages, so the lane would read all ten.
  const idlist = Array.from({ length: 50 }, (_, index) => String(42_000_000 + index));
  const { urls, env } = relay(t, url => (url.pathname.endsWith('/esearch.fcgi') ? { esearchresult: { idlist } } : { result: {} }));
  // One request a minute: every page after the first finds the minute spent by the one before it.
  Object.assign(env, { PUBMED_GLOBAL_MINUTE_LIMIT: '1' });
  const { binding, db } = testD1();
  const started = Date.now();
  // The lane step's timeout (paper-harvest.ts) is ten minutes; the clock shows
  // how long the lane waited before it ended.
  const refusal = await settleOnMockedClock(t, harvestLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'med.cardio' })
    .then(() => null, (error: unknown) => error));
  assert.ok(refusal instanceof SourceRefused, 'the lane ends for this run once it has waited out one minute');
  assert.ok(Date.now() - started <= 2 * 60_000, `the lane took ${(Date.now() - started) / 1000} s`);
  assert.equal(urls.filter(url => url.pathname.endsWith('/esearch.fcgi')).length, 2);
  const firstPage = urls.find(url => url.pathname.endsWith('/esearch.fcgi'))!.searchParams.get('term')!;
  assert.ok(firstPage.endsWith(') NOT ((editorial[pt] OR letter[pt] OR comment[pt]) NOT hasabstract)'), 'a record without an abstract is listed too, unless it is an editorial, a letter or a comment');
  assert.deepEqual(db.prepare('SELECT source, lane FROM lane_state').all(), [], 'its progress is not recorded: the next run reads it again');
});

// Even when enrichment spends the nightly share, a reader's new follow can
// still be harvested that day.
test("followed searches stop at their part of the nightly run's OpenAlex share, category lanes and enrichment keep the rest of it, and new follows keep their own 300", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu' ? PROJECT_PUBLICATIONS : { results: [] }));
  // The shared ledger's own ceilings, out of the way: the harvest's share is what is under test.
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const { binding } = testD1();
  const followedSearch = (newFollow = false) => harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-follows', lane: 'query:graphs', newFollow });
  // A search is ten list calls: the nightly refresh of followed lanes may spend 700 of the harvest's 4,000.
  // A keyword's first harvest is two searches, its weekly listing and the
  // night's novelties; a later one that day is the novelties alone.
  for (let harvest = 0; harvest < 69; harvest += 1) await followedSearch();
  await assert.rejects(followedSearch(), (error: Error & { retryAfterSeconds?: number }) => (error.retryAfterSeconds ?? 0) > 60);
  await assert.rejects(SOURCES.openaire.fetchPage(env, { lane: 'project:NSF|2047484', page: 1, since: '', waits: { seconds: 0 } }), SourceRefused);
  assert.equal(urls.filter(url => url.hostname === 'api.openalex.org').length, 70);
  // A run a new follow started, before the nightly run's enrichment.
  await followedSearch(true);
  // A category's lane is still served, and enrichment after it, up to the
  // nightly run's 3,700 whatever the new follows have spent.
  await SOURCES['openalex-topics'].fetchPage(env, { lane: 'bio.mol', page: 1, since: '', waits: { seconds: 0 } });
  assert.equal(urls.filter(url => url.hostname === 'api.openalex.org').length, 72);
  const enrich = () => handleHarvestOpenAlex(new Request('https://papertok.internal/openalex/works?filter=doi:10.1093/genetics/iyag290&per-page=50'), env);
  for (let call = 0; call < 2_999; call += 1) assert.equal((await enrich()).status, 200);
  // The budget route says so too, with the new follows' 300 not yet spent.
  assert.equal((await readOpenAlexBudget(env)).report!.tiers.feed.open, false);
  assert.equal((await enrich()).status, 429);
  // The rest of the new follows' 300 is still theirs.
  for (let call = 0; call < 29; call += 1) await followedSearch(true);
  await assert.rejects(followedSearch(true), SourceRefused);
});

// The nightly run harvests every category lane and the notable lanes before
// its followed lanes, and the topic lanes alone can ask for more than the
// harvest's 4,000 units.
test("category and notable lanes stop at 3,000 of the harvest's OpenAlex units, so the nightly refresh's 700 and the new follows' 300 are left", async t => {
  const { urls, env } = relay(t, () => ({ results: [] }));
  // The relay's own ceilings, out of the way: the harvest's share and its parts are under test.
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const openAlexCalls = () => urls.filter(url => url.hostname === 'api.openalex.org').length;
  const request = { page: 1, since: '', waits: { seconds: 0 } };
  const topics = () => SOURCES['openalex-topics'].fetchPage(env, { ...request, lane: 'bio.mol' });
  const series = () => SOURCES['openalex-series'].fetchPage(env, { ...request, lane: 'series:working-papers' });
  const notable = () => SOURCES['openalex-notable'].fetchPage(env, { ...request, lane: 'notable:cs.CV' });
  const area = () => SOURCES['openalex-areas'].fetchPage(env, { ...request, lane: 'area:physics' });
  const venues = () => SOURCES['openalex-venues'].fetchPage(env, { ...request, lane: 'econ.EM' });

  for (let call = 0; call < 2_996; call += 1) await topics();
  await series();
  await notable();
  await area();
  await venues();
  await assert.rejects(topics(), SourceRefused);
  await assert.rejects(series(), SourceRefused);
  await assert.rejects(notable(), SourceRefused);
  await assert.rejects(area(), SourceRefused);
  await assert.rejects(venues(), SourceRefused);
  assert.equal(openAlexCalls(), 3_000);

  // The nightly refresh's 700 and the new follows' 300, ten units a search.
  // A keyword's first harvest is two searches, and a later one that day is one.
  const { binding } = testD1();
  const followedSearch = (newFollow: boolean) => harvestLane({ ...env, PAPER_STORE: binding }, { source: 'openalex-follows', lane: 'query:graphs', newFollow });
  for (let harvest = 0; harvest < 69; harvest += 1) await followedSearch(false);
  for (let call = 0; call < 30; call += 1) await followedSearch(true);
  assert.equal(openAlexCalls(), 3_100);

  // The share is spent, and the budget route says so.
  const { report } = await readOpenAlexBudget(env);
  assert.equal(report!.tiers.feed.used, 4_000);
  assert.equal(report!.tiers.feed.open, false);
});

test('a paper a reader liked, looked up by id, stays for them whatever its age, in no lane other readers share', async t => {
  const { urls, env } = relay(t, () => ({ ...splicingWork, publication_date: '2019-05-02', publication_year: 2019 }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as WorkerEnv;
  const now = Date.now();
  await ingestPaperIds(store, ['W7222916812'], { keepUntil: daysFromNow(KEEP_LIKED_DAYS, now), now });
  assert.equal(urls.length, 1);
  assert.equal(db.prepare('SELECT id FROM works').all().length, 1);
  assert.deepEqual(db.prepare('SELECT lane FROM work_lanes').all(), [], "neither its author's nor its topic's readers are offered it");
  await evictExpired(store, now + 86_400_000);
  assert.equal(db.prepare('SELECT id FROM works').all().length, 1, 'the next eviction keeps it');
});

test("a recent paper a reader liked, looked up by id, is filed under its lanes with no arrival, so it does not top other readers' day-by-day feeds", async t => {
  const now = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const { env } = relay(t, () => splicingWork);
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as WorkerEnv;
  await ingestPaperIds(store, ['W7222916812'], { keepUntil: daysFromNow(KEEP_LIKED_DAYS, now), now });
  const lanes = db.prepare('SELECT lane, arrived FROM work_lanes').all() as Array<{ lane: string; arrived: string | null }>;
  assert.ok(lanes.length > 0, 'filed under its lanes');
  assert.deepEqual(lanes.map(row => row.arrived), lanes.map(() => null));
});

// A DOI went into the relay's path as the reader sent it.
test('a DOI a reader sends is looked up as that DOI only: no other record, no added parameters, and parentheses reach OpenAlex', async t => {
  const { urls, env } = relay(t, () => splicingWork);
  const store = { ...env, PAPER_STORE: testD1().binding } as WorkerEnv;
  const lookedUp = async (id: string) => {
    urls.length = 0;
    await ingestPaperIds(store, [id], { keepUntil: daysFromNow(KEEP_LIKED_DAYS) });
    return urls.map(url => `${url.pathname}${[...url.searchParams.keys()].filter(name => name !== 'mailto' && name !== 'api_key').map(name => `?${name}`).join('')}`);
  };
  assert.deepEqual(await lookedUp('10.1000/a/../../authors/A5023888391'), [], 'a path that leaves the work is not asked');
  assert.deepEqual(await lookedUp('doi:10.1000/a/./b'), []);
  assert.deepEqual(await lookedUp('10.1000/a?select=id&per-page=200'), ['/works/doi:10.1000/a%3Fselect%3Did%26per-page%3D200']);
  assert.deepEqual(await lookedUp('10.1000/a#part'), ['/works/doi:10.1000/a%23part']);
  assert.deepEqual(await lookedUp('10.1000/a(%23)b'), ['/works/doi:10.1000/a%28%2523%29b']);
  assert.deepEqual(await lookedUp('doi:10.1000/a%3Fb'), ['/works/doi:10.1000/a%253Fb']);
  assert.deepEqual(await lookedUp('doi:10.1000/a%2Fb'), ['/works/doi:10.1000/a%252Fb']);
  assert.deepEqual(await lookedUp('doi:10.1000/a%25b'), ['/works/doi:10.1000/a%2525b']);
  assert.deepEqual(await lookedUp('10.1002/(SICI)1097-4571(199205)43:4<284::AID-ASI3>3.0.CO;2-0'),
    ['/works/doi:10.1002/%28SICI%291097-4571%28199205%2943:4%3C284::AID-ASI3%3E3.0.CO%3B2-0']);
  assert.deepEqual(paperIdLookup('10.1000/a/../../authors/A5023888391'), null);
  assert.deepEqual(paperIdLookup('doi:10.1093/genetics/iyag290'), { openAlexPath: '/openalex/works/doi:10.1093/genetics/iyag290' });
});

test('DOI lookups use the relay limit of 240 encoded identifier characters', async t => {
  const { urls, env } = relay(t, () => splicingWork);
  const store = { ...env, PAPER_STORE: testD1().binding } as WorkerEnv;
  const doi239 = `10.1000/${'a'.repeat(225)}:b`;
  const doi240 = `10.1000/${'a'.repeat(219)}:,|é`;
  const doi241 = `${doi240}b`;

  await ingestPaperIds(store, [doi239, doi240, doi241], { keepUntil: daysFromNow(KEEP_LIKED_DAYS) });

  assert.deepEqual(urls.map(url => url.pathname).sort(), [
    `/works/doi:10.1000/${'a'.repeat(219)}:,|%C3%A9`,
    `/works/doi:${doi239}`,
  ]);
  assert.equal(paperIdLookup(doi241), null);
});

// PAP-88: readers' searches and profile lists stop at 60 % of the day's
// OpenAlex ceiling, their card batches at 80 %. A followed author, search or
// project asks OpenAlex in those same shapes, and a run started by a new follow
// can come at any hour, so the harvest spends its own share up to 95 %. The
// last 5 % is nobody's since ENG-225: an opened paper stops with everything
// else that is not the harvest, at their own part of the day.
test("readers' closed tiers do not stop the harvest's OpenAlex lanes, and the harvest stops at its 95 % of the day", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu' ? PROJECT_PUBLICATIONS : { results: [] }));
  const ceiling = 1_000;
  const share = (tier: keyof typeof OPENALEX_TIER_PERCENT) => Math.floor(ceiling * OPENALEX_TIER_PERCENT[tier] / 100);
  Object.assign(env, { OPENALEX_GLOBAL_DAILY_LIMIT: String(ceiling) });
  const spendElsewhere = (amount: number) => reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `openalex:day:${new Date().toISOString().slice(0, 10)}`, subject: 'readers', subjectLimit: ceiling, globalLimit: ceiling, amount,
  });
  const follows = (lane: string) => SOURCES['openalex-follows'].fetchPage(env, { lane, page: 1, since: '', waits: { seconds: 0 } });

  // Readers have spent past both of their shares.
  const readers = share('enrichment') + 50;
  await spendElsewhere(readers);
  await follows('author:A5023888391');
  await harvestLane({ ...env, PAPER_STORE: testD1().binding }, { source: 'openalex-follows', lane: 'query:graphs' });
  await SOURCES.openaire.fetchPage(env, { lane: 'project:NSF|2047484', page: 1, since: '', waits: { seconds: 0 } });
  assert.deepEqual(
    urls.filter(url => url.hostname === 'api.openalex.org').map(url => (keywordSearchOf(url) ? 'search' : url.searchParams.get('filter')!.split(':')[0])),
    ['author.id', 'search', 'search', 'doi'],
  );

  // An author page, a keyword's two searches and a DOI list: 22 units. The
  // rest of the harvest's tier goes elsewhere.
  await spendElsewhere(share('feed') - readers - 22);
  await assert.rejects(follows('author:A5000000001'), SourceRefused);
  Object.assign(env, { PDF_RATE_LIMIT_SECRET: 'test-only-pdf-rate-limit-key-32-bytes' });
  const opened = await handleOpenAlex(new Request('https://papertok.internal/openalex/works?filter=doi:10.1093/genetics/iyag290&per-page=1', {
    headers: { 'cf-connecting-ip': '192.0.2.1' },
  }), env);
  assert.equal(opened.status, 429, 'a paper being opened has no part of the day left either');
  assert.equal(opened.headers.get('x-papertok-budget-tier'), 'essential');
});

// The harvest's share is counted in the day's OpenAlex ledger, on a miss only:
// a page an earlier run or another location already stored costs none of it.
test("the harvest reserves its share with the day's OpenAlex ledger, and a stored page reserves nothing", async t => {
  const { urls, env } = relay(t, () => ({ results: [] }));
  const ledger = inMemoryQuotaLedger();
  const entries = new Map<string, { value: string; metadata: unknown }>();
  Object.assign(env, {
    REQUEST_QUOTA_LEDGER: ledger.binding,
    NOTIFICATION_STORE: {
      getWithMetadata: async (key: string) => entries.get(key) ?? { value: null, metadata: null },
      put: async (key: string, value: string, options?: { metadata?: unknown }) => { entries.set(key, { value, metadata: options?.metadata }); },
    },
  });
  const follows = () => SOURCES['openalex-follows'].fetchPage(env, { lane: 'author:A5023888391', page: 1, since: '', waits: { seconds: 0 } });

  await follows();
  await follows();
  assert.equal(urls.length, 1, 'the second page came from the store');
  assert.deepEqual(ledger.calls.map(key => key.split(':').slice(0, 2).join(':')), ['openalex:day']);
});

// ENG-123 (D4, Pablo 2026-10-25): a journal's lane lists its newest
// articles, with or without an abstract, 100 a page: one list call, as a page
// of 50 is. In the 90 days to 2026-10-25 PLOS ONE published 39 articles a day,
// Nature 12, the American Economic Review 0.3. Errata and paratext stay out;
// reviews, which OpenAlex types `review` (every paper of the Annual Review of
// Economics), are listed.
test("a journal's lane asks OpenAlex for the journal's articles and reviews, 100 a page, none dated after today", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T02:40:00Z') });
  const review = {
    id: 'https://openalex.org/W7000000002', type: 'review', title: 'Macroeconomic models of inequality: a review', publication_date: '2026-10-20',
    primary_location: { is_published: true, source: { id: 'https://openalex.org/S2764697018', display_name: 'Annual Review of Economics', type: 'journal' } },
  };
  const { urls, env } = relay(t, () => ({ results: [review] }));
  assert.deepEqual(followedLaneJob('source:S2764697018'), { source: 'openalex-follows', lane: 'source:S2764697018' });
  const { items } = await SOURCES['openalex-follows'].fetchPage(env, { lane: 'source:S2764697018', page: 1, since: '', waits: { seconds: 0 } });
  const [url] = urls;
  assert.deepEqual(filtersOf(url).sort(), ['primary_location.source.id:S2764697018', 'to_publication_date:2026-10-25', 'type:article|review']);
  assert.deepEqual(items.map(item => [item.paper.title, item.lanes]), [['Macroeconomic models of inequality: a review', ['source:S2764697018']]]);
  assert.equal(url.searchParams.get('per-page'), '100');
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc');
});

// ─── Keyword lanes: a followed search, and a custom feed's keyword ───

// A keyword lane has two listings in titles and abstracts: the 50 best matches
// of any year, once a week, whose order the lane keeps as each paper's rank,
// and the 20 best matches of the last 90 days, every night (Nicolás,
// 2026-11-14). A weekly listing has no publication window.
const KEYWORD_NIGHT = Date.parse('2026-11-10T03:00:00Z');
const NIGHT_MS = 86_400_000;
const isCatalogue = (url: URL) => !filtersOf(url).some(filter => filter.startsWith('from_publication_date:'));
const keywordWork = (id: string, date: string) => ({
  ...journalArticle(`W${id}`, `10.1000/keyword.${id}`, `Study ${id} of a charge density wave in a kagome superconductor`, date, JBES,
    `Study ${id} reports a charge density wave in a kagome superconductor and how it competes with the superconducting state.`),
  publication_year: Number(date.slice(0, 4)),
});
const keywordId = (id: string) => `openalex:W${id}`;
// What each of the lane's listings returns tonight; a phrase names 30 papers unless `count` says otherwise.
function keywordLane(t: import('node:test').TestContext, listings: { catalogue?: () => unknown[]; novelties?: () => unknown[]; count?: (url: URL) => number }) {
  t.mock.timers.enable({ apis: ['Date'], now: KEYWORD_NIGHT });
  const { urls, env } = relay(t, url => ({
    meta: { count: listings.count?.(url) ?? 30 },
    results: (isCatalogue(url) ? listings.catalogue?.() : listings.novelties?.()) ?? [],
  }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  return {
    urls,
    db,
    harvest: (lane: string) => harvestLane(store, { source: 'openalex-follows', lane }),
    onNight: (night: number) => t.mock.timers.setTime(KEYWORD_NIGHT + (night - 1) * NIGHT_MS),
    rows: (lane: string) => (db.prepare("SELECT w.paper ->> '$.id' AS id, l.rank, l.arrived FROM work_lanes l JOIN works w ON w.id = l.work_id WHERE l.lane = ? ORDER BY id").all(lane) as Array<{ id: string; rank: number | null; arrived: string | null }>)
      .map(row => ({ ...row })),
    state: (lane: string) => db.prepare("SELECT harvested_through, reading, catalogued_at FROM lane_state WHERE source = 'openalex-follows' AND lane = ?").get(lane) as
      { harvested_through: string; reading: string | null; catalogued_at: string | null } | undefined,
  };
}

test('a keyword lane asks titles and abstracts for the phrase, and keeps the phrase when it fills a screen', async t => {
  const { urls, harvest, state } = keywordLane(t, { count: () => 22 });
  await harvest('query:quadratic funding');
  const [catalogue, novelties] = urls;
  assert.deepEqual(filtersOf(catalogue), ['title_and_abstract.search:"quadratic funding"', 'is_retracted:false', 'type:article|review|conference-paper|preprint']);
  assert.equal(catalogue.searchParams.get('sort'), 'relevance_score:desc');
  assert.equal(catalogue.searchParams.get('per-page'), '50');
  assert.equal(catalogue.searchParams.has('search'), false);
  assert.equal(novelties.searchParams.get('per-page'), '20');
  assert.equal(novelties.searchParams.get('sort'), 'relevance_score:desc');
  assert.ok(filtersOf(novelties).includes('title_and_abstract.search:"quadratic funding"'));
  assert.ok(filtersOf(novelties).includes('from_publication_date:2026-08-12'), 'the last 90 days');
  assert.equal(urls.length, 2);
  assert.equal(state('query:quadratic funding')?.reading, 'phrase');
});

test('a phrase with fewer than 20 papers falls back to loose words, for both listings', async t => {
  const { urls, harvest, state } = keywordLane(t, { count: url => (keywordSearchOf(url)!.includes('"') ? 2 : 38) });
  await harvest('query:lmsr prediction markets');
  assert.deepEqual(urls.map(keywordSearchOf), [
    'title_and_abstract.search:"lmsr prediction markets"',
    'title_and_abstract.search:lmsr prediction markets',
    'title_and_abstract.search:lmsr prediction markets',
  ]);
  assert.deepEqual(urls.map(isCatalogue), [true, true, false]);
  assert.equal(state('query:lmsr prediction markets')?.reading, 'words');
});

test('a one-word keyword is not asked as a phrase', async t => {
  const { urls, harvest } = keywordLane(t, {});
  await harvest('query:kagome');
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => filtersOf(url).includes('title_and_abstract.search:kagome')));
});

test('the any-age listing ranks its papers and none of them arrives as news, on the first night or a later week', async t => {
  let catalogue = [keywordWork('2015', '2015-03-02'), keywordWork('2019', '2019-06-11')];
  const { harvest, onNight, rows } = keywordLane(t, { catalogue: () => catalogue });
  await harvest('query:kagome superconductors');
  assert.deepEqual(rows('query:kagome superconductors'), [
    { id: keywordId('2015'), rank: 1, arrived: null },
    { id: keywordId('2019'), rank: 2, arrived: null },
  ]);
  onNight(8);
  catalogue = [keywordWork('2012', '2012-09-20'), keywordWork('2015', '2015-03-02')];
  await harvest('query:kagome superconductors');
  assert.deepEqual(rows('query:kagome superconductors'), [
    { id: keywordId('2012'), rank: 1, arrived: null },
    { id: keywordId('2015'), rank: 2, arrived: null },
    { id: keywordId('2019'), rank: null, arrived: null },
  ]);
});

test('the catalogue is listed once a week and the novelties every night', async t => {
  const { urls, harvest, onNight } = keywordLane(t, {});
  const callsPerNight: number[] = [];
  for (const night of [1, 2, 8]) {
    onNight(night);
    const before = urls.length;
    await harvest('query:kagome superconductors');
    callsPerNight.push(urls.length - before);
  }
  assert.deepEqual(callsPerNight, [2, 1, 2]);
});

// The nightly run reaches a lane a few minutes earlier or later each night.
test('a catalogue listed late one night is due again a week on, though the run reaches it earlier that night', async t => {
  const { urls, harvest } = keywordLane(t, {});
  t.mock.timers.setTime(KEYWORD_NIGHT + 40 * 60_000);
  await harvest('query:kagome superconductors');
  t.mock.timers.setTime(KEYWORD_NIGHT + 7 * NIGHT_MS);
  await harvest('query:kagome superconductors');
  assert.deepEqual(urls.map(isCatalogue), [true, false, true, false]);
});

test('a novelty published this week arrives today; one that enters the list late, or with the first load, keeps its publication date', async t => {
  const published = (daysBefore: number, night: number) => new Date(KEYWORD_NIGHT + (night - 1 - daysBefore) * NIGHT_MS).toISOString().slice(0, 10);
  let novelties = [keywordWork('7001', published(1, 1))];
  const { harvest, onNight, rows } = keywordLane(t, { novelties: () => novelties });
  await harvest('query:kagome superconductors');
  onNight(2);
  novelties = [keywordWork('7002', published(1, 2)), keywordWork('7003', published(40, 2)), ...novelties];
  await harvest('query:kagome superconductors');
  const tonight = new Date(KEYWORD_NIGHT + NIGHT_MS).toISOString();
  assert.deepEqual(rows('query:kagome superconductors').map(row => [row.id, row.arrived]), [
    [keywordId('7001'), null],
    [keywordId('7002'), tonight],
    [keywordId('7003'), null],
  ]);
});

// For a niche keyword the 50 best matches of any year hold nearly every new paper.
test('a paper published this week that is also among the best matches of any year arrives on the night both list it', async t => {
  let listed: unknown[] = [];
  const { harvest, onNight, rows } = keywordLane(t, { catalogue: () => [...listed, keywordWork('2015', '2015-03-02')], novelties: () => listed });
  await harvest('query:kagome superconductors');
  onNight(8);
  listed = [keywordWork('7008', '2026-11-16')];
  await harvest('query:kagome superconductors');
  assert.deepEqual(rows('query:kagome superconductors'), [
    { id: keywordId('2015'), rank: 2, arrived: null },
    { id: keywordId('7008'), rank: 1, arrived: new Date(KEYWORD_NIGHT + 7 * NIGHT_MS).toISOString() },
  ]);
});

test('a keyword nothing can be searched for finishes its turn without asking OpenAlex', async t => {
  const { urls, harvest, state } = keywordLane(t, {});
  await harvest('query:+++');
  assert.equal(urls.length, 0);
  assert.ok(state('query:+++')?.harvested_through);
});

test('a keyword with filter syntax in it is asked as plain words', async t => {
  const { urls, harvest } = keywordLane(t, { count: () => 0 });
  await harvest('query:p|q, tcp:ip');
  assert.deepEqual(urls.map(keywordSearchOf), ['title_and_abstract.search:"p q tcp ip"', 'title_and_abstract.search:p q tcp ip', 'title_and_abstract.search:p q tcp ip']);
  assert.ok(urls.every(url => filtersOf(url).filter(filter => filter.startsWith('type:')).length === 1));
  assert.ok(urls.every(url => filtersOf(url).length === (isCatalogue(url) ? 3 : 5)), 'no clause beside the search, the retraction, the types and the window');
});

test('an empty catalogue still lists the novelties and ends the first harvest', async t => {
  const { urls, harvest, state } = keywordLane(t, { count: () => 0 });
  await harvest('query:lsmr prediction markets');
  assert.deepEqual(urls.map(isCatalogue), [true, true, false]);
  assert.ok(state('query:lsmr prediction markets')?.harvested_through);
});

test("a weekly listing that fails leaves the ranks and still files the night's novelties", async t => {
  let failing = false;
  let novelties: unknown[] = [];
  const { harvest, onNight, rows, state } = keywordLane(t, {
    catalogue: () => { if (failing) throw new Error('OpenAlex is down'); return [keywordWork('2015', '2015-03-02')]; },
    novelties: () => novelties,
  });
  await harvest('query:kagome superconductors');
  const night1 = new Date(KEYWORD_NIGHT).toISOString();
  onNight(8);
  failing = true;
  novelties = [keywordWork('7008', '2026-11-16')];
  const warned = t.mock.method(console, 'warn', () => undefined);
  await harvest('query:kagome superconductors');
  assert.equal(warned.mock.callCount(), 1);
  assert.deepEqual(rows('query:kagome superconductors').map(row => [row.id, row.rank]), [[keywordId('2015'), 1], [keywordId('7008'), null]]);
  assert.equal(state('query:kagome superconductors')?.catalogued_at, night1, 'due again the next night');
  assert.equal(state('query:kagome superconductors')?.harvested_through, new Date(KEYWORD_NIGHT + 7 * NIGHT_MS).toISOString());
});

test("a first harvest whose night's request fails keeps its weekly listing, which the next harvest does not ask again", async t => {
  let failing = true;
  const { urls, harvest, rows, state } = keywordLane(t, {
    catalogue: () => [keywordWork('2015', '2015-03-02')],
    novelties: () => { if (failing) throw new Error('OpenAlex is down'); return []; },
  });
  await assert.rejects(harvest('query:kagome superconductors'));
  assert.deepEqual(rows('query:kagome superconductors'), [{ id: keywordId('2015'), rank: 1, arrived: null }]);
  assert.deepEqual({ ...state('query:kagome superconductors') }, { harvested_through: '', reading: 'phrase', catalogued_at: new Date(KEYWORD_NIGHT).toISOString() });
  failing = false;
  const before = urls.length;
  await harvest('query:kagome superconductors');
  assert.deepEqual(urls.slice(before).map(isCatalogue), [false]);
  assert.ok(state('query:kagome superconductors')?.harvested_through);
});

test("a keyword's first weekly listing that fails leaves the lane unharvested", async t => {
  const { harvest, state } = keywordLane(t, { catalogue: () => { throw new Error('OpenAlex is down'); } });
  await assert.rejects(harvest('query:kagome superconductors'));
  assert.equal(state('query:kagome superconductors'), undefined);
});

test('a followed author is still harvested by date, 50 a page', async t => {
  const { urls, harvest } = keywordLane(t, {});
  await harvest('author:A1');
  assert.equal(urls[0].searchParams.get('sort'), 'publication_date:desc');
  assert.equal(urls[0].searchParams.get('per-page'), '50');
  assert.equal(keywordSearchOf(urls[0]), undefined);
});

// ─── Notable papers: the most-cited articles of an admitted leaf's last ten years ───

// OpenAlex W2107743791 as returned on 2026-10-23 to cs.LG's notable query,
// most cited first (trimmed, abstract shortened): a closed 2017 article. The
// relabelled gate no longer admits cs.LG, so the tests serve it as the
// listing of cs.CV, which it admits.
const plsiWork = {
  id: 'https://openalex.org/W2107743791',
  doi: 'https://doi.org/10.1145/3130348.3130370',
  title: 'Probabilistic Latent Semantic Indexing',
  type: 'article',
  publication_date: '2017-08-02',
  publication_year: 2017,
  cited_by_count: 3988,
  abstract_inverted_index: invertedIndex('Probabilistic Latent Semantic Indexing is a novel approach to automated document indexing.'),
  authorships: [{ author: { id: 'https://openalex.org/A5102981763', display_name: 'Thomas Hofmann' }, institutions: [] }],
  primary_location: {
    is_oa: false,
    landing_page_url: 'https://doi.org/10.1145/3130348.3130370',
    version: 'publishedVersion',
    source: { id: 'https://openalex.org/S6756005', display_name: 'ACM SIGIR Forum', type: 'journal', is_core: true },
  },
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  primary_topic: subscriptionArticle.primary_topic,
};

test("an admitted leaf's notable lane lists each of the ten completed years before this one, most cited first, and never the current year", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  // OpenAlex lists the recorded work, of 2017, for its own year only.
  const { urls, env } = relay(t, url => ({ results: filtersOf(url).includes('from_publication_date:2017-01-01') ? [plsiWork] : [] }));
  const page = (n: number) => SOURCES['openalex-notable'].fetchPage(env, { lane: 'notable:cs.CV', page: n, since: '', waits: { seconds: 0 } });
  await page(1); await page(10);
  assert.deepEqual(filtersOf(urls[0]).sort(), [
    ...openAlexTopicFilterForLeaf('cs.CV')!.split(','),
    'from_publication_date:2016-01-01',
    'to_publication_date:2016-12-31',
    'is_retracted:false',
    'primary_location.source.is_core:true',
  ].sort());
  assert.ok(filtersOf(urls[0]).includes('from_publication_date:2016-01-01') && filtersOf(urls[0]).includes('to_publication_date:2016-12-31'));
  assert.ok(filtersOf(urls[1]).includes('from_publication_date:2025-01-01') && filtersOf(urls[1]).includes('to_publication_date:2025-12-31'));
  assert.equal(urls[0].searchParams.get('sort'), 'cited_by_count:desc');
  assert.equal(urls[0].searchParams.get('per-page'), '100');
  assert.equal(urls[1].searchParams.get('page'), '1', 'the lane page chooses the year; OpenAlex is asked its first page');
  assert.ok(!filtersOf(urls[0]).some(f => f.startsWith('has_abstract')));
  const { items } = await page(2);
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W2107743791', ['notable:cs.CV']]]);
  const [{ paper }] = items;
  assert.equal(paper.year, 2017);
  assert.equal(paper.citationsCount, 3988);
  assert.equal(paper.citationCountKnown, true);
  assert.equal(paper.openAccess, false, 'a closed article stays closed');
  t.mock.timers.setTime(Date.parse('2027-01-02T03:00:00Z'));
  await page(1);
  assert.ok(filtersOf(urls[3]).includes('from_publication_date:2017-01-01'), 'in January the oldest listed year moves on');
});

// Synthetic variants of the recorded work: `count` distinct articles of one year.
const notableYear = (year: number, count: number) => Array.from({ length: count }, (_, index) => ({
  ...plsiWork,
  id: `https://openalex.org/W9${year}${index}`,
  doi: `https://doi.org/10.1/plsi${year}.${index}`,
  title: `Probabilistic Latent Semantic Indexing, ${year} part ${index}`,
  publication_date: `${year}-08-02`,
  publication_year: year,
}));
const listedYear = (url: URL) => Number(filtersOf(url).find(filter => filter.startsWith('from_publication_date:'))!.slice('from_publication_date:'.length, -'-01-01'.length));

test('a notable lane is ten OpenAlex calls a week, one a year; a short year does not end the lane, and a lapsed listing leaves', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const now = Date.now();
  const { urls, env } = relay(t, url => ({ results: notableYear(listedYear(url), listedYear(url) === 2019 ? 3 : 100) }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, now);
  assert.deepEqual(urls.map(listedYear), [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM work_lanes WHERE lane = 'notable:cs.CV'").get() as { n: number }).n;
  assert.equal(count(), 903, 'up to ten years old and filed, the years after the short one too');
  await evictExpired(store, now + 13 * 86_400_000);
  assert.equal(count(), 903, 'the next weekly listing comes before they lapse');
  await evictExpired(store, now + 15 * 86_400_000);
  assert.equal(count(), 0, 'two weeks unlisted, they leave');
});

test('a page refused mid-lane leaves the lane due again and keeps the pages already stored', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const now = Date.now();
  const { env } = relay(t, url => ({ results: notableYear(listedYear(url), 100) }));
  // Readers have spent all but three units of the harvest tier's share of the day.
  const ceiling = 1_000;
  Object.assign(env, { OPENALEX_GLOBAL_DAILY_LIMIT: String(ceiling) });
  await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `openalex:day:${new Date(now).toISOString().slice(0, 10)}`, subject: 'readers', subjectLimit: ceiling, globalLimit: ceiling,
    amount: Math.floor(ceiling * OPENALEX_TIER_PERCENT.feed / 100) - 3,
  });
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  await assert.rejects(harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, now), SourceRefused);
  assert.deepEqual(db.prepare("SELECT lane FROM lane_state WHERE source = 'openalex-notable'").all(), [], 'the lane is due again');
  const rows = db.prepare("SELECT listed_until FROM work_lanes WHERE lane = 'notable:cs.CV'").all() as Array<{ listed_until: string }>;
  assert.equal(rows.length, 300, 'the three years listed before the refusal stay filed');
  assert.ok(rows.every(row => row.listed_until === daysFromNow(14, now)));
});

test("a notable lane's weekly listing renews its papers' counts, so the enrichment's refresh asks OpenAlex only for one it no longer lists", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // Synthetic variants of the recorded work.
  const dropped = { ...plsiWork, id: 'https://openalex.org/W1000000001', doi: 'https://doi.org/10.5555/left-the-hundred', title: 'An article that has left the most-cited hundred' };
  const newcomer = { ...plsiWork, id: 'https://openalex.org/W1000000002', doi: 'https://doi.org/10.5555/joined-the-hundred', title: 'An article that has joined the most-cited hundred' };
  let listing: unknown[] = [plsiWork, dropped];
  const { urls, env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: listing } : { results: [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, first);
  // That night's enrichment.
  db.prepare('UPDATE works SET enriched_at = ?').run(new Date(first).toISOString());

  // A week on, the listing names one of them again, cited more, and a new one.
  t.mock.timers.setTime(first + 7 * DAY);
  listing = [{ ...plsiWork, cited_by_count: 4100 }, newcomer];
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, first + 7 * DAY);
  const counts = (db.prepare('SELECT paper FROM works').all() as Array<{ paper: string }>).map(row => JSON.parse(row.paper)).map(paper => [paper.id, paper.citationCount]);
  assert.deepEqual(counts.sort(), [['openalex:W1000000001', 3988], ['openalex:W1000000002', 3988], ['openalex:W2107743791', 4100]]);

  // Fourteen days after that first night, the counts it stored come due.
  t.mock.timers.setTime(first + 14 * DAY + 3_600_000);
  urls.length = 0;
  await enrichPending(store, 50, first + 14 * DAY + 3_600_000);
  assert.deepEqual(urls.filter(url => url.hostname === 'api.openalex.org').map(url => url.searchParams.get('filter')), ['openalex:W1000000001']);
  // The new paper still gets its first enrichment: Crossref's type for its DOI.
  const typed = urls.filter(url => url.hostname === 'api.crossref.org').flatMap(url => url.searchParams.get('filter')!.split(','));
  assert.deepEqual(typed.sort(), ['doi:10.5555/joined-the-hundred', 'doi:10.5555/left-the-hundred']);
});

test("a notable lane's listing renews only the papers it returned, though the corpus keeps one it dropped for longer", async t => {
  const DAY = 86_400_000;
  // In January, so that last year's articles are both listed and recent.
  const first = Date.parse('2027-01-05T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // Synthetic variants of the recorded work. A recent article is kept 90 days
  // from its date, past the listing's 14.
  const recent = { ...plsiWork, id: 'https://openalex.org/W1000000003', doi: 'https://doi.org/10.5555/recent-and-cited', title: 'A recent article cited enough to make the hundred', publication_date: '2026-12-20', publication_year: 2026 };
  const newcomer = { ...plsiWork, id: 'https://openalex.org/W1000000002', doi: 'https://doi.org/10.5555/joined-the-hundred', title: 'An article that has joined the most-cited hundred' };
  let listing = [plsiWork, recent];
  // Each year's listing names that year's articles.
  const { env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: listing.filter(work => work.publication_year === listedYear(url)) } : { results: [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  const enrichedAt = () => Object.fromEntries((db.prepare("SELECT paper ->> '$.id' AS id, enriched_at FROM works").all() as Array<{ id: string; enriched_at: string | null }>)
    .map(row => [row.id, row.enriched_at]));
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, first);
  // That night's enrichment.
  const enriched = new Date(first).toISOString();
  db.prepare('UPDATE works SET enriched_at = ?').run(enriched);

  // A week on, the listing names the older one again and a new one, not the recent one.
  const next = first + 7 * DAY;
  t.mock.timers.setTime(next);
  listing = [plsiWork, newcomer];
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, next);
  assert.deepEqual(enrichedAt(), {
    'openalex:W2107743791': new Date(next).toISOString(),
    'openalex:W1000000003': enriched,
    'openalex:W1000000002': null,
  });

  // A listing that returns nothing renews nothing.
  t.mock.timers.setTime(next + 7 * DAY);
  listing = [];
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, next + 7 * DAY);
  assert.deepEqual(enrichedAt(), {
    'openalex:W2107743791': new Date(next).toISOString(),
    'openalex:W1000000003': enriched,
    'openalex:W1000000002': null,
  });
});

test("a notable lane's listing does not renew a paper without an abstract, so the refresh still asks for one", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // A synthetic variant of the recorded work that OpenAlex lists without an abstract.
  const withoutAbstract = { ...plsiWork, id: 'https://openalex.org/W1000000004', doi: 'https://doi.org/10.5555/cited-without-abstract', title: 'A most-cited article OpenAlex lists without its abstract', abstract_inverted_index: null };
  const { env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: [plsiWork, withoutAbstract] } : { results: [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  const enrichedAt = () => Object.fromEntries((db.prepare("SELECT paper ->> '$.id' AS id, enriched_at FROM works").all() as Array<{ id: string; enriched_at: string | null }>)
    .map(row => [row.id, row.enriched_at]));
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, first);
  // That night's enrichment, which found no abstract.
  const enriched = new Date(first).toISOString();
  db.prepare('UPDATE works SET enriched_at = ?').run(enriched);

  const next = first + 7 * DAY;
  t.mock.timers.setTime(next);
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, next);
  assert.deepEqual(enrichedAt(), {
    'openalex:W2107743791': new Date(next).toISOString(),
    'openalex:W1000000004': enriched,
  });
});

// ENG-165: a notable lane can list a journal article and its working paper
// together every week, and each listing renews the row's enrichment date, so
// the refresh never asks OpenAlex for the article. The listing's own record of
// the article must bring OpenAlex's new topic to the row the week it changes.
// Synthetic records under q-fin.GN's topic ids
// (open-alex-leaf-topics.generated.ts); OpenAlex types the FEDS series, a
// listed working-paper series, as a `journal`.
test("a notable lane that lists an article and its working paper every week gives their row the article's new topic the first week it changes", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-21T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  const qfinTopic = (id: string) => ({ id: `https://openalex.org/${id}`, display_name: `Topic ${id}` });
  const article = { ...gmmArticle, publication_date: '2025-10-14', publication_year: 2025, primary_topic: qfinTopic('T10047'), topics: [qfinTopic('T10047')] };
  const fedsLocation = { is_published: true, landing_page_url: 'https://doi.org/10.17016/feds.2025.165', source: { id: 'https://openalex.org/S4210212089', display_name: 'Finance and Economics Discussion Series', type: 'journal', is_core: true } };
  const workingPaper = { ...article, id: 'https://openalex.org/W7220000165', doi: 'https://doi.org/10.17016/feds.2025.165', primary_location: fedsLocation, locations: [fedsLocation] };
  let listedArticle = article;
  const { env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' && listedYear(url) === 2025
    ? { results: [workingPaper, listedArticle] }
    : { results: [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  const lane = { source: 'openalex-notable', lane: 'notable:q-fin.GN' } as const;
  const shown = () => {
    const rows = db.prepare('SELECT paper FROM works').all() as Array<{ paper: string }>;
    return rows.map(row => JSON.parse(row.paper) as Paper).map(paper => [paper.primaryTopic?.id, paper.publicationType, paper.peerReviewed]);
  };
  await harvestLane(store, lane, first);
  await enrichPending(store, 50, first);
  assert.deepEqual(shown(), [['https://openalex.org/T10047', 'article', true]]);

  listedArticle = { ...article, primary_topic: qfinTopic('T10127'), topics: [qfinTopic('T10127')] };
  const weeks = [];
  for (let week = 1; week <= 6; week++) {
    const now = first + week * 7 * DAY;
    t.mock.timers.setTime(now);
    await harvestLane(store, lane, now);
    await enrichPending(store, 50, now);
    weeks.push(shown());
  }
  assert.deepEqual(weeks, Array.from({ length: 6 }, () => [['https://openalex.org/T10127', 'article', true]]));
});

test("a notable lane's listing does not renew a paper with a PubMed id, so the refresh reads PubMed's retraction from Europe PMC", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // A synthetic variant of the recorded work with a PubMed id. OpenAlex's
  // listing keeps it while `is_retracted` stays false; Europe PMC's record
  // types it retracted once PubMed does.
  const inPubmed = { ...plsiWork, id: 'https://openalex.org/W1000000005', doi: 'https://doi.org/10.5555/cited-in-pubmed', title: 'A most-cited article PubMed also indexes', ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/9500320' } };
  let pubType = ['Journal Article'];
  const { urls, env } = relay(t, url => {
    if (url.hostname === 'www.ebi.ac.uk') return { resultList: { result: [{ id: '9500320', source: 'MED', pmid: '9500320', title: inPubmed.title, pubTypeList: { pubType } }] } };
    return url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: [plsiWork, inPubmed] } : { results: [] };
  });
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  const statusAndLanes = () => Object.fromEntries((db.prepare('SELECT id, paper FROM works').all() as Array<{ id: number; paper: string }>).map(row => [
    JSON.parse(row.paper).id,
    [JSON.parse(row.paper).publicationStatus, (db.prepare('SELECT lane FROM work_lanes WHERE work_id = ?').all(row.id) as Array<{ lane: string }>).map(lane => lane.lane)],
  ]));
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, first);
  const enriched = new Date(first).toISOString();
  db.prepare('UPDATE works SET enriched_at = ?').run(enriched);

  const next = first + 7 * DAY;
  t.mock.timers.setTime(next);
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, next);
  const enrichedAt = Object.fromEntries((db.prepare("SELECT paper ->> '$.id' AS id, enriched_at FROM works").all() as Array<{ id: string; enriched_at: string }>).map(row => [row.id, row.enriched_at]));
  assert.deepEqual(enrichedAt, { 'openalex:W2107743791': new Date(next).toISOString(), 'openalex:W1000000005': enriched });

  // PubMed types it retracted; OpenAlex has not caught up and still lists it.
  pubType = ['Journal Article', 'Retracted Publication'];
  const due = first + 14 * DAY + 3_600_000;
  t.mock.timers.setTime(due);
  urls.length = 0;
  await enrichPending(store, 50, due);
  assert.ok(urls.some(url => url.hostname === 'www.ebi.ac.uk'), 'the refresh asks Europe PMC for its PubMed id');
  assert.deepEqual(statusAndLanes(), { 'openalex:W2107743791': ['published', ['notable:cs.CV']], 'openalex:W1000000005': ['retracted', []] });
});

test("a notable lane's listing renews the row a record merged into, and not one whose record it turned away", async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // The recorded work's arXiv version, looked up for a reader: OpenAlex's
  // record shares its DOI. A synthetic variant of the recorded work that
  // OpenAlex lists a week later with a placeholder title.
  const arxiv = arxivRecordPaper({
    arxivId: '1301.6705', title: 'Probabilistic Latent Semantic Indexing', abstract: 'Probabilistic Latent Semantic Indexing is a novel approach to automated document indexing.',
    authors: ['Thomas Hofmann'], categories: ['cs.IR'], doi: '10.1145/3130348.3130370', journalRef: null, comments: null,
    published: '2013-01-23T12:00:00.000Z', updated: '2013-01-23T12:00:00.000Z',
  });
  const untitledLater = { ...plsiWork, id: 'https://openalex.org/W1000000004', doi: 'https://doi.org/10.5555/untitled-later', title: 'An article OpenAlex lists without its title a week later' };
  let listing: unknown[] = [plsiWork, untitledLater];
  const { env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: listing } : { results: [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  const enrichedAt = () => Object.fromEntries((db.prepare("SELECT paper ->> '$.id' AS id, enriched_at FROM works").all() as Array<{ id: string; enriched_at: string | null }>)
    .map(row => [row.id, row.enriched_at]));
  await ingestPapers(store, [{ paper: arxiv, lanes: [] }], { keepUntil: daysFromNow(KEEP_LIKED_DAYS, first), now: first });
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, first);
  const enriched = new Date(first).toISOString();
  db.prepare('UPDATE works SET enriched_at = ?').run(enriched);

  const next = first + 7 * DAY;
  t.mock.timers.setTime(next);
  listing = [plsiWork, { ...untitledLater, title: 'Untitled', cited_by_count: 9999 }];
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, next);
  // The stored record keeps last week's count, so the refresh still comes for it.
  assert.deepEqual(enrichedAt(), { '1301.6705': new Date(next).toISOString(), 'openalex:W1000000004': enriched });
});

test('a notable lane drops a paper 14 days after the listing that last returned it, though a like or its date keeps it in the corpus', async t => {
  const DAY = 86_400_000;
  // In January, so that last year's articles are both listed and recent.
  const first = Date.parse('2027-01-05T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // Synthetic variants of the recorded work: an older one a reader liked, and
  // a recent one its category lane also holds, kept 90 days from its date.
  const liked = { ...plsiWork, id: 'https://openalex.org/W1000000001', doi: 'https://doi.org/10.5555/left-the-hundred', title: 'An article that has left the most-cited hundred' };
  const recent = { ...plsiWork, id: 'https://openalex.org/W1000000003', doi: 'https://doi.org/10.5555/recent-and-cited', title: 'A recent article cited enough to make the hundred', publication_date: '2026-12-20', publication_year: 2026 };
  let listing = [plsiWork, liked, recent];
  // Each year's listing names that year's articles.
  const { env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: listing.filter(work => work.publication_year === listedYear(url)) } : { results: [] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  const lane = { source: 'openalex-notable' as const, lane: 'notable:cs.CV' };
  await ingestPapers(store, [{ paper: mapOpenAlexWork(recent)!, lanes: ['cs.CV'] }], { now: first });
  await harvestLane(store, lane, first);
  const likedWorks = [...(await findWorks(binding, ['openalex:W1000000001'])).values()];
  const ids = (sql: string) => (db.prepare(sql).all() as Array<{ id: string }>).map(row => row.id).sort();
  const members = () => ids("SELECT w.paper ->> '$.id' AS id FROM work_lanes l JOIN works w ON w.id = l.work_id WHERE l.lane = 'notable:cs.CV'");

  // From the next week the listing names only the first. A reader keeps
  // ranking their feed by the one they liked.
  listing = [plsiWork];
  for (const days of [7, 14]) {
    const night = first + days * DAY;
    t.mock.timers.setTime(night);
    await harvestLane(store, lane, night);
    await keepLiked(binding, likedWorks, night);
    await evictExpired(store, night);
  }
  assert.deepEqual(members(), ['openalex:W1000000001', 'openalex:W1000000003', 'openalex:W2107743791'], 'two weeks unlisted, still in the lane');
  const now = first + 15 * DAY;
  t.mock.timers.setTime(now);
  await evictExpired(store, now);
  assert.deepEqual(members(), ['openalex:W2107743791']);
  assert.deepEqual(ids("SELECT paper ->> '$.id' AS id FROM works"), ['openalex:W1000000001', 'openalex:W1000000003', 'openalex:W2107743791'], 'the corpus keeps them');

  // Another reader of cs.CV, who has seen nothing, is offered only the listed one as a notable card.
  const page = await readFeedPage(store, parseFeedRequest({ categories: ['cs.CV'], pageSize: 15, seen: feedSeenFilter([]), notable: 3 }), { now });
  assert.deepEqual(page.map(paper => [paper.id, paper._notable === true]), [['openalex:W1000000003', false], ['openalex:W2107743791', true]]);
});

test('a leaf no sample admitted has no OpenAlex notable listing, and a topic leaf keeps the core-source filter', () => {
  // med.path's topic sample was 3 of 15 on target on 2026-10-26.
  assert.equal(openAlexNotableListingFilter('med.path', 2016), null);
  // cs.MM's journal sample was 3 of 15 on target on 2026-10-26.
  assert.ok(openAlexVenueFilterForLeaf('cs.MM'));
  assert.equal(openAlexNotableListingFilter('cs.MM', 2016), null, 'a venue lane alone does not admit a leaf');
  assert.deepEqual(openAlexNotableListingFilter('cs.CV', 2016)!.split(','), [
    ...openAlexTopicFilterForLeaf('cs.CV')!.split(','),
    'from_publication_date:2016-01-01',
    'to_publication_date:2016-12-31',
    'is_retracted:false',
    'primary_location.source.is_core:true',
  ]);
});

test('a leaf the journal sample admitted lists its journals\' most-cited articles of each year, without the core-source filter', async () => {
  // quant-ph's journal sample was 15 of 15 on target on 2026-10-26.
  const filter = openAlexNotableListingFilter('quant-ph', 2016)!;
  assert.match(filter, /^primary_location\.source\.id:S\d+(?:\|S\d+)*,type:article,/, 'the venue lane\'s journals and types');
  assert.equal(filter, [
    openAlexVenueFilterForLeaf('quant-ph'), 'from_publication_date:2016-01-01', 'to_publication_date:2016-12-31', 'is_retracted:false',
  ].join(','));
  const { binding } = testD1();
  const jobs = await notableLaneJobs(binding, Date.parse('2026-10-30T02:40:00Z'));
  assert.ok(jobs.some(job => job.source === 'openalex-notable' && job.lane === 'notable:quant-ph'));
});

test('a notable job for a leaf without a notable listing fails before asking OpenAlex', async t => {
  const { urls, env } = relay(t, () => ({ results: [] }));
  await assert.rejects(SOURCES['openalex-notable'].fetchPage(env, { lane: 'notable:cs.MM', page: 1, since: '', waits: { seconds: 0 } }), /notable:cs\.MM has no notable listing/);
  assert.equal(urls.length, 0);
});

test('every admitted leaf has a notable lane, asked again once a week has passed', async () => {
  const { binding, db } = testD1();
  const now = Date.parse('2026-10-30T02:40:00Z');
  const lanes = async () => (await notableLaneJobs(binding as never, now)).map(job => `${job.source} ${job.lane}`).filter(job => job.startsWith('openalex-notable '));
  assert.deepEqual(await lanes(), notableLeaves().map(leaf => `openalex-notable notable:${leaf}`), 'the first night lists every lane, by lane id');
  const harvested = db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-notable', ?, ?)");
  // Last week's run reached cs.CV later in the night than this run has.
  harvested.run('notable:cs.CV', '2026-10-23T04:10:00.000Z');
  harvested.run('notable:cs.SE', '2026-10-24T02:35:00.000Z');
  const due = await lanes();
  assert.ok(due.includes('openalex-notable notable:cs.CV'), 'seven days on');
  assert.ok(!due.includes('openalex-notable notable:cs.SE'), 'six days on');
  assert.equal(due.length, notableLeaves().length - 1);
});

// Synthetic ADS records in the shape `fetchAdsNotable` returns; not captured.
const adsDoc = (year: number, index: number, extra: Record<string, unknown> = {}) => ({
  bibcode: `${year}PhRvL.${100 + index}A`,
  title: [`A quantum landmark of ${year}, number ${index}`],
  author: ['Doe, J.'],
  abstract: 'A synthetic abstract about entanglement in many-body systems.',
  year: String(year),
  pubdate: `${year}-03-00`,
  identifier: [`arXiv:${String(year).slice(2)}03.${10000 + index}`],
  arxiv_class: ['quant-ph'],
  citation_count: 1000 - index,
  doctype: 'article',
  ...extra,
});
const adsYear = (url: URL) => Number(url.searchParams.get('q')!.match(/year:(\d{4})/)![1]);
const adsEnv = (env: WorkerEnv) => ({ ...env, NASA_ADS_API_TOKEN: 'ads-test-token' }) as WorkerEnv;

test("an arXiv category's notable lane also lists ADS's most-cited papers of each of the ten years, under the same lane", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  const { urls, env } = relay(t, url => ({ response: { docs: adsYear(url) === 2018 ? [adsDoc(2018, 1)] : [] } }));
  const page = (n: number) => SOURCES['ads-notable'].fetchPage(adsEnv(env), { lane: 'notable:quant-ph', page: n, since: '', waits: { seconds: 0 } });
  await page(1); await page(10);
  assert.deepEqual(urls.map(url => url.searchParams.get('q')), [
    'arxiv_class:"quant-ph" year:2016 doctype:(article OR eprint OR inproceedings)',
    'arxiv_class:"quant-ph" year:2025 doctype:(article OR eprint OR inproceedings)',
  ]);
  assert.equal(urls[0].searchParams.get('sort'), 'citation_count desc');
  assert.equal(urls[0].searchParams.get('rows'), '100');
  const { items } = await page(3);
  assert.deepEqual(items.map(item => [item.paper.arxivId, item.lanes]), [['1803.10001', ['notable:quant-ph']]]);
  assert.equal(items[0].paper.openAccess, true, 'a paper with an arXiv version is open');
});

test('the notable lane of a leaf its ADS sample admitted lists only the papers arXiv files under the leaf first', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  const ranked = [
    adsDoc(2018, 1, { arxiv_class: ['astro-ph.HE', 'nucl-th'] }),
    adsDoc(2018, 2, { arxiv_class: ['nucl-th', 'nucl-ex'] }),
    adsDoc(2018, 3, { arxiv_class: ['hep-ph', 'nucl-th'] }),
    adsDoc(2018, 4, { arxiv_class: ['nucl-th'] }),
  ];
  const { urls, env } = relay(t, url => (url.searchParams.get('fl') === 'bibcode,arxiv_class'
    ? { response: { docs: adsYear(url) === 2018 ? ranked.map(({ bibcode, arxiv_class }) => ({ bibcode, arxiv_class })) : [] } }
    : { response: { docs: ranked.filter(doc => url.searchParams.get('q')!.includes(`"${doc.bibcode}"`)) } }));
  const { items } = await SOURCES['ads-notable'].fetchPage(adsEnv(env), { lane: 'notable:nucl-th', page: 3, since: '', waits: { seconds: 0 } });
  assert.deepEqual(items.map(item => [item.paper.arxivId, item.lanes]), [['1803.10002', ['notable:nucl-th']], ['1803.10004', ['notable:nucl-th']]]);
  assert.equal(urls.length, 2, 'the classes of the year, then the records of its own papers');
});

test('every arXiv category, and no other leaf, has an ADS notable job on its first night', async () => {
  const { binding } = testD1();
  const jobs = await notableLaneJobs(binding, Date.parse('2026-10-30T02:40:00Z'));
  const ads = jobs.filter(job => job.source === 'ads-notable').map(job => job.lane);
  assert.equal(ads.length, 83, 'the 83 leaves that are arXiv categories');
  for (const lane of ['notable:quant-ph', 'notable:cs.RO', 'notable:econ.EM', 'notable:astro-ph.EP', 'notable:physics.plasm-ph', 'notable:cs.CV']) assert.ok(ads.includes(lane), lane);
  for (const lane of ['notable:eess.optics', 'notable:med.onco', 'notable:mech.aero', 'notable:chem.org']) assert.ok(!ads.includes(lane), lane);
});

test('without its token, an ADS notable listing fails before asking ADS', async t => {
  const { urls, env } = relay(t, () => ({ response: { docs: [] } }));
  await assert.rejects(SOURCES['ads-notable'].fetchPage(env, { lane: 'notable:quant-ph', page: 1, since: '', waits: { seconds: 0 } }), /NASA_ADS_API_TOKEN/);
  assert.equal(urls.length, 0);
});

test('a refused ADS listing is not marked harvested, so the lane is listed again the next night', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  t.mock.method(globalThis, 'fetch', async () => new Response('Too many requests', { status: 429 }));
  const { binding, db } = testD1();
  const store = { REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, NASA_ADS_API_TOKEN: 'ads-test-token', PAPER_STORE: binding } as never;
  await assert.rejects(harvestLane(store, { source: 'ads-notable', lane: 'notable:quant-ph' }, Date.now()), SourceRefused);
  assert.deepEqual(db.prepare("SELECT lane FROM lane_state WHERE source = 'ads-notable'").all(), []);
});

test('a paper ADS and OpenAlex both list is one work in the lane, kept until the later listing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const first = Date.now();
  const { env } = relay(t, url => (url.hostname === 'api.adsabs.harvard.edu'
    ? { response: { docs: adsYear(url) === 2017 ? [adsDoc(2017, 1, { doi: ['10.1145/3130348.3130370'], arxiv_class: ['cs.CV'] })] : [] } }
    : { results: filtersOf(url).includes('from_publication_date:2017-01-01') ? [plsiWork] : [] }));
  const { binding, db } = testD1();
  const store = { ...adsEnv(env), PAPER_STORE: binding } as never;
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, first);
  await harvestLane(store, { source: 'ads-notable', lane: 'notable:cs.CV' }, first + 86_400_000);
  const rows = db.prepare("SELECT listed_until FROM work_lanes WHERE lane = 'notable:cs.CV'").all() as Array<{ listed_until: string }>;
  assert.deepEqual(rows.map(row => row.listed_until), [daysFromNow(14, first + 86_400_000)]);
});

test('a year with no ADS papers does not end the lane', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  const { urls, env } = relay(t, url => ({ response: { docs: adsYear(url) === 2016 ? [] : [adsDoc(adsYear(url), 1)] } }));
  const { binding, db } = testD1();
  await harvestLane({ ...adsEnv(env), PAPER_STORE: binding }, { source: 'ads-notable', lane: 'notable:quant-ph' }, Date.now());
  assert.deepEqual(urls.map(adsYear), [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_lanes WHERE lane = 'notable:quant-ph'").get() as { n: number }).n, 9);
});

// PubMed's records and the preprint servers', without retracted papers and the
// notices, errata and opinion pieces around research.
const europePmcRecords = '(SRC:MED OR SRC:PPR) NOT PUB_TYPE:"retracted publication" NOT PUB_TYPE:"retraction of publication" NOT PUB_TYPE:"published erratum" NOT ((PUB_TYPE:"editorial" OR PUB_TYPE:"letter" OR PUB_TYPE:"comment") AND HAS_ABSTRACT:n)';
// Synthetic Europe PMC search records in the shape the core search returns; not captured.
const europePmcRecord = (index: number, extra: Record<string, unknown> = {}) => ({
  id: String(29000000 + index), source: 'MED', pmid: String(29000000 + index), doi: `10.5555/genetics.${index}`,
  title: `A genetics landmark, number ${index}`, abstractText: 'A synthetic abstract about genome-wide association studies of complex traits.',
  authorString: 'Doe J, Roe R.', firstPublicationDate: '2018-03-14', pubYear: '2018', citedByCount: 5000 - index,
  ...extra,
});

test("a medicine or biology leaf's notable lane lists Europe PMC's most-cited records of each year that its sampled query matches", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  const { urls, env } = relay(t, () => ({ resultList: { result: [europePmcRecord(1)] } }));
  const page = (n: number) => SOURCES['europepmc-notable'].fetchPage(env, { lane: 'notable:med.onco', page: n, since: '', waits: { seconds: 0 } });
  await page(1);
  const { items } = await page(3);
  assert.deepEqual(urls.map(url => `${url.origin}${url.pathname}`), Array(2).fill('https://www.ebi.ac.uk/europepmc/webservices/rest/search'));
  // med.onco's sample asked its label, as the category lanes do.
  assert.deepEqual(urls.map(url => url.searchParams.get('query')), [
    `(TITLE_ABS:"Oncology" OR KW:"Oncology") AND FIRST_PDATE:[2016-01-01 TO 2016-12-31] AND ${europePmcRecords} sort_cited:y`,
    `(TITLE_ABS:"Oncology" OR KW:"Oncology") AND FIRST_PDATE:[2018-01-01 TO 2018-12-31] AND ${europePmcRecords} sort_cited:y`,
  ]);
  assert.deepEqual(['pageSize', 'resultType', 'format'].map(name => urls[0].searchParams.get(name)), ['100', 'core', 'json']);
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['pmid:29000001', ['notable:med.onco']]]);
});

test('a leaf whose MeSH or journal sample passed lists with that query, not with its label', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  const { urls, env } = relay(t, () => ({ resultList: { result: [] } }));
  for (const leaf of ['med.surg', 'med.path']) {
    await SOURCES['europepmc-notable'].fetchPage(env, { lane: `notable:${leaf}`, page: 10, since: '', waits: { seconds: 0 } });
  }
  const [surgery, pathology] = urls.map(url => url.searchParams.get('query')!);
  // med.surg's sample asked MeSH descriptors on 2026-10-26, med.path's its journals.
  assert.ok(surgery.startsWith('(KW:"General Surgery" OR KW:"Surgeons" OR KW:"Surgical Procedures"'), surgery);
  assert.ok(pathology.startsWith('(ISSN:"0893-3952" OR ISSN:"0147-5185"'), pathology);
  for (const query of [surgery, pathology]) {
    assert.ok(!query.includes('TITLE_ABS'), 'no label text');
    assert.ok(query.endsWith(`) AND FIRST_PDATE:[2025-01-01 TO 2025-12-31] AND ${europePmcRecords} sort_cited:y`), query);
  }
});

test('a Europe PMC notable job for a leaf no sample admitted fails before asking Europe PMC', async t => {
  const { urls, env } = relay(t, () => ({ resultList: { result: [europePmcRecord(1)] } }));
  // bio.gen's sample was 7 of 15 on target on 2026-10-26.
  await assert.rejects(SOURCES['europepmc-notable'].fetchPage(env, { lane: 'notable:bio.gen', page: 1, since: '', waits: { seconds: 0 } }), /notable:bio\.gen has no Europe PMC notable listing/);
  assert.deepEqual(urls, []);
});

test('every medicine and biology leaf the Europe PMC sample admitted, and no other leaf, has a Europe PMC notable job', async () => {
  const { binding } = testD1();
  const lanes = (await notableLaneJobs(binding, Date.parse('2026-10-30T02:40:00Z'))).filter(job => job.source === 'europepmc-notable').map(job => job.lane);
  const coverage = gateFile('europepmc-notable-coverage.json') as Array<{ leaf: string; status: string }>;
  assert.deepEqual(lanes, coverage.filter(row => row.status === 'passed').map(row => `notable:${row.leaf}`).sort());
  // med.onco's sample was 14 of 15 on target on 2026-10-26, bio.physio's 0,
  // med.psych's 14 of a label that matches 57 records.
  assert.ok(lanes.includes('notable:med.onco'));
  for (const lane of ['notable:bio.physio', 'notable:med.psych', 'notable:cs.CV']) assert.ok(!lanes.includes(lane), lane);
});

test('a year with no Europe PMC records does not end the lane', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  const yearOf = (url: URL) => Number(url.searchParams.get('query')!.match(/FIRST_PDATE:\[(\d{4})-/)![1]);
  const { urls, env } = relay(t, url => ({ resultList: { result: yearOf(url) === 2016 ? [] : [europePmcRecord(yearOf(url), { firstPublicationDate: `${yearOf(url)}-03-14` })] } }));
  const { binding, db } = testD1();
  await harvestLane({ ...env, PAPER_STORE: binding }, { source: 'europepmc-notable', lane: 'notable:med.onco' }, Date.now());
  assert.deepEqual(urls.map(yearOf), [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_lanes WHERE lane = 'notable:med.onco'").get() as { n: number }).n, 9);
});

test('a preprint Europe PMC and bioRxiv both list is one work, in the notable lane and the category lane', async t => {
  const now = Date.parse('2026-10-26T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const doi = '10.1101/2018.03.14.123456';
  const preprint = europePmcRecord(2, { id: 'PPR12345', source: 'PPR', pmid: undefined, doi, firstPublicationDate: '2018-03-14' });
  const { env } = relay(t, () => ({ resultList: { result: [preprint] } }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  await ingestPapers(store, [{ paper: mapBioRxivPaper({ doi, title: preprint.title, abstract: preprint.abstractText, authors: 'Doe, J.', category: 'microbiology', date: '2018-03-14', version: '1' })!, lanes: ['bio.micro'] }], { keepUntil: daysFromNow(14, now), now });
  await harvestLane(store, { source: 'europepmc-notable', lane: 'notable:bio.micro' }, now);
  const rows = db.prepare('SELECT work_id, lane FROM work_lanes ORDER BY lane').all() as Array<{ work_id: number; lane: string }>;
  assert.deepEqual(rows.map(row => row.lane), ['bio.micro', 'notable:bio.micro']);
  assert.equal(new Set(rows.map(row => row.work_id)).size, 1);
  assert.deepEqual(db.prepare("SELECT paper ->> '$.publicationStatus' AS status FROM works").all().map(row => row.status), ['preprint'], 'still a preprint after the Europe PMC listing');
});

test('a leaf the notable sample admitted gets a notable lane asking for its sampled topics, and no topic lane', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T03:00:00Z') });
  const { binding } = testD1();
  const lanes = (await notableLaneJobs(binding as never)).filter(job => job.source === 'openalex-notable').map(job => job.lane);
  assert.deepEqual(lanes, notableLeaves().map(leaf => `notable:${leaf}`), 'the topic-lane leaves and the notable-sample leaves, no others');
  const { urls, env } = relay(t, () => ({ results: [] }));
  for (const [leaf, topics] of Object.entries(OPENALEX_NOTABLE_LEAF_TOPICS)) {
    assert.ok(!topicLanes().includes(leaf), `${leaf} gets no topic lane`);
    assert.equal(openAlexTopicFilterForLeaf(leaf), null);
    await SOURCES['openalex-notable'].fetchPage(env, { lane: `notable:${leaf}`, page: 10, since: '', waits: { seconds: 0 } });
    const filters = filtersOf(urls.at(-1)!);
    assert.deepEqual(topicsOf(filters), [...topics].sort(), `${leaf}'s listing asks for the topics its sample found on target`);
    assert.ok(filters.includes('type:article') && filters.includes('from_publication_date:2025-01-01'));
  }
  // A topic-lane leaf's notable lane asks for its topic lane's topics.
  assert.equal(openAlexNotableFilterForLeaf('cs.CV'), openAlexTopicFilterForLeaf('cs.CV'));
  assert.equal(openAlexNotableFilterForLeaf('nlin.CD'), null, 'a leaf neither sample admitted has no lane');
});

// The generators propose each sample over the years the lane lists, and check
// a review's query against its capture year; both are written apart from the
// Worker, so this ties them to the lane's own years.
test("a notable sample's query covers the ten completed years the lane lists, before its capture year", () => {
  const { year, leaves } = gateFile('openalex-notable-candidates.json') as { year: number; leaves: Array<{ leaf: string; sampleUrl?: string }> };
  const reviews = gateFile('openalex-notable-reviews.json') as Record<string, { capturedAt: string; query: string }>;
  const queries = [
    ...leaves.filter(row => row.sampleUrl).map(row => ({ leaf: row.leaf, url: row.sampleUrl!, now: Date.UTC(year, 5, 1) })),
    ...Object.entries(reviews).map(([leaf, review]) => ({ leaf, url: review.query, now: Date.parse(review.capturedAt) })),
  ];
  assert.ok(queries.length > 0);
  for (const { leaf, url, now } of queries) {
    const filters = filtersOf(new URL(url));
    assert.ok(filters.includes(`from_publication_date:${notableListedYear(1, now)}-01-01`), `${leaf} starts at the oldest listed year`);
    assert.ok(filters.includes(`to_publication_date:${notableListedYear(NOTABLE_YEARS, now)}-12-31`), `${leaf} ends with the last completed year`);
    assert.ok(filters.includes('type:article') && filters.includes('is_retracted:false') && filters.includes('primary_location.source.is_core:true'));
  }
  // A journal notable sample asks the venue lane's own types and no core filter.
  const { notableSamples } = gateFile('openalex-venue-reviews.json') as { notableSamples: Record<string, { capturedAt: string; query: string }> };
  for (const [leaf, sample] of Object.entries(notableSamples)) {
    const now = Date.parse(sample.capturedAt);
    const filters = filtersOf(new URL(sample.query));
    assert.ok(filters.includes(`from_publication_date:${notableListedYear(1, now)}-01-01`), `${leaf} starts at the oldest listed year`);
    assert.ok(filters.includes(`to_publication_date:${notableListedYear(NOTABLE_YEARS, now)}-12-31`), `${leaf} ends with the last completed year`);
  }
});

test('a night re-lists eight due notable lanes, or a seventh of them once there are more than 56, so every lane stays weekly', () => {
  assert.equal(notableLanesPerNight(39), NOTABLE_LANES_PER_NIGHT);
  assert.equal(notableLanesPerNight(56), 8);
  assert.equal(notableLanesPerNight(57), 9);
  assert.equal(notableLanesPerNight(149), 22);
});

test("a night lists every never-harvested notable job, then each source's share of its jobs due again, the longest unlisted first", async () => {
  const now = Date.parse('2026-10-30T02:40:00Z');
  const nightWith = async (rows: Array<[string, string]>) => {
    const { binding, db } = testD1();
    const harvested = db.prepare('INSERT INTO lane_state (source, lane, harvested_through) VALUES (?, ?, ?)');
    for (const [job, through] of rows) harvested.run(...job.split(' '), through);
    return (await notableLaneJobs(binding, now)).map(job => `${job.source} ${job.lane}`);
  };
  // The first night: OpenAlex's lanes, then ADS's, then Europe PMC's, each by lane id.
  const jobs = await nightWith([]);
  const openAlex = jobs.filter(job => job.startsWith('openalex-notable '));
  const ads = jobs.filter(job => job.startsWith('ads-notable '));
  const europePmc = jobs.filter(job => job.startsWith('europepmc-notable '));
  assert.deepEqual(jobs, [...notableLeaves().map(leaf => `openalex-notable notable:${leaf}`), ...[...ads].sort(), ...[...europePmc].sort()]);
  const share = (source: string[]) => notableLanesPerNight(source.length);
  // Harvested eight days ago, each a minute after the next job, so the longest unlisted is the last job.
  const eightDaysAgo = (index: number) => new Date(Date.parse('2026-10-22T03:00:00Z') + (jobs.length - index) * 60_000).toISOString();
  const fresh = 'ads-notable notable:quant-ph';
  const others = (source: string[]) => source.filter(job => job !== fresh);

  assert.deepEqual(
    await nightWith(jobs.filter(job => job !== fresh).map(job => [job, '2026-10-22T03:00:00.000Z'])),
    [fresh, ...others(openAlex).slice(0, share(openAlex)), ...others(ads).slice(0, share(ads)), ...europePmc.slice(0, share(europePmc))],
    'the new job, then each source\'s share of those due again, a tie by source and lane id',
  );
  // The later sources' jobs are the oldest, as when their listings keep
  // failing: OpenAlex still gets its own share.
  assert.deepEqual(
    await nightWith(jobs.map((job, index) => [job, eightDaysAgo(index)])),
    [...europePmc.slice(-share(europePmc)).reverse(), ...ads.slice(-share(ads)).reverse(), ...openAlex.slice(-share(openAlex)).reverse()],
    'each source\'s share of its own jobs due again, the oldest harvest first',
  );
  assert.deepEqual(await nightWith(jobs.map(job => [job, '2026-10-27T03:00:00.000Z'])), [], 'none harvested in the last six days');
});

test('OpenReview harvest marks accepted venues and preserves the original submission text', async t => {
  const main = 'ICLR.cc/2026/Conference';
  const venues = [
    ['ICLR 2026 Poster', main], ['Submitted to ICLR 2026', main], ['Withdrawn from ICLR 2026', main],
    ['Rejected at ICLR 2026', main], ['ICLR 2026 Workshop', main], ['ICLR 2026', `${main}/Submission`],
    ['ICLR 2026 Poster'], ['AAAI 2026 Oral', 'AAAI.cc/2026/Conference'], ['AAAI 2026', 'AAAI.cc/2026/Conference'],
  ];
  const { env } = relay(t, () => ({ notes: venues.map(([venue, venueId], i) => ({
    id: `note-${i}`, domain: main, cdate: Date.UTC(2026, 1, 12),
    content: { title: { value: `Manuscript ${i}` }, venue: { value: venue }, ...(venueId && { venueid: { value: venueId } }) },
  })) }));
  const { items } = await SOURCES.openreview.fetchPage(env, { lane: 'cs.LG', page: 1, since: '', waits: { seconds: 0 } });
  assert.deepEqual(items.map(({ paper }) => paper.conference), venues.map(([venue]) => venue));
  assert.deepEqual(items.map(({ paper }) => paper.acceptedConference), [
    { id: 'S4306419637', label: 'ICLR', year: 2026, evidence: 'openreview' },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { id: 'S4210191458', label: 'AAAI', year: 2026, evidence: 'openreview' },
  ]);
});

test('relisting a withdrawn OpenReview submission removes its previous venue evidence from the corpus', async t => {
  let venue = 'ICLR 2026 Oral';
  const { env } = relay(t, () => ({ notes: [{ id: 'revised-note', cdate: Date.UTC(2026, 2, 1),
    content: { title: 'A synthetic venue correction', venue, venueid: 'ICLR.cc/2026/Conference' } }] }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding };
  const fileNotes = async (now: number) => {
    const { items } = await SOURCES.openreview.fetchPage(env, { lane: 'cs.LG', page: 1, since: '', waits: { seconds: 0 } });
    await ingestPapers(store, items, { now });
    return db.prepare("SELECT paper ->> '$.acceptedConference.label' AS venue, paper ->> '$.corpusUpdatedAt' AS revision FROM works").get();
  };
  const first = Date.UTC(2026, 2, 15);
  const startedEarlier = first - 1000;
  assert.deepEqual({ ...await fileNotes(first) }, { venue: 'ICLR', revision: first });
  venue = 'Withdrawn from ICLR 2026';
  assert.deepEqual({ ...await fileNotes(startedEarlier) }, { venue: null, revision: first + 1 });
});

test('repeated arXiv listings cannot give a different edition to an OpenReview venue', async () => {
  const { db, binding } = testD1();
  const record = parseOaiPage(OAI_PAGE).papers[0];
  const paper = arxivRecordPaper({ ...record, comments: 'Accepted at ICLR 2026' });
  const venue = { id: 'S4306419637', label: 'ICLR', evidence: 'openreview' as const };
  const file = async (record: Paper) => {
    await ingestPapers({ PAPER_STORE: binding }, [{ paper: record, lanes: [] }], { keepUntil: '2026-12-01' });
    return (JSON.parse(String(db.prepare('SELECT paper FROM works').get()?.paper)) as Paper).acceptedConference;
  };
  await file({ ...paper, sources: { primary: 'openreview', enrichedBy: [] }, openReviewVenueId: 'ICLR.cc/2025/Conference',
    acceptedConference: { ...venue, year: 2025 } });
  assert.deepEqual(await file(paper), venue);
  assert.deepEqual(await file(paper), venue);
});
