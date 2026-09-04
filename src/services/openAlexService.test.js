import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCrossrefInstitutionWork } from './crossrefInstitutionService.js';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadlineHarness.js';
import {
  buildOpenAlexIdFilter,
  buildRorIdFilter,
  fetchWithTimeout,
  buildRecentImpactUrl,
  dedupeAuthors,
  enrichAuthorInstitutionLocalization,
  fetchRecentImpactWorks,
  fetchPaperByWorkId,
  getLocalTopicEntity,
  isOpenAlexEnrichmentId,
  mapOpenAlexEnrichmentWork,
  normalizeRecentImpactEntityId,
  searchInstitutions,
  searchLocalTopics,
} from './openAlexService.js';

test('localizes topic entities without changing their canonical category identity', () => {
  const spanish = getLocalTopicEntity('gr-qc', 'es');
  const english = getLocalTopicEntity('gr-qc', 'en');

  assert.equal(spanish.id, 'gr-qc');
  assert.equal(spanish.display_name, 'Relatividad General');
  assert.equal(english.id, 'gr-qc');
  assert.equal(english.display_name, 'General Relativity and Quantum Cosmology');
  assert.deepEqual(english.categoryIds, spanish.categoryIds);
  assert.equal(english._localTopic, true);
});

test('searches local topics bilingually and ignores accents', () => {
  const spanish = searchLocalTopics('cosmologia', 'es');
  const english = searchLocalTopics('cosmology', 'en');

  assert.equal(spanish[0].id, 'astro-ph.CO');
  assert.equal(spanish[0].display_name, 'Cosmología');
  assert.equal(english[0].id, 'astro-ph.CO');
  assert.equal(english[0].display_name, 'Cosmology');
});

test('returns real local topic metadata instead of invented work counts', () => {
  const [physics] = searchLocalTopics('physics', 'en');

  assert.equal(physics.id, 'physics');
  assert.equal(physics.works_count, null);
  assert.ok(physics.subcategoryCount > 0);
  assert.equal(physics._localTopic, true);
});

test('builds recent-impact samples for institutions and authors on the same FWCI contract', () => {
  const period = { from: '2023-01-01', to: '2025-12-31' };
  const institutionUrl = new URL(buildRecentImpactUrl('institution', 'https://openalex.org/I63966007', period));
  const authorUrl = new URL(buildRecentImpactUrl('author', 'A123', period));

  assert.equal(normalizeRecentImpactEntityId('institution', { id: 'https://openalex.org/I63966007' }), 'I63966007');
  assert.equal(normalizeRecentImpactEntityId('author', 'https://openalex.org/A123'), 'A123');
  assert.equal(normalizeRecentImpactEntityId('project', 'P123'), '');
  assert.match(institutionUrl.searchParams.get('filter'), /^institutions\.id:I63966007,/);
  assert.equal(institutionUrl.searchParams.get('sample'), '200');
  assert.match(authorUrl.searchParams.get('filter'), /^author\.id:A123,/);
  assert.equal(authorUrl.searchParams.get('sample'), '100');
});

test('retries a full recent-impact sample only when FWCI coverage is insufficient', async () => {
  const calls = [];
  const fetchJson = async (url) => {
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

  assert.equal(mapped.openAlexId, 'W2626778328');
  assert.equal(mapped.arxivId, '1706.03762');
  assert.equal(mapped.enrichment.citationCount, 6590);
  assert.equal(mapped.enrichment.citationCountKnown, true);
  assert.equal(mapped.enrichment.publicationType, 'preprint');
  assert.equal(mapped.enrichment.publicationStatus, 'preprint');
  assert.equal(mapped.enrichment.openAccess, true);
  assert.equal(mapped.enrichment.pdfUrl, 'https://arxiv.org/pdf/1706.03762');
  assert.equal(mapped.enrichment.doi, undefined);
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

  assert.equal(mapped.arxivId, '2401.12345');
  assert.equal(mapped.enrichment.doi, '10.1000/published-paper');
  assert.equal(mapped.enrichment.publicationStatus, 'published');
});

test('keeps enrichment for a native OpenAlex work without an arXiv copy', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W456',
    doi: 'https://doi.org/10.1000/openalex-only',
    cited_by_count: 24,
    type: 'article',
    locations: [],
  });

  assert.equal(mapped.openAlexId, 'W456');
  assert.equal(mapped.arxivId, '');
  assert.equal(mapped.enrichment.citationCount, 24);
  assert.equal(mapped.enrichment.doi, '10.1000/openalex-only');
});

test('falls back to current OpenAlex topics when legacy concepts are absent', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W789',
    cited_by_count: 3,
    topics: [{ id: 'https://openalex.org/T123', display_name: 'Quantum sensing', score: 0.87 }],
    primary_topic: { id: 'https://openalex.org/T123', display_name: 'Quantum sensing' },
    locations: [],
  });

  assert.equal(mapped.enrichment.concepts[0].display_name, 'Quantum sensing');
  assert.equal(mapped.enrichment.primaryTopic.id, 'https://openalex.org/T123');
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
    const author = await enrichAuthorInstitutionLocalization({
      id: 'https://openalex.org/A123',
      display_name: 'Raúl Muñoz',
      last_known_institutions: [{
        id: 'https://openalex.org/I123',
        display_name: 'Universidad de Salamanca',
        ror: 'https://ror.org/02f40zc51',
      }],
    });

    assert.equal(author.institutionData.localized_names.en, 'University of Salamanca');
    assert.equal(author.last_known_institutions[0].localized_names.es, 'Universidad de Salamanca');
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
const ROR_MIT_ITEMS = [
  ['04mtcj695', 'University of Southern Mindanao', ['MIT', 'USM']],
  ['047m6hg73', 'Management Intelligenter Technologien (Germany)', ['MIT']],
  ['002r67t24', 'Manukau Institute of Technology', ['MIT']],
  ['02mb6z761', 'Myanmar Institute of Theology', ['MIT']],
  ['02qk9nj07', 'Ministry of Infrastructures and Transport', ['MIT']],
  ['02yyma482', 'International Tourism Institute', ['ITI', 'MIT']],
  ['042nb2s44', 'Massachusetts Institute of Technology', ['MIT']],
].map(([rorId, displayName, acronyms]) => ({
  id: `https://ror.org/${rorId}`,
  names: [
    { value: displayName, lang: 'en', types: ['ror_display', 'label'] },
    ...acronyms.map(value => ({ value, types: ['acronym'] })),
  ],
  locations: [{ geonames_details: { country_code: 'US', country_name: 'United States' } }],
  types: ['education'],
}));

// The real OpenAlex figures for those same ROR ids.
const OPENALEX_MIT_STATS = [
  ['042nb2s44', 355652, 65816719],
  ['002r67t24', 1004, 22797],
  ['04mtcj695', 974, 8769],
  ['02mb6z761', 255, 4328],
  ['02qk9nj07', 150, 3472],
  ['047m6hg73', 128, 1225],
  ['02yyma482', 122, 338],
].map(([rorId, works_count, cited_by_count]) => ({
  ror: `https://ror.org/${rorId}`,
  works_count,
  cited_by_count,
  summary_stats: { h_index: works_count },
}));

// ROR goes through the bare global `fetch`; OpenAlex does not. The shared
// client bound `globalThis.fetch` when its module loaded, so it has to be
// injected instead — see `fetchInstitutionProminence`.
function stubRorFetch() {
  return async (input) => {
    const href = String(input?.url || input);
    if (!href.includes('api.ror.org')) throw new Error(`unexpected request: ${href}`);
    return new Response(JSON.stringify({ items: ROR_MIT_ITEMS }), { status: 200 });
  };
}

async function withRorFetch(run) {
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
  const requested = [];
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
  abstract_inverted_index: { Open: [0], access: [1] },
  primary_location: { landing_page_url: 'https://peerj.com/articles/4375', source: { display_name: 'PeerJ', type: 'journal' } },
  open_access: { is_oa: true, oa_url: 'https://peerj.com/articles/4375.pdf' },
  concepts: [],
};

test('opens an OpenAlex work id or a PubMed id through /works/{id}, keyed as the feed keys it', async () => {
  const requested = [];
  const openAlexJson = async (url) => { requested.push(url); return WORK_FIXTURE; };

  const byWork = await fetchPaperByWorkId('openalex', 'w2741809807', { openAlexJson });
  assert.equal(byWork.id, 'openalex:W2741809807');
  assert.equal(byWork.title, 'The state of OA');
  assert.equal(byWork.doi, '10.7717/peerj.4375');
  assert.equal(byWork.abstract, 'Open access');

  const byPmid = await fetchPaperByWorkId('pmid', '31234567', { openAlexJson });
  assert.equal(byPmid.id, 'pmid:31234567');

  assert.deepEqual(requested, [
    'https://api.openalex.org/works/W2741809807',
    'https://api.openalex.org/works/pmid%3A31234567',
  ]);
});

test('refuses to ask OpenAlex for an id that is not a work or a PubMed number', async () => {
  const openAlexJson = async () => { throw new Error('must not be called'); };
  assert.equal(await fetchPaperByWorkId('openalex', 'A2741809807', { openAlexJson }), null);
  assert.equal(await fetchPaperByWorkId('pmid', '12a', { openAlexJson }), null);
  assert.equal(await fetchPaperByWorkId('doi', '10.1/x', { openAlexJson }), null);
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
