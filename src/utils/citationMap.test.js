import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITATION_MAP_GEOMETRY,
  buildCitationMapLayout,
  formatCitationTick,
  isMappableCitationPaper,
} from './citationMap.js';

function paper(overrides = {}) {
  return {
    id: overrides.id || `paper-${overrides.year || 2000}-${overrides.citationCount ?? 0}`,
    title: 'A paper',
    year: 2010,
    citationCount: 100,
    citationCountKnown: true,
    ...overrides,
  };
}

function series(count, build) {
  return Array.from({ length: count }, (_, index) => build(index));
}

const BOX = { width: 682, height: 396 };

function layout(overrides = {}) {
  return buildCitationMapLayout({
    ...BOX,
    center: paper({ id: 'center', year: 2017, citationCount: 131204 }),
    references: [],
    citations: [],
    ...overrides,
  });
}

function band(result, relation) {
  return result.nodes.filter(node => node.relation === relation);
}

test('a paper is mappable only when both of its coordinates are known', () => {
  assert.equal(isMappableCitationPaper(paper()), true);
  // A count of zero is a measurement; an unknown count is not, and the
  // horizontal axis cannot place what nobody counted.
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
});

test('every node stays inside the band it belongs to', () => {
  const result = layout({
    references: series(8, index => paper({ id: `r${index}`, year: 1997 + index * 2, citationCount: 500 * (index + 1) })),
    citations: series(8, index => paper({ id: `c${index}`, year: 2018 + index, citationCount: 800 * (index + 1) })),
  });

  const referenceBand = result.bands.references;
  const citationBand = result.bands.citations;
  assert.ok(referenceBand.bottom < result.ruleY);
  assert.ok(citationBand.top > result.ruleY);

  for (const node of band(result, 'reference')) {
    assert.ok(node.y - node.rowHeight / 2 >= referenceBand.top - 0.001, `top ${node.y}`);
    assert.ok(node.y + node.rowHeight / 2 <= referenceBand.bottom + 0.001, `bottom ${node.y}`);
  }
  for (const node of band(result, 'citation')) {
    assert.ok(node.y - node.rowHeight / 2 >= citationBand.top - 0.001, `top ${node.y}`);
    assert.ok(node.y + node.rowHeight / 2 <= citationBand.bottom + 0.001, `bottom ${node.y}`);
  }
});

test('hit rows tile without ever sharing a pixel', () => {
  const result = layout({
    // Six of these share a year, so the whole band leans on the spreading pass.
    references: series(8, index => paper({ id: `r${index}`, year: index < 6 ? 2014 : 1997 + index, citationCount: 400 + index })),
  });

  const rows = band(result, 'reference').slice().sort((a, b) => a.y - b.y);
  for (let index = 1; index < rows.length; index += 1) {
    const previousBottom = rows[index - 1].y + rows[index - 1].rowHeight / 2;
    const currentTop = rows[index].y - rows[index].rowHeight / 2;
    assert.ok(currentTop >= previousBottom - 0.001, `row ${index} overlaps the one above`);
  }
});

test('the row height gives way before the band does', () => {
  const roomy = layout({ references: series(4, index => paper({ id: `r${index}`, year: 2000 + index * 4 })) });
  const crowded = layout({ references: series(10, index => paper({ id: `r${index}`, year: 2000 + index })) });

  assert.equal(roomy.nodes[0].rowHeight, CITATION_MAP_GEOMETRY.minGap);
  assert.ok(crowded.nodes[0].rowHeight < CITATION_MAP_GEOMETRY.minGap);
  assert.ok(crowded.nodes[0].rowHeight >= CITATION_MAP_GEOMETRY.minRowHeight);
});

test('spreading crowded nodes never reorders them in time', () => {
  const result = layout({
    references: series(8, index => paper({ id: `r${index}`, year: index < 5 ? 2014 : 2015 + index })),
  });

  const rows = band(result, 'reference');
  const byYear = rows.slice().sort((a, b) => a.paper.year - b.paper.year || a.paper.id.localeCompare(b.paper.id));
  const byPosition = rows.slice().sort((a, b) => a.y - b.y);
  assert.deepEqual(byPosition.map(node => node.paper.id), byYear.map(node => node.paper.id));
});

test('the horizontal axis is monotonic in citations and stays inside the plot', () => {
  const result = layout({
    references: [
      paper({ id: 'few', year: 2001, citationCount: 120 }),
      paper({ id: 'some', year: 2005, citationCount: 4200 }),
      paper({ id: 'many', year: 2009, citationCount: 96000 }),
    ],
  });

  const x = Object.fromEntries(result.nodes.map(node => [node.paper.id, node.x]));
  assert.ok(x.few < x.some);
  assert.ok(x.some < x.many);
  for (const node of result.nodes) {
    assert.ok(node.x >= CITATION_MAP_GEOMETRY.sidePadding - 0.001);
    assert.ok(node.x <= BOX.width - CITATION_MAP_GEOMETRY.sidePadding + 0.001);
  }
});

test('a neighbourhood with one citation count does not collapse onto a single column', () => {
  const result = layout({
    center: paper({ id: 'center', year: 2017, citationCount: 900 }),
    references: series(3, index => paper({ id: `r${index}`, year: 2000 + index, citationCount: 900 })),
  });

  for (const node of result.nodes) assert.ok(Number.isFinite(node.x));
  assert.ok(result.ticks.every(tick => Number.isFinite(tick.x)));
});

test('ticks are powers of ten that fall inside the plot', () => {
  const result = layout({
    references: [paper({ id: 'a', year: 2001, citationCount: 300 })],
    citations: [paper({ id: 'b', year: 2020, citationCount: 90000 })],
  });

  assert.ok(result.ticks.length >= 2);
  for (const tick of result.ticks) {
    const exponent = Math.log10(tick.value);
    assert.equal(exponent, Math.round(exponent));
    assert.ok(tick.x > 0 && tick.x < BOX.width);
  }
});

test('tick labels stay short at every scale', () => {
  assert.equal(formatCitationTick(100), '100');
  assert.equal(formatCitationTick(1000), '1K');
  assert.equal(formatCitationTick(10000), '10K');
  assert.equal(formatCitationTick(1000000), '1M');
});

test('a label near the right edge flips to the other side of its node', () => {
  const result = layout({
    references: [
      paper({ id: 'left', year: 2001, citationCount: 100 }),
      paper({ id: 'right', year: 2010, citationCount: 500000 }),
    ],
  });

  const sides = Object.fromEntries(result.nodes.map(node => [node.paper.id, node.side]));
  assert.equal(sides.left, 'right');
  assert.equal(sides.right, 'left');
});

test('papers without both coordinates are counted out instead of being placed', () => {
  const result = layout({
    references: [
      paper({ id: 'placed', year: 2001, citationCount: 100 }),
      paper({ id: 'no-count', year: 2002, citationCount: 0, citationCountKnown: false }),
      paper({ id: 'no-year', year: undefined, citationCount: 40 }),
    ],
    citations: [paper({ id: 'also-placed', year: 2020, citationCount: 300 })],
  });

  assert.deepEqual(result.nodes.map(node => node.paper.id), ['placed', 'also-placed']);
  assert.equal(result.omitted.references, 2);
  assert.equal(result.omitted.citations, 0);
});

test('a single node in a band sits inside it', () => {
  const result = layout({ references: [paper({ id: 'only', year: 2004 })] });
  const only = result.nodes[0];
  assert.ok(Number.isFinite(only.y));
  assert.ok(only.y >= result.bands.references.top);
  assert.ok(only.y <= result.bands.references.bottom);
});

test('the centre marker sits at the citation count of the paper you are looking at', () => {
  const modest = layout({
    center: paper({ id: 'center', year: 2017, citationCount: 200 }),
    references: [paper({ id: 'r', year: 2001, citationCount: 100 })],
    citations: [paper({ id: 'c', year: 2020, citationCount: 90000 })],
  });
  const huge = layout({
    center: paper({ id: 'center', year: 2017, citationCount: 80000 }),
    references: [paper({ id: 'r', year: 2001, citationCount: 100 })],
    citations: [paper({ id: 'c', year: 2020, citationCount: 90000 })],
  });

  assert.ok(modest.centerX < huge.centerX);
  assert.ok(modest.centerX >= CITATION_MAP_GEOMETRY.sidePadding - 0.001);
  assert.ok(huge.centerX <= BOX.width - CITATION_MAP_GEOMETRY.sidePadding + 0.001);
});

test('a centre with an unknown citation count still gets a marker', () => {
  const result = layout({
    center: paper({ id: 'center', year: 2017, citationCount: 0, citationCountKnown: false }),
    references: [paper({ id: 'r', year: 2001, citationCount: 100 })],
  });
  assert.ok(Number.isFinite(result.centerX));
  assert.equal(result.centerImpactKnown, false);
});

test('the stagger restarts on each band so sixteen nodes do not queue up', () => {
  const result = layout({
    references: series(3, index => paper({ id: `r${index}`, year: 2000 + index })),
    citations: series(3, index => paper({ id: `c${index}`, year: 2020 + index })),
  });

  const references = band(result, 'reference').slice().sort((a, b) => a.delay - b.delay);
  const citations = band(result, 'citation').slice().sort((a, b) => a.delay - b.delay);
  const { nodeDelayBase, nodeDelayStep, edgeDelayBase, edgeDelayStep } = CITATION_MAP_GEOMETRY;

  assert.deepEqual(references.map(node => node.delay), [0, 1, 2].map(i => nodeDelayBase + i * nodeDelayStep));
  assert.deepEqual(citations.map(node => node.delay), [0, 1, 2].map(i => nodeDelayBase + i * nodeDelayStep));
  assert.deepEqual(references.map(node => node.edgeDelay), [0, 1, 2].map(i => edgeDelayBase + i * edgeDelayStep));
});

test('a sheet too short for a band keeps its nodes on the plot', () => {
  const cramped = layout({
    height: 120,
    references: series(4, index => paper({ id: `r${index}`, year: 2000 + index })),
    citations: series(4, index => paper({ id: `c${index}`, year: 2020 + index })),
  });

  assert.equal(cramped.nodes.length, 8);
  for (const node of cramped.nodes) {
    assert.ok(Number.isFinite(node.y), 'a node landed nowhere');
    assert.ok(node.y >= 0 && node.y <= 120, `a node left the plot at ${node.y}`);
  }
});

test('an empty neighbourhood still draws a rule and a marker', () => {
  const result = layout();
  assert.equal(result.ready, true);
  assert.equal(result.nodes.length, 0);
  assert.ok(result.ruleY > 0 && result.ruleY < BOX.height);
});
