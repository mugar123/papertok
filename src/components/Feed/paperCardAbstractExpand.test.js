import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('SOURCE: opening the abstract pins the card on the press, before the state flips', async () => {
  const jsx = await read('./PaperCard.jsx');
  // Measured in a layout effect, the pin came after the open panel had already
  // grown and re-centred the sheet, and froze the shifted position.
  const toggle = jsx.slice(jsx.indexOf('const toggleExpanded = '), jsx.indexOf('setExpanded(newState);') + 1);
  assert.ok(toggle.includes('pinSheet()'), 'the press pins the sheet before the state flips');
  assert.match(jsx, /if \(!authorsExpanded\) pinSheet\(\);\s*setAuthorsExpanded\(\(open\) => !open\);/);
});

test('SOURCE: the abstract travels between its measured heights on the card clock', async () => {
  const jsx = await read('./PaperCard.jsx');
  assert.match(jsx, /if \(!panel \|\| from == null \|\| prefersReducedMotion\) return;/, 'reduced motion keeps the jump');
  assert.match(jsx, /animateSize\(panel, 'maxHeight', from, [^)]*\{ overflowY: 'hidden' \}\)/, 'no scrollbar while it travels');
  // On the card's own clock: the travel reads the shared constants rather than
  // a duration and curve of its own.
  const travel = jsx.slice(jsx.indexOf('animateSize(panel'), jsx.indexOf('}, [expanded, prefersReducedMotion]);'));
  assert.ok(travel.includes('CARD_DURATION_MS') && travel.includes('EASE_OUT_EXPO'), 'the height travels on the card clock');
});

test('SOURCE: closing the abstract is instant: no height travel, no scroll back, no fade transition', async () => {
  const jsx = await read('./PaperCard.jsx');
  assert.match(jsx, /abstractFromHeight\.current = newState \?[^;]*: null;/, 'only opening records a height to travel from');
  assert.match(jsx, /if \(!newState && abstractRef\.current\) abstractRef\.current\.scrollTop = 0;/);
  assert.doesNotMatch(jsx, /tweenScrollTop\(abstractRef/);
  const css = (await read('./PaperCard.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const base = css.match(/\n\.pc-abstract \{\s*max-height[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(base, /transition/, 'the collapsed panel carries no transition, so closing applies at once');
  const open = css.match(/\.pc-abstract--open \{[^}]*\}/)?.[0] || '';
  assert.match(open, /transition:[^;]*max-height/, 'opening still eases');
});
