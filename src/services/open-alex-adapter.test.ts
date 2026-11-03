import type { PaperAuthor } from '../models/paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAlexAdapter } from './adapters/open-alex-adapter.ts';
import { OPENALEX_SEARCH_TYPES } from '../utils/open-alex-work.ts';
import { OPENALEX_WORK_SEARCH_FIELDS } from '../utils/open-alex-work.ts';
import { mapEuropePmcResult, mergeEuropePmcEnrichment } from './europe-pmc-records.ts';
import { openAlexClient } from './open-alex-client.ts';
import { PaperBuilder } from './paper-builder.ts';
import { accessStatusForPaper, reviewTagForPaper } from '../utils/paper-status.ts';
import type { Paper } from '../models/paper.ts';
import type { PaperSearchFilters } from './adapters/index.ts';

test('keeps OpenAlex citations and semantic concepts on discovered papers', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W123',
    title: 'An OpenAlex paper',
    type: 'article',
    cited_by_count: 42,
    concepts: [
      { id: 'https://openalex.org/C1', display_name: 'Cosmology', score: 0.91 },
      { id: 'https://openalex.org/C2', display_name: 'Weak signal', score: 0.1 },
    ],
    topics: [{ id: 'https://openalex.org/T1', display_name: 'Galaxy formation', score: 0.8 }],
    primary_topic: { id: 'https://openalex.org/T1', display_name: 'Galaxy formation' },
    authorships: [],
    open_access: { is_oa: false },
    primary_location: { is_published: true, source: { type: 'journal' } },
  });

  assert.deepEqual(paper!.sources, { primary: 'openalex', enrichedBy: [] });
  assert.equal(paper!.citationsCount, 42);
  assert.equal(paper!.citationCountKnown, true);
  assert.deepEqual(paper!.concepts!.map(concept => concept.display_name), ['Cosmology']);
  assert.equal(paper!.primaryTopic!.display_name, 'Galaxy formation');
  assert.equal(paper!.publicationStatus, 'published');
});

test('a search result hosted on arXiv carries its arXiv id', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W2626778328',
    title: 'Attention Is All You Need',
    type: 'preprint',
    cited_by_count: 6590,
    authorships: [],
    open_access: { is_oa: true, oa_url: 'https://arxiv.org/pdf/1706.03762' },
    primary_location: { is_published: false, source: { type: 'repository' } },
    locations: [{
      landing_page_url: 'http://arxiv.org/abs/1706.03762',
      pdf_url: 'https://arxiv.org/pdf/1706.03762',
      is_published: false,
    }],
  });

  assert.equal(paper!.arxivId, '1706.03762');
});

test('a search result with no arXiv copy has no arXiv id to give', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W999',
    title: 'Journal-only paper',
    doi: 'https://doi.org/10.1000/journal-only',
    type: 'article',
    cited_by_count: 4,
    authorships: [],
    locations: [{ landing_page_url: 'https://example.com/journal/article', is_published: true }],
  });

  assert.equal(paper!.arxivId, undefined);
});

test('a search result that does not say whether it is open gets no access chip, and a closed one still reads subscription', () => {
  const adapter = new OpenAlexAdapter();
  const work = { id: 'https://openalex.org/W321', title: 'A paper without access data', type: 'article', authorships: [] };
  for (const silent of [adapter.mapToStandard(work), adapter.mapToStandard({ ...work, open_access: {} })]) {
    assert.equal(silent!.openAccess, undefined);
    assert.equal(accessStatusForPaper(silent), null);
  }
  const closed = adapter.mapToStandard({ ...work, open_access: { is_oa: false } });
  assert.equal(accessStatusForPaper(closed), 'subscription');
});

test('does not mark repository preprints as published', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W456',
    title: 'A repository preprint',
    type: 'preprint',
    cited_by_count: 0,
    authorships: [],
    primary_location: { is_published: false, source: { type: 'repository' } },
  });

  assert.equal(paper!.citationCountKnown, true);
  assert.equal(paper!.publicationStatus, 'preprint');
});

// OpenAlex returns the IMF series exactly as it returns Nature: `article`, in a
// `journal`, published version (sources as returned on 2026-10-19).
const feedWork = (id: string, source: { id: string; display_name: string; type: string } | null) => new OpenAlexAdapter().mapToStandard({
  id: `https://openalex.org/${id}`,
  title: `Work ${id}`,
  type: 'article',
  authorships: [],
  primary_location: { is_published: true, source },
});
const IMF_SOURCE = { id: 'https://openalex.org/S4210171147', display_name: 'IMF Working Paper', type: 'journal' };
const NATURE_SOURCE = { id: 'https://openalex.org/S137773608', display_name: 'Nature', type: 'journal' };

test('a feed card from OpenAlex is peer reviewed only when a venue shows it', () => {
  // The card used to call both reviewed.
  const [imf, nature, unsourced] = PaperBuilder.deduplicate([
    feedWork('W7215107402', IMF_SOURCE),
    feedWork('W2919115771', NATURE_SOURCE),
    feedWork('W3', null),
  ]);

  assert.equal(imf.peerReviewed, false);
  assert.equal(nature.peerReviewed, true);
  assert.equal(unsourced.peerReviewed, undefined);
});

test('a feed card tags the working paper, and neither the journal article nor a journal named Working Paper', () => {
  const [imf, nature, publicHealth] = PaperBuilder.deduplicate([
    feedWork('W7215107402', IMF_SOURCE),
    feedWork('W2919115771', NATURE_SOURCE),
    // A PAGEPress journal whose name alone would read as a working-paper series.
    feedWork('W4', { id: 'https://openalex.org/S4210222596', display_name: 'Working Paper of Public Health', type: 'journal' }),
  ]);

  assert.equal(reviewTagForPaper(imf)?.label, 'Working paper');
  assert.equal(reviewTagForPaper(nature), null);
  assert.equal(publicHealth.peerReviewed, undefined);
  assert.equal(reviewTagForPaper(publicHealth), null);
});

test('uses current OpenAlex topics when legacy concepts are missing', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W789',
    title: 'A topic-first work',
    type: 'article',
    cited_by_count: 7,
    authorships: [],
    concepts: [],
    topics: [{ id: 'https://openalex.org/T123', display_name: 'Particle Cosmology', score: 0.87 }],
    primary_location: { is_published: true, source: { type: 'journal' } },
  });

  assert.deepEqual(paper!.categories, ['Particle Cosmology']);
  assert.equal(paper!.concepts![0].id, 'https://openalex.org/T123');
});

// A works page came back at 455 KB uncompressed, 65–82 KB on the wire, and the
// mapper reads sixteen top-level fields of it. `select=` asks OpenAlex for
// those alone (measured 2026-09-16: 326 KB / 45–49 KB), and the Worker relays
// the parameter as it is (OPENALEX_PARAMS in worker/openalex-api.ts).
test('the search asks OpenAlex for the fields the mapper reads, and nothing else', () => {
  const url = new URL(new OpenAlexAdapter().buildSearchUrl('"Quantum Physics" OR "Cosmology"', 3));
  assert.equal(url.origin + url.pathname, 'https://api.openalex.org/works');
  assert.equal(url.searchParams.get('select'), OPENALEX_WORK_SEARCH_FIELDS.join(','));
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('per-page'), '25');
  assert.match(url.searchParams.get('filter')!, /^default\.search:"Quantum Physics" OR "Cosmology",type:article\|conference-paper\|review$/);
});

// OpenAlex renamed the type: `proceedings-article` matches nothing there any
// more, so a filter carrying it dropped every conference paper without an
// error. Discovery also accepts scientific reviews; paper search widens this
// list to include preprints.
test('the type filter speaks OpenAlex\'s current vocabulary and never the retired one', () => {
  const adapter = new OpenAlexAdapter();
  const feedFilter = new URL(adapter.buildSearchUrl('segment anything')).searchParams.get('filter');
  assert.equal(feedFilter, 'default.search:segment anything,type:article|conference-paper|review');
  assert.doesNotMatch(feedFilter, /proceedings-article/);

  const searchFilter = new URL(adapter.buildSearchUrl('segment anything', 1, { types: OPENALEX_SEARCH_TYPES }))
    .searchParams.get('filter');
  assert.equal(searchFilter, 'default.search:segment anything,type:article|conference-paper|review|preprint');
});

test('a conference paper maps to the conference source type', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W4390874575',
    title: 'Segment Anything',
    type: 'conference-paper',
    cited_by_count: 10567,
    authorships: [],
  });
  assert.equal(paper!.sourceType, 'conference');
  assert.equal(paper!.publicationStatus, 'published');
});

// The guard against drift: a work stripped to the selected fields must map to
// the same paper as the full work. A mapper that starts reading a field the
// selection leaves out fails here, not in production with a silent `undefined`.
test('dropping every unselected field changes nothing the mapper produces', () => {
  const full = {
    id: 'https://openalex.org/W2626778328',
    doi: 'https://doi.org/10.48550/arxiv.1706.03762',
    ids: { openalex: 'https://openalex.org/W2626778328', doi: 'https://doi.org/10.48550/arxiv.1706.03762', arxiv: '1706.03762' },
    display_name: 'Attention Is All You Need',
    title: 'Attention Is All You Need',
    type: 'preprint',
    language: 'en',
    publication_date: '2017-06-12',
    publication_year: 2017,
    authorships: [{
      author: { id: 'https://openalex.org/A1', display_name: 'Ashish Vaswani' },
      institutions: [{ id: 'https://openalex.org/I1', ror: 'https://ror.org/00njsd438', display_name: 'Google (United States)' }],
      raw_affiliation_strings: ['Google Brain'],
      countries: ['US'],
    }],
    abstract_inverted_index: { The: [0], dominant: [1], sequence: [2], transduction: [3], models: [4], are: [5], based: [6], on: [7], recurrent: [8], networks: [9] },
    primary_location: { is_published: false, landing_page_url: 'http://arxiv.org/abs/1706.03762', source: { display_name: 'arXiv (Cornell University)', type: 'repository' } },
    locations: [{ landing_page_url: 'http://arxiv.org/abs/1706.03762', pdf_url: 'http://arxiv.org/pdf/1706.03762', source: { type: 'repository' } }],
    best_oa_location: { pdf_url: 'http://arxiv.org/pdf/1706.03762' },
    open_access: { is_oa: true, oa_url: 'http://arxiv.org/pdf/1706.03762' },
    cited_by_count: 6590,
    concepts: [{ id: 'https://openalex.org/C1', display_name: 'Transformer', score: 0.9 }],
    topics: [{ id: 'https://openalex.org/T1', display_name: 'Natural language processing', score: 0.99 }],
    primary_topic: { id: 'https://openalex.org/T1', display_name: 'Natural language processing' },
    keywords: [{ display_name: 'Attention', score: 0.5 }],
    referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
    related_works: ['https://openalex.org/W3'],
    counts_by_year: [{ year: 2024, cited_by_count: 1000 }],
    fwci: 250.1,
    grants: [{ funder: 'https://openalex.org/F1', award_id: '123' }],
    is_retracted: false,
  };
  const selected = Object.fromEntries(OPENALEX_WORK_SEARCH_FIELDS.filter(field => field in full).map(field => [field, full[field as keyof typeof full]]));
  const adapter = new OpenAlexAdapter();
  const withoutRaw = (paper: Paper|null) => { const copy = { ...paper }; delete copy.raw; return copy; };
  const fromFull = withoutRaw(adapter.mapToStandard(full));
  const fromSelected = withoutRaw(adapter.mapToStandard(selected));
  assert.deepEqual(fromSelected, fromFull);
  assert.equal(fromSelected.arxivId, '1706.03762');
  assert.equal((fromSelected.authors![0] as PaperAuthor).affiliation, 'Google (United States)');
  assert.equal(fromSelected.abstract, 'The dominant sequence transduction models are based on recurrent networks');
});

test('economics and finance discovery includes preprints without changing other fields or explicit type filters', () => {
  const adapter = new OpenAlexAdapter();
  const filterFor = (options: PaperSearchFilters|undefined) => new URL(adapter.buildSearchUrl('risk management', 1, options))
    .searchParams.get('filter');

  for (const internalCategories of [['econ.EM'], ['q-fin.RM'], ['cs.LG', 'q-fin.PM']]) {
    assert.equal(filterFor({ internalCategories }),
      'default.search:risk management,type:article|conference-paper|review|preprint');
  }
  assert.equal(filterFor({ internalCategories: ['cs.LG'] }),
    'default.search:risk management,type:article|conference-paper|review');
  assert.equal(filterFor({ internalCategories: ['econ.GN'], types: ['article'] }),
    'default.search:risk management,type:article');
  assert.equal(filterFor({ internalCategories: ['q-fin.RM'], types: OPENALEX_SEARCH_TYPES }),
    'default.search:risk management,type:article|conference-paper|review|preprint');
});

test('category discovery returns working papers and preserves their preprint status', async (t) => {
  // Synthetic OpenAlex records. The stub applies the upstream type filter so
  // a request that still excludes preprints cannot return the working paper.
  const records = [
    {
      id: 'https://openalex.org/W1001',
      title: 'Risk Management Working Paper',
      type: 'preprint',
      authorships: [{ author: { display_name: 'Alex Smith' } }],
      primary_location: { is_published: false, source: { type: 'repository' } },
    },
    {
      id: 'https://openalex.org/W1002',
      title: 'Risk Management Journal Article',
      type: 'article',
      primary_location: { is_published: true, source: { type: 'journal' } },
    },
  ];
  let requests = 0;
  t.mock.method(openAlexClient, 'fetch', async (url: string|URL) => {
    requests += 1;
    const filter = new URL(url).searchParams.get('filter');
    const types = filter!.match(/(?:^|,)type:([^,]+)/)![1].split('|');
    const results = records.filter(record => types.includes(record.type));
    return Response.json({ meta: { count: results.length }, results });
  });

  const adapter = new OpenAlexAdapter();
  for (const category of ['econ.EM', 'q-fin.RM']) {
    const result = await adapter.search('risk management', 1, { internalCategories: [category] });
    assert.deepEqual(result.papers.map(paper => paper.id), ['openalex:W1001', 'openalex:W1002']);
    assert.equal(result.papers[0].publicationType, 'preprint');
    assert.equal(result.papers[0].publicationStatus, 'preprint');
    assert.equal(result.papers[0].primaryCategory, undefined, 'the requested category is not stamped on the work');
    assert.equal(result.papers[0].arxivId, undefined);
    assert.equal(result.papers[1].publicationStatus, 'published');
  }
  assert.equal(requests, 2, 'each category search still makes one upstream request');
});

test('a work with no arXiv category keeps its own field instead of the requested one', async (t) => {
  // The WIREs survey "Artificial intelligence" (W4233888153) used to come back
  // from a feed request for hep-th as "High Energy Physics - Theory": the
  // requested category was chosen by label words found in the abstract
  // ("theory", "high" in "highlights") and the first one won the tie (PAP-60).
  t.mock.method(openAlexClient, 'fetch', async () => Response.json({
    meta: { count: 1 },
    results: [{
      id: 'https://openalex.org/W4233888153',
      title: 'Artificial intelligence',
      type: 'article',
      abstract_inverted_index: {
        Artificial: [0], intelligence: [1], theory: [2], and: [3], practice: [4], highlights: [5],
      },
      concepts: [{ id: 'https://openalex.org/C154945302', display_name: 'Artificial intelligence', level: 1, score: 0.72 }],
      primary_topic: { id: 'https://openalex.org/T10883', display_name: 'Artificial Intelligence Applications', field: { id: 'https://openalex.org/fields/17', display_name: 'Computer Science' } },
    }],
  }));

  const result = await new OpenAlexAdapter().search('"High Energy Physics - Theory" OR "Artificial Intelligence"', 1, {
    internalCategories: ['hep-th', 'cs.AI'],
  });
  const [paper] = result.papers;
  assert.equal(paper.primaryCategory, undefined);
  for (const list of [paper.categories, paper.allCategories]) {
    assert.ok(!(list || []).some(category => ['hep-th', 'cs.AI'].includes(category)), `no requested category in ${JSON.stringify(list)}`);
  }
  assert.deepEqual(paper.categories, ['Artificial intelligence']);
  assert.equal(paper.primaryTopic?.field?.display_name, 'Computer Science');
});

// PAP-31. OpenAlex writes a work's PubMed id as a URL in `ids.pmid`, and the
// feed asks Europe PMC by the bare number in `paper.pmid`. The mapper dropped
// it, so a closed paper whose abstract Europe PMC holds kept showing "No
// abstract available.". Both works are shaped after the live records (fetched
// 2026-10-17), trimmed to the fields the mapper reads.
const PCR_METHOD_WORK = {
  id: 'https://openalex.org/W2107277218',
  doi: 'https://doi.org/10.1006/meth.2001.1262',
  ids: {
    openalex: 'https://openalex.org/W2107277218',
    doi: 'https://doi.org/10.1006/meth.2001.1262',
    mag: '2107277218',
    pmid: 'https://pubmed.ncbi.nlm.nih.gov/11846609',
  },
  title: 'Analysis of Relative Gene Expression Data Using Real-Time Quantitative PCR and the 2−ΔΔCT Method',
  type: 'article',
  publication_date: '2001-12-01',
  publication_year: 2001,
  authorships: [],
  abstract_inverted_index: null,
  open_access: { is_oa: false, oa_url: null },
  primary_location: {
    landing_page_url: 'https://doi.org/10.1006/meth.2001.1262',
    is_published: true,
    source: { display_name: 'Methods', type: 'journal' },
  },
  cited_by_count: 180397,
};

// Huber 1958: no PubMed record, and no abstract in OpenAlex, Crossref or at
// the publisher. Its missing abstract has to stay missing.
const HUBER_WORK = {
  id: 'https://openalex.org/W2036144354',
  doi: 'https://doi.org/10.1007/bf02564570',
  ids: {
    openalex: 'https://openalex.org/W2036144354',
    doi: 'https://doi.org/10.1007/bf02564570',
    mag: '2036144354',
  },
  title: 'On subharmonic functions and differential geometry in the large',
  type: 'article',
  publication_date: '1958-12-01',
  publication_year: 1958,
  authorships: [],
  abstract_inverted_index: null,
  open_access: { is_oa: false, oa_url: null },
  primary_location: {
    landing_page_url: 'https://doi.org/10.1007/bf02564570',
    is_published: true,
    source: { display_name: 'Commentarii Mathematici Helvetici', type: 'journal' },
  },
  cited_by_count: 470,
};

test('a search result keeps the PubMed id OpenAlex writes as a URL, as the bare number', () => {
  const adapter = new OpenAlexAdapter();
  assert.equal(adapter.mapToStandard(PCR_METHOD_WORK)!.pmid, '11846609');
  assert.equal(adapter.mapToStandard(HUBER_WORK)!.pmid, undefined);
});

test('a closed search result takes its abstract from Europe PMC by that id and stays closed', () => {
  const adapter = new OpenAlexAdapter();
  const pcrMethod = adapter.mapToStandard(PCR_METHOD_WORK)!;
  const huber = adapter.mapToStandard(HUBER_WORK)!;
  assert.equal(pcrMethod.abstract, 'No abstract available.');

  // Europe PMC's core record for PMID 11846609, trimmed. The abstract text is
  // a synthetic stand-in for the 867-character original.
  const abstract = 'Synthetic stand-in: relative gene expression computed from real-time PCR threshold cycles.';
  const record = mapEuropePmcResult({
    id: '11846609',
    pmid: '11846609',
    abstractText: abstract,
    isOpenAccess: 'N',
    fullTextUrlList: { fullTextUrl: [{
      availability: 'Subscription required',
      availabilityCode: 'S',
      documentStyle: 'doi',
      url: 'https://doi.org/10.1006/meth.2001.1262',
    }] },
  })!;

  const [merged, untouched] = mergeEuropePmcEnrichment([pcrMethod, huber], new Map([[record.pmid, record]]));
  assert.equal(merged.abstract, abstract);
  assert.equal(merged.openAccess, false, 'an abstract is not access to the full text');
  assert.equal(merged.pdfUrl, null);
  assert.equal(merged.openAccessPdfUrl, undefined);
  assert.equal(merged.landingPageUrl, 'https://doi.org/10.1006/meth.2001.1262');
  assert.ok(Object.is(untouched, huber), 'a paper with no PubMed id is left as it was');
  assert.equal(untouched.abstract, 'No abstract available.');
});

test('title suggestions combine exact, fuzzy and prefix retrieval in one request', async t => {
  const requests: string[] = [];
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL, options: { retries?: number }) => {
    requests.push(String(url));
    assert.equal(options.retries, 0, 'no automatic retry can multiply a suggestion request');
    return Response.json({ meta: { count: 0 }, results: [] });
  });
  await new OpenAlexAdapter().search('Segment Anythign', 1, { typeahead: true });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).searchParams.get('filter'),
    'title.search.exact:"segment anythign" OR (segment~1 AND anythign~1) OR (segment~1 AND anythign*),type:article|conference-paper|review');
});

test('suggestion expansion preserves acronym phrases, numbers and default feed queries', () => {
  const adapter = new OpenAlexAdapter();
  const filter = (query: string, typeahead = true) => new URL(adapter.buildSearchUrl(query, 1, { typeahead })).searchParams.get('filter')!;
  assert.equal(filter('FC-CLIP'), 'default.search.exact:"fc clip",type:article|conference-paper|review');
  assert.equal(filter('risk management', false), 'default.search:risk management,type:article|conference-paper|review');
  assert.doesNotMatch(filter('Llama 2'), /2[~*]/);
  assert.match(filter('attention is all you ne'), /OR \(attention~1 AND is AND all AND you\)/);
  assert.match(filter('Convolutions Die Hard: Open-Vocabulary Segmentation'), /^title.search.exact:/);
  assert.match(filter('10.48550/arXiv.1706.03762'), /^default.search:10.48550\/arXiv.1706.03762,/);
  assert.doesNotMatch(filter('C++'), /[~*]/);
  assert.match(filter('atte'), /atte\*/);
});
