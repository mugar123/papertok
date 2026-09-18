import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HERO_PAPERS, SIGNALS, FOLLOW_ROWS, LISTS, MAP, RESEARCH, SOURCES, ENRICHERS, PILE } from './papers.js';

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
  assert.equal(SOURCES.length, 5);
  // The split is the claim: a name in SOURCES is rendered as a place papers
  // come FROM, so anything that only annotates a paper already in the feed
  // belongs in ENRICHERS. iCite was on the wrong side of that comma.
  assert.ok(!SOURCES.some(([name]) => /iCite|Unpaywall/i.test(name)), 'an enricher is being sold as a source of papers');
  assert.equal(ENRICHERS.length, 2);
});

// landing.css's phone .lp-pile__venue column (76px) was sized by measuring
// PILE's actual longest venue strings against the real mono-label font, not
// by trusting a character count — see that rule's comment for the
// measurement (72.6px natural width, canvas measureText, at this column's
// font+letter-spacing). white-space: nowrap there is what stops a string
// from ever wrapping a row regardless of length; this test is the other
// half of that guarantee — it pins the length the width was measured for,
// so a future PILE entry with a longer venue fails HERE, loudly, instead of
// silently taking a row's height with it in a screenshot nobody diffs.
// If this ever needs to grow past 10, re-measure the phone column's
// natural-width headroom (see landing.css) before raising the number.
test("no PILE venue string has grown past what the phone column was measured for", () => {
  const longest = Math.max(...PILE.map((row) => row.venue.length));
  assert.equal(longest, 10, 'PILE.venue length — widen .lp-pile__venue (landing.css, phone block) if this genuinely needs to grow');
});
