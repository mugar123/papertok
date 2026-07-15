import test from 'node:test';
import assert from 'node:assert/strict';

import { filterAndSortEntityPapers, pinSourcePaper } from './entityExplorer.js';

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

test('keeps the source paper first after project sorting and pagination', () => {
  const ordered = pinSourcePaper(papers, 'arxiv:recent-cs');
  assert.deepEqual(ordered.map(p => p.id), ['recent-cs', 'older-physics']);
});
