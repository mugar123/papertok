import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPLORER_ROW_CHUNK,
  GUEST_PREVIEW_LIMIT,
  guestGateTotal,
  guestPreviewRows,
  shouldShowGuestGate,
  nextExplorerRowBudget,
  entityPapersRequestKey,
  filterAndSortEntityPapers,
  getPaperCitationCount,
  hasKnownPaperCitationCount,
  pinSourcePaper,
} from './entityExplorer.js';

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
    entity: { display_name: 'CLIMATE-X', type: 'project', funder: 'EC' },
    entityDisplayName: 'CLIMATE-X',
  });
  const detailed = entityPapersRequestKey({
    ...authorRequest,
    type: 'project',
    id: '101017733',
    entity: { id: '101017733', display_name: 'CLIMATE-X: Climate extremes', type: 'project', summary: '…' },
    entityDisplayName: 'CLIMATE-X: Climate extremes',
  });
  assert.equal(optimistic, detailed);
});

/**
 * A search-palette handover hands over a ROR-shaped institution row (`id:
 * https://ror.org/<x>`, explorerHandover.js). Once `getEntityById` answers,
 * `mergeInstitutionWithRor` replaces it with an OpenAlex-shaped id
 * (`services/rorService.js`). Keying on `entity.id` for that type changes
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
  assert.equal(guestGateTotal({ works_count: '1234' }, 2), null, 'un total que no es un número no se enseña');
});
