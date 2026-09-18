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

test('a quote whose only mention lies under a mark of another source is kept, not dropped', () => {
  const text = 'La idea central es sencilla: quien convive más comparte más microbios, y el mapa se parece.';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'sencilla: quien convive más', kind: 'user', source: 'user' },
    { quote: 'quien convive más comparte más microbios', kind: 'finding', source: 'ai' },
  ]);
  assert.equal(ranges.length, 2, 'both survive: they belong to different sources');
  assert.deepEqual(ranges.map(range => range.source), ['user', 'ai']);
});

test('a repeated quote of the same source still moves on to the next mention, and is dropped when none is free', () => {
  const text = 'the control group improved and the control group persisted';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'the control group', source: 'ai' },
    { quote: 'the control group', source: 'ai' },
    { quote: 'the control group', source: 'ai' },
  ]);
  assert.equal(ranges.length, 2);
});

test('a pending selection may sit on top of anything, including the reader\'s own saved mark', () => {
  const text = 'quien convive más comparte más microbios, y el mapa de amistades se parece';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'quien convive más comparte más', kind: 'user', source: 'user', id: 'saved' },
    { quote: 'quien convive más comparte más', kind: 'user', source: 'user', id: 'pending', pending: true },
  ]);
  assert.equal(ranges.length, 2);
});

test('overlapping marks are cut at every boundary, the reader\'s on top and the model\'s remembered underneath', () => {
  // user: 4..14, ai: 10..20 over 'abcdefghijklmnopqrstuv'
  const segments = segmentTextChunk(0, 'abcdefghijklmnopqrstuv', [
    { start: 4, end: 14, kind: 'user', source: 'user', id: 'u' },
    { start: 10, end: 20, kind: 'finding', source: 'ai', id: 'a' },
  ]);
  assert.deepEqual(segments.map(s => [s.type, s.value, s.source || null, s.under || null]), [
    ['text', 'abcd', null, null],
    ['mark', 'efghij', 'user', []],
    ['mark', 'klmn', 'user', ['ai']],
    ['mark', 'opqrst', 'ai', []],
    ['text', 'uv', null, null],
  ]);
  // The reader's mark wins the top even when the model's range started first.
  const reversed = segmentTextChunk(0, 'abcdefghijklmnopqrstuv', [
    { start: 4, end: 14, kind: 'finding', source: 'ai', id: 'a' },
    { start: 10, end: 20, kind: 'user', source: 'user', id: 'u' },
  ]);
  assert.deepEqual(reversed.map(s => [s.value, s.source, s.under]), [
    ['abcd', undefined, undefined],
    ['efghij', 'ai', []],
    ['klmn', 'user', ['ai']],
    ['opqrst', 'user', []],
    ['uv', undefined, undefined],
  ]);
});

test('a plan with overlapping marks still concatenates back to the text and carries `under` on maths', () => {
  const text = 'usan una fórmula $S = 1$ entre pares y la comparan';
  const plan = buildHighlightPlan(text, [
    { quote: 'una fórmula $S = 1$ entre', kind: 'finding', source: 'ai' },
    { quote: 'fórmula $S = 1$ entre pares', kind: 'user', source: 'user', pending: true },
  ]);
  const rebuilt = plan.map(item => item.type === 'math' ? item.raw : item.value).join('');
  assert.equal(rebuilt, 'usan una fórmula $S = 1$ entre pares y la comparan');
  const math = plan.find(item => item.type === 'math');
  assert.equal(math.source, 'user', 'the pending selection paints the formula');
  assert.deepEqual(math.under, ['ai']);
  assert.ok(plan.every(item => item.type === 'text' || Array.isArray(item.under)));
});
