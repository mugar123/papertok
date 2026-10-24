import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { SOURCES, SourceRefused, WORKING_PAPER_SERIES_IDS, backfillLane, categoryLaneJobs, harvestLane, ingestPaperIds, notableLaneJobs, parseOaiPage, splitRawAuthors } from './paper-sources.ts';
import { FEED_CANDIDATE_LIMIT, KEEP_LIKED_DAYS, daysFromNow, evictExpired, findWorks, ingestPapers, keepLiked, parseFeedRequest, readFeedPage } from './paper-store.ts';
import { enrichPending } from './paper-enrichment.ts';
import { handleHarvestOpenAlex, handleOpenAlex } from './openalex-api.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { OPENALEX_TIER_PERCENT, readOpenAlexBudget } from './provider-runtime.ts';
import { parseXmlDocument } from './xml-dom.ts';
import { handlePubmed } from './source-api.ts';
import { testD1 } from './test-support/sqlite-d1.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { parseXmlDocument as parseWithShim } from '../src/test-support/xml-dom-shim.ts';
import { readPubmedEfetch } from '../src/utils/pubmed-efetch.ts';
import { areaLabelForPaper, leavesForOpenAlexTopic, openAlexTopicFilterForLeaf } from '../src/utils/area-accent.ts';
import { getCategoryArea } from '../src/data/category-taxonomy.ts';
import { mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { hasUsableAIAbstract } from '../src/utils/ai-explanation-access.ts';
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
    return Response.json(answer(url));
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
  for (const filter of ['type:article', 'has_abstract:true', 'is_retracted:false', 'primary_location.source.is_core:true', 'to_publication_date:2026-10-21']) {
    assert.ok(filters.includes(filter), filter);
  }
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W7222916812', ['bio.mol']]]);
  assert.equal(items[0].paper.primaryCategory, undefined, 'filed under the lane, not given it as its field');

  // Aerospace conference papers were 19 of 20 relevant in the gate; structural ones 0 of 2.
  await SOURCES['openalex-topics'].fetchPage(env, { lane: 'mech.aero', page: 1, since: '', waits: { seconds: 0 } });
  assert.ok(filtersOf(urls[1]).includes('type:article|conference-paper'));
});

// ─── Which leaves get an OpenAlex topic lane: the precision gate's decisions ───

const gateFile = (name: string) => JSON.parse(readFileSync(new URL(`../scripts/data/${name}`, import.meta.url), 'utf8'));
const topicLanes = () => categoryLaneJobs().filter(job => job.source === 'openalex-topics').map(job => job.lane);
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
    for (const filter of ['type:article', 'has_abstract:true', 'is_retracted:false', 'primary_location.source.is_core:true']) {
      assert.ok(filters.includes(filter) && sampled.includes(filter), `${leaf}: ${filter}`);
    }
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
  // mechanical or civil work, and Economics as economics unless it is finance:
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
test('the areas the feed fills from arXiv get a journal lane, but statistics; medicine and biology, whose every leaf PubMed serves, do not', () => {
  const lanes = categoryLaneJobs().filter(job => job.source === 'openalex-areas').map(job => job.lane).sort();
  assert.deepEqual(lanes, ['area:chemeng', 'area:civil', 'area:cs', 'area:econ', 'area:eess', 'area:math', 'area:mech', 'area:physics', 'area:q-fin']);
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
  assert.equal(terms.length, 20);
  assert.deepEqual({ ...backfill() }, { backfill_until: '2026-10-24', backfill_page: 21 });
  await backfillLane(store, job);
  assert.equal(terms.length, 40);
  assert.ok(terms.every(term => term.endsWith(' AND hasabstract AND 1800/01/01:2026/10/24[edat]')));
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

test("a refused page ends the lane's backfill for the run, which goes on from that page next run", async t => {
  const { terms, env } = pubmedListing(t);
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z')").run();
  await backfillLane({ ...env, PUBMED_GLOBAL_MINUTE_LIMIT: '5', PAPER_STORE: binding }, { source: 'pubmed', lane: 'bio.zoo' });
  assert.equal(terms.length, 5, "the minute's five");
  assert.equal((db.prepare('SELECT backfill_page FROM lane_state').get() as { backfill_page: number }).backfill_page, 6);
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
    assert.equal(terms.length, 20, 'pages 7 to 26: a step reads 20 pages');
  });
}

test('a backfill step cut short goes on next time from the page after the last one stored', async t => {
  const { terms, env } = pubmedListing(t);
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z')").run();
  // A step the Worker stops partway, as its CPU limit does: here a write that throws.
  let batches = 0;
  const cut = { ...binding, prepare: binding.prepare.bind(binding), batch: (statements: D1PreparedStatement[]) => {
    batches += 1;
    if (batches === 5) throw new Error('Worker exceeded CPU time limit.');
    return binding.batch(statements);
  } } as unknown as D1Database;
  await assert.rejects(backfillLane({ ...env, PAPER_STORE: cut }, { source: 'pubmed', lane: 'bio.zoo' }));
  const reached = terms.length;
  assert.ok(reached > 1);
  assert.equal((db.prepare('SELECT backfill_page FROM lane_state').get() as { backfill_page: number }).backfill_page, reached, 'the page it was cut on');
});

test("a backfill ends at the last page the PubMed route serves, which answers any later one with it", async t => {
  const { terms, env } = pubmedListing(t, { endless: true });
  const { binding, db } = testD1();
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through, backfill_until, backfill_page) VALUES ('pubmed', 'bio.zoo', '2026-10-24T03:00:00.000Z', '2026-10-20', 95)").run();
  await backfillLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'bio.zoo' });
  assert.equal(terms.length, 6, 'pages 95 to 100');
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

test("a followed project's lane asks OpenAIRE by its id, with the funder only for a bare grant code, then OpenAlex by DOI", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu'
    ? { response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:result': { pid: [{ '@classname': 'Digital Object Identifier', $: 'https://doi.org/10.1093/Genetics/IYAG290' }] } } } }] } } }
    : { results: [splicingWork] }));
  await SOURCES.openaire.fetchPage(env, { lane: 'project:EC|corda__h2020::0123456789abcdef', page: 1, since: '', waits: { seconds: 0 } });
  await SOURCES.openaire.fetchPage(env, { lane: 'project:NSF|2047484', page: 1, since: '', waits: { seconds: 0 } });
  const openAire = urls.filter(url => url.hostname === 'api.openaire.eu');
  assert.equal(openAire[0].searchParams.get('openaireProjectID'), 'corda__h2020::0123456789abcdef');
  assert.equal(openAire[0].searchParams.has('funder'), false, 'an OpenAIRE id names its funder already');
  assert.equal(openAire[1].searchParams.get('projectID'), '2047484');
  assert.equal(openAire[1].searchParams.get('funder'), 'NSF');
  assert.ok(urls.some(url => url.hostname === 'api.openalex.org' && url.searchParams.get('filter') === 'doi:10.1093/genetics/iyag290'));
});

test("a lane whose source's minute is full waits for the next minute instead of failing", async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-21T05:21:00Z') });
  const { urls, env } = relay(t, () => ({ esearchresult: { idlist: [] } }));
  Object.assign(env, { PUBMED_GLOBAL_MINUTE_LIMIT: '1' });
  const { binding, db } = testD1();
  // A reader's PubMed search takes this minute's one request.
  assert.equal((await handlePubmed(new Request('https://papertok.internal/sources/pubmed?q=heart'), env)).status, 200);
  let settled = false;
  const harvest = harvestLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'med.cardio' }).finally(() => { settled = true; });
  // The route refuses with a 60 s retry-after; let the clock run until the
  // lane settles, letting the ledger answer within each second.
  for (let second = 0; !settled && second < 15 * 60; second += 1) {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  await harvest;
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
  let settled = false;
  const harvest = harvestLane({ ...env, PAPER_STORE: binding }, { source: 'pubmed', lane: 'med.cardio' })
    .then(() => null, (error: unknown) => error)
    .finally(() => { settled = true; });
  // The lane step's timeout (paper-harvest.ts) is ten minutes; run the clock
  // past it, letting the ledger answer within each second.
  for (let second = 0; !settled && second < 15 * 60; second += 1) {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  const refusal = await harvest;
  assert.ok(refusal instanceof SourceRefused, 'the lane ends for this run once it has waited out one minute');
  assert.ok(Date.now() - started <= 2 * 60_000, `the lane took ${(Date.now() - started) / 1000} s`);
  assert.equal(urls.filter(url => url.pathname.endsWith('/esearch.fcgi')).length, 2);
  assert.deepEqual(db.prepare('SELECT source, lane FROM lane_state').all(), [], 'its progress is not recorded: the next run reads it again');
});

// Enrichment runs last in the nightly run and can always use more units. A
// reader who follows something new after it has finished must still have the
// follow harvested at once, not the next night.
test("followed searches stop at their part of the nightly run's OpenAlex share, category lanes and enrichment keep the rest of it, and new follows keep their own 300", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu'
    ? { response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:result': { pid: [{ '@classname': 'doi', $: '10.1093/genetics/iyag290' }] } } } }] } } }
    : { results: [] }));
  // The shared ledger's own ceilings, out of the way: the harvest's share is what is under test.
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const followedSearch = (newFollow = false) => SOURCES['openalex-follows'].fetchPage(env, { lane: 'query:graph neural networks', page: 1, since: '', waits: { seconds: 0 }, newFollow });
  // A search is ten list calls: the nightly refresh of followed lanes may spend 700 of the harvest's 4,000.
  for (let call = 0; call < 70; call += 1) await followedSearch();
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

  for (let call = 0; call < 2_997; call += 1) await topics();
  await series();
  await notable();
  await area();
  await assert.rejects(topics(), SourceRefused);
  await assert.rejects(series(), SourceRefused);
  await assert.rejects(notable(), SourceRefused);
  await assert.rejects(area(), SourceRefused);
  assert.equal(openAlexCalls(), 3_000);

  // The nightly refresh's 700 and the new follows' 300, ten units a search.
  const followedSearch = (newFollow: boolean) => SOURCES['openalex-follows'].fetchPage(env, { ...request, lane: 'query:graph neural networks', newFollow });
  for (let call = 0; call < 70; call += 1) await followedSearch(false);
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

// PAP-88: readers' searches and profile lists stop at 60 % of the day's
// OpenAlex ceiling, their card batches at 80 %. A followed author, search or
// project asks OpenAlex in those same shapes, and a run started by a new follow
// can come at any hour, so the harvest spends its own share up to 95 % and
// leaves the rest to papers being opened.
test("readers' closed tiers do not stop the harvest's OpenAlex lanes, and the harvest leaves the last share to an opened paper", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu'
    ? { response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:result': { pid: [{ '@classname': 'Digital Object Identifier', $: 'https://doi.org/10.1093/genetics/iyag290' }] } } } }] } } }
    : { results: [] }));
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
  await follows('query:graph neural networks');
  await SOURCES.openaire.fetchPage(env, { lane: 'project:NSF|2047484', page: 1, since: '', waits: { seconds: 0 } });
  assert.deepEqual(
    urls.filter(url => url.hostname === 'api.openalex.org').map(url => (url.searchParams.has('search') ? 'search' : url.searchParams.get('filter')!.split(':')[0])),
    ['author.id', 'search', 'doi'],
  );

  // An author page, a search and a DOI list: 12 units. The rest of the
  // harvest's tier goes elsewhere.
  await spendElsewhere(share('feed') - readers - 12);
  await assert.rejects(follows('author:A5000000001'), SourceRefused);
  const opened = await handleOpenAlex(new Request('https://papertok.internal/openalex/works?filter=doi:10.1093/genetics/iyag290&per-page=1'), env);
  assert.equal(opened.status, 200, 'a paper being opened still has the rest of the ceiling');
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

test("an admitted leaf's notable lane asks for its topics' most-cited articles of the last ten years, and keeps their year, citations and access", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const { urls, env } = relay(t, () => ({ results: [plsiWork] }));
  const { items } = await SOURCES['openalex-notable'].fetchPage(env, { lane: 'notable:cs.CV', page: 1, since: '', waits: { seconds: 0 } });
  assert.equal(urls[0].searchParams.get('sort'), 'cited_by_count:desc');
  // The leaf's own topics and types, as its journal lane asks, over ten years.
  assert.deepEqual(filtersOf(urls[0]).sort(), [
    ...openAlexTopicFilterForLeaf('cs.CV')!.split(','),
    'from_publication_date:2016-01-01',
    'to_publication_date:2026-10-23',
    'has_abstract:true',
    'is_retracted:false',
    'primary_location.source.is_core:true',
  ].sort());
  assert.deepEqual(items.map(item => [item.paper.id, item.lanes]), [['openalex:W2107743791', ['notable:cs.CV']]]);
  const [{ paper }] = items;
  assert.equal(paper.year, 2017);
  assert.equal(paper.citationsCount, 3988);
  assert.equal(paper.citationCountKnown, true);
  assert.equal(paper.openAccess, false, 'a closed article stays closed');

  // The window is whole years: in January it starts ten years before that one.
  t.mock.timers.setTime(Date.parse('2027-01-02T03:00:00Z'));
  await SOURCES['openalex-notable'].fetchPage(env, { lane: 'notable:cs.CV', page: 1, since: '', waits: { seconds: 0 } });
  assert.ok(filtersOf(urls[1]).includes('from_publication_date:2017-01-01'));
});

test('a notable lane is one OpenAlex call a week, and its papers stay whatever their age until a listing lapses', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const now = Date.now();
  const full = Array.from({ length: 100 }, (_, index) => ({ ...plsiWork, id: `https://openalex.org/W9${index}`, doi: `https://doi.org/10.1/plsi${index}`, title: `Probabilistic Latent Semantic Indexing, part ${index}` }));
  const { urls, env } = relay(t, () => ({ results: full }));
  const { binding, db } = testD1();
  const store = { ...env, PAPER_STORE: binding } as never;
  await harvestLane(store, { source: 'openalex-notable', lane: 'notable:cs.CV' }, now);
  assert.equal(urls.length, 1, 'a full page is not followed by another');
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM work_lanes WHERE lane = 'notable:cs.CV'").get() as { n: number }).n;
  assert.equal(count(), 100, 'nine years old and filed');
  await evictExpired(store, now + 13 * 86_400_000);
  assert.equal(count(), 100, 'the next weekly listing comes before they lapse');
  await evictExpired(store, now + 15 * 86_400_000);
  assert.equal(count(), 0, 'two weeks unlisted, they leave');
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
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // Synthetic variants of the recorded work. A recent article is kept 90 days
  // from its date, past the listing's 14.
  const recent = { ...plsiWork, id: 'https://openalex.org/W1000000003', doi: 'https://doi.org/10.5555/recent-and-cited', title: 'A recent article cited enough to make the hundred', publication_date: '2026-10-01', publication_year: 2026 };
  const newcomer = { ...plsiWork, id: 'https://openalex.org/W1000000002', doi: 'https://doi.org/10.5555/joined-the-hundred', title: 'An article that has joined the most-cited hundred' };
  let listing: unknown[] = [plsiWork, recent];
  const { env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: listing } : { results: [] }));
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

test('a notable lane drops a paper 14 days after the listing that last returned it, though a like or its date keeps it in the corpus', async t => {
  const DAY = 86_400_000;
  const first = Date.parse('2026-10-23T03:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: first });
  // Synthetic variants of the recorded work: an older one a reader liked, and
  // a recent one its category lane also holds, kept 90 days from its date.
  const liked = { ...plsiWork, id: 'https://openalex.org/W1000000001', doi: 'https://doi.org/10.5555/left-the-hundred', title: 'An article that has left the most-cited hundred' };
  const recent = { ...plsiWork, id: 'https://openalex.org/W1000000003', doi: 'https://doi.org/10.5555/recent-and-cited', title: 'A recent article cited enough to make the hundred', publication_date: '2026-10-01', publication_year: 2026 };
  let listing: unknown[] = [plsiWork, liked, recent];
  const { env } = relay(t, url => (url.searchParams.get('sort') === 'cited_by_count:desc' ? { results: listing } : { results: [] }));
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

test('every admitted leaf has a notable lane, asked again once a week has passed', async () => {
  const { binding, db } = testD1();
  const now = Date.parse('2026-10-30T02:40:00Z');
  const lanes = async () => (await notableLaneJobs(binding as never, now)).map(job => `${job.source} ${job.lane}`);
  assert.deepEqual((await lanes()).sort(), topicLanes().map(leaf => `openalex-notable notable:${leaf}`).sort());
  const harvested = db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-notable', ?, ?)");
  // Last week's run reached cs.CV later in the night than this run has.
  harvested.run('notable:cs.CV', '2026-10-23T04:10:00.000Z');
  harvested.run('notable:cs.SE', '2026-10-24T02:35:00.000Z');
  const due = await lanes();
  assert.ok(due.includes('openalex-notable notable:cs.CV'), 'seven days on');
  assert.ok(!due.includes('openalex-notable notable:cs.SE'), 'six days on');
  assert.equal(due.length, topicLanes().length - 1);
});
