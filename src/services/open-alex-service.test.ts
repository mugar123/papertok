import type { Paper, PaperAuthor } from '../models/paper.ts';
import type { OpenAlexAuthor, OpenAlexWork } from './adapters/open-alex-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCrossrefInstitutionWork } from './crossref-institution-service.ts';
import { mapEuropePmcResult, mergeEuropePmcEnrichment } from './europe-pmc-records.ts';
import { openAlexClient, writeOpenAlexPersistent } from './open-alex-client.ts';
import { PaperBuilder } from './paper-builder.ts';
import { filterAndSortEntityPapers } from '../utils/entity-explorer.ts';
import { openAlexPeerReviewed } from '../utils/publication-status.ts';
import { reviewTagForPaper } from '../utils/paper-status.ts';
import { hasUsableAIAbstract } from '../utils/ai-explanation-access.ts';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadline-harness.ts';
import { inTimeZone } from '../test-support/time-zone.ts';
import {
  buildOpenAlexIdFilter,
  buildRorIdFilter,
  fetchWithTimeout,
  buildRecentImpactUrl,
  dedupeAuthors,
  enrichAuthorInstitutionLocalization,
  enrichPapersBatch,
  fetchRecentImpactWorks,
  fetchPaperByWorkId,
  fetchPapersByDois,
  getAuthorProfileExact,
  getAuthorsByEntity,
  getLocalTopicEntity,
  getWorksByEntity,
  isOpenAlexEnrichmentId,
  normalizeRecentImpactEntityId,
  peekEntity,
  searchAuthors,
  searchConcepts,
  searchInstitutions,
  searchLocalTopics,
  slimWorksPage,
} from './open-alex-service.ts';
import { MAX_ENRICHMENT_AUTHORS, mapOpenAlexEnrichmentWork } from '../utils/open-alex-work.ts';

test('names local topic entities without changing their canonical category identity', () => {
  const topic = getLocalTopicEntity('gr-qc');

  assert.equal(topic!.id, 'gr-qc');
  assert.equal(topic!.display_name, 'General Relativity and Quantum Cosmology');
  assert.deepEqual(topic!.categoryIds, ['gr-qc']);
  assert.equal(topic!._localTopic, true);
});

test('entity and followed-work normalization preserves book and scientific review types over venue types', () => {
  const { papers } = slimWorksPage({ results: ['book', 'review'].map((type, index) => ({
    id: `https://openalex.org/W${index}`, type, title: `Synthetic ${type}`,
    primary_location: { source: { type: 'journal' } },
  })) });
  assert.deepEqual(papers.map(paper => paper.publicationType), ['book', 'review']);
});

// The FEDS paper and the Nature paper as OpenAlex returned them on 2026-10-19:
// both `article`, in a `journal`, published version.
const FEDS_WORK: OpenAlexWork = {
  id: 'https://openalex.org/W4414816997',
  title: 'A FEDS paper',
  type: 'article',
  primary_location: {
    is_published: true,
    source: { id: 'https://openalex.org/S4210212089', display_name: 'Finance and Economics Discussion Series', type: 'journal' },
  },
};
const NATURE_WORK: OpenAlexWork = {
  id: 'https://openalex.org/W2919115771',
  title: 'Deep learning',
  type: 'article',
  primary_location: {
    is_published: true,
    source: { display_name: 'Nature', type: 'journal' },
  },
};

test('the Explorer\'s peer-reviewed filter keeps the journal paper and drops the working paper and the unknown', () => {
  const unsourced: OpenAlexWork = { id: 'https://openalex.org/W3', title: 'No venue', type: 'article' };
  const papers = PaperBuilder.deduplicate(slimWorksPage({ results: [FEDS_WORK, NATURE_WORK, unsourced] }).papers);

  assert.deepEqual(
    filterAndSortEntityPapers(papers, { filters: { peerReviewed: true } }).map(paper => paper.id),
    ['W2919115771'],
  );
  assert.equal(papers.find(paper => paper.id === 'W3')!.peerReviewed, undefined);
});

test('a journal article keeps its review when its working paper shares the title and first author', () => {
  // `deduplicate` joins the two versions on title and first author. The row
  // keeps the article's id, venue and DOI, so it stays peer reviewed.
  const article: OpenAlexWork = {
    id: 'https://openalex.org/W100',
    doi: 'https://doi.org/10.1000/ijcb.1',
    title: 'Monetary policy and bank lending',
    type: 'article',
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
    primary_location: {
      is_published: true,
      source: { display_name: 'International Journal of Central Banking', type: 'journal' },
    },
  };
  const imfWorkingPaper: OpenAlexWork = {
    ...article,
    id: 'https://openalex.org/W200',
    doi: 'https://doi.org/10.5089/imf.1',
    primary_location: {
      is_published: true,
      source: { id: 'https://openalex.org/S4210171147', display_name: 'IMF Working Papers', type: 'journal' },
    },
  };
  const nberReport: OpenAlexWork = {
    ...article,
    id: 'https://openalex.org/W300',
    doi: 'https://doi.org/10.3386/w1',
    type: 'report',
    primary_location: { is_published: true, source: { display_name: 'NBER Working Paper Series' } },
  };

  for (const workingPaper of [imfWorkingPaper, nberReport]) {
    const papers = PaperBuilder.deduplicate(slimWorksPage({ results: [article, workingPaper] }).papers);
    assert.deepEqual(
      filterAndSortEntityPapers(papers, { filters: { peerReviewed: true } })
        .map(paper => [paper.id, paper.journal, paper.peerReviewed, reviewTagForPaper(paper)]),
      [['W100', 'International Journal of Central Banking', true, null]],
    );
  }
});

test('an arXiv preprint whose OpenAlex record is a working paper is published, not peer reviewed, and tagged as one', () => {
  const preprint = PaperBuilder.create({
    id: 'arxiv:2601.00001',
    title: 'A FEDS paper',
    publicationType: 'preprint',
    publicationStatus: 'preprint',
    sources: { primary: 'arxiv', enrichedBy: [] },
  });
  const working = PaperBuilder.merge(preprint, mapOpenAlexEnrichmentWork(FEDS_WORK)!.enrichment, 'openalex');
  const journal = PaperBuilder.merge(preprint, mapOpenAlexEnrichmentWork(NATURE_WORK)!.enrichment, 'openalex');

  assert.equal(working.publicationStatus, 'published');
  assert.equal(working.peerReviewed, false);
  assert.equal(reviewTagForPaper(working)?.label, 'Working paper');
  assert.equal(journal.peerReviewed, true);
  assert.equal(reviewTagForPaper(journal), null);
});

/**
 * A subcategory used to be born with its area's tagline as its own
 * description, so every astro-ph.* page whose label has no exact Wikipedia
 * article read "From subatomic particles to distant galaxies" (audit of
 * 2026-10-12: 58 of the 142 subcategories). The area keeps its tagline; a
 * subcategory has none of its own, and the Explorer shows nothing rather
 * than its parent's sentence.
 */
test('a subcategory does not inherit its area\'s description', () => {
  const area = getLocalTopicEntity('physics');
  const topic = getLocalTopicEntity('astro-ph.SR');
  const [searched] = searchLocalTopics('Solar and Stellar Astrophysics');

  assert.ok(area!.description);
  assert.equal(topic!.description, undefined);
  assert.equal(searched.id, 'astro-ph.SR');
  assert.equal(searched.description, undefined);
});

test('searches local topics regardless of case', () => {
  const lower = searchLocalTopics('cosmology');
  const upper = searchLocalTopics('COSMOLOGY');

  assert.equal(lower[0].id, 'astro-ph.CO');
  assert.equal(lower[0].display_name, 'Cosmology');
  assert.equal(upper[0].id, 'astro-ph.CO');
});

test('returns real local topic metadata instead of invented work counts', () => {
  const [physics] = searchLocalTopics('physics');

  assert.equal(physics.id, 'physics');
  assert.equal(physics.works_count, null);
  assert.ok(physics.subcategoryCount! > 0);
  assert.equal(physics._localTopic, true);
});

test('builds recent-impact samples for institutions and authors on the same FWCI contract', () => {
  const period = { from: '2023-01-01', to: '2025-12-31' };
  const institutionUrl = new URL(buildRecentImpactUrl('institution', 'https://openalex.org/I63966007', period));
  const authorUrl = new URL(buildRecentImpactUrl('author', 'A123', period));

  assert.equal(normalizeRecentImpactEntityId('institution', { id: 'https://openalex.org/I63966007' }), 'I63966007');
  assert.equal(normalizeRecentImpactEntityId('author', 'https://openalex.org/A123'), 'A123');
  assert.equal(normalizeRecentImpactEntityId('project', 'P123'), '');
  assert.match(institutionUrl.searchParams.get('filter')!, /^institutions\.id:I63966007,/);
  assert.equal(institutionUrl.searchParams.get('sample'), '200');
  assert.match(authorUrl.searchParams.get('filter')!, /^author\.id:A123,/);
  assert.equal(authorUrl.searchParams.get('sample'), '100');
});

test('retries a full recent-impact sample only when FWCI coverage is insufficient', async () => {
  const calls = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    const offset = calls.length === 1 ? 0 : 100;
    return {
      results: Array.from({ length: 100 }, (_, index) => ({
        id: `https://openalex.org/W${offset + index}`,
        fwci: calls.length === 1 && index >= 4 ? null : 1,
      })),
    };
  };

  const result = await fetchRecentImpactWorks(
    'author',
    'A123',
    { from: '2023-01-01', to: '2025-12-31' },
    fetchJson,
  );

  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  assert.equal(result.works.length, 200);
});

test('only sends arXiv and OpenAlex identifiers to batch enrichment', () => {
  assert.equal(isOpenAlexEnrichmentId('2503.10761v2'), true);
  assert.equal(isOpenAlexEnrichmentId('hep-th/9901001'), true);
  assert.equal(isOpenAlexEnrichmentId('openalex:W123'), true);
  assert.equal(isOpenAlexEnrichmentId('biorxiv:10.1101%2F2026.01.01.123456:v1'), false);
  assert.equal(isOpenAlexEnrichmentId('pmid:123456'), false);
});

test('maps real-shaped OpenAlex arXiv enrichment without a top-level id', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    doi: 'https://doi.org/10.65215/unrelated-preprint-doi',
    ids: { openalex: 'https://openalex.org/W2626778328' },
    cited_by_count: 6590,
    concepts: [{ id: 'https://openalex.org/C41008148', display_name: 'Computer science' }],
    type: 'preprint',
    open_access: { is_oa: true, oa_url: 'https://arxiv.org/pdf/1706.03762' },
    primary_location: {
      is_published: false,
      source: { type: 'repository', display_name: 'arXiv (Cornell University)' },
    },
    locations: [{
      landing_page_url: 'http://arxiv.org/abs/1706.03762',
      pdf_url: 'https://arxiv.org/pdf/1706.03762',
      is_published: false,
      source: { id: 'https://openalex.org/S4306400194' },
    }],
  });

  assert.equal(mapped!.openAlexId, 'W2626778328');
  assert.equal(mapped!.arxivId, '1706.03762');
  assert.equal(mapped!.enrichment.citationCount, 6590);
  assert.equal(mapped!.enrichment.citationCountKnown, true);
  assert.equal(mapped!.enrichment.publicationType, 'preprint');
  assert.equal(mapped!.enrichment.publicationStatus, 'preprint');
  assert.equal(mapped!.enrichment.openAccess, true);
  assert.equal(mapped!.enrichment.pdfUrl, 'https://arxiv.org/pdf/1706.03762');
  assert.equal(mapped!.enrichment.doi, undefined);
});

test('keeps a published DOI while enriching an arXiv paper', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W123',
    doi: 'https://doi.org/10.1000/published-paper',
    cited_by_count: 12,
    type: 'article',
    locations: [{
      landing_page_url: 'https://arxiv.org/abs/2401.12345v2',
      is_published: true,
      source: { display_name: 'Example Journal' },
    }],
  });

  assert.equal(mapped!.arxivId, '2401.12345');
  assert.equal(mapped!.enrichment.doi, '10.1000/published-paper');
  assert.equal(mapped!.enrichment.publicationStatus, 'published');
});

test('keeps enrichment for a native OpenAlex work without an arXiv copy', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W456',
    doi: 'https://doi.org/10.1000/openalex-only',
    cited_by_count: 24,
    type: 'article',
    locations: [],
  });

  assert.equal(mapped!.openAlexId, 'W456');
  assert.equal(mapped!.arxivId, '');
  assert.equal(mapped!.enrichment.citationCount, 24);
  assert.equal(mapped!.enrichment.doi, '10.1000/openalex-only');
});

test('falls back to current OpenAlex topics when legacy concepts are absent', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W789',
    cited_by_count: 3,
    topics: [{ id: 'https://openalex.org/T123', display_name: 'Quantum sensing', score: 0.87 }],
    primary_topic: { id: 'https://openalex.org/T123', display_name: 'Quantum sensing' },
    locations: [],
  });

  assert.equal(mapped!.enrichment.concepts![0].display_name, 'Quantum sensing');
  assert.equal(mapped!.enrichment.primaryTopic!.id, 'https://openalex.org/T123');
});

test('collapses fragmented author records sharing a name, keeping the richest profile', () => {
  const deduped = dedupeAuthors([
    { id: 'A1', display_name: 'Geoffrey E. Hinton', works_count: 12, cited_by_count: 100, orcid: null, institution: null },
    { id: 'A2', display_name: 'Geoffrey E. Hinton', works_count: 400, cited_by_count: 500000, orcid: 'https://orcid.org/0000-0001', institution: 'University of Toronto' },
    { id: 'A3', display_name: 'geoffrey e hinton', works_count: 3, cited_by_count: 5, orcid: null, institution: null },
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'A2');
  assert.equal(deduped[0].institution, 'University of Toronto');
});

test('adds localized ROR institution names to author profiles', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'https://ror.org/02f40zc51',
    names: [
      { value: 'Universidad de Salamanca', lang: 'es', types: ['ror_display', 'label'] },
      { value: 'University of Salamanca', lang: 'en', types: ['label'] },
    ],
    locations: [{ geonames_details: { name: 'Salamanca', country_name: 'Spain', country_code: 'ES' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const author = await enrichAuthorInstitutionLocalization<OpenAlexAuthor>({
      id: 'https://openalex.org/A123',
      display_name: 'Raúl Muñoz',
      last_known_institutions: [{
        id: 'https://openalex.org/I123',
        display_name: 'Universidad de Salamanca',
        ror: 'https://ror.org/02f40zc51',
      }],
    });

    assert.equal(author.institutionData!.localized_names!.en, 'University of Salamanca');
    assert.equal(author.last_known_institutions![0].localized_names!.en, 'University of Salamanca');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('back-fills a missing institution and ORCID from a weaker duplicate', () => {
  const deduped = dedupeAuthors([
    { id: 'B1', display_name: 'Ada Lovelace', works_count: 50, cited_by_count: 900, orcid: null, institution: null },
    { id: 'B2', display_name: 'Ada Lovelace', works_count: 2, cited_by_count: 3, orcid: 'https://orcid.org/0000-0002', institution: 'Analytical Engine Lab' },
  ]);

  // B1 wins on works/citations, but adopts the identity fields it was missing.
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'B1');
  assert.equal(deduped[0].institution, 'Analytical Engine Lab');
  assert.equal(deduped[0].orcid, 'https://orcid.org/0000-0002');
});

test('keeps same-name authors separate when their ORCIDs differ', () => {
  const deduped = dedupeAuthors([
    { id: 'D1', display_name: 'Juan García', works_count: 80, cited_by_count: 900, orcid: 'https://orcid.org/0000-0001', institution: null },
    { id: 'D2', display_name: 'Juan García', works_count: 40, cited_by_count: 200, orcid: 'https://orcid.org/0000-0002', institution: null },
  ]);

  assert.equal(deduped.length, 2);
});

test('keeps same-name authors separate when their institutions differ', () => {
  const deduped = dedupeAuthors([
    { id: 'E1', display_name: 'Juan García', works_count: 80, cited_by_count: 900, orcid: null, institution: 'Universidad de Sevilla' },
    { id: 'E2', display_name: 'Juan García', works_count: 40, cited_by_count: 200, orcid: null, institution: 'Universidad de Chile' },
  ]);

  assert.equal(deduped.length, 2);
});

test('still merges an identity-less fragment into a same-name profile with identity', () => {
  const deduped = dedupeAuthors([
    { id: 'F1', display_name: 'Juan García', works_count: 3, cited_by_count: 5, orcid: null, institution: null },
    { id: 'F2', display_name: 'Juan García', works_count: 200, cited_by_count: 4000, orcid: 'https://orcid.org/0000-0003', institution: 'Universidad de Granada' },
  ]);

  // The bare fragment carries nothing that contradicts F2, so it folds in.
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'F2');
  assert.equal(deduped[0].institution, 'Universidad de Granada');
});

test('keeps distinct authors with different names', () => {
  const deduped = dedupeAuthors([
    { id: 'C1', display_name: 'Yann LeCun', works_count: 300, cited_by_count: 400000, orcid: null, institution: 'NYU' },
    { id: 'C2', display_name: 'Yoshua Bengio', works_count: 350, cited_by_count: 450000, orcid: null, institution: 'MILA' },
  ]);

  assert.equal(deduped.length, 2);
});

test('maps Crossref institution fallback records into PaperTok papers', () => {
  const paper = mapCrossrefInstitutionWork({
    DOI: '10.1000/example-work',
    title: ['A study from an institutional fallback'],
    abstract: '<jats:p>Crossref <i>abstract</i>.</jats:p>',
    author: [{ given: 'Ada', family: 'Lovelace' }],
    published: { 'date-parts': [[2024, 4, 2]] },
    'container-title': ['Journal of Reliable Metadata'],
    publisher: 'Example Publisher',
    URL: 'https://doi.org/10.1000/example-work',
    'is-referenced-by-count': 18,
    type: 'journal-article',
    license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }],
  });

  assert.deepEqual(paper, {
    id: 'crossref:10.1000/example-work',
    doi: '10.1000/example-work',
    title: 'A study from an institutional fallback',
    abstract: 'Crossref abstract .',
    authors: [{ name: 'Ada Lovelace' }],
    year: 2024,
    published: '2024-04-02',
    journal: 'Journal of Reliable Metadata',
    publisher: 'Example Publisher',
    publicationType: 'journal',
    publicationStatus: 'published',
    peerReviewed: true,
    openAccess: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    landingPageUrl: 'https://doi.org/10.1000/example-work',
    citationCount: 18,
    sourceType: 'journal-article',
    provider: 'crossref',
    sources: { primary: 'crossref', enrichedBy: [] },
  });
});

test('ORs OpenAlex identifiers as values of one filter, not as several filters', () => {
  // `openalex:W1|openalex:W2` is refused: «It looks like you're trying to do an
  // OR query between filters and it's not supported». One call site wrote it
  // that way and had always been getting a 400 in production.
  assert.equal(buildOpenAlexIdFilter(['W1', 'W2', 'W3']), 'openalex:W1%7CW2%7CW3');
  assert.doesNotMatch(buildOpenAlexIdFilter(['W1', 'W2']), /openalex:.*openalex:/);
});

test('drops blanks and duplicates instead of sending an empty filter', () => {
  assert.equal(buildOpenAlexIdFilter(['W1', '', '  ', 'W1', 'W2']), 'openalex:W1%7CW2');
  assert.equal(buildOpenAlexIdFilter([]), '');
  assert.equal(buildOpenAlexIdFilter(null), '');
});

test('the deadline covers a non-OpenAlex body that never finishes', async () => {
  // This branch hands the response back unread, so the body is read by a caller
  // far from here. Clearing the timer on the way out left that read unbounded.
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout('https://api.crossref.org/works?query=deadline', 50);
        await response.json();
      }),
      'TimeoutError',
    );
  });
});


// --- institution prominence -------------------------------------------------

// Live ROR, 2026-08-26: `?query=MIT` answers with 47 organisations, 20 on the
// page, SEVEN of which carry MIT in `acronyms`. Every one of them scores 100,
// and Massachusetts Institute of Technology is seventh in ROR's own order.
const ROR_MIT_ITEMS = ([
  ['04mtcj695', 'University of Southern Mindanao', ['MIT', 'USM']],
  ['047m6hg73', 'Management Intelligenter Technologien (Germany)', ['MIT']],
  ['002r67t24', 'Manukau Institute of Technology', ['MIT']],
  ['02mb6z761', 'Myanmar Institute of Theology', ['MIT']],
  ['02qk9nj07', 'Ministry of Infrastructures and Transport', ['MIT']],
  ['02yyma482', 'International Tourism Institute', ['ITI', 'MIT']],
  ['042nb2s44', 'Massachusetts Institute of Technology', ['MIT']],
] as [string, string, string[]][]).map(([rorId, displayName, acronyms]) => ({
  id: `https://ror.org/${rorId}`,
  names: [
    { value: displayName, lang: 'en', types: ['ror_display', 'label'] },
    ...acronyms.map(value => ({ value, types: ['acronym'] })),
  ],
  locations: [{ geonames_details: { country_code: 'US', country_name: 'United States' } }],
  types: ['education'],
}));

// The real OpenAlex figures for those same ROR ids.
const OPENALEX_MIT_STATS = ([
  ['042nb2s44', 355652, 65816719],
  ['002r67t24', 1004, 22797],
  ['04mtcj695', 974, 8769],
  ['02mb6z761', 255, 4328],
  ['02qk9nj07', 150, 3472],
  ['047m6hg73', 128, 1225],
  ['02yyma482', 122, 338],
] as [string, number, number][]).map(([rorId, works_count, cited_by_count]) => ({
  ror: `https://ror.org/${rorId}`,
  works_count,
  cited_by_count,
  summary_stats: { h_index: works_count },
}));

// ROR goes through the bare global `fetch`; OpenAlex does not. The shared
// client bound `globalThis.fetch` when its module loaded, so it has to be
// injected instead — see `fetchInstitutionProminence`.
function stubRorFetch() {
  return async (input: string | URL | Request) => {
    const href = String((input as Request)?.url || input);
    if (!href.includes('api.ror.org')) throw new Error(`unexpected request: ${href}`);
    return new Response(JSON.stringify({ items: ROR_MIT_ITEMS }), { status: 200 });
  };
}

async function withRorFetch<T>(run: () => T): Promise<Awaited<T>> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubRorFetch();
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('an acronym search does not cut off the institution everybody meant', async () => {
  // The whole bug in one assertion: six organisations tie at 100 above MIT, the
  // slice keeps five, so a search for "MIT" answered without MIT in it.
  const requested: string[] = [];
  const results = await withRorFetch(() => searchInstitutions('MIT', {
    openAlexJson: async (url) => {
      requested.push(url);
      return { results: OPENALEX_MIT_STATS };
    },
  }));
  {
    // One request for the whole candidate list, filtered by the identifiers we
    // already hold — not one per institution, and not a second text search.
    assert.equal(requested.length, 1);
    assert.match(requested[0], /filter=ror:[0-9a-z]{9}(?:%7C[0-9a-z]{9}){6}&/);

    assert.equal(results[0].display_name, 'Massachusetts Institute of Technology');
    assert.equal(results.length, 5);
    assert.deepEqual(
      results.map(institution => institution.display_name),
      [
        'Massachusetts Institute of Technology',
        'Manukau Institute of Technology',
        'University of Southern Mindanao',
        'Myanmar Institute of Theology',
        'Ministry of Infrastructures and Transport',
      ],
    );
    // The ROR identity is what both search surfaces navigate with
    // (`institution.id.split('/').pop()`), so enrichment must not swap in an
    // OpenAlex id.
    assert.equal(results[0].id, 'https://ror.org/042nb2s44');
    assert.equal(results[0].cited_by_count, 65816719);
  }
});

test('a dead prominence lookup costs the order, never the results', async () => {
  // Best-effort by construction: OpenAlex is metered and rate-limited, and the
  // institutions task has 4.5s. If the tie-break cannot be had, the section
  // still renders in ROR's order rather than coming back empty.
  // A query of its own, because `searchRorInstitutions` caches on the
  // normalized query and "MIT" is already answered above.
  const results = await withRorFetch(() => searchInstitutions('Institute of Technology', {
    openAlexJson: async () => { throw new Error('OpenAlex is down'); },
  }));
  {
    assert.deepEqual(
      results.map(institution => institution.display_name),
      // ROR's own order, untouched: Manukau is third on its page and
      // Massachusetts seventh. Nothing was dropped, only left unranked.
      ['Manukau Institute of Technology', 'Massachusetts Institute of Technology'],
    );
    assert.equal(results[0].cited_by_count, null, 'un-enriched, exactly as ROR sent it');
  }
});

test('ROR identifiers OR as values of one filter, like every other OpenAlex filter', () => {
  assert.equal(buildRorIdFilter(['042nb2s44', 'https://ror.org/02f40zc51']), 'ror:042nb2s44%7C02f40zc51');
  assert.doesNotMatch(buildRorIdFilter(['042nb2s44', '02f40zc51']), /ror:.*ror:/);
  assert.equal(buildRorIdFilter(['042nb2s44', '042nb2s44']), 'ror:042nb2s44');
  assert.equal(buildRorIdFilter(['not-a-ror', '']), '');
  assert.equal(buildRorIdFilter([]), '');
  assert.equal(buildRorIdFilter(null), '');
});

/**
 * The public paper page opens the likes the feed remembered under a provider
 * id — `openalex:W…` from an OpenAlex card, `pmid:…` from a PubMed one — and
 * OpenAlex resolves both through `GET /works/{id}`. The paper comes back with
 * the id the feed would have given it, so a like made on the page and one
 * made on the card are the same interaction document.
 */
const WORK_FIXTURE = {
  id: 'https://openalex.org/W2741809807',
  doi: 'https://doi.org/10.7717/peerj.4375',
  title: 'The state of OA',
  publication_date: '2018-02-13',
  cited_by_count: 12,
  authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Heather Piwowar' }, institutions: [] }],
  abstract_inverted_index: { Open: [0], access: [1], to: [2], research: [3], articles: [4], keeps: [5], growing: [6], every: [7], year: [8] },
  primary_location: { landing_page_url: 'https://peerj.com/articles/4375', source: { display_name: 'PeerJ', type: 'journal' } },
  open_access: { is_oa: true, oa_url: 'https://peerj.com/articles/4375.pdf' },
  concepts: [],
};

test('opens an OpenAlex work id or a PubMed id through /works/{id}, keyed as the feed keys it', async () => {
  const requested: unknown[] = [];
  const openAlexJson = async (url: unknown) => { requested.push(url); return WORK_FIXTURE; };

  const byWork = await fetchPaperByWorkId('openalex', 'w2741809807', { openAlexJson });
  assert.equal(byWork!.id, 'openalex:W2741809807');
  assert.equal(byWork!.title, 'The state of OA');
  assert.equal(byWork!.doi, '10.7717/peerj.4375');
  assert.equal(byWork!.abstract, 'Open access to research articles keeps growing every year');

  const byPmid = await fetchPaperByWorkId('pmid', '31234567', { openAlexJson });
  assert.equal(byPmid!.id, 'pmid:31234567');

  assert.deepEqual(requested, [
    'https://api.openalex.org/works/W2741809807',
    'https://api.openalex.org/works/pmid%3A31234567',
  ]);
});

test('refuses to ask OpenAlex for an id that is not a work or a PubMed number', async () => {
  const openAlexJson = async () => { throw new Error('must not be called'); };
  assert.equal(await fetchPaperByWorkId('openalex', 'A2741809807', { openAlexJson }), null);
  assert.equal(await fetchPaperByWorkId('pmid', '12a', { openAlexJson }), null);
  assert.equal(await fetchPaperByWorkId('doi', 'not a doi', { openAlexJson }), null);
  assert.equal(await fetchPaperByWorkId('openalex', '', { openAlexJson }), null);
});

test('a work OpenAlex does not have is not found; a provider failure is an error the page can retry', async () => {
  const notFound = Object.assign(new Error('OpenAlex API error: 404'), { status: 404 });
  assert.equal(await fetchPaperByWorkId('openalex', 'W1', { openAlexJson: async () => { throw notFound; } }), null);
  assert.equal(await fetchPaperByWorkId('openalex', 'W1', { openAlexJson: async () => ({}) }), null);

  const down = Object.assign(new Error('OpenAlex API error: 503'), { status: 503 });
  await assert.rejects(
    fetchPaperByWorkId('openalex', 'W1', { openAlexJson: async () => { throw down; } }),
    down,
  );
});

// The personal lane's cards arrive by DOI. A synthetic work shaped like the
// `/works?filter=doi:` results: OpenAlex dates a work as a calendar day, and
// files a work known only by its year under 1 January.
const doiWork = (doi: string, fields: Partial<OpenAlexWork> = {}): OpenAlexWork => ({
  ...WORK_FIXTURE,
  id: `https://openalex.org/W${doi.replace(/\D/g, '')}`,
  doi: `https://doi.org/${doi}`,
  ...fields,
});

async function fetchDoiCard(t: import('node:test').TestContext, work: OpenAlexWork) {
  t.mock.method(openAlexClient, 'fetch', async () => Response.json({ meta: { count: 1 }, results: [work] }));
  const papers = await fetchPapersByDois([work.doi!]);
  assert.equal(papers.length, 1);
  return papers[0];
}

test('a DOI card keeps the date, abstract and metadata OpenAlex gave it', async t => {
  const paper = await fetchDoiCard(t, doiWork('10.7717/peerj.4375'));

  assert.equal(paper.title, 'The state of OA');
  assert.equal(paper.doi, '10.7717/peerj.4375');
  assert.deepEqual(paper.authors.map(author => (author as PaperAuthor).name), ['Heather Piwowar']);
  assert.equal(paper.abstract, 'Open access to research articles keeps growing every year');
  assert.equal(paper.summary, 'Open access to research articles keeps growing every year');
  assert.equal(paper.year, 2018);
  assert.equal(paper.published, '2018-02-13');
  assert.equal(paper.journal, 'PeerJ');
  assert.equal(paper.citationCount, 12);
  assert.equal(paper.pdfUrl, 'https://peerj.com/articles/4375.pdf');
});

// Los Angeles is eight hours behind UTC on 1 January: midnight UTC on that day
// is still 31 December there.
test('a DOI card dated 1 January keeps its year in a time zone behind UTC', async t => {
  const paper = await inTimeZone('America/Los_Angeles', () => {
    assert.equal(new Date('2026-01-01').getDate(), 31, 'the clock reads Los Angeles time');
    return fetchDoiCard(t, doiWork('10.1000/new-year', { publication_date: '2026-01-01' }));
  });

  assert.equal(paper.year, 2026);
  assert.equal(paper.published, '2026-01-01');
});

test('a DOI card OpenAlex gives no date has no year and no publication date', async t => {
  const paper = await fetchDoiCard(t, doiWork('10.1000/undated', { publication_date: undefined }));

  assert.equal(paper.year, undefined);
  assert.ok(!paper.published, `published is ${JSON.stringify(paper.published)}`);
});

test('a DOI card without an abstract offers none, in English or any other words', async t => {
  const paper = await fetchDoiCard(t, doiWork('10.1000/no-abstract', { abstract_inverted_index: undefined }));

  assert.equal(hasUsableAIAbstract(paper.abstract), false);
  // The summary is what a like, a save and a reference export store as the abstract.
  assert.equal(paper.summary, '');
  assert.doesNotMatch(JSON.stringify(paper), /resumen|disponible/i);
});

test('a works page and an authors page persist as what the Explorer shows, not as raw OpenAlex objects', async () => {
  const { slimWorksPage, slimAuthorsPage } = await import('./open-alex-service.ts');
  const work = {
    id: 'https://openalex.org/W1', title: 'A paper', publication_date: '2024-02-01', cited_by_count: 3,
    abstract_inverted_index: { This: [0], abstract: [1], describes: [2], a: [3], paper: [4], about: [5], experimental: [6], physics: [7], results: [8] },
    authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ada' }, institutions: [{ id: 'I1', display_name: 'Uni' }] }],
    concepts: [{ display_name: 'Physics' } as import('../models/paper.ts').PaperSubject], primary_location: { source: { type: 'journal', display_name: 'J' }, is_published: true },
  };
  const page = slimWorksPage({ results: [work as OpenAlexWork], meta: { count: 42 } });
  assert.equal(page.total, 42);
  assert.equal(page.papers.length, 1);
  assert.equal(page.papers[0].title, 'A paper');
  assert.equal(page.papers[0].abstract, 'This abstract describes a paper about experimental physics results');
  assert.ok(!('abstract_inverted_index' in page.papers[0]));
  assert.deepEqual(slimWorksPage(null), { papers: [], total: 0 });

  const authors = (slimAuthorsPage as (data: unknown) => unknown)({ results: [{ id: 'A1', display_name: 'Ada', works_count: 2, summary_stats: { h_index: 5 }, last_known_institutions: [{ display_name: 'Uni' }], x_concepts: [1, 2, 3, 4] }], meta: { count: 9 } });
  assert.deepEqual(authors, { authors: [{ id: 'A1', display_name: 'Ada', works_count: 2, cited_by_count: 0, h_index: 5, institution: 'Uni', concepts: [1, 2, 3] }], total: 9 });
});

test('the works and authors requests persist the pages the Explorer shows, not the raw responses', async () => {
  const previousStorage = openAlexClient.storage;
  const previousStore = openAlexClient.persistentStore;
  const realFetch = openAlexClient.fetchImpl;
  const memory = new Map<string, string>();
  openAlexClient.storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  openAlexClient.persistentStore = null;
  openAlexClient.fetchImpl = async (url) => Response.json(String(url).includes('/authors?')
    ? { meta: { count: 1 }, results: [{ id: 'https://openalex.org/A7000000002', display_name: 'Ada', works_count: 2, summary_stats: { h_index: 5 }, x_concepts: [] }] }
    : { meta: { count: 1 }, results: [{ id: 'https://openalex.org/W7000000002', title: 'A persisted paper', abstract_inverted_index: { Persisted: [0], text: [1] } }] });
  try {
    await getWorksByEntity('author', 'A7000000002', 'cited_by_count:desc', 1, '', {}, 'Ada');
    await getAuthorsByEntity('institution', 'I7000000002', 1, '', 'Uni');
    await Promise.resolve();

    const entries = Object.values(JSON.parse(memory.get('papertok_openalex_cache_v1')!) as Record<string, { data: unknown }>).map(entry => entry.data);
    assert.deepEqual(entries.map(data => Object.keys(data as object).sort().join(',')).sort(), ['authors,total', 'papers,total']);
    const serialized = JSON.stringify(entries);
    assert.doesNotMatch(serialized, /abstract_inverted_index|summary_stats/);
    assert.match(serialized, /"title":"A persisted paper"/);
    assert.match(serialized, /"h_index":5/);
  } finally {
    openAlexClient.fetchImpl = realFetch;
    openAlexClient.storage = previousStorage;
    openAlexClient.persistentStore = previousStore;
  }
});

// The previous release built this page with `peerReviewed: true` on the FEDS
// working paper and persisted it for six hours, and at any age as the answer
// when OpenAlex fails. Read back, it put the working paper through
// "Peer-reviewed only" without a request. A `v3` page answered the query from
// before it named the working-paper series, so it numbers other works.
test('an Explorer works page persisted before the review rule is fetched again', async () => {
  const previousStorage = openAlexClient.storage;
  const previousStore = openAlexClient.persistentStore;
  const realFetch = openAlexClient.fetchImpl;
  const memory = new Map<string, string>();
  openAlexClient.storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) } as NonNullable<typeof openAlexClient.storage> & Record<string, unknown>;
  openAlexClient.persistentStore = null;
  const filters = { peerReviewed: true };
  for (const version of ['v2', 'v3']) {
    writeOpenAlexPersistent(`entity-works-${version}:author:A7000000001:cited_by_count:desc:1::${JSON.stringify(filters)}`, {
      papers: [{ id: 'W4414816997', title: 'A FEDS paper', publicationStatus: 'published', peerReviewed: true, sources: { primary: 'openalex', enrichedBy: [] } }],
      total: 1,
    });
  }
  const urls: string[] = [];
  openAlexClient.fetchImpl = async (url) => {
    urls.push(String(url));
    return Response.json({ meta: { count: 1 }, results: [FEDS_WORK] });
  };
  try {
    const { papers } = await getWorksByEntity('author', 'A7000000001', 'cited_by_count:desc', 1, '', filters, 'Ada Lovelace');

    assert.equal(urls.filter(url => url.includes('/works?')).length, 1);
    assert.deepEqual(filterAndSortEntityPapers(PaperBuilder.deduplicate(papers), { filters }), []);
  } finally {
    openAlexClient.fetchImpl = realFetch;
    openAlexClient.storage = previousStorage;
    openAlexClient.persistentStore = previousStore;
  }
});

// What OpenAlex does with each clause of the works query, as keyless requests
// showed on 2026-10-20: `|` is OR inside one filter, comma-separated filters
// are ANDed, and so is each repeated negated `primary_location.source.id`,
// which also keeps works with no source. Every work here is the author's.
function openAlexFilterKeeps(filter: string, work: OpenAlexWork) {
  return filter.split(',').every((clause) => {
    const key = clause.slice(0, clause.indexOf(':'));
    const value = clause.slice(clause.indexOf(':') + 1);
    if (key === 'author.id') return true;
    if (key === 'primary_location.is_published') return String(Boolean(work.primary_location?.is_published)) === value;
    if (key === 'type') return value.split('|').includes(String(work.type));
    if (key === 'primary_location.source.id' && value.startsWith('!')) {
      return work.primary_location?.source?.id !== `https://openalex.org/${value.slice(1)}`;
    }
    throw new Error(`no stand-in for the clause ${clause}`);
  });
}

// OpenAlex's works endpoint over one author's works, in the order the query
// sorts them: the count and the pages are of the works the filter keeps.
function stubAuthorWorks(works: OpenAlexWork[]) {
  return async (url: string | URL | Request) => {
    const params = new URL(String(url)).searchParams;
    const page = Number(params.get('page'));
    const kept = works.filter(work => openAlexFilterKeeps(params.get('filter')!, work));
    return Response.json({ meta: { count: kept.length }, results: kept.slice((page - 1) * 30, page * 30) });
  };
}

const venue = (id: string, display_name: string, type = 'journal') => ({
  is_published: true,
  source: { id: `https://openalex.org/${id}`, display_name, type },
});

// Synthetic works by one author, sources as OpenAlex files them.
const authorWork = (n: number, source: ReturnType<typeof venue>): OpenAlexWork => ({
  id: `https://openalex.org/W9${String(n).padStart(5, '0')}`,
  title: `Labour market study ${n}`,
  type: 'article',
  authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Ana Economist' } }],
  primary_location: source,
});
const FEDS = venue('S4210212089', 'Finance and Economics Discussion Series');
// A discussion-paper series filed as a journal and missing from the rule's
// list: the rule cannot call its articles reviewed, and the query cannot name it.
const UNLISTED_SERIES = venue('S10', 'IZA Discussion Papers');
const JOURNAL = venue('S11', 'Journal of Labor Economics');

const reviewedOnly = { category: '', peerReviewed: true, dateRange: '' };
const explorerRows = (papers: Paper[]) => filterAndSortEntityPapers(PaperBuilder.deduplicate(papers), { filters: reviewedOnly });

test('"Peer-reviewed only" asks OpenAlex to leave out reports and listed series, and no work the rule calls reviewed', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const urls: string[] = [];
  openAlexClient.fetchImpl = async (url) => {
    urls.push(String(url));
    return Response.json({ meta: { count: 0 }, results: [] });
  };
  try {
    await getWorksByEntity('author', 'A7000000002', 'cited_by_count:desc', 1, '', reviewedOnly, 'Ana Economist');
    await getWorksByEntity('author', 'A7000000003', 'cited_by_count:desc', 1, '', { category: '', peerReviewed: false, dateRange: '' }, 'Ana Economist');
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
  const [reviewedFilter, everything] = urls
    .filter(url => url.includes('/works?'))
    .map(url => new URL(url).searchParams.get('filter')!);
  assert.equal(everything, 'author.id:A7000000003');

  const works: OpenAlexWork[] = [
    FEDS_WORK,
    NATURE_WORK,
    { id: 'W-imf', type: 'article', primary_location: venue('S4210171147', 'IMF Working Papers') },
    { id: 'W-nber', type: 'report', primary_location: venue('S2809516038', 'National Bureau of Economic Research', 'repository') },
    { id: 'W-proceedings', type: 'conference-paper', primary_location: venue('S5', 'NeurIPS', 'conference') },
    { id: 'W-review', type: 'review', primary_location: venue('S6', 'Annual Review of Economics') },
    { id: 'W-published-preprint', type: 'preprint', primary_location: venue('S7', 'Journal of Finance') },
    { id: 'W-unsourced', type: 'article', primary_location: { is_published: true, source: null }, locations: [venue('S8', 'Econometrica')] },
    { id: 'W-chapter', type: 'book-chapter', primary_location: venue('S9', 'Lecture Notes in Economics', 'book series') },
    { id: 'W-iza', type: 'article', primary_location: UNLISTED_SERIES },
  ];
  const reviewed = works.filter(work => openAlexPeerReviewed(work) === true);
  assert.deepEqual(reviewed.map(work => work.id), [NATURE_WORK.id, 'W-proceedings', 'W-review', 'W-published-preprint', 'W-unsourced']);
  for (const work of reviewed) assert.ok(openAlexFilterKeeps(reviewedFilter, work), `${work.id} is asked for`);
  assert.deepEqual(
    works.filter(work => !openAlexFilterKeeps(reviewedFilter, work)).map(work => work.id),
    [FEDS_WORK.id, 'W-imf', 'W-nber', 'W-chapter'],
  );
});

test('an author whose most cited works are FEDS papers gets reviewed rows on the first "Peer-reviewed only" page', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const works = [
    ...Array.from({ length: 30 }, (_, n) => authorWork(n, FEDS)),
    ...Array.from({ length: 30 }, (_, n) => authorWork(30 + n, JOURNAL)),
  ];
  openAlexClient.fetchImpl = stubAuthorWorks(works);
  try {
    const { papers, total } = await getWorksByEntity('author', 'A7000000006', 'cited_by_count:desc', 1, '', reviewedOnly, 'Ana Economist');
    const rows = explorerRows(papers);

    assert.equal(total, 30);
    assert.equal(rows.length, 30);
    assert.ok(rows.every(paper => paper.journal === 'Journal of Labor Economics'));
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

test('the enrichment carries the authors with their OpenAlex ids', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W123',
    authorships: [
      { author: { id: 'https://openalex.org/A5006398227', display_name: 'A. M. Gavrilik' } },
      { author: { id: null, display_name: 'Do, Tuan' } },
      { author: {} },
    ],
  });

  assert.deepEqual(mapped!.enrichment.authors, [
    { name: 'A. M. Gavrilik', id: 'https://openalex.org/A5006398227' },
    // OpenAlex leaves an authorship undisambiguated often enough to matter --
    // 3 of 18 papers on a measured feed page -- and the name is still worth
    // carrying, so the entry stays with a null id rather than being dropped.
    { name: 'Do, Tuan', id: null },
    { name: 'Unknown', id: null },
  ]);
});

test('a work with no authorships enriches without an authors key', () => {
  const mapped = mapOpenAlexEnrichmentWork({ id: 'https://openalex.org/W123' });
  assert.equal('authors' in mapped!.enrichment, false, 'nothing to graft is not the same as an empty list');
});

// PAP-31. OpenAlex writes a work's PubMed id as a URL in `ids.pmid`; the feed
// asks Europe PMC by the bare number in `paper.pmid`. Shaped after the live
// record of W2107277218 (fetched 2026-10-17): closed, no OpenAlex abstract.
const PUBMED_LINKED_WORK = {
  id: 'https://openalex.org/W2107277218',
  doi: 'https://doi.org/10.1006/meth.2001.1262',
  ids: {
    openalex: 'https://openalex.org/W2107277218',
    doi: 'https://doi.org/10.1006/meth.2001.1262',
    pmid: 'https://pubmed.ncbi.nlm.nih.gov/11846609',
  },
  title: 'Analysis of Relative Gene Expression Data Using Real-Time Quantitative PCR and the 2−ΔΔCT Method',
  type: 'article',
  publication_date: '2001-12-01',
  abstract_inverted_index: null,
  open_access: { is_oa: false, oa_url: null },
  primary_location: {
    landing_page_url: 'https://doi.org/10.1006/meth.2001.1262',
    is_published: true,
    source: { display_name: 'Methods', type: 'journal' },
  },
  cited_by_count: 180397,
};
const UNLINKED_WORK = { ...PUBMED_LINKED_WORK, ids: { openalex: PUBMED_LINKED_WORK.ids.openalex, doi: PUBMED_LINKED_WORK.ids.doi } };

test('a works page keeps the PubMed id OpenAlex writes as a URL, as the bare number', () => {
  const { papers } = slimWorksPage({ results: [PUBMED_LINKED_WORK, UNLINKED_WORK] });
  assert.equal(papers[0].pmid, '11846609');
  assert.equal(papers[1].pmid, undefined);
});

test('the enrichment carries the PubMed id as the bare number', () => {
  assert.equal(mapOpenAlexEnrichmentWork(PUBMED_LINKED_WORK)!.enrichment.pmid, '11846609');
  assert.equal(mapOpenAlexEnrichmentWork(UNLINKED_WORK)!.enrichment.pmid, undefined);
});

test('a closed paper from a works page takes its abstract from Europe PMC and stays closed', () => {
  const [paper] = slimWorksPage({ results: [PUBMED_LINKED_WORK] }).papers;
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

  const [merged] = mergeEuropePmcEnrichment([paper], new Map([[record.pmid, record]]));
  assert.equal(merged.abstract, abstract);
  assert.equal(merged.openAccess, false, 'an abstract is not access to the full text');
  assert.equal(merged.openAccessPdfUrl, undefined);
});

/**
 * Collaboration papers carry 1,000–3,000 authorships. Mapped whole, a
 * 2,000-author work serialises to ~150K chars of `authors` alone — over the
 * 150,000-char cap a persistent entry may have (open-alex-client.ts), so it was
 * silently dropped and re-fetched every session (2026-09-09 review). The graft
 * only needs candidates for the names a card already shows, and a card never
 * shows thousands; fifty keeps the entry under 5K and the first fifty authors
 * — the ones a reader can actually reach — get their door.
 */
test('the mapped authorships are capped, in authorship order', () => {
  const authorships = Array.from({ length: 2000 }, (_, i) => ({
    author: { id: `https://openalex.org/A${i}`, display_name: `Author ${i}` },
  }));
  const mapped = mapOpenAlexEnrichmentWork({ id: 'https://openalex.org/W1', authorships });
  assert.equal(mapped!.enrichment.authors!.length, MAX_ENRICHMENT_AUTHORS);
  assert.equal((mapped!.enrichment.authors![0] as PaperAuthor).id, 'https://openalex.org/A0');
  assert.equal((mapped!.enrichment.authors![MAX_ENRICHMENT_AUTHORS - 1] as PaperAuthor).id, `https://openalex.org/A${MAX_ENRICHMENT_AUTHORS - 1}`);
  assert.ok(JSON.stringify(mapped!.enrichment).length < 20_000, 'and the entry stays far under the persistent cap');
});

test('the enrichment request asks OpenAlex for the authorships', async () => {
  // Without this field the ids never reach the browser at all, and the card
  // has to send the reader through the name door. OpenAlex refuses subfield
  // selection (`authorships.author.id` answers 400), so it is all or nothing.
  const realFetch = openAlexClient.fetchImpl;
  const urls: string[] = [];
  openAlexClient.fetchImpl = async (url) => {
    urls.push(String(url));
    return Response.json({ results: [] });
  };
  try {
    await enrichPapersBatch(['W7000000003']);
    assert.equal(urls.length, 1);
    assert.ok(new URL(urls[0]).searchParams.get('select')!.split(',').includes('authorships'), urls[0]);
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

// The Explorer's category filter used to send OpenAlex legacy concepts for
// eight areas and nothing for the other four, while its rows are labelled by
// their topic's field. Asked for Medicine, an entity page now asks OpenAlex for
// the fields that label a row as Medicine.
test('an entity page filtered by area asks OpenAlex for the fields that label that area', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const urls: string[] = [];
  openAlexClient.fetchImpl = async (url) => {
    urls.push(decodeURIComponent(String(url)));
    return new Response(JSON.stringify({ meta: { count: 0 }, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await getWorksByEntity('author', 'A123', 'cited_by_count:desc', 1, '', { category: 'med' }, 'Ada Lovelace');
    const works = urls.find(url => url.includes('/works?'));
    assert.ok(works, `asked for works, got ${urls.join(' ')}`);
    assert.match(works, /filter=author\.id:A123,primary_topic\.field\.id:24\|27\|28\|29\|30\|35\|36(&|$)/);
    assert.doesNotMatch(works, /concepts\.id/);
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

test('a DOI-keyed id is fetched by DOI and comes back under that key', async () => {
  // Overriding the singleton's fetchImpl rather than globalThis.fetch: the
  // client binds its own at construction, so a global stub never reaches it
  // and the test would go to the real network and pass for the wrong reason.
  const realFetch = openAlexClient.fetchImpl;
  const urls: string[] = [];
  openAlexClient.fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      results: [{
        id: 'https://openalex.org/W7202263130',
        doi: 'https://doi.org/10.1142/s0218271826500495',
        cited_by_count: 3,
        authorships: [{ author: { id: 'https://openalex.org/A7', display_name: 'Ada Lovelace' } }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await enrichPapersBatch(['doi:10.1142/s0218271826500495']);
    // The client percent-encodes the query on its way out, so the check is
    // against the decoded URL rather than the literal one.
    const asked = urls.map(url => decodeURIComponent(url));
    assert.ok(asked.some(url => url.includes('filter=doi:10.1142/s0218271826500495')), `asked by DOI, got ${asked.join(' ')}`);
    assert.ok(result['doi:10.1142/s0218271826500495'], 'keyed by the id the feed will look it up with');
    assert.equal((result['doi:10.1142/s0218271826500495'].authors![0] as PaperAuthor).id, 'https://openalex.org/A7');
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

// A helper for the two tests below: they both need to know WHEN each request
// was issued, not only that it was.
function recordingFetch(handlers: [string, () => Response | Promise<Response>][]) {
  const urls: string[] = [];
  return {
    urls,
    impl: async (url: string | URL | Request) => {
      const decoded = decodeURIComponent(String(url));
      urls.push(decoded);
      for (const [pattern, respond] of handlers) {
        if (decoded.includes(pattern)) return respond();
      }
      return new Response('{}', { status: 404 });
    },
  };
}

test('the name search does not wait for the work lookup to fail', async () => {
  // The paper OpenAlex has not indexed is the majority case -- 51 of 56 slow
  // links on a measured feed page -- and there the work lookup can only 404.
  // Running the name search behind it made three round trips out of one.
  const realFetch = openAlexClient.fetchImpl;
  let releaseWork!: () => void;
  const workHeld = new Promise<void>((resolve) => { releaseWork = resolve; });
  const { urls, impl } = recordingFetch([
    ['works/doi:', async () => { await workHeld; return new Response('{}', { status: 404 }); }],
    ['authors?search=', () => new Response(JSON.stringify({
      results: [{ id: 'https://openalex.org/A5139858328', display_name: 'Romain Grane', works_count: 1, summary_stats: { h_index: 0 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;

  try {
    const pending = getAuthorProfileExact('Romain Grane', '2609.05134');
    // Long enough for anything the call fires up front to have been issued.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(
      urls.some(url => url.includes('authors?search=')),
      `the name search was still waiting on the work: ${urls.join(' ')}`,
    );

    releaseWork();
    const profile = await pending;
    assert.equal(profile!.id, 'https://openalex.org/A5139858328');
    assert.ok(
      !urls.some(url => url.includes('works?filter=doi:')),
      'the standby DOI query is gone: measured 2026-09-07, it rescued 0 of 8 and was strictly worse in 2',
    );
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

test('the authorship match still beats the name search when the work is there', async () => {
  // "A. M. Gavrilik" is three different entities in OpenAlex, so the exact
  // identity has to win whenever the paper can supply one.
  const realFetch = openAlexClient.fetchImpl;
  const { urls, impl } = recordingFetch([
    ['works/doi:', () => new Response(JSON.stringify({
      id: 'https://openalex.org/W1',
      authorships: [{ author: { id: 'https://api.openalex.org/authors/A5008807080', display_name: 'A. M. Gavrilik' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors/A5008807080', () => new Response(JSON.stringify({
      id: 'https://openalex.org/A5008807080', display_name: 'A. M. Gavrilik', works_count: 92, summary_stats: { h_index: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors?search=', () => new Response(JSON.stringify({
      results: [{ id: 'https://openalex.org/A5087022088', display_name: 'A M Gavrilik', works_count: 1, summary_stats: { h_index: 0 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;

  try {
    const profile = await getAuthorProfileExact('A. M. Gavrilik', '2309.03290');
    assert.equal(profile!.id, 'https://openalex.org/A5008807080');
    assert.equal(profile!.h_index, 15);
    assert.ok(!urls.some(url => url.includes('works?filter=doi:')), 'still no standby query');
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

/**
 * The work names the author but OpenAlex never linked an id to that
 * authorship. Before 78cb22d a second search ran from OpenAlex's own spelling
 * of the name; 78cb22d deleted it and left only the search already in flight
 * from the CARD's spelling — an initialled "N. Cuello" where the work says
 * "Nicolás Cuello" — which is the one more likely to miss. Both spellings are
 * tried again: the card's first (it was already out), OpenAlex's if that misses.
 */
test('an authorship without an id falls back to a search from the spelling the work used', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const { urls, impl } = recordingFetch([
    ['works/doi:', () => new Response(JSON.stringify({
      id: 'https://openalex.org/W1',
      authorships: [{ author: { id: null, display_name: 'Nicolás Cuello' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    // The card's spelling misses; the work's spelling finds them.
    ['authors?search=N.', () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors?search=Nicol', () => new Response(JSON.stringify({
      results: [{ id: 'https://openalex.org/A5', display_name: 'Nicolás Cuello', works_count: 12, summary_stats: { h_index: 4 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;
  try {
    const profile = await getAuthorProfileExact('N. Cuello', '2310.04521');
    assert.equal(profile!.id, 'https://openalex.org/A5', 'found from the spelling the work used');
    assert.ok(urls.some((url) => url.includes('authors?search=Nicol')), 'the second search ran');
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

// A PubMed card's author used to reach this with the paper's `pmid:` id as an
// "arXiv id", which became `works/doi:10.48550/arxiv.pmid:42774036` and 404'd,
// and the name search behind it opened "Po-Wn Li" (1 work) for "Li WN". The
// paper is on OpenAlex under its PMID, and it says who wrote it: Wan-Ning Li,
// A5075361382 (audit 2026-09-23, issue 4).
test('a PubMed paper is looked up by its PMID, and the author it names is the verified one', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const { urls, impl } = recordingFetch([
    ['works/pmid:42774036', () => new Response(JSON.stringify({
      id: 'https://openalex.org/W7211952859',
      authorships: [
        { author: { id: 'https://openalex.org/A1', display_name: 'Vijaya Kumar Pidugu' }, raw_author_name: 'Pidugu VK' },
        { author: { id: 'https://openalex.org/A5075361382', display_name: 'Wan-Ning Li' }, raw_author_name: 'Li WN' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors/A5075361382', () => new Response(JSON.stringify({
      id: 'https://openalex.org/A5075361382', display_name: 'Wan-Ning Li', works_count: 40, summary_stats: { h_index: 12 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors?search=', () => new Response(JSON.stringify({
      results: [{ id: 'https://openalex.org/A5050248117', display_name: 'Po-Wn Li', works_count: 1, summary_stats: { h_index: 0 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;
  try {
    const profile = await getAuthorProfileExact('Li WN', 'pmid:42774036');
    assert.equal(profile!.id, 'https://openalex.org/A5075361382');
    assert.equal(profile!.verified, true);
    assert.ok(!urls.some(url => url.includes('arxiv.pmid')), `no arXiv DOI built from a PMID: ${urls.join(' ')}`);
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

test('a paper with a DOI is looked up by that DOI', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const { urls, impl } = recordingFetch([
    ['works/doi:10.3389/fendo.2026.1980821', () => new Response(JSON.stringify({
      id: 'https://openalex.org/W7211952859',
      authorships: [{ author: { id: 'https://openalex.org/A5075361382', display_name: 'Wan-Ning Li' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors/A5075361382', () => new Response(JSON.stringify({
      id: 'https://openalex.org/A5075361382', display_name: 'Wan-Ning Li', works_count: 40,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors?search=', () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;
  try {
    const profile = await getAuthorProfileExact('Li WN', 'doi:10.3389/fendo.2026.1980821');
    assert.equal(profile!.verified, true);
    assert.ok(urls.some(url => url.includes('works/doi:10.3389/fendo.2026.1980821')));
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

// A card's short byline can fit two authors of the same paper: PubMed's
// "Zhang W" is both Wei Zhang and Wen Zhang on a paper that lists both. The
// first authorship that matched was taken and marked verified, so whoever
// clicked Wen got Wei's page as a confirmed profile (review of 2026-09-25).
test('a byline two authorships of the paper share is not a verified identity', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const { urls, impl } = recordingFetch([
    ['works/doi:10.1000/two-zhangs', () => new Response(JSON.stringify({
      id: 'https://openalex.org/W9',
      authorships: [
        { author: { id: 'https://openalex.org/A9001', display_name: 'Wei Zhang' }, raw_author_name: 'Zhang W' },
        { author: { id: 'https://openalex.org/A9002', display_name: 'Wen Zhang' }, raw_author_name: 'Zhang W' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors/A900', () => new Response(JSON.stringify({
      id: 'https://openalex.org/A9001', display_name: 'Wei Zhang', works_count: 10,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors?search=', () => new Response(JSON.stringify({
      results: [{ id: 'https://openalex.org/A7', display_name: 'W. Zhang', works_count: 3, summary_stats: { h_index: 1 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;
  try {
    const profile = await getAuthorProfileExact('Zhang W', 'doi:10.1000/two-zhangs');
    assert.notEqual(profile!.verified, true, 'the paper cannot say which of the two was meant');
    assert.ok(!urls.some(url => /authors\/A900[12]/.test(url)), `neither author was opened as the one: ${urls.join(' ')}`);
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

test('a profile found only by the name is not verified', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const { impl } = recordingFetch([
    ['works/doi:', () => new Response('{}', { status: 404 })],
    ['authors?search=', () => new Response(JSON.stringify({
      results: [{ id: 'https://openalex.org/A5024723899', display_name: 'XY Zhou', works_count: 7, summary_stats: { h_index: 2 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;
  try {
    // Another name than the tests above: the client caches searches by URL.
    const profile = await getAuthorProfileExact('Zhou XY', '2609.05199');
    assert.equal(profile!.id, 'https://openalex.org/A5024723899');
    assert.notEqual(profile!.verified, true);
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

/**
 * Measured 2026-09-09 on a warm institution: the skeleton stood for 30 ms —
 * two frames — before the hero replaced it, and the four numbers landed at
 * once inside the hero's own crossfade. A flash, not a wait. getEntityById
 * reads this same entry first, but it is async, and by the time it answers
 * the skeleton has painted. A page born from the entry paints its data on its
 * first frame, the way one handed over from the search palette does.
 */
test('peekEntity answers the persistent cache synchronously, fresh entries only, authors and institutions only', () => {
  const previousStorage = openAlexClient.storage;
  const previousStore = openAlexClient.persistentStore;
  const memory = new Map<string, string>();
  openAlexClient.storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) } as NonNullable<typeof openAlexClient.storage> & Record<string, unknown>;
  openAlexClient.persistentStore = null;
  try {
    writeOpenAlexPersistent('entity:author:A5000000001', { id: 'https://openalex.org/A5000000001', display_name: 'Ada Lovelace', works_count: 3 });
    assert.equal(peekEntity('author', 'https://openalex.org/A5000000001')?.display_name, 'Ada Lovelace', 'a full OpenAlex url is keyed by its last segment, like getEntityById');
    assert.equal(peekEntity('author', 'A5000000001')?.works_count, 3, 'and a bare id finds the same entry');
    assert.equal(peekEntity('author', 'A5000000002'), null, 'unknown: null, never a stub');
    assert.equal(peekEntity('project', 'A5000000001'), null, 'projects come from OpenAIRE, never from here');
    assert.equal(peekEntity('topic', 'A5000000001'), null, 'topics are born local already');
  } finally {
    openAlexClient.storage = previousStorage;
    openAlexClient.persistentStore = previousStore;
  }
});


/**
 * OpenAlex stalled, Crossref fast: the two halves of an institution page's worst
 * case. The stall has to outlast every budget in play — an OpenAlex that answers
 * 503 on its own before the deadline never exercises the deadline at all, and
 * the test would measure nothing.
 *
 * The OpenAlex half honours the abort signal, because the client's deadline IS
 * an `AbortController`: a stub that ignored it would take its own sweet time
 * whatever the timeout said.
 */
function slowOpenAlexThenCrossref(openAlexDelayMs: number|undefined, crossrefDelayMs: number|undefined) {
  const openAlex: typeof fetch = (url, options = {}) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(new Response('{}', { status: 503 })),
      openAlexDelayMs,
    );
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });

  const crossref = () => new Promise<Response>((resolve) => {
    setTimeout(() => resolve(new Response(JSON.stringify({
      message: {
        items: [{
          DOI: '10.1000/fallback',
          title: ['A work Crossref knew about'],
          author: [{ given: 'Ada', family: 'Researcher' }],
          issued: { 'date-parts': [[2024, 3, 1]] },
          'container-title': ['Journal of Fallbacks'],
          type: 'journal-article',
          'is-referenced-by-count': 4,
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })), crossrefDelayMs);
  });

  return { openAlex, crossref };
}

/**
 * The institution page cuts its own wait at 7000 ms (`entity-explorer.tsx`), and
 * OpenAlex was allowed all seven of them before the Crossref fallback was even
 * asked. The fallback existed and could never arrive in time: the reader got the
 * empty state on every institution OpenAlex was slow about. 3500 + 3250 leaves
 * 250 ms of margin for the client's own queue.
 */
test('an institution page gets Crossref before the screen budget runs out', async () => {
  const realOpenAlexFetch = openAlexClient.fetchImpl;
  const realFetch = globalThis.fetch;
  const { openAlex, crossref } = slowOpenAlexThenCrossref(30_000, 25);
  openAlexClient.fetchImpl = openAlex;
  globalThis.fetch = crossref;

  const started = Date.now();
  try {
    const works = await getWorksByEntity(
      'institution',
      'I123',
      'cited_by_count:desc',
      1,
      '',
      {},
      'Some University',
    );
    const elapsed = Date.now() - started;

    assert.ok(works.papers.length > 0, 'the fallback answered');
    assert.ok(elapsed < 7000, `the screen budget is 7000 ms and the answer took ${elapsed} ms`);
  } finally {
    openAlexClient.fetchImpl = realOpenAlexFetch;
    globalThis.fetch = realFetch;
  }
});


test('author suggestions retrieve exact names before highly cited fuzzy matches can displace them', async t => {
  const requests: string[] = [];
  // Synthetic pages: broad matching fills all 25 slots before Mario's work.
  const broadWorks = Array.from({ length: 25 }, (_, index) => ({
    id: `https://openalex.org/W${index}`,
    authorships: [{ author: { id: `https://openalex.org/A${index}`, display_name: 'Mario Amados' } }],
  }));
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL) => {
    requests.push(String(url));
    const filter = new URL(url).searchParams.get('filter')!;
    return Response.json({ results: filter.includes(' OR ') ? broadWorks : [{
      id: 'https://openalex.org/W100',
      authorships: [{ author: { id: 'https://openalex.org/A5034580028', display_name: 'Mario Amado' } }],
    }] });
  });

  const results = await searchAuthors('Mario Amado', { typeahead: true, throwOnError: true });

  assert.deepEqual(results.map(author => author.id), ['https://openalex.org/A5034580028']);
  assert.equal(requests.length, 1, 'an exact match needs no approximate search');
  assert.equal(new URL(requests[0]).searchParams.get('filter'), 'raw_author_name.search:"mario amado"');
});

test('author suggestions keep a typed pipe from splitting the exact byline search', async t => {
  const filters: string[] = [];
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL) => {
    filters.push(new URL(url).searchParams.get('filter')!);
    return Response.json({ results: [] });
  });

  await searchAuthors('José | Amado', { typeahead: true, throwOnError: true });

  assert.equal(filters[0], 'raw_author_name.search:"josé amado"');
});

test('author suggestions recover a typo plus surname prefix after an empty exact search without inventing metrics', async t => {
  const requests: string[] = [];
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL, options: { retries?: number }) => {
    requests.push(String(url));
    assert.equal(options.retries, 0);
    if (!new URL(url).searchParams.get('filter')!.includes(' OR ')) return Response.json({ results: [] });
    return Response.json({ results: [{ id: 'https://openalex.org/W123', authorships: [
      { author: { id: 'https://openalex.org/A1', display_name: 'Geoffrey E. Hinton' }, institutions: [{ display_name: 'University of Toronto' }] },
      { author: { id: 'https://openalex.org/A2', display_name: 'Unrelated Coauthor' } },
    ] }] });
  });
  const results = await searchAuthors('Geofrey Hin', { typeahead: true, throwOnError: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(url => new URL(url).searchParams.get('sort')), ['cited_by_count:desc', 'cited_by_count:desc']);
  assert.match(new URL(requests[1]).searchParams.get('filter')!, /raw_author_name.search:.*geofrey~1 AND hin\*/);
  assert.deepEqual(results.map(author => author.id), ['https://openalex.org/A1']);
  assert.equal(results[0].display_name, 'Geoffrey E. Hinton');
  assert.equal(results[0].works_count, null);
  assert.equal(results[0].cited_by_count, null);
  assert.equal(results[0].institution, 'University of Toronto');
});

test('author suggestions recover an unfinished surname when exact bylines have no relevant canonical names', async t => {
  let requests = 0;
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL) => {
    requests += 1;
    const approximate = new URL(url).searchParams.get('filter')!.includes(' OR ');
    return Response.json({ results: [{ authorships: [{ author: approximate
      ? { id: 'https://openalex.org/A1', display_name: 'Geoffrey E. Hinton' }
      : { id: 'https://openalex.org/A2', display_name: 'Unrelated Coauthor' },
    }] }] });
  });

  const results = await searchAuthors('Geoffrey Hin', { typeahead: true, throwOnError: true });

  assert.deepEqual(results.map(author => author.id), ['https://openalex.org/A1']);
  assert.equal(requests, 2);
});

test('author suggestions finish an empty search after at most two requests and do not repeat literal-only queries', async t => {
  const requests: string[] = [];
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL) => {
    requests.push(String(url));
    return Response.json({ results: [] });
  });

  assert.deepEqual(await searchAuthors('Missing Researcher', { typeahead: true, throwOnError: true }), []);
  assert.equal(requests.length, 2);
  requests.length = 0;
  assert.deepEqual(await searchAuthors('Li', { typeahead: true, throwOnError: true }), []);
  assert.equal(requests.length, 1);
});

test('author suggestions propagate either request failure instead of treating it as an empty search', async t => {
  for (const failingRequest of [1, 2]) {
    let requests = 0;
    const failure = new Error('Provider unavailable');
    const fetch = t.mock.method(openAlexClient, 'fetch', async (_url: string | URL, options: { retries?: number }) => {
      requests += 1;
      assert.equal(options.retries, 0);
      if (requests === failingRequest) throw failure;
      return Response.json({ results: [] });
    });

    await assert.rejects(searchAuthors(`Unavailable Researcher ${failingRequest}`, { typeahead: true, throwOnError: true }),
      error => error === failure);
    assert.equal(requests, failingRequest);
    fetch.mock.restore();
  }
});

test('author suggestions do not start a fallback after the reader cancels the exact request', async t => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(openAlexClient, 'fetch', async () => {
    requests += 1;
    controller.abort();
    return Response.json({ results: [] });
  });

  await assert.rejects(searchAuthors('Cancelled Researcher', {
    typeahead: true, throwOnError: true, signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('author suggestions cancel the approximate fetch within the original search budget', async t => {
  const signals: AbortSignal[] = [];
  const originalFetch = openAlexClient.fetchImpl;
  t.after(() => { openAlexClient.fetchImpl = originalFetch; });
  openAlexClient.fetchImpl = async (_url, options = {}) => {
    const signal = options.signal;
    assert.ok(signal);
    signals.push(signal);
    if (signals.length === 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return Response.json({ results: [] });
    }
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return Response.json({ results: [] });
  };

  const outcome = await settleWithin(6000, () => assert.rejects(searchAuthors('Deadline Researcher', {
    typeahead: true, throwOnError: true,
  }), { name: 'OpenAlexRequestError', code: 'aborted' }));
  assert.equal(outcome, 'resolved');
  assert.equal(signals.length, 2);
  assert.equal(signals[1].aborted, true);
});

test('local and remote topic suggestions tolerate typos with one provider request', async t => {
  let calls = 0;
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL, options: { retries?: number }) => {
    calls += 1;
    assert.equal(options.retries, 0);
    assert.equal(new URL(url).pathname, '/autocomplete/topics');
    assert.equal(new URL(url).searchParams.get('q'), 'Machine Learning');
    return Response.json({ results: [{ id: 'https://openalex.org/T123', display_name: 'Machine Learning and Algorithms', works_count: 120 }] });
  });
  const results = await searchConcepts('Machien lear', { throwOnError: true });
  assert.equal(calls, 1);
  assert.ok(results.some(topic => topic.display_name === 'Machine Learning'));
  assert.ok(results.some(topic => topic.id === 'T123'));
});

// PAP-86: the search page's author search is a search, which the relay
// reserves ten list calls for on every miss. It carried the client's default
// of two more attempts after a 5xx, each of them a fresh reservation for the
// same outage; the typeahead branch also stops on the first failure.
test('the author search asks once when OpenAlex answers a 5xx', async () => {
  const realFetch = openAlexClient.fetchImpl;
  let requests = 0;
  openAlexClient.fetchImpl = async () => {
    requests += 1;
    return Response.json({ error: 'upstream' }, { status: 502 });
  };
  try {
    await assert.rejects(searchAuthors('Ada Lovelace', { throwOnError: true }));
    assert.equal(requests, 1);
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});

// PAP-88: a paper opened by DOI was a works list (`filter=doi:`), which
// OpenAlex bills and the Worker files under enrichment, refused from 80 % of
// the day. `works/doi:` is one entity: free, and never refused by the ledger.
test('opening a paper by DOI asks for the work by DOI, which is free, and a 404 is not found', async () => {
  const requested: string[] = [];
  const openAlexJson = async (url: unknown) => { requested.push(String(url)); return WORK_FIXTURE; };

  const paper = await fetchPaperByWorkId('doi', '10.7717/peerj.4375', { openAlexJson });
  assert.deepEqual(requested, ['https://api.openalex.org/works/doi:10.7717/peerj.4375']);
  // The same paper the DOI list made of this work.
  const { slimWorksPage } = await import('./open-alex-service.ts');
  assert.deepEqual(paper, slimWorksPage({ results: [WORK_FIXTURE] }).papers[0]);

  // A SICI DOI: parentheses, angle brackets, a colon and a semicolon. The relay
  // takes an id of letters, digits and `._:%|,-/` only.
  const sici = '10.1002/(sici)1097-4636(199905)45:2<84::aid-jbm2>3.0.co;2-#';
  requested.length = 0;
  await fetchPaperByWorkId('doi', sici, { openAlexJson });
  const path = new URL(requested[0]).pathname;
  assert.ok(path.startsWith('/works/doi:'), path);
  const id = path.slice('/works/doi:'.length);
  assert.match(id, /^[A-Za-z0-9._%/-]+$/);
  assert.equal(decodeURIComponent(id), sici);

  const notFound = Object.assign(new Error('OpenAlex API error: 404'), { status: 404 });
  assert.equal(await fetchPaperByWorkId('doi', '10.1000/missing', { openAlexJson: async () => { throw notFound; } }), null);
  const down = Object.assign(new Error('OpenAlex API error: 503'), { status: 503 });
  await assert.rejects(fetchPaperByWorkId('doi', '10.1000/x', { openAlexJson: async () => { throw down; } }), down);
});

// The client hands the URL to `new URL()`, which resolves a `.` or `..`
// segment before the relay sees the path: `10.1234/../w2741809807` opened
// another work, and `10.1234/../../authors` a billed list of authors. The
// relay also refuses an id containing `..` or longer than 240 characters. Such
// a DOI is asked for as the one-work list instead, where it is a query value.
test('a DOI that cannot travel as a path is asked for as a one-work DOI list', async () => {
  const requested: URL[] = [];
  const openAlexJson = async (url: unknown) => {
    requested.push(new URL(String(url)));
    return { results: [WORK_FIXTURE] };
  };
  const { slimWorksPage } = await import('./open-alex-service.ts');
  const unpathable = [
    '10.1234/../w2741809807',
    '10.1234/../../authors',
    '10.1234/./x',
    '10.1234/a..b',
    `10.1234/${'x'.repeat(240)}`,
  ];
  for (const doi of unpathable) {
    requested.length = 0;
    const paper = await fetchPaperByWorkId('doi', doi, { openAlexJson });
    assert.equal(requested.length, 1, doi);
    assert.equal(requested[0].pathname, '/works', doi);
    assert.equal(requested[0].searchParams.get('filter'), `doi:${doi}`, doi);
    assert.equal(requested[0].searchParams.get('per-page'), '1', doi);
    assert.deepEqual(paper, slimWorksPage({ results: [WORK_FIXTURE] }).papers[0], doi);
  }

  assert.equal(await fetchPaperByWorkId('doi', '10.1234/a..b', { openAlexJson: async () => ({ results: [] }) }), null);
});
