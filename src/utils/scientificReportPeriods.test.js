import test from 'node:test';
import assert from 'node:assert/strict';
import { getComparisonPeriods, getDateThresholds } from './scientificReportPeriods.js';

test('builds inclusive report periods', () => {
  const now = new Date(2026, 6, 16, 12, 0, 0);
  assert.deepEqual(getDateThresholds('7d', now), {
    fromStr: '2026-07-10',
    toStr: '2026-07-16',
    days: 7,
  });
});

test('builds a non-overlapping comparison period of equal length', () => {
  const periods = getComparisonPeriods('7d', new Date(2026, 6, 16, 12, 0, 0));
  assert.deepEqual(periods.previous, {
    fromStr: '2026-07-03',
    toStr: '2026-07-09',
    days: 7,
  });
});
