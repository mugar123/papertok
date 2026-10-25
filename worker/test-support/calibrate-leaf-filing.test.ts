import assert from 'node:assert/strict';
import test from 'node:test';

import { quantize } from '../paper-store.ts';
import { calibrateLeafFiling, wilson } from './calibrate-leaf-filing.ts';

// Synthetic vectors: each leaf's papers point along one axis of the stored 256
// dimensions, with a little seeded noise in every dimension.
function vector(axes: Record<number, number>, seed: number) {
  let state = seed;
  const values = Array.from({ length: 256 }, (_, index) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (axes[index] || 0) + 0.04 * (state / 2147483648 - 0.5);
  });
  return Buffer.from(quantize(values).buffer).toString('base64');
}
const many = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));

test('the Wilson interval of 27 successes in 30', () => {
  assert.deepEqual(wilson(27, 30), [0.744, 0.965]);
  assert.equal(wilson(0, 0), null);
});

test('calibration files clear articles, leaves those between two leaves at area level, and enables only areas that reach the precision', () => {
  const dataset = {
    arxiv: [
      ...many(60, index => ({ id: `2610.1${index}`, leaf: 'hep-th', vector: vector({ 0: 1 }, index) })),
      ...many(60, index => ({ id: `2610.2${index}`, leaf: 'quant-ph', vector: vector({ 1: 1 }, 100 + index) })),
      // Two computer science leaves whose papers point the same way.
      ...many(60, index => ({ id: `2610.3${index}`, leaf: 'cs.AI', vector: vector({ 2: 1 }, 200 + index) })),
      ...many(60, index => ({ id: `2610.4${index}`, leaf: 'cs.LG', vector: vector({ 2: 1 }, 300 + index) })),
    ],
    labelled: [
      ...many(40, index => ({ id: `W1${index}`, vector: vector({ 0: 1 }, 1_000 + index), labels: { 'hep-th': 'on' as const } })),
      ...many(40, index => ({ id: `W2${index}`, vector: vector({ 1: 1 }, 2_000 + index), labels: { 'quant-ph': 'on' as const } })),
      // Between the two physics leaves, and labelled off target for one.
      ...many(20, index => ({ id: `W3${index}`, vector: vector({ 0: 1, 1: 1 }, 3_000 + index), labels: { 'hep-th': 'off' as const } })),
      ...many(40, index => ({ id: `W4${index}`, vector: vector({ 2: 1 }, 4_000 + index), labels: { [index % 2 ? 'cs.AI' : 'cs.LG']: 'on' as const } })),
      // A mechanical engineering leaf: no arXiv category, so no centroid.
      { id: 'W5', vector: vector({ 3: 1 }, 5_000), labels: { 'mech.dyn': 'on' as const } },
    ],
    areaSamples: [
      ...many(10, index => ({ id: `W6${index}`, area: 'physics', vector: vector({ 0: 1 }, 6_000 + index) })),
      ...many(10, index => ({ id: `W7${index}`, area: 'physics', vector: vector({ 0: 1, 1: 1 }, 7_000 + index) })),
    ],
  };
  const report = calibrateLeafFiling(dataset);
  assert.deepEqual(report.map(row => [row.area, row.enabled]), [['physics', true], ['cs', false], ['mech', false]]);

  const physics = report[0];
  assert.deepEqual(physics.split, { calibration: 50, heldOut: 50 });
  assert.ok(physics.heldOut);
  assert.equal(physics.heldOut.filed, physics.heldOut.positives, 'every clear article, and none between the leaves');
  assert.equal(physics.heldOut.correct, physics.heldOut.filed);
  assert.equal(physics.heldOut.wrong, 0);
  assert.equal(physics.heldOut.precision, 1);
  assert.equal(physics.heldOut.recall, 1);
  assert.deepEqual(physics.areaLaneSample, { papers: 20, filed: 10, share: 0.5, interval: [0.299, 0.701] });

  assert.match(report[1].reason, /^no rule reaches 0.95 precision/);
  assert.equal(report[2].reason, 'fewer than two leaves with a centroid');
  assert.deepEqual(report[2].labelsPerLeaf, { 'mech.dyn': { on: 1, off: 0, doubt: 0 } });
});
