import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';

import {
  EXPLORER_ROW_CHUNK,
  GUEST_PREVIEW_LIMIT,
  explorerListState,
  explorerPageAllowance,
  guestGateTotal,
  guestPreviewRows,
  shouldShowGuestGate,
  nextExplorerRowBudget,
  entityPapersRequestKey,
  filterAndSortEntityPapers,
  countPapersByArea,
  getPaperCitationCount,
  hasKnownPaperCitationCount,
  pinSourcePaper,
  authorIdentityVerified,
  sourceArxivIdFrom,
  explorerListErrorCode,
} from './entity-explorer.ts';
import { getUiErrorMessage } from './error-messages.ts';
import { openAlexClient } from '../services/open-alex-client.ts';
import { getAuthorsByEntity, getWorksByEntity } from '../services/open-alex-service.ts';

// A name is shared ("Wei Zhang" is 11,284 OpenAlex entities): a page reached
// by a name alone is only this person when an id or the paper confirms it
// (audit 2026-09-23, issue 4).
test('an author page is verified by an OpenAlex id, an ORCID, or the paper, never by the name alone', () => {
  assert.equal(authorIdentityVerified({ type: 'author', routeId: 'A5075361382', entity: {} }), true);
  assert.equal(authorIdentityVerified({ type: 'author', routeId: 'https://openalex.org/A5075361382', entity: {} }), true);
  assert.equal(authorIdentityVerified({ type: 'author', routeId: '0000-0002-1825-0097', entity: {} }), true);
  assert.equal(authorIdentityVerified({ type: 'author', routeId: 'Li WN', entity: { id: 'https://openalex.org/A5075361382', verified: true } }), true);
  assert.equal(authorIdentityVerified({ type: 'author', routeId: 'Li WN', entity: { id: 'https://openalex.org/A5024723812' } }), false);
  assert.equal(authorIdentityVerified({ type: 'author', routeId: 'Li WN', entity: { id: 'stub-Li-WN' } }), false);
  assert.equal(authorIdentityVerified({ type: 'institution', routeId: 'I1', entity: {} }), true);
});

// An ORCID route whose person OpenAlex does not know renders a stub, and the
// stub's list is an arXiv search by name: the ORCID says who the person is,
// not whose papers those are (review of 2026-09-25).
test('an ORCID page that fell back to a stub is not verified', () => {
  assert.equal(authorIdentityVerified({ type: 'author', routeId: '0000-0002-1825-0097', entity: { id: 'stub-0000-0002-1825-0097' } }), false);
  assert.equal(authorIdentityVerified({ type: 'author', routeId: '0000-0002-1825-0097', entity: { id: 'https://openalex.org/A5075361382' } }), true);
  assert.equal(authorIdentityVerified({ type: 'author', routeId: '0000-0002-1825-0097', entity: null }), true);
});

// Old links carried a PubMed paper's `pmid:` id as "arxivId", and the
// "source paper first" fallback sent it to arXiv as `id_list=pmid:…`.
test('only a real arXiv id is pinned as the source paper', () => {
  assert.equal(sourceArxivIdFrom('2401.12345v2'), '2401.12345');
  assert.equal(sourceArxivIdFrom('hep-th/9901001'), 'hep-th/9901001');
  assert.equal(sourceArxivIdFrom('pmid:42774036'), '');
  assert.equal(sourceArxivIdFrom(null), '');
});

const papers = [
  {
    id: 'older-physics',
    title: 'Quantum accelerator design',
    authors: [{ name: 'Ada Researcher' }],
    categories: ['quant-ph'],
    published: '2020-01-01',
    citationCount: 50,
    peerReviewed: true,
  },
  {
    id: 'recent-cs',
    title: 'Distributed systems',
    authors: [{ name: 'Grace Researcher' }],
    categories: ['cs.DC'],
    published: '2026-01-01',
    citationCount: 5,
    peerReviewed: false,
  },
];

test('filters project papers by text and top-level category', () => {
  assert.deepEqual(
    filterAndSortEntityPapers(papers, { searchQuery: 'Ada', filters: { category: 'physics' } }).map(p => p.id),
    ['older-physics']
  );
});

// An OpenAlex work carries no arXiv category, only its topic's subfield and
// field. Matching categories alone dropped every such row, so an author's or a
// topic's list emptied as soon as a category was chosen, even for rows already
// labelled with it.
test('the category filter keeps a row by the area it is labelled with', () => {
  const openAlexWork = (id: string, subfield: number, field: number) => ({
    id,
    title: id,
    authors: [],
    categories: ['Data imputation'],
    primaryTopic: { subfield: { id: `https://openalex.org/subfields/${subfield}` }, field: { id: `https://openalex.org/fields/${field}` } } as Paper['primaryTopic'],
  });
  const rows = [
    openAlexWork('decision-sciences', 1803, 18),
    openAlexWork('mechanical', 2210, 22),
    openAlexWork('electrical', 2208, 22),
    ...papers,
  ];

  assert.deepEqual(filterAndSortEntityPapers(rows, { filters: { category: 'stat' } }).map(p => p.id), ['decision-sciences']);
  assert.deepEqual(filterAndSortEntityPapers(rows, { filters: { category: 'mech' } }).map(p => p.id), ['mechanical']);
  assert.deepEqual(filterAndSortEntityPapers(rows, { filters: { category: 'eess' } }).map(p => p.id), ['electrical']);
  assert.deepEqual(filterAndSortEntityPapers(rows, { filters: { category: 'cs' } }).map(p => p.id), ['recent-cs']);
});

test('a cross-listed arXiv paper matches the area of any of its categories', () => {
  const crossListed = { id: 'cross', title: 'x', authors: [], primaryCategory: 'cs.LG', categories: ['cs.LG', 'stat.ML'] };
  assert.deepEqual(filterAndSortEntityPapers([crossListed], { filters: { category: 'stat' } }).map(p => p.id), ['cross']);
  assert.deepEqual(filterAndSortEntityPapers([crossListed], { filters: { category: 'math' } }).map(p => p.id), []);
});

test('applies peer-review and date filters to project papers', () => {
  // The filter asked for a differently spelled flag that no adapter writes and
  // `PaperBuilder` does not build: with it, every paper failed the test and the
  // toggle emptied the list. The fixtures above now carry the field papers
  // really have, and a reviewed paper inside the window must survive both.
  const recent = {
    id: 'recent-reviewed',
    title: 'Fresh',
    authors: [],
    categories: ['cs.DC'],
    published: `${new Date().getFullYear()}-01-01`,
    citationCount: 1,
    peerReviewed: true,
  };

  assert.deepEqual(
    filterAndSortEntityPapers([...papers, recent], { filters: { peerReviewed: true, dateRange: 'last_year' } }).map(p => p.id),
    ['recent-reviewed'],
  );
});

test('sorts accumulated project papers by citations or publication date', () => {
  assert.deepEqual(
    filterAndSortEntityPapers(papers, { sortBy: 'cited_by_count:desc' }).map(p => p.id),
    ['older-physics', 'recent-cs']
  );
  assert.deepEqual(
    filterAndSortEntityPapers(papers, { sortBy: 'publication_date:desc' }).map(p => p.id),
    ['recent-cs', 'older-physics']
  );
});

test('sorts and displays citations from every supported metadata shape', () => {
  const mixedPapers = [
    { id: 'nested', openAlex: { citationCount: 120, citationCountKnown: true } },
    { id: 'legacy', citationsCount: 40 },
    { id: 'unknown', citationCount: 0, citationCountKnown: false },
  ];

  assert.deepEqual(
    filterAndSortEntityPapers(mixedPapers, { sortBy: 'cited_by_count:desc' }).map(paper => paper.id),
    ['nested', 'legacy', 'unknown'],
  );
  assert.equal(getPaperCitationCount(mixedPapers[0]), 120);
  assert.equal(hasKnownPaperCitationCount(mixedPapers[0]), true);
  assert.equal(hasKnownPaperCitationCount(mixedPapers[2]), false);
});

test('keeps the source paper first after project sorting and pagination', () => {
  const ordered = pinSourcePaper(papers, 'arxiv:recent-cs');
  assert.deepEqual(ordered.map(p => p.id), ['recent-cs', 'older-physics']);
});

/**
 * The papers request is keyed by what the request depends on, so the effect
 * that issues it can tell a re-render from a new request.
 */
const authorRequest = {
  type: 'author',
  id: 'A123',
  entity: { id: 'A123', display_name: 'Ada Researcher' },
  entityDisplayName: 'Ada Researcher',
  sortBy: 'cited_by_count:desc',
  page: 1,
  searchQuery: '',
  filters: { category: '', peerReviewed: false, dateRange: '' },
  searchParams: '',
  reloadKey: 0,
  entityReloadKey: 0,
};

test('a project keeps the same papers key when its details land on the optimistic entity', () => {
  const optimistic = entityPapersRequestKey({
    ...authorRequest,
    type: 'project',
    id: '101017733',
    entity: { display_name: 'CLIMATE-X', type: 'project', funder: 'EC' } as NonNullable<NonNullable<Parameters<typeof entityPapersRequestKey>[0]>["entity"]> & Record<string, unknown>,
    entityDisplayName: 'CLIMATE-X',
  });
  const detailed = entityPapersRequestKey({
    ...authorRequest,
    type: 'project',
    id: '101017733',
    entity: { id: '101017733', display_name: 'CLIMATE-X: Climate extremes', type: 'project', summary: '…' } as NonNullable<NonNullable<Parameters<typeof entityPapersRequestKey>[0]>["entity"]> & Record<string, unknown>,
    entityDisplayName: 'CLIMATE-X: Climate extremes',
  });
  assert.equal(optimistic, detailed);
});

/**
 * A search-palette handover hands over a ROR-shaped institution row (`id:
 * https://ror.org/<x>`, explorer-handover.ts). Once `getEntityById` answers,
 * `mergeInstitutionWithRor` replaces it with an OpenAlex-shaped id
 * (`services/ror-service.ts`). Keying on `entity.id` for that type changes
 * the key mid-flight and starts a second, differently-filtered
 * `getWorksByEntity` request — cancelling the first one that was already
 * in flight, on every institution opened from the palette (the only way to
 * reach one: the feed has no institution links).
 */
test('an institution keeps the same papers key when its ROR id resolves to an OpenAlex one', () => {
  const rorHandover = {
    ...authorRequest,
    type: 'institution',
    id: '03vek6s52',
    entity: { id: 'https://ror.org/03vek6s52', display_name: 'Harvard University' },
    entityDisplayName: 'Harvard University',
  };
  const beforeFetch = entityPapersRequestKey(rorHandover);
  const afterFetch = entityPapersRequestKey({
    ...rorHandover,
    entity: { id: 'https://openalex.org/I136199984', display_name: 'Harvard University' },
  });
  assert.equal(beforeFetch, afterFetch, 'resolving to the OpenAlex id must not start a second request');

  const anotherInstitution = entityPapersRequestKey({ ...rorHandover, id: '05gvnxz63' });
  assert.notEqual(beforeFetch, anotherInstitution, 'navigating to a different institution must still change the key');
});

test('every input the papers request reads changes its key', () => {
  const base = entityPapersRequestKey(authorRequest);
  const variants = [
    { page: 2 },
    { sortBy: 'publication_date:desc' },
    { searchQuery: 'quantum' },
    { filters: { ...authorRequest.filters, peerReviewed: true } },
    { searchParams: 'arxivId=2401.00001' },
    { reloadKey: 1 },
    { entityReloadKey: 1 },
    { entity: { id: 'stub-0000-0001', display_name: 'Ada Researcher' } },
    { entity: { id: 'A123', display_name: 'Ada B. Researcher' } },
  ];
  for (const variant of variants) {
    assert.notEqual(entityPapersRequestKey({ ...authorRequest, ...variant }), base, JSON.stringify(variant));
  }
  assert.equal(entityPapersRequestKey({ ...authorRequest, entity: { ...authorRequest.entity } }), base);
});

test('the list mounts eight rows at a time and never more than it has', () => {
  assert.equal(EXPLORER_ROW_CHUNK, 8);
  assert.equal(nextExplorerRowBudget(8, 30), 16);
  assert.equal(nextExplorerRowBudget(24, 30), 30);
  assert.equal(nextExplorerRowBudget(30, 30), 30);
  assert.equal(nextExplorerRowBudget(8, 5), 5);
  assert.equal(nextExplorerRowBudget(-1, 0), 0);
});

test('a page the filters emptied keeps the list looking while more pages remain, then waits for the reader', () => {
  const emptiedPage = { rows: 0, hasMore: true, publicMode: false };

  // More pages left: the list asks for the next one and is not the empty state.
  assert.equal(explorerListState(emptiedPage), 'looking');
  assert.equal(explorerPageAllowance(1, { byReader: false }), 0, 'the list asks, with nothing left after');

  // No allowance left: it waits for "Keep looking".
  assert.equal(explorerPageAllowance(0, { byReader: false }), null);
  const restored = explorerPageAllowance(0, { byReader: true });
  assert.ok(restored !== null && restored > 0, 'the reader\'s request goes ahead and restores the allowance');

  // No more pages: the empty state.
  assert.equal(explorerListState({ ...emptiedPage, hasMore: false }), 'empty');
  // A visitor gets no next page: their empty first page is the empty state.
  assert.equal(explorerListState({ ...emptiedPage, publicMode: true }), 'empty');
  // A page with rows leaves the asking to the foot of the list.
  assert.equal(explorerListState({ ...emptiedPage, rows: 3 }), 'rows');
  assert.equal(explorerListState({ rows: 3, hasMore: false, publicMode: true }), 'rows');
});


/**
 * La vista previa del invitado (2026-09-12).
 *
 * Sin cuenta, el explorador enseña dos filas y pone una puerta debajo. La
 * decisión vive aquí, fuera del componente, porque lo que importa son los
 * bordes: una entidad con una sola publicación no tiene muro que poner, y una
 * lista todavía cargando no puede afirmar que falte nada.
 */

test('sin sesión la lista se queda en dos filas; con sesión se entrega entera', () => {
  const rows = ['a', 'b', 'c', 'd'];
  assert.equal(GUEST_PREVIEW_LIMIT, 2);
  assert.deepEqual(guestPreviewRows(rows, { publicMode: true }), ['a', 'b']);
  assert.equal(guestPreviewRows(rows, { publicMode: false }), rows, 'con sesión debe devolverse la MISMA lista, sin copiarla');
  assert.deepEqual(guestPreviewRows(['a'], { publicMode: true }), ['a']);
  assert.deepEqual(guestPreviewRows([], { publicMode: true }), []);
});

test('la puerta se pone cuando queda algo detrás', () => {
  const base = { publicMode: true, loaded: 30, hasMore: true, isLoading: false };
  assert.equal(shouldShowGuestGate(base), true);
  assert.equal(shouldShowGuestGate({ ...base, hasMore: false }), true, 'treinta cargadas y ninguna más en el servidor siguen siendo veintiocho detrás del muro');
  assert.equal(shouldShowGuestGate({ ...base, loaded: 3, hasMore: false }), true);
  assert.equal(shouldShowGuestGate({ ...base, loaded: 2, hasMore: true }), true, 'lo cargado cabe en la vista previa, pero el servidor tiene más');
});

test('no hay puerta cuando no hay nada detrás', () => {
  const base = { publicMode: true, loaded: 2, hasMore: false, isLoading: false };
  assert.equal(shouldShowGuestGate(base), false, 'dos publicaciones son el final de la lista, no un muro');
  assert.equal(shouldShowGuestGate({ ...base, loaded: 1 }), false);
  assert.equal(shouldShowGuestGate({ ...base, loaded: 0 }), false, 'una entidad vacía tiene su propio cartel');
});

test('con sesión nunca hay puerta, y mientras carga tampoco', () => {
  assert.equal(shouldShowGuestGate({ publicMode: false, loaded: 30, hasMore: true, isLoading: false }), false);
  assert.equal(shouldShowGuestGate({ publicMode: true, loaded: 0, hasMore: false, isLoading: true }), false);
  assert.equal(shouldShowGuestGate({ publicMode: true, loaded: 30, hasMore: true, isLoading: true }), false, 'una lista a medio cargar no puede decir cuánto falta');
});

test('el número que promete la puerta sale de la entidad, y solo si es creíble', () => {
  assert.equal(guestGateTotal({ works_count: 1234 }, 2), 1234);
  assert.equal(guestGateTotal({ works_count: 2 }, 2), null, 'un total que no supera lo mostrado no explica el muro');
  assert.equal(guestGateTotal({ works_count: 0 }, 2), null);
  assert.equal(guestGateTotal({}, 2), null);
  assert.equal(guestGateTotal(null, 2), null);
  assert.equal(guestGateTotal({ works_count: '1234' as never }, 2), null, 'un total que no es un número no se enseña');
});

test('area counts agree with what each area filter keeps, cross-listed papers in both', () => {
  const papers = [
    { id: 'a', primaryCategory: 'astro-ph.CO', categories: ['astro-ph.CO'] },
    { id: 'b', primaryCategory: 'cs.LG', categories: ['cs.LG', 'astro-ph.CO'] },
    { id: 'c', primaryCategory: 'math.DG', categories: ['math.DG'] },
  ] as Partial<Paper>[];
  const counts: Record<string, number> = countPapersByArea(papers, ['physics', 'cs', 'math', 'bio']);
  for (const key of ['physics', 'cs', 'math', 'bio']) {
    assert.equal(counts[key], filterAndSortEntityPapers(papers, { filters: { category: key } }).length);
  }
  assert.deepEqual(counts, { physics: 2, cs: 1, math: 1, bio: 0 });
});

// PAP-88: from 60 % of the day's OpenAlex budget the Worker refuses the lists
// an Explorer page asks for by author, institution or topic, and its authors
// tab, and names the tier on the 429. OpenAlex and the network still answer
// other requests, so the list says it is paused and when it is back at the
// latest instead of blaming the reader's connection. An institution's Crossref
// rows still fill its list during the pause.
test("an Explorer list the Worker paused for the day's budget says so instead of blaming the connection", async () => {
  const realOpenAlexFetch = openAlexClient.fetchImpl;
  const realFetch = globalThis.fetch;
  const failure = (request: Promise<unknown>) => request.then(
    () => assert.fail('the list was expected to fail'),
    (error: unknown) => error,
  );
  const shown = (error: unknown, failedCode: string) => getUiErrorMessage(explorerListErrorCode(error, failedCode), failedCode);
  let crossref: () => Response = () => new Response('{}', { status: 503 });
  openAlexClient.fetchImpl = async () => new Response('{"code":"PROVIDER_RATE_LIMITED"}', {
    status: 429,
    headers: { 'Retry-After': '300', 'X-PaperTok-Budget-Tier': 'exploration' },
  });
  globalThis.fetch = async () => crossref();
  try {
    const paused = [
      shown(await failure(getWorksByEntity('author', 'A7000000881', 'cited_by_count:desc', 1, '', {}, 'Ada Lovelace')), 'PUBLICATIONS_LOAD_FAILED'),
      shown(await failure(getWorksByEntity('topic', 'T7000000882', 'cited_by_count:desc', 1, '', {}, 'Cosmology')), 'PUBLICATIONS_LOAD_FAILED'),
      shown(await failure(getWorksByEntity('institution', 'I7000000883', 'cited_by_count:desc', 1, '', {}, 'Some University')), 'PUBLICATIONS_LOAD_FAILED'),
      shown(await failure(getAuthorsByEntity('concept', 'C7000000884', 1, '', 'Cosmology')), 'AUTHORS_LOAD_FAILED'),
    ];
    for (const message of paused) {
      assert.doesNotMatch(message, /connection/i);
      assert.match(message, /paused/);
      assert.match(message, /00:00 UTC/);
    }

    crossref = () => Response.json({ message: { items: [{
      DOI: '10.1000/fallback',
      title: ['A work Crossref knew about'],
      author: [{ given: 'Ada', family: 'Researcher' }],
      issued: { 'date-parts': [[2024, 3, 1]] },
      'container-title': ['Journal of Fallbacks'],
      type: 'journal-article',
    }] } });
    const institution = await getWorksByEntity('institution', 'I7000000885', 'cited_by_count:desc', 1, '', {}, 'Some University');
    assert.deepEqual(institution.papers.map(paper => paper.title), ['A work Crossref knew about']);

    openAlexClient.fetchImpl = async () => { throw new TypeError('fetch failed'); };
    const offline = await failure(getWorksByEntity('author', 'A7000000886', 'cited_by_count:desc', 1, '', {}, 'Ada Lovelace'));
    assert.equal(shown(offline, 'PUBLICATIONS_LOAD_FAILED'), 'Publications could not be loaded. Check your connection and try again.');
    assert.equal(shown(offline, 'AUTHORS_LOAD_FAILED'), 'Authors could not be loaded. Check your connection and try again.');
  } finally {
    openAlexClient.fetchImpl = realOpenAlexFetch;
    globalThis.fetch = realFetch;
  }
});
