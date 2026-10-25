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
  assert.deepEqual(physics.areaLaneSample, { papers: 20, leftOutByVenueLane: 0, filed: 10, share: 0.5, interval: [0.299, 0.701] });

  assert.match(report[1].reason, /^no rule reaches 0.95 precision/);
  assert.equal(report[2].reason, 'fewer than two leaves with a centroid');
  assert.deepEqual(report[2].labelsPerLeaf, { 'mech.dyn': { on: 1, off: 0, doubt: 0 } });
});

test('a doubted label is never on target: a filing under a doubted leaf is wrong, and an article only doubted is not a positive', () => {
  const dataset = {
    arxiv: [
      ...many(60, index => ({ id: `2610.1${index}`, leaf: 'hep-th', vector: vector({ 0: 1 }, index) })),
      ...many(60, index => ({ id: `2610.2${index}`, leaf: 'quant-ph', vector: vector({ 1: 1 }, 100 + index) })),
    ],
    labelled: [
      ...many(40, index => ({ id: `W1${index}`, vector: vector({ 0: 1 }, 1_000 + index), labels: { 'hep-th': 'on' as const } })),
      ...many(40, index => ({ id: `W2${index}`, vector: vector({ 1: 1 }, 2_000 + index), labels: { 'quant-ph': 'on' as const } })),
      // Doubted for the leaf they sit with: filed there, and wrong.
      ...many(2, index => ({ id: `W3${index}`, vector: vector({ 0: 1 }, 3_000 + index), labels: { 'hep-th': 'doubt' as const } })),
      // Doubted for hep-th, filed under quant-ph: no label decides that filing.
      ...many(3, index => ({ id: `W4${index}`, vector: vector({ 1: 1 }, 4_000 + index), labels: { 'hep-th': 'doubt' as const } })),
    ],
    areaSamples: [],
  };
  const [physics] = calibrateLeafFiling(dataset);
  assert.equal(physics.area, 'physics');
  assert.ok(physics.calibration && physics.heldOut);
  // Every article sits clearly with one leaf, so the chosen rule files all of
  // them; the totals over both halves do not depend on how they were split.
  const total = (key: 'papers' | 'positives' | 'filed' | 'correct' | 'wrong' | 'unknown') => physics.calibration![key] + physics.heldOut![key];
  assert.equal(total('papers'), 85);
  assert.equal(total('filed'), 85);
  assert.equal(total('positives'), 80, 'only the on-target articles are positives');
  assert.equal(total('correct'), 80);
  assert.equal(total('wrong'), 2, 'the two filed under the leaf they are doubted for');
  assert.equal(total('unknown'), 3, 'the three filed under the other leaf');
});

test('a labelled article whose preprint is one of the centroid papers is left out before the split', () => {
  const dataset: Parameters<typeof calibrateLeafFiling>[0] = {
    arxiv: [
      ...many(60, index => ({ id: `2610.1${index}`, leaf: 'hep-th', vector: vector({ 0: 1 }, index) })),
      ...many(60, index => ({ id: `2610.2${index}`, leaf: 'quant-ph', vector: vector({ 1: 1 }, 100 + index) })),
    ],
    labelled: [
      ...many(40, index => ({ id: `W1${index}`, vector: vector({ 0: 1 }, 1_000 + index), labels: { 'hep-th': 'on' as const } })),
      ...many(40, index => ({ id: `W2${index}`, vector: vector({ 1: 1 }, 2_000 + index), labels: { 'quant-ph': 'on' as const } })),
      // The published version of the hep-th centroid's first paper.
      { id: 'W3', vector: vector({ 0: 1 }, 0), labels: { 'hep-th': 'on' as const }, arxivIds: ['2610.10'] },
      // A preprint outside the sample does not matter.
      { id: 'W4', vector: vector({ 1: 1 }, 4_000), labels: { 'quant-ph': 'on' as const }, arxivIds: ['2611.00001'] },
    ],
    areaSamples: [],
  };
  const [physics] = calibrateLeafFiling(dataset);
  assert.equal(physics.labelledArticles, 81);
  assert.deepEqual(physics.leftOut, { centroidPreprint: 1, venueLane: 0 });
  assert.deepEqual(physics.split, { calibration: 41, heldOut: 40 });
});

test('an article the venue lane of a leaf of the area takes is left out, labelled or sampled from the area lane', () => {
  const venues = {
    'hep-ex': { sources: ['S1'], filters: ['type:article'] },
    'hep-ph': { sources: ['S2'], filters: ['type:article', 'primary_topic.id:T1|T2'] },
    'nucl-ex': { sources: ['S3'], filters: ['type:article', 'authors_count:>99'] },
    'math.CO': { sources: ['S4'], filters: ['type:article'] },
  };
  const record = (source: string, type = 'article', primaryTopic: string | null = null, authors = 3) => ({ source, type, primaryTopic, authors });
  const dataset = {
    arxiv: [
      ...many(60, index => ({ id: `2610.1${index}`, leaf: 'hep-th', vector: vector({ 0: 1 }, index) })),
      ...many(60, index => ({ id: `2610.2${index}`, leaf: 'quant-ph', vector: vector({ 1: 1 }, 100 + index) })),
    ],
    labelled: [
      ...many(40, index => ({ id: `W1${index}`, vector: vector({ 0: 1 }, 1_000 + index), labels: { 'hep-th': 'on' as const } })),
      ...many(40, index => ({ id: `W2${index}`, vector: vector({ 1: 1 }, 2_000 + index), labels: { 'quant-ph': 'on' as const } })),
      // Taken by a physics venue lane: left out.
      { id: 'W30', vector: vector({ 0: 1 }, 3_000), labels: { 'hep-th': 'on' as const }, openAlex: record('S1') },
      { id: 'W31', vector: vector({ 0: 1 }, 3_001), labels: { 'hep-th': 'on' as const }, openAlex: record('S2', 'article', 'T2') },
      { id: 'W32', vector: vector({ 0: 1 }, 3_002), labels: { 'hep-th': 'on' as const }, openAlex: record('S3', 'article', null, 150) },
      // A listed journal whose lane's filters it does not match, or another area's lane: kept.
      { id: 'W40', vector: vector({ 0: 1 }, 4_000), labels: { 'hep-th': 'on' as const }, openAlex: record('S1', 'review') },
      { id: 'W41', vector: vector({ 0: 1 }, 4_001), labels: { 'hep-th': 'on' as const }, openAlex: record('S2', 'article', 'T3') },
      { id: 'W42', vector: vector({ 0: 1 }, 4_002), labels: { 'hep-th': 'on' as const }, openAlex: record('S3', 'article', null, 99) },
      { id: 'W43', vector: vector({ 0: 1 }, 4_003), labels: { 'hep-th': 'on' as const }, openAlex: record('S4') },
    ],
    areaSamples: [
      ...many(4, index => ({ id: `W5${index}`, area: 'physics', vector: vector({ 0: 1 }, 5_000 + index) })),
      { id: 'W60', area: 'physics', vector: vector({ 0: 1 }, 6_000), openAlex: record('S1') },
      { id: 'W61', area: 'physics', vector: vector({ 0: 1 }, 6_001), openAlex: record('S4') },
    ],
  };
  const [physics] = calibrateLeafFiling(dataset, venues);
  assert.equal(physics.labelledArticles, 84);
  assert.deepEqual(physics.leftOut, { centroidPreprint: 0, venueLane: 3 });
  assert.deepEqual(physics.split, { calibration: 42, heldOut: 42 });
  assert.ok(physics.areaLaneSample);
  assert.deepEqual([physics.areaLaneSample.papers, physics.areaLaneSample.leftOutByVenueLane], [5, 1]);
});

test('an area just under the required precision on its held-out half gets no rule, though the precision rounds to it', () => {
  // The fixed split puts 21 of these off-target articles in the held-out half and 10 in the calibration half.
  const offTarget = new Set([...many(23, index => index), 24, 26, 32, 34, 36, 40, 45, 46]);
  const dataset = {
    arxiv: [
      ...many(60, index => ({ id: `2610.1${index}`, leaf: 'hep-th', vector: vector({ 0: 1 }, index) })),
      ...many(60, index => ({ id: `2610.2${index}`, leaf: 'quant-ph', vector: vector({ 1: 1 }, 100 + index) })),
    ],
    labelled: many(418, index => offTarget.has(index)
      ? { id: `W${index}`, vector: vector({ 0: 1 }, 1_000 + index), labels: { 'hep-th': 'off' as const } }
      : { id: `W${index}`, vector: vector({ [index % 2]: 1 }, 1_000 + index), labels: { [index % 2 ? 'quant-ph' : 'hep-th']: 'on' as const } }),
    areaSamples: [],
  };
  const [physics] = calibrateLeafFiling(dataset);
  assert.ok(physics.calibration && physics.heldOut);
  assert.deepEqual([physics.calibration.correct, physics.calibration.wrong], [199, 10], 'calibration: 0.952');
  assert.deepEqual([physics.heldOut.correct, physics.heldOut.wrong], [188, 21], 'held out: 0.8995');
  assert.equal(physics.enabled, false);
  assert.match(physics.reason, /188\/209, under 0\.9$/);
});
