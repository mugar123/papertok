import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInstitutionWorksFallback, deduplicateProjectParticipants } from './entityMetadata.js';

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

test('deduplicates project participants and keeps the richest metadata', () => {
  const participants = deduplicateProjectParticipants([
    { name: 'University of Strathclyde', country: null, website: 'https://strath.ac.uk' },
    { name: ' University of Strathclyde ', country: 'United Kingdom', website: null },
    { name: 'UNIVERSITY OF STRATHCLYDE', country: null, website: null },
    { name: 'Unknown' },
  ]);

  assert.deepEqual(participants, [{
    name: 'University of Strathclyde',
    country: 'United Kingdom',
    website: 'https://strath.ac.uk',
  }]);
});
