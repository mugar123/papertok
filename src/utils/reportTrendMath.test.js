import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScientificTrends } from './reportTrendMath.js';

test('does not call stable topic share a trend when raw volume grows', () => {
  const result = computeScientificTrends(
    { total: 1000, groups: [{ key: 'T1', key_display_name: 'Stable topic', count: 20 }] },
    { total: 500, groups: [{ key: 'T1', key_display_name: 'Stable topic', count: 10 }] },
  );

  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.items, []);
});

test('surfaces meaningful growth using period share instead of raw count', () => {
  const result = computeScientificTrends(
    { total: 500, groups: [{ key: 'T1', key_display_name: 'Quantum sensing', count: 30 }] },
    { total: 500, groups: [{ key: 'T1', key_display_name: 'Quantum sensing', count: 10 }] },
  );

  assert.equal(result.status, 'active');
  assert.equal(result.items[0].label, 'Quantum sensing');
  assert.ok(result.items[0].changePercent > 100);
});

test('does not manufacture huge percentages from tiny samples', () => {
  const result = computeScientificTrends(
    { total: 200, groups: [{ key: 'T1', key_display_name: 'Tiny topic', count: 2 }] },
    { total: 200, groups: [] },
  );

  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.items, []);
});

test('labels sufficiently supported topics with no baseline as new', () => {
  const result = computeScientificTrends(
    { total: 200, groups: [{ key: 'T1', key_display_name: 'New topic', count: 8 }] },
    { total: 200, groups: [] },
  );

  assert.equal(result.items[0].state, 'new');
  assert.equal(result.items[0].changePercent, null);
});
