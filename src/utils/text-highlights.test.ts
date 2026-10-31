import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHighlightPlan,
  buildRangeAnchor,
  buildSelectionAnchor,
  resolveHighlightRanges,
  segmentTextChunk,
} from './text-highlights.ts';
import { normalizeLatexText, normalizeSavedLatexText } from './latex.ts';

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
  const segments = segmentTextChunk(0, 'alpha beta gamma', ([{ start: 6, end: 10, kind: 'number' }] as import('./text-highlights.ts').HighlightRange[]));
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
  assert.equal(anchor!.quote, 'a long enough selection');
  assert.equal(anchor!.kind, 'user');
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
  assert.equal(math!.kind, 'number');
  // Marked whole, and still handed to KaTeX as valid LaTeX.
  assert.equal(math!.value, '\\omega_b = 0.02');
});

test('a highlight that stops inside a formula leaves it unmarked', () => {
  const text = 'the value $\\omega_b = 0.02$ was fixed throughout';
  const plan = buildHighlightPlan(text, [{ quote: 'the value $\\omega' }]);
  const math = plan.find(item => item.type === 'math');
  assert.equal(math!.kind, null);
});

test('builds an anchor from offsets when the selected string cannot be trusted', () => {
  const text = 'we measured $x^2$ across three sites';
  // The span of "measured $x^2$ across", counted in the normalized source.
  const start = text.indexOf('measured');
  const anchor = buildRangeAnchor(text, start, text.indexOf(' three'));
  assert.equal(anchor!.quote, 'measured $x^2$ across');
  assert.equal(anchor!.kind, 'user');
  // And it resolves back onto the same text, which is the whole point.
  const ranges = resolveHighlightRanges(text, [anchor!]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, start);
});

// Quotes saved while font commands still showed in the normalized text keep
// their wrapper fragments; they mark the same words in the unwrapped text.
test('a quote saved before font commands were unwrapped still marks its words', () => {
  const text = 'a \\textbf{HERMES} harness and \\emph{nested \\textbf{x}} prose with $y$ after';
  assert.equal(normalizeLatexText(text), 'a HERMES harness and nested x prose with $y$ after');
  const cases: [string, string][] = [
    ['HERMES} harness and', 'HERMES harness and'],
    ['a \\textbf{HERMES', 'a HERMES'],
    ['harness and \\emph{nested \\textbf{x', 'harness and nested x'],
    ['x}} prose with $y$', 'x prose with $y$'],
  ];
  const normalized = normalizeLatexText(text);
  for (const [quote, words] of cases) {
    const ranges = resolveHighlightRanges(text, [{ quote, source: 'user' }]);
    assert.equal(ranges.length, 1, quote);
    assert.equal(normalized.slice(ranges[0].start, ranges[0].end), words);
  }
});

// `\textbf{HERMES}` was long enough to save; its unwrapped words are not.
test('a saved quote of one wrapper whose words fall under the minimum still marks them', () => {
  const text = 'the \\textbf{HERMES} system and more words';
  const ranges = resolveHighlightRanges(text, [{ quote: '\\textbf{HERMES}', source: 'user' }]);
  assert.equal(ranges.length, 1);
  assert.equal(normalizeLatexText(text).slice(ranges[0].start, ranges[0].end), 'HERMES');
  assert.deepEqual(resolveHighlightRanges('the HERMES system', [{ quote: 'HERMES', source: 'user' }]), []);
});

// The saved quote carries the wrapper, so it belongs to the wrapped mention,
// not to an earlier plain one with the same words.
test('a saved quote with a whole font command marks the wrapped mention', () => {
  const text = 'the HERMES harness runs first; then \\textbf{HERMES} harness runs again';
  const normalized = normalizeLatexText(text);
  const start = normalized.lastIndexOf('HERMES harness runs');
  const [range] = resolveHighlightRanges(text, [{ quote: '\\textbf{HERMES} harness runs', source: 'user' }]);
  assert.deepEqual([range.start, range.end], [start, start + 'HERMES harness runs'.length]);
});

// Unwrapped, the first mention reads like the plain one a reader marked on
// main, so a quote is searched in the text it was cut from first.
test('a quote saved before font commands were unwrapped keeps the mention it marked', () => {
  const text = 'the \\textbf{alpha beta} gamma shows up and later alpha beta gamma again';
  const plain = { quote: 'alpha beta gamma', source: 'user', id: 'plain' };
  const wrapped = { quote: '\\textbf{alpha beta} gamma', source: 'user', id: 'wrapped' };
  for (const order of [[plain, wrapped], [wrapped, plain]]) {
    const ranges = resolveHighlightRanges(text, order);
    assert.deepEqual(ranges.map(range => [range.id, range.start, range.end]), [['wrapped', 4, 20], ['plain', 40, 56]]);
  }
  const [range] = resolveHighlightRanges('We call it the \\textbf{HERMES harness}. Later, the HERMES harness runs fast.', [{ quote: 'the HERMES harness', source: 'user' }]);
  assert.deepEqual([range.start, range.end], [38, 56]);
});

// A selection is stored as the slice of that text it covers, wrappers whole
// where it covers them whole, so it marks the mention that was selected.
test('a selection over unwrapped words marks the mention that was selected', () => {
  const text = 'the \\textbf{alpha beta} gamma shows up and later alpha beta gamma again';
  for (const [start, end, quote] of [
    [4, 20, '\\textbf{alpha beta} gamma'],
    [40, 56, 'alpha beta gamma'],
    [10, 20, 'beta} gamma'],
  ] as const) {
    const anchor = buildRangeAnchor(text, start, end);
    assert.equal(anchor?.quote, quote);
    for (const highlight of [{ quote, pending: true }, { quote, source: 'user' }]) {
      const ranges = resolveHighlightRanges(text, [highlight]);
      assert.deepEqual(ranges.map(range => [range.start, range.end]), [[start, end]], quote);
    }
  }
  const nested = 'a \\textbf{\\emph{HERMES}} harness for agents';
  assert.equal(buildRangeAnchor(nested, 2, 16)?.quote, '\\textbf{\\emph{HERMES}} harness');
});

// Each slice that might read as the selection is normalized whole, and every
// start was tried against every end: with 160 empty wrappers either side, a
// selection held the reader's selection handler for seconds.
test('a selection between many removed font commands anchors at once', () => {
  const empty = '\\emph{}'.repeat(160);
  for (const [text, quote] of [
    [`\\textbf{prefix ${empty}} \\textbf{selected words}\\textbf{${empty} suffix}`, '\\textbf{selected words}'],
    // Cut across a wrapper at either end, no slice reads as the selected words.
    [`\\textbf{prefix ${empty}selected} words${empty} suffix`, 'selected} words'],
    [`prefix ${empty} selected \\textbf{words${empty} suffix}`, 'selected \\textbf{words'],
  ]) {
    const start = normalizeLatexText(text).indexOf('selected words');
    const started = performance.now();
    const anchor = buildRangeAnchor(text, start, start + 'selected words'.length);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `took ${elapsed.toFixed(1)} ms`);
    assert.equal(anchor?.quote, quote);
    const [range] = resolveHighlightRanges(text, [{ quote, source: 'user' }]);
    assert.deepEqual([range.start, range.end], [start, start + 'selected words'.length], quote);
  }
});

// A closing brace glued to the wrapper's own closer belongs to the text.
test('a saved quote ending on a font command closer maps onto the wrapped words alone', () => {
  const text = 'x\\emph{ab}} and the rest of it';
  const [range] = resolveHighlightRanges(text, [{ quote: 'x\\emph{ab}', source: 'user' }]);
  assert.equal(normalizeLatexText(text).slice(range.start, range.end), 'xab');
});

// Math alphanumerics and emoji take two UTF-16 units; the offsets are in units.
test('characters outside the BMP before a quote do not shift where it marks', () => {
  for (const text of [
    'The 𝒜 operator yields robust estimates',
    'We study 𝑥 and 😀 with \\textbf{HERMES}, a harness for agents',
    'We study 𝑥 with \\textbf{HERMES}, a harness for agents',
  ]) {
    const normalized = normalizeLatexText(text);
    const whole = buildRangeAnchor(text, 0, normalized.length);
    assert.equal(whole?.quote, normalizeSavedLatexText(text), text);
    const tail = normalized.slice(-16);
    const anchor = buildRangeAnchor(text, normalized.length - 16, normalized.length);
    for (const highlight of [{ quote: anchor?.quote, pending: true }, { quote: anchor?.quote, source: 'user' }]) {
      const [range] = resolveHighlightRanges(text, [highlight]);
      assert.equal(normalized.slice(range.start, range.end), tail, text);
    }
  }
  const text = 'We study 𝑥 with \\textbf{HERMES}, a harness for agents';
  const [range] = resolveHighlightRanges(text, [{ quote: 'harness for agents', source: 'user' }]);
  assert.equal(normalizeLatexText(text).slice(range.start, range.end), 'harness for agents');
});

// A quote that starts on a brace can also match a wrapper's brace earlier on.
test('a quote cut at a plain brace marks the words it was selected on', () => {
  const text = 'The \\textbf{set} is good and the set {S} is good.';
  const normalized = normalizeLatexText(text);
  assert.equal(normalized, 'The set is good and the set {S} is good.');
  const start = normalized.indexOf('} is good');
  const anchor = buildRangeAnchor(text, start, normalized.length);
  assert.equal(anchor?.quote, '} is good.');
  const [range] = resolveHighlightRanges(text, [{ quote: '} is good', source: 'user' }]);
  assert.deepEqual([range.start, range.end], [start, start + '} is good'.length]);
  // A wrapper the paragraph keeps as written still resolves by its own words.
  const kept = 'intro \\[ \\textbf{x \\] rest} tail and more words';
  const [rest] = resolveHighlightRanges(kept, [{ quote: 'x \\] rest} tail', source: 'user' }]);
  assert.ok(rest);
});

test('a range too short to anchor is refused like any other', () => {
  assert.equal(buildRangeAnchor('some paragraph text', 0, 3), null);
  assert.equal(buildRangeAnchor('', 0, 20), null);
});

test('a quote whose only mention lies under a mark of another source is kept, not dropped', () => {
  const text = 'La idea central es sencilla: quien convive más comparte más microbios, y el mapa se parece.';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'sencilla: quien convive más', kind: 'user' as const, source: 'user' },
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
    { quote: 'quien convive más comparte más', kind: 'user' as const, source: 'user', id: 'saved' },
    { quote: 'quien convive más comparte más', kind: 'user' as const, source: 'user', id: 'pending', pending: true },
  ]);
  assert.equal(ranges.length, 2);
});

test('overlapping marks are cut at every boundary, the reader\'s on top and the model\'s remembered underneath', () => {
  // user: 4..14, ai: 10..20 over 'abcdefghijklmnopqrstuv'
  const segments = segmentTextChunk(0, 'abcdefghijklmnopqrstuv', ([
    { start: 4, end: 14, kind: 'user' as const, source: 'user', id: 'u' },
    { start: 10, end: 20, kind: 'finding', source: 'ai', id: 'a' },
  ] as import('./text-highlights.ts').HighlightRange[]));
  assert.deepEqual(segments.map(s => [s.type, s.value, s.source || null, s.under || null]), [
    ['text', 'abcd', null, null],
    ['mark', 'efghij', 'user', []],
    ['mark', 'klmn', 'user', ['ai']],
    ['mark', 'opqrst', 'ai', []],
    ['text', 'uv', null, null],
  ]);
  // The reader's mark wins the top even when the model's range started first.
  const reversed = segmentTextChunk(0, 'abcdefghijklmnopqrstuv', ([
    { start: 4, end: 14, kind: 'finding', source: 'ai', id: 'a' },
    { start: 10, end: 20, kind: 'user' as const, source: 'user', id: 'u' },
  ] as import('./text-highlights.ts').HighlightRange[]));
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
    { quote: 'fórmula $S = 1$ entre pares', kind: 'user' as const, source: 'user', pending: true },
  ]);
  const rebuilt = plan.map(item => item.type === 'math' ? item.raw : item.value).join('');
  assert.equal(rebuilt, 'usan una fórmula $S = 1$ entre pares y la comparan');
  const math = plan.find(item => item.type === 'math');
  assert.equal(math!.source, 'user', 'the pending selection paints the formula');
  assert.deepEqual(math!.under, ['ai']);
  assert.ok(plan.every(item => item.type === 'text' || Array.isArray(item.under)));
});
