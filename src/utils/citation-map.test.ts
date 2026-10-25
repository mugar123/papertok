import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITATION_MAP_GEOMETRY,
  buildCitationMapLayout,
  formatCitationTick,
  isMappableCitationPaper,
  nearestCitationLink,
} from './citation-map.ts';

function paper(overrides: Partial<import('../models/paper.ts').Paper> = {}) {
  return {
    id: overrides.id || `paper-${overrides.year || 2000}-${overrides.citationCount ?? 0}`,
    title: 'A paper',
    year: 2010,
    citationCount: 100,
    citationCountKnown: true,
    ...overrides,
  };
}

function series<T>(count: number, build: (index: number) => T) {
  return Array.from({ length: count }, (_, index) => build(index));
}

const BOX = { width: 682, height: 396 };

function layout(overrides: Partial<Parameters<typeof buildCitationMapLayout>[0]> = {}) {
  return buildCitationMapLayout({
    ...BOX,
    center: paper({ id: 'center', year: 2017, citationCount: 131204 }),
    references: [],
    citations: [],
    ...overrides,
  });
}

const half = CITATION_MAP_GEOMETRY.minGap / 2;
const square = (node: { x: number; y: number }) => ({ left: node.x - half, right: node.x + half, top: node.y - half, bottom: node.y + half });
const overlaps = (a: ReturnType<typeof square>, b: ReturnType<typeof square>) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function assertNoSharedTargets(result: ReturnType<typeof layout>) {
  const boxes = result.nodes.map(square);
  boxes.push(square({ x: result.centerX, y: result.centerY }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.equal(overlaps(boxes[i], boxes[j]), false, `targets ${i} and ${j} share pixels`);
    }
  }
}

test('a paper is mappable only when both of its coordinates are known', () => {
  assert.equal(isMappableCitationPaper(paper()), true);
  // A count of zero is a measurement; an unknown count is not, and the
  // citation axis cannot place what nobody counted.
  assert.equal(isMappableCitationPaper(paper({ citationCount: 0 })), true);
  assert.equal(isMappableCitationPaper(paper({ citationCountKnown: false })), false);
  assert.equal(isMappableCitationPaper(paper({ year: undefined })), false);
  assert.equal(isMappableCitationPaper(paper({ year: Number.NaN })), false);
  assert.equal(isMappableCitationPaper(null), false);
});

test('the layout waits for a measured box instead of dividing by zero', () => {
  const pending = layout({ width: 0, height: 0, references: [paper()] });
  assert.equal(pending.ready, false);
  assert.equal(pending.nodes.length, 0);
  assert.ok(Number.isFinite(pending.centerX));
  assert.ok(Number.isFinite(pending.centerY));
});

test('time runs left to right and citations run bottom to top', () => {
  const result = layout({
    references: [
      paper({ id: 'old', year: 2001, citationCount: 50 }),
      paper({ id: 'newer', year: 2012, citationCount: 50 }),
    ],
    citations: [
      paper({ id: 'quiet', year: 2020, citationCount: 10 }),
      paper({ id: 'loud', year: 2021, citationCount: 10000 }),
    ],
  });
  const at = (id: string) => result.nodes.find(node => node.paper.id === id)!;
  assert.ok(at('old').x < at('newer').x, 'an older paper stands further left');
  assert.ok(at('newer').x < result.centerX, 'a paper from before the centre stands to its left');
  assert.ok(at('quiet').x > result.centerX, 'a paper from after the centre stands to its right');
  assert.ok(at('loud').y < at('quiet').y, 'a more cited paper stands higher');
});

test('a node is never moved up or down to make room: its height is its count', () => {
  // Five papers from one year with one count all want the same spot.
  const crowd = series(5, index => paper({ id: `same-${index}`, year: 2015, citationCount: 300 }));
  const result = layout({ references: crowd });
  const heights = new Set(result.nodes.map(node => Math.round(node.y * 1000)));
  assert.equal(heights.size, 1, 'every placed node keeps the height of its own count');
  assertNoSharedTargets(result);
});

test('papers that want the same spot spread sideways, within their own year', () => {
  const crowd = series(4, index => paper({ id: `same-${index}`, year: 2015, citationCount: 300 }));
  const result = layout({ references: crowd });
  const neighbour = layout({ references: [paper({ id: 'a', year: 2015, citationCount: 300 }), paper({ id: 'b', year: 2016, citationCount: 300 })] });
  const [first, next] = neighbour.nodes.map(node => node.x).sort((p, q) => p - q);
  const pxPerYear = next - first;
  for (const node of result.nodes) {
    assert.ok(Math.abs(node.x - first) < pxPerYear / 2, 'a spread node stays within half a year of its own');
  }
});

test('no two targets ever share a pixel, the centre mark included', () => {
  const references = series(30, index => paper({ id: `r-${index}`, year: 2000 + (index % 8), citationCount: 10 ** (1 + (index % 4)) }));
  const citations = series(30, index => paper({ id: `c-${index}`, year: 2018 + (index % 6), citationCount: 10 ** (index % 3) }));
  assertNoSharedTargets(layout({ references, citations }));
  assertNoSharedTargets(layout({ width: 360, height: 300, references, citations }));
});

test('crowding drops nodes into the list rather than shrinking their targets', () => {
  const crowd = series(40, index => paper({ id: `same-${index}`, year: 2015, citationCount: 300 }));
  const result = layout({ references: crowd });
  assert.ok(result.nodes.length < 40, 'a single crowded spot cannot hold forty targets');
});

test('a crowded map keeps the leading papers of both neighbourhoods', () => {
  // Both ranked lists want the same spot; the first of each must survive.
  const references = series(20, index => paper({ id: `r-${index}`, year: 2017, citationCount: 300 }));
  const citations = series(20, index => paper({ id: `c-${index}`, year: 2017, citationCount: 300 }));
  const result = layout({ references, citations, center: paper({ id: 'center', year: 2010, citationCount: 5 }) });
  const ids = result.nodes.map(node => node.paper.id);
  assert.ok(ids.includes('r-0'), 'the most cited reference is drawn');
  assert.ok(ids.includes('c-0'), 'the most recent citation is drawn');
});

test('every node and the centre stay inside the plot', () => {
  const result = layout({
    references: series(8, index => paper({ id: `r-${index}`, year: 1990 + index * 3, citationCount: 10 ** index })),
    citations: series(8, index => paper({ id: `c-${index}`, year: 2018 + index, citationCount: index * 5 })),
  });
  for (const node of [...result.nodes, { x: result.centerX, y: result.centerY }]) {
    assert.ok(node.x - half >= 0 && node.x + half <= BOX.width, 'inside horizontally');
    assert.ok(node.y >= result.plot.top && node.y <= result.plot.bottom, 'inside vertically');
  }
});

test('a neighbourhood with one citation count does not collapse onto the floor or ceiling', () => {
  const result = layout({
    center: paper({ id: 'center', year: 2017, citationCount: 40 }),
    references: [paper({ id: 'a', year: 2010, citationCount: 40 })],
  });
  const node = result.nodes[0];
  assert.ok(node.y > result.plot.top && node.y < result.plot.bottom, 'the shared count sits inside the scale');
});

test('citation ticks are powers of ten, larger ones higher, inside the plot', () => {
  const result = layout({
    references: [paper({ id: 'a', citationCount: 3 }), paper({ id: 'b', citationCount: 40000 })],
  });
  assert.ok(result.ticks.length >= 2);
  for (const tick of result.ticks) {
    assert.equal(Math.log10(tick.value) % 1, 0, `${tick.value} is a power of ten`);
    assert.ok(tick.y >= result.plot.top && tick.y <= result.plot.bottom);
  }
  const ys = result.ticks.map(tick => tick.y);
  assert.deepEqual([...ys].sort((p, q) => q - p), ys, 'larger values sit higher');
});

test('year ticks are round years, far enough apart to read', () => {
  const result = layout({
    references: [paper({ id: 'a', year: 1975 })],
    citations: [paper({ id: 'b', year: 2024 })],
  });
  assert.ok(result.yearTicks.length >= 2);
  for (let index = 1; index < result.yearTicks.length; index += 1) {
    const gap = result.yearTicks[index].x - result.yearTicks[index - 1].x;
    assert.ok(gap >= CITATION_MAP_GEOMETRY.minYearTickGap, 'labels do not crowd');
  }
});

test('tick labels stay short at every scale', () => {
  assert.equal(formatCitationTick(1), '1');
  assert.equal(formatCitationTick(1000), '1K');
  assert.equal(formatCitationTick(10000), '10K');
  assert.equal(formatCitationTick(1000000), '1M');
});

test('a label near the right edge sits on the other side of its node', () => {
  const result = layout({ citations: [paper({ id: 'late', year: 2030, citationCount: 100 })] });
  const node = result.nodes[0];
  assert.ok(node.x > BOX.width - CITATION_MAP_GEOMETRY.labelWidth - CITATION_MAP_GEOMETRY.flipMargin);
  assert.equal(node.side, 'left');
});

test('a label with no free room waits for hover or focus instead of covering another node', () => {
  const crowd = series(6, index => paper({ id: `same-${index}`, year: 2015, citationCount: 300 }));
  const result = layout({ references: crowd });
  const labelBox = (node: ReturnType<typeof layout>['nodes'][number]) => {
    const top = node.y - CITATION_MAP_GEOMETRY.labelHeight / 2;
    const bottom = node.y + CITATION_MAP_GEOMETRY.labelHeight / 2;
    return node.side === 'right'
      ? { left: node.x + half, right: node.x + half + CITATION_MAP_GEOMETRY.labelWidth, top, bottom }
      : { left: node.x - half - CITATION_MAP_GEOMETRY.labelWidth, right: node.x - half, top, bottom };
  };
  for (const node of result.nodes.filter(entry => !entry.labelHidden)) {
    for (const other of result.nodes) {
      if (other !== node) assert.equal(overlaps(labelBox(node), square(other)), false, 'a shown label covers no target');
    }
  }
  assert.ok(result.nodes.some(node => node.labelHidden), 'the crowd leaves some labels for hover');
});

test('the centre keeps its own spot; a neighbour that wants it is moved aside', () => {
  const result = layout({
    center: paper({ id: 'center', year: 2017, citationCount: 1000 }),
    references: [paper({ id: 'r', year: 2017, citationCount: 1000 })],
  });
  const node = result.nodes[0];
  assert.equal(Math.round(node.y), Math.round(result.centerY), 'same count, same height');
  assert.notEqual(Math.round(node.x), Math.round(result.centerX), 'moved sideways, not onto the centre');
});

test('a centre with an unknown citation count stands mid-height rather than at an invented count', () => {
  const result = layout({
    center: paper({ id: 'center', year: 2017, citationCountKnown: false }),
    references: [paper({ id: 'r', year: 2010, citationCount: 10 })],
  });
  assert.equal(result.centerY, BOX.height / 2);
});

test('the stagger restarts for each neighbourhood so a full map does not queue up', () => {
  const result = layout({
    references: series(8, index => paper({ id: `r-${index}`, year: 2000 + index, citationCount: 10 + index * 100 })),
    citations: series(8, index => paper({ id: `c-${index}`, year: 2018 + index, citationCount: 10 + index * 100 })),
  });
  const first = (relation: 'reference' | 'citation') => result.nodes.find(node => node.relation === relation)!;
  assert.equal(first('reference').delay, CITATION_MAP_GEOMETRY.nodeDelayBase);
  assert.equal(first('citation').delay, CITATION_MAP_GEOMETRY.nodeDelayBase);
});

test('an empty neighbourhood still draws the centre', () => {
  const result = layout();
  assert.equal(result.ready, true);
  assert.equal(result.nodes.length, 0);
  assert.ok(Number.isFinite(result.centerX) && Number.isFinite(result.centerY));
});

test('a narrow neighbourhood gets the 2 and 5 steps, so the scale has more than one mark', () => {
  const result = layout({
    center: paper({ id: 'center', year: 2017, citationCount: 900 }),
    references: [paper({ id: 'a', year: 2010, citationCount: 700 }), paper({ id: 'b', year: 2012, citationCount: 1500 })],
  });
  assert.ok(result.ticks.length >= 2, 'more than one mark');
  for (const tick of result.ticks) {
    const lead = tick.value / 10 ** Math.floor(Math.log10(tick.value));
    assert.ok([1, 2, 5].includes(lead), `${tick.value} is a 1, 2 or 5 step`);
  }
});

test('a star at the first year or the top count stays clear of the scale beside and above the plot', () => {
  const result = layout({
    references: [paper({ id: 'oldest', year: 1950, citationCount: 90000 })],
  });
  const node = result.nodes.find(entry => entry.paper.id === 'oldest');
  assert.ok(node, 'the oldest, most cited paper is drawn');
  assert.ok(node.x - half >= result.plot.left, 'its target starts inside the plot, not on the scale labels');
  assert.ok(node.y - half >= result.plot.top, 'its target starts below the scale name');
});

test('no star label lands on the centre chip', () => {
  const geometry = CITATION_MAP_GEOMETRY;
  const result = layout({
    // Just left of the centre at its count: a label on its right would run
    // into the chip, which stands right of the mark here.
    citations: [paper({ id: 'beside', year: 2016, citationCount: 131204 })],
  });
  assert.equal(result.chipSide, 'right');
  const chipLeft = result.centerX + geometry.chipGap;
  const chip = {
    left: chipLeft,
    right: chipLeft + geometry.chipWidth,
    top: result.centerY - geometry.chipHeight / 2,
    bottom: result.centerY + geometry.chipHeight / 2,
  };
  for (const node of result.nodes.filter(entry => !entry.labelHidden)) {
    const top = node.y - geometry.labelHeight / 2;
    const bottom = node.y + geometry.labelHeight / 2;
    const label = node.side === 'right'
      ? { left: node.x + half, right: node.x + half + geometry.labelWidth, top, bottom }
      : { left: node.x - half - geometry.labelWidth, right: node.x - half, top, bottom };
    assert.ok(!overlaps(label, chip), `${node.paper.id}'s label covers the chip`);
  }
});

test('a press picks the nearest link, not the one drawn last, and nothing out of reach', () => {
  const center = { x: 100, y: 100 };
  const nodes = [
    { key: 'upper', x: 300, y: 90 },
    { key: 'lower', x: 300, y: 110 },
  ];
  assert.equal(nearestCitationLink(nodes, center, { x: 250, y: 94 }), 'upper');
  assert.equal(nearestCitationLink(nodes, center, { x: 250, y: 106 }), 'lower');
  assert.equal(nearestCitationLink(nodes, center, { x: 250, y: 150 }), null);
  assert.equal(nearestCitationLink(nodes, center, { x: 320, y: 110 }), 'lower', 'past the star the distance is to the star');
  assert.equal(nearestCitationLink(nodes, center, { x: 330, y: 110 }), null);
});
