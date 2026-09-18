import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citationPlate } from './graphMap.js';
import { MAP } from './papers.js';

const svg = citationPlate(MAP);
test('every node sits inside the plate and the centre label sits left of the dot with the rule cut around it', () => {
  for (const m of svg.matchAll(/<circle class="mp-node[^"]*"[^>]*cx="([\d.]+)"/g)) assert.ok(Number(m[1]) <= 1150, m[1]);
  assert.match(svg, /<text class="mp-label"[^>]*text-anchor="end"[^>]*>THIS PAPER · 2016<\/text>/);
  const rules = [...svg.matchAll(/<line class="mp-rule"[^>]*x1="([\d.]+)"[^>]*x2="([\d.]+)"/g)];
  assert.equal(rules.length, 2, 'the rule is two segments');
});
test('the draw-on order starts at the centre and runs oldest to newest', () => {
  const orders = [...svg.matchAll(/class="mp-node[^"]*" style="--i: (\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(orders.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  // The half this test only ever claimed in its name: the centre draws first
  // and everything after it arrives in the order it was published. Read off
  // the names, which is where the year is - the data carries no year field,
  // so a neighbour swapped in without moving its `order` is exactly the
  // regression this catches. (A two-digit year at or under 30 is this
  // century; nothing on this map is from the 1930s or earlier.)
  const years = [...MAP.above, ...MAP.below]
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((n) => {
      const yy = n.name.match(/'(\d{2})/)?.[1];
      assert.ok(yy, `no year in ${n.name} - the draw order cannot be checked`);
      return Number(yy) <= 30 ? 2000 + Number(yy) : 1900 + Number(yy);
    });
  for (let i = 1; i < years.length; i++) {
    assert.ok(years[i] >= years[i - 1], `draw order ${i + 1} is ${years[i]}, older than ${years[i - 1]} before it`);
  }
});
test('the svg is one image for assistive tech, with its own title', () => {
  assert.match(svg, /<svg[^>]*role="img"[^>]*aria-labelledby="lp-map-title"/);
  assert.match(svg, /<title id="lp-map-title">/);
});
test('the compact plate has fewer nodes and three axis marks', () => {
  const c = citationPlate(MAP, { compact: true });
  assert.equal((c.match(/class="mp-node"/g) || []).length, 4);
  assert.deepEqual([...c.matchAll(/class="mp-tick">([^<]+)</g)].map((m) => m[1]), ['1', '100', '10K']);
});

// Belt for the braces beyond the brief's own four assertions above: the two
// data-derived strings that land as raw SVG text content — the centre's own
// label and each neighbour's name — go through the same esc() every other
// text node in this codebase goes through.
//
// Fed a FIXTURE, not MAP: this used to lean on "Hulse & Taylor '75" being in
// the real data, so the day the map was refreshed with measured neighbours
// (2026-09-18) the only name carrying a bare `&` left with it and the test
// would have gone on passing while asserting nothing. What is under test is
// the escaping, not who happens to be on the map this month.
test('a citation name with an ampersand renders escaped, not as a bare &', () => {
  const fixture = {
    centre: { label: 'THIS & THAT · 2016' },
    totals: { cited: 9, citing: 900 },
    above: [{ name: "Hulse & Taylor '75", citations: 2100, y: 124, order: 1 }],
    below: [{ name: 'A <b>bold</b> claim', citations: 4, y: 360, order: 2 }],
  };
  const plate = citationPlate(fixture);
  assert.match(plate, /Hulse &amp; Taylor '75/);
  assert.doesNotMatch(plate, /Hulse & Taylor '75/);
  assert.match(plate, /THIS &amp; THAT/);
  // A name is text content, never markup: the tags arrive escaped or the
  // plate has an injection point.
  assert.match(plate, /A &lt;b&gt;bold&lt;\/b&gt; claim/);
  assert.doesNotMatch(plate, /<b>bold<\/b>/);
});
