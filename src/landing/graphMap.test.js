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
// text node in this codebase goes through. MAP.centre.label has no
// metacharacters today, so the assertion above already proves it renders
// correctly either way; this test is the one that would actually catch a
// regression, because "Hulse & Taylor '75" (MAP.above[1].name) contains a
// bare `&`, which is not well-formed inside SVG text content unescaped — an
// un-escaped ampersand there is a markup bug, not a taste choice.
test('a citation name with an ampersand renders escaped, not as a bare &', () => {
  assert.match(svg, /Hulse &amp; Taylor '75/);
  assert.doesNotMatch(svg, /Hulse & Taylor '75/);
});
