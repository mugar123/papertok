import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHighlightPlan,
  buildRangeAnchor,
  buildSelectionAnchor,
  resolveHighlightRanges,
  segmentTextChunk,
} from './textHighlights.js';

test('resolves a quote to a range in normalized space', () => {
  const text = 'The model reduced error by 12%.';
  const ranges = resolveHighlightRanges(text, [{ quote: 'reduced error by 12%', kind: 'finding' }]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].kind, 'finding');
  // normalizeLatexText escapes the percent sign on both sides, so the quote
  // still matches and the range covers it.
  assert.ok(ranges[0].end > ranges[0].start);
});

test('drops quotes the model did not copy verbatim', () => {
  const ranges = resolveHighlightRanges('Sample size was 240 patients.', [
    { quote: 'sample size was 900 patients' },
  ]);
  assert.deepEqual(ranges, []);
});

test('ignores quotes too short to anchor reliably', () => {
  const ranges = resolveHighlightRanges('Growth was linear over time.', [{ quote: 'was' }]);
  assert.deepEqual(ranges, []);
});

test('marks each mention instead of stacking on the first', () => {
  const text = 'the control group improved and the control group persisted';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'the control group' },
    { quote: 'the control group' },
  ]);
  assert.equal(ranges.length, 2);
  assert.notEqual(ranges[0].start, ranges[1].start);
});

test('splits a text chunk into plain and marked segments', () => {
  const segments = segmentTextChunk(0, 'alpha beta gamma', [{ start: 6, end: 10, kind: 'number' }]);
  assert.deepEqual(segments.map(segment => segment.type), ['text', 'mark', 'text']);
  assert.equal(segments[1].value, 'beta');
  assert.equal(segments[1].kind, 'number');
});

test('never marks inside a maths chunk', () => {
  const text = 'the value $\\omega_b = 0.02$ was fixed';
  // A quote spanning the equation would otherwise cut the LaTeX in half.
  const plan = buildHighlightPlan(text, [{ quote: 'the value $\\omega_b = 0.02$ was fixed' }]);
  const math = plan.filter(item => item.type === 'math');
  assert.equal(math.length, 1);
  assert.equal(math[0].value, '\\omega_b = 0.02');
  assert.ok(plan.some(item => item.type === 'mark'));
  assert.ok(plan.every(item => item.type !== 'mark' || !item.value.includes('$')));
});

test('keeps maths intact when there are no highlights', () => {
  const plan = buildHighlightPlan('rate $10^{-4}$ per year', []);
  assert.deepEqual(plan.map(item => item.type), ['text', 'math', 'text']);
  assert.equal(plan.filter(item => item.type === 'mark').length, 0);
});

test('a plan concatenates back to the normalized text', () => {
  const text = 'we measured $x$ across 3 sites and found no drift';
  const plan = buildHighlightPlan(text, [{ quote: 'found no drift' }]);
  const rebuilt = plan.map(item => item.type === 'math' ? item.raw : item.value).join('');
  assert.equal(rebuilt, 'we measured $x$ across 3 sites and found no drift');
});

test('builds an anchor from a usable selection only', () => {
  assert.equal(buildSelectionAnchor('ok'), null);
  const anchor = buildSelectionAnchor('  a long enough selection  ');
  assert.equal(anchor.quote, 'a long enough selection');
  assert.equal(anchor.kind, 'user');
});

test('every item carries its span in normalized space', () => {
  const text = 'we measured $x$ across 3 sites and found no drift';
  const plan = buildHighlightPlan(text, [{ quote: 'found no drift' }]);
  // Contiguous and in order: this is what a DOM selection is mapped back onto.
  let cursor = 0;
  for (const item of plan) {
    assert.equal(item.start, cursor);
    assert.equal(item.end, cursor + (item.type === 'math' ? item.raw.length : item.value.length));
    cursor = item.end;
  }
  assert.equal(cursor, 'we measured $x$ across 3 sites and found no drift'.length);
});

test('a highlight that swallows a formula marks the formula too', () => {
  const text = 'the value $\\omega_b = 0.02$ was fixed throughout';
  const plan = buildHighlightPlan(text, [{ quote: 'the value $\\omega_b = 0.02$ was fixed', kind: 'number' }]);
  const math = plan.find(item => item.type === 'math');
  assert.equal(math.kind, 'number');
  // Marked whole, and still handed to KaTeX as valid LaTeX.
  assert.equal(math.value, '\\omega_b = 0.02');
});

test('a highlight that stops inside a formula leaves it unmarked', () => {
  const text = 'the value $\\omega_b = 0.02$ was fixed throughout';
  const plan = buildHighlightPlan(text, [{ quote: 'the value $\\omega' }]);
  const math = plan.find(item => item.type === 'math');
  assert.equal(math.kind, null);
});

test('builds an anchor from offsets when the selected string cannot be trusted', () => {
  const text = 'we measured $x^2$ across three sites';
  // The span of "measured $x^2$ across", counted in the normalized source.
  const start = text.indexOf('measured');
  const anchor = buildRangeAnchor(text, start, text.indexOf(' three'));
  assert.equal(anchor.quote, 'measured $x^2$ across');
  assert.equal(anchor.kind, 'user');
  // And it resolves back onto the same text, which is the whole point.
  const ranges = resolveHighlightRanges(text, [anchor]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, start);
});

test('a range too short to anchor is refused like any other', () => {
  assert.equal(buildRangeAnchor('some paragraph text', 0, 3), null);
  assert.equal(buildRangeAnchor('', 0, 20), null);
});
