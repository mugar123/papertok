import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInstitutionWorksFallback,
  calculateInstitutionRecentImpact,
  deduplicateProjectParticipants,
  getRecentImpactPeriod,
} from './entityMetadata.js';

test('replaces misleading zero institution metrics with a verified works count', () => {
  const institution = applyInstitutionWorksFallback({
    display_name: 'MIT',
    works_count: 0,
    cited_by_count: 0,
    summary_stats: { h_index: 0, '2yr_mean_citedness': 0 },
  }, 334442);

  assert.equal(institution.works_count, 334442);
  assert.equal(institution.cited_by_count, null);
  assert.equal(institution.summary_stats.h_index, null);
  assert.equal(institution.metrics_are_partial, true);
});

test('does not overwrite institution metrics when OpenAlex provides them', () => {
  const institution = applyInstitutionWorksFallback({
    works_count: 42,
    cited_by_count: 100,
    summary_stats: { h_index: 8 },
  }, 120);

  assert.equal(institution.works_count, 42);
  assert.equal(institution.cited_by_count, 100);
  assert.equal(institution.summary_stats.h_index, 8);
});

test('builds a three-year recent-impact window with a six-month citation delay', () => {
  assert.deepEqual(getRecentImpactPeriod(new Date('2026-07-15T12:00:00Z')), {
    from: '2023-01-01',
    to: '2025-12-31',
    label: '2023–2025',
  });
});

test('scores field-normalized recent institutional impact on a ten-point scale', () => {
  const works = [
    ...Array.from({ length: 30 }, () => ({ fwci: 1 })),
    ...Array.from({ length: 20 }, () => ({ fwci: 2 })),
  ];
  const impact = calculateInstitutionRecentImpact(works);

  assert.equal(impact.available, true);
  assert.equal(impact.score, 5.8);
  assert.equal(impact.sampleSize, 50);
  assert.equal(impact.medianFwci, 1);
  assert.equal(impact.highImpactShare, 0.4);
  assert.equal(impact.level, 'Por encima de la media');
});

test('does not publish an impact score from an undersized sample', () => {
  assert.deepEqual(calculateInstitutionRecentImpact(
    Array.from({ length: 49 }, () => ({ fwci: 3 })),
  ), {
    available: false,
    sampleSize: 49,
    minimumSampleSize: 50,
  });
});

test('deduplicates project participants and keeps the richest metadata', () => {
  const participants = deduplicateProjectParticipants([
    { name: 'UOS', searchName: 'University of Strathclyde', country: null, website: 'https://strath.ac.uk' },
    { name: ' University of Strathclyde ', searchName: 'University of Strathclyde', country: 'United Kingdom', website: null },
    { name: 'UNIVERSITY OF STRATHCLYDE', searchName: 'University of Strathclyde', country: null, website: null },
    { name: 'Unknown' },
  ]);

  assert.deepEqual(participants, [{
    name: 'UOS',
    searchName: 'University of Strathclyde',
    country: 'United Kingdom',
    website: 'https://strath.ac.uk',
  }]);
});
