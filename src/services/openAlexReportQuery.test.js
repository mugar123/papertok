import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAlexTrendFilter, normalizeReportFilters } from './openAlexReportQuery.js';

test('builds trend filters from current OpenAlex topic fields', () => {
  const filter = buildOpenAlexTrendFilter(
    { fromStr: '2026-07-01', toStr: '2026-07-07' },
    { categories: ['physics', 'cs'], countries: ['es'] },
  );

  assert.match(filter, /primary_topic\.field\.id:17\|31|primary_topic\.field\.id:31\|17/);
  assert.match(filter, /authorships\.institutions\.country_code:ES/);
  assert.doesNotMatch(filter, /concepts\.id/);
});

test('drops unknown categories and invalid country codes', () => {
  assert.deepEqual(normalizeReportFilters({
    categories: ['physics', 'unknown'],
    countries: ['ES', 'INVALID'],
  }), {
    categories: ['physics'],
    countries: ['ES'],
  });
});
