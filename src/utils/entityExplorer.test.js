import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
    isPeerReviewed: true,
  },
  {
    id: 'recent-cs',
    title: 'Distributed systems',
    authors: [{ name: 'Grace Researcher' }],
    categories: ['cs.DC'],
    published: '2026-01-01',
    citationCount: 5,
    isPeerReviewed: false,
  },
];

test('filters project papers by text and top-level category', () => {
  assert.deepEqual(
    filterAndSortEntityPapers(papers, { searchQuery: 'Ada', filters: { category: 'physics' } }).map(p => p.id),
    ['older-physics']
  );
});

test('applies peer-review and date filters to project papers', () => {
  assert.deepEqual(
    filterAndSortEntityPapers(papers, { filters: { peerReviewed: true, dateRange: 'last_year' } }),
    []
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
