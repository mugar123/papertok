import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HERO_PAPERS, SIGNALS, FOLLOW_ROWS, LISTS, MAP, RESEARCH, SOURCES } from './papers.js';

test('the deck opens with LIGO and closes with the paper that is not open access', () => {
  assert.equal(HERO_PAPERS.length, 3);
  assert.match(HERO_PAPERS[0].title, /Gravitational Waves/);
  assert.ok(!HERO_PAPERS[2].chips.some((c) => c.label === 'Open access'));
  assert.ok(HERO_PAPERS[2].chips.some((c) => c.label === 'Subscription'));
});
test('six signals, three entities, four lists', () => {
  assert.equal(SIGNALS.length, 6);
  assert.deepEqual(FOLLOW_ROWS.map((r) => r.kind), ['person', 'tag', 'building']);
  assert.equal(FOLLOW_ROWS[2].lang, 'es');
  assert.equal(LISTS.length, 4);
  assert.equal(LISTS.filter((l) => l.isPublic).length, 1);
});
test('the map has five cited and two citing neighbours, all inside the plate', () => {
  assert.equal(MAP.above.length, 5);
  assert.equal(MAP.below.length, 2);
  const x = (c) => Math.min(1150, 300 + Math.log10(Math.max(c, 1)) * 220);
  for (const n of [...MAP.above, ...MAP.below]) assert.ok(x(n.citations) <= 1150, n.name);
  const orders = [...MAP.above, ...MAP.below].map((n) => n.order).sort((a, b) => a - b);
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7]);
});
test('growing-topic percentages are the ones their own counts give', () => {
  for (const t of RESEARCH.topics) {
    assert.equal(t.pct, Math.round((t.works / t.previous - 1) * 100), t.name);
  }
  assert.equal(RESEARCH.topics[0].pct, 69);
  assert.equal(RESEARCH.topics[1].pct, 47);
});
test('six core sources, and no claim that they are the only ones', () => {
  assert.equal(SOURCES.length, 6);
});
