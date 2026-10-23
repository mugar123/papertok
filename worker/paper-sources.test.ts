import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { SOURCES, SourceRefused, WORKING_PAPER_SERIES_IDS, categoryLaneJobs, harvestLane, parseOaiPage, splitRawAuthors } from './paper-sources.ts';
import { handleOpenAlex } from './openalex-api.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { OPENALEX_TIER_PERCENT } from './provider-runtime.ts';
import { parseXmlDocument } from './xml-dom.ts';
import { testD1 } from './test-support/sqliteD1.ts';
import { inMemoryQuotaLedger } from './test-support/quotaLedger.ts';
import { parseXmlDocument as parseWithShim } from '../src/test-support/xmlDomShim.ts';
import { readPubmedEfetch } from '../src/utils/pubmedEfetch.ts';
import { areaLabelForPaper, leavesForOpenAlexTopic, openAlexTopicFilterForLeaf } from '../src/utils/areaAccent.ts';
import { getCategoryArea } from '../src/data/categoryTaxonomy.ts';
import { mapOpenAlexWork } from '../src/utils/openAlexWork.ts';

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


// Trimmed from efetch for PMID 42775314 (2026-09-24), as in pubmedEfetch.test.ts:
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
  }) as typeof fetch;
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
  const { items } = await SOURCES['openalex-series'].fetchPage(env as never, { lane: 'series:working-papers', page: 2, since: '' });
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
    // What shows the Working paper tag (paperStatus.ts).
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
  const { items } = await SOURCES['openalex-topics'].fetchPage(env as never, { lane: 'bio.mol', page: 1, since: '' });
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
  await SOURCES['openalex-topics'].fetchPage(env as never, { lane: 'mech.aero', page: 1, since: '' });
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
    await SOURCES['openalex-topics'].fetchPage(env as never, { lane: leaf, page: 1, since: '' });
    const filters = filtersOf(urls.at(-1)!);
    const sampled = new URL(reviews[leaf].query).searchParams.get('filter')!.split(',');
    assert.deepEqual(topicsOf(filters), topics, leaf);
    assert.ok(topics.every(id => topicsOf(sampled).includes(id)), `${leaf} asks only for topics its sample asked for`);
    for (const filter of ['type:article', 'has_abstract:true', 'is_retracted:false', 'primary_location.source.is_core:true']) {
      assert.ok(filters.includes(filter) && sampled.includes(filter), `${leaf}: ${filter}`);
    }
  }
  const { items } = await SOURCES['openalex-topics'].fetchPage(env as never, { lane: 'q-fin.GN', page: 1, since: '' });
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
    await SOURCES['openalex-topics'].fetchPage(env as never, { lane: leaf, page: 1, since: '' });
    asked.push([leaf, topicsOf(filtersOf(urls.at(-1)!))]);
  }
  assert.deepEqual(asked.find(([leaf]) => leaf === 'bio.mol')![1],
    ['T10123', 'T10268', 'T10521', 'T10604', 'T10878', 'T11041', 'T11237', 'T11482', 'T11765', 'T12534']);
  // The 14 lists as merged in #236 (areaAccent.ts on main before PAP-99), each
  // sorted: an edit to the baseline file cannot also move this expectation.
  assert.equal(createHash('sha256').update(JSON.stringify(asked)).digest('hex'),
    'd712fc6dd9b51123876e8bbf61022a0172cde893fa03bb7aa394bfa16cd14d5f');
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
  await harvestLane({ ...env, PAPER_STORE: binding } as never, { source: 'openalex-topics', lane: 'bio.mol' });
  assert.deepEqual(urls.map(url => url.searchParams.get('page')), ['1', '2'], 'the second page reached the overlap before the last run');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM works').get() as { n: number }).n, 201);
  assert.deepEqual(db.prepare('SELECT harvested_through FROM lane_state').all().map(row => (row as { harvested_through: string }).harvested_through), ['2026-10-21T05:21:00.000Z']);
});

test("a followed project's lane asks OpenAIRE by its id, with the funder only for a bare grant code, then OpenAlex by DOI", async t => {
  const { urls, env } = relay(t, url => (url.hostname === 'api.openaire.eu'
    ? { response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:result': { pid: [{ '@classname': 'Digital Object Identifier', $: 'https://doi.org/10.1093/Genetics/IYAG290' }] } } } }] } } }
    : { results: [splicingWork] }));
  await SOURCES.openaire.fetchPage(env as never, { lane: 'project:EC|corda__h2020::0123456789abcdef', page: 1, since: '' });
  await SOURCES.openaire.fetchPage(env as never, { lane: 'project:NSF|2047484', page: 1, since: '' });
  const openAire = urls.filter(url => url.hostname === 'api.openaire.eu');
  assert.equal(openAire[0].searchParams.get('openaireProjectID'), 'corda__h2020::0123456789abcdef');
  assert.equal(openAire[0].searchParams.has('funder'), false, 'an OpenAIRE id names its funder already');
  assert.equal(openAire[1].searchParams.get('projectID'), '2047484');
  assert.equal(openAire[1].searchParams.get('funder'), 'NSF');
  assert.ok(urls.some(url => url.hostname === 'api.openalex.org' && url.searchParams.get('filter') === 'doi:10.1093/genetics/iyag290'));
});

test("the harvest stops asking OpenAlex once its share of the day is spent, leaving the rest to readers", async t => {
  const { urls, env } = relay(t, () => ({ results: [] }));
  // The shared ledger's own ceilings, out of the way: the harvest's share is what is under test.
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  await assert.rejects(
    (async () => {
      for (let call = 0; call < 401; call += 1) {
        await SOURCES['openalex-follows'].fetchPage(env as never, { lane: 'query:graph neural networks', page: 1, since: '' });
      }
    })(),
    (error: Error & { retryAfterSeconds?: number }) => (error.retryAfterSeconds ?? 0) > 60,
  );
  // A search is ten list calls of the harvest's 4,000.
  assert.equal(urls.length, 400);
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
  const follows = (lane: string) => SOURCES['openalex-follows'].fetchPage(env as never, { lane, page: 1, since: '' });

  // Readers have spent past both of their shares.
  const readers = share('enrichment') + 50;
  await spendElsewhere(readers);
  await follows('author:A5023888391');
  await follows('query:graph neural networks');
  await SOURCES.openaire.fetchPage(env as never, { lane: 'project:NSF|2047484', page: 1, since: '' });
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
  const follows = () => SOURCES['openalex-follows'].fetchPage(env as never, { lane: 'author:A5023888391', page: 1, since: '' });

  await follows();
  await follows();
  assert.equal(urls.length, 1, 'the second page came from the store');
  assert.deepEqual(ledger.calls.map(key => key.split(':').slice(0, 2).join(':')), ['openalex:day']);
});
