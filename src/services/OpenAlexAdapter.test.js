import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENALEX_SEARCH_TYPES, OPENALEX_WORK_SEARCH_FIELDS, OpenAlexAdapter } from './adapters/OpenAlexAdapter.js';

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

  assert.deepEqual(paper.sources, { primary: 'openalex', enrichedBy: [] });
  assert.equal(paper.citationsCount, 42);
  assert.equal(paper.citationCountKnown, true);
  assert.deepEqual(paper.concepts.map(concept => concept.display_name), ['Cosmology']);
  assert.equal(paper.primaryTopic.display_name, 'Galaxy formation');
  assert.equal(paper.publicationStatus, 'published');
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

  assert.equal(paper.arxivId, '1706.03762');
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

  assert.equal(paper.arxivId, undefined);
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

  assert.equal(paper.citationCountKnown, true);
  assert.equal(paper.publicationStatus, 'preprint');
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

  assert.deepEqual(paper.categories, ['Particle Cosmology']);
  assert.equal(paper.concepts[0].id, 'https://openalex.org/T123');
});

// A works page came back at 455 KB uncompressed, 65–82 KB on the wire, and the
// mapper reads sixteen top-level fields of it. `select=` asks OpenAlex for
// those alone (measured 2026-09-16: 326 KB / 45–49 KB), and the Worker relays
// the parameter as it is (OPENALEX_PARAMS in worker/report-api.js).
test('the search asks OpenAlex for the fields the mapper reads, and nothing else', () => {
  const url = new URL(new OpenAlexAdapter().buildSearchUrl('"Quantum Physics" OR "Cosmology"', 3));
  assert.equal(url.origin + url.pathname, 'https://api.openalex.org/works');
  assert.equal(url.searchParams.get('select'), OPENALEX_WORK_SEARCH_FIELDS.join(','));
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('per-page'), '25');
  assert.match(url.searchParams.get('filter'), /^default\.search:"Quantum Physics" OR "Cosmology",type:article\|conference-paper$/);
});

// OpenAlex renamed the type: `proceedings-article` matches nothing there any
// more, so a filter carrying it dropped every conference paper without an
// error. The feed's default asks for articles and conference papers; the paper
// search widens to preprints and reviews, which is where an arXiv-only paper
// or a survey lives.
test('the type filter speaks OpenAlex\'s current vocabulary and never the retired one', () => {
  const adapter = new OpenAlexAdapter();
  const feedFilter = new URL(adapter.buildSearchUrl('segment anything')).searchParams.get('filter');
  assert.equal(feedFilter, 'default.search:segment anything,type:article|conference-paper');
  assert.doesNotMatch(feedFilter, /proceedings-article/);

  const searchFilter = new URL(adapter.buildSearchUrl('segment anything', 1, { types: OPENALEX_SEARCH_TYPES }))
    .searchParams.get('filter');
  assert.equal(searchFilter, 'default.search:segment anything,type:article|conference-paper|preprint|review');
});

test('a conference paper maps to the conference source type', () => {
  const paper = new OpenAlexAdapter().mapToStandard({
    id: 'https://openalex.org/W4390874575',
    title: 'Segment Anything',
    type: 'conference-paper',
    cited_by_count: 10567,
    authorships: [],
  });
  assert.equal(paper.sourceType, 'conference');
  assert.equal(paper.publicationStatus, 'published');
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
  const selected = Object.fromEntries(OPENALEX_WORK_SEARCH_FIELDS.filter(field => field in full).map(field => [field, full[field]]));
  const adapter = new OpenAlexAdapter();
  const withoutRaw = (paper) => { const copy = { ...paper }; delete copy.raw; return copy; };
  const fromFull = withoutRaw(adapter.mapToStandard(full));
  const fromSelected = withoutRaw(adapter.mapToStandard(selected));
  assert.deepEqual(fromSelected, fromFull);
  assert.equal(fromSelected.arxivId, '1706.03762');
  assert.equal(fromSelected.authors[0].affiliation, 'Google (United States)');
  assert.equal(fromSelected.abstract, 'The dominant sequence transduction models are based on recurrent networks');
});
