import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScientificReportEditions,
  calculateScientificImpactSignals,
} from './scientificReportRanking.js';

function paper(id, category, citations, extra = {}) {
  return {
    id,
    title: `Paper ${id}`,
    abstract: 'A'.repeat(300),
    authors: [{ name: `Author ${id}` }],
    primaryCategory: category,
    categories: [category],
    allCategories: [category],
    citationCount: citations,
    published: '2026-07-10',
    doi: `10.1/${id}`,
    ...extra,
  };
}

test('uses normalized OpenAlex impact without producing invalid values', () => {
  const signals = calculateScientificImpactSignals(
    paper('one', 'physics', 10, {
      fwci: 2,
      citationNormalizedPercentile: { value: 0.9 },
      institutionCount: 3,
    }),
    '30d',
    new Map(),
    new Date('2026-07-16T12:00:00Z'),
  );

  assert.ok(signals.fieldImpact > 0.5);
  assert.ok(Number.isFinite(signals.score));
  assert.equal(signals.confidence, 'high');
});

test('builds a personal edition from the same corpus while preserving exploration', () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, index) => paper(`physics-${index}`, 'physics', 100 - index)),
    ...Array.from({ length: 6 }, (_, index) => paper(`cs-${index}`, 'cs', 20 - index)),
  ];
  const editions = buildScientificReportEditions(candidates, {
    timeframe: '30d',
    days: 30,
    currentDate: new Date('2026-07-16T12:00:00Z'),
    profile: {
      userPreferences: ['cs'],
      categoryAffinities: { cs: 20 },
      conceptAffinities: {},
      followedAuthors: [],
    },
  });

  const panoramaPapers = [editions.panorama.mainDiscovery, ...editions.panorama.highlights];
  const personalPapers = [editions.personal.mainDiscovery, ...editions.personal.highlights];
  assert.ok(
    personalPapers.filter(item => item.primaryCategory === 'cs').length
      > panoramaPapers.filter(item => item.primaryCategory === 'cs').length,
  );
  assert.ok(personalPapers.filter(item => item.primaryCategory === 'physics').length >= 2);
  assert.equal(editions.panorama.mainDiscovery.primaryCategory, 'physics');
});

test('excludes papers explicitly rejected by the user from the personal corpus', () => {
  const editions = buildScientificReportEditions([
    paper('blocked', 'cs', 100),
    paper('allowed', 'physics', 10),
  ], {
    timeframe: '30d',
    days: 30,
    profile: { userPreferences: ['cs'], notInterestedIds: ['blocked'] },
  });

  assert.equal(editions.personal.mainDiscovery.id, 'allowed');
});
