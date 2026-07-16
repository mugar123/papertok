import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFeaturedConcepts,
  formatOpenAlexWork,
  getDateThresholds,
  scorePaper,
} from './scientificReportService.js';

test('uses inclusive calendar-day ranges without adding an extra day', () => {
  const now = new Date(2026, 6, 16, 12, 0, 0);

  assert.deepEqual(getDateThresholds('24h', now), {
    fromStr: '2026-07-15',
    toStr: '2026-07-16',
    days: 2,
  });
  assert.deepEqual(getDateThresholds('7d', now), {
    fromStr: '2026-07-10',
    toStr: '2026-07-16',
    days: 7,
  });
  assert.deepEqual(getDateThresholds('30d', now), {
    fromStr: '2026-06-17',
    toStr: '2026-07-16',
    days: 30,
  });
});

test('counts both endpoints of a custom report range', () => {
  assert.equal(getDateThresholds({
    type: 'custom',
    from: '2026-07-10',
    to: '2026-07-16',
  }).days, 7);
});

test('preserves the OpenAlex publication date used by report ranking', () => {
  const paper = formatOpenAlexWork({
    id: 'https://openalex.org/W1',
    title: '<i>Recent discovery</i>',
    publication_date: '2024-05-17',
    cited_by_count: 12,
    authorships: [],
    concepts: [],
    open_access: { is_oa: true },
  });

  assert.equal(paper.title, 'Recent discovery');
  assert.equal(paper.published, '2024-05-17');
  assert.equal(paper.year, 2024);
});

test('age-normalized report ranking rewards a genuinely recent paper', () => {
  const now = new Date('2026-07-16T12:00:00Z');
  const rankingState = () => [new Map(), 3650, new Map(), now];
  const recent = { citationCount: 100, published: '2026-01-16', abstract: 'A'.repeat(200), categories: ['physics'] };
  const old = { ...recent, published: '2017-01-16' };

  assert.ok(
    scorePaper(recent, '10y', ...rankingState()) > scorePaper(old, '10y', ...rankingState()),
  );
});

test('extracts featured topics from string and OpenAlex object concepts', () => {
  const concepts = extractFeaturedConcepts([
    { concepts: [{ display_name: 'Quantum computing', score: 0.9, level: 2 }, { display_name: 'Physics', score: 0.6, level: 0 }] },
    { concepts: ['Quantum computing', 'Machine Learning'] },
    { categories: ['cs.AI'] },
  ]);

  assert.equal(concepts[0], 'Quantum computing');
  assert.ok(concepts.includes('Machine Learning'));
  assert.ok(concepts.includes('Inteligencia Artificial'));
  assert.ok(!concepts.includes('Physics'));
});
