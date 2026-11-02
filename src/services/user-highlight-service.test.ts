import type { Firestore, CollectionReference, Query, QueryConstraint, QueryFieldFilterConstraint, QueryLimitConstraint, FieldPath, WhereFilterOp } from 'firebase/firestore';
type MockCollection = CollectionReference & { kind: string; segments: string[] };
type MockQuery = Query & { kind: string; source: Query; constraints: (QueryConstraint & { kind: string })[] };
type MockFilter = QueryFieldFilterConstraint & { kind: string; field: string | FieldPath; operator: WhereFilterOp; value: unknown };
type MockLimit = QueryLimitConstraint & { kind: string; count: number };
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ScientificText from '../components/scientific-text.ts';
import { annotationMarkdown } from '../utils/annotation-markdown.ts';
import {
  buildHighlightId,
  buildHighlightsQuery,
  indexHighlightsByParagraph,
  listUserHighlights,
  MAX_HIGHLIGHTS_PER_PAPER,
  normalizeUserHighlight,
  passageQuote,
  passageSegments,
} from './user-highlight-service.ts';
import { buildRangeAnchor, resolveHighlightRanges } from '../utils/text-highlights.ts';
import { displayProse, normalizeLatexText } from '../utils/latex.ts';

/**
 * Stand-ins for the Firestore builders. They record what the service asked for,
 * which is the whole point of these tests: the bug was not in the result, it was
 * in how many documents had to be billed to produce it.
 */
function fakeFirestore(docs: ReturnType<typeof fakeDoc>[] = []) {
  const calls: { collections: { database: unknown; segments: string[] }[]; filters: { field: string | FieldPath; operator: WhereFilterOp; value: unknown }[]; caps: number[]; reads: unknown[] } = { collections: [], filters: [], caps: [], reads: [] };
  const overrides = {
    database: { tag: 'database' } as Firestore & { tag: string },
    collectionRef: (database: unknown, ...segments: string[]) => {
      calls.collections.push({ database, segments });
      return { kind: 'collection', segments } as MockCollection;
    },
    matching: (field: string | FieldPath, operator: WhereFilterOp, value: unknown) => {
      calls.filters.push({ field, operator, value });
      return { kind: 'where', field, operator, value } as MockFilter;
    },
    cap: (count: number) => {
      calls.caps.push(count);
      return { kind: 'limit', count } as MockLimit;
    },
    composeQuery: (source: Query, ...constraints: (QueryConstraint | import('firebase/firestore').QueryCompositeFilterConstraint)[]) => ({ kind: 'query', source, constraints }) as MockQuery,
    readDocuments: async <T, D extends import('firebase/firestore').DocumentData>(target: Query<T, D>) => {
      calls.reads.push(target);
      return { docs } as import('firebase/firestore').QuerySnapshot<T, D>;
    },
  };
  return { overrides, calls };
}

function fakeDoc(id: string, data: { paperId: string; quote?: string; }) {
  return { id, data: () => data };
}

test('the highlights query filters by paper and caps server-side', () => {
  const { overrides, calls } = fakeFirestore();
  const built = buildHighlightsQuery('uid-1', 'paper-7', overrides) as MockQuery;

  assert.deepEqual(calls.collections[0].segments, ['users', 'uid-1', 'highlights']);
  assert.deepEqual(calls.filters, [{ field: 'paperId', operator: '==', value: 'paper-7' }]);
  assert.deepEqual(calls.caps, [MAX_HIGHLIGHTS_PER_PAPER]);
  assert.equal(built.kind, 'query');
  assert.deepEqual(built.constraints.map(item => item.kind), ['where', 'limit']);
});

test('reading highlights goes through the query, never the bare collection', async () => {
  const { overrides, calls } = fakeFirestore([
    fakeDoc('h1', { paperId: 'paper-7', quote: 'first' }),
  ]);

  const rows = await listUserHighlights('uid-1', 'paper-7', overrides);

  assert.equal(calls.reads.length, 1);
  // A collection reference reaching `getDocs` is the original bug: every
  // highlight the account owns, billed to show the ones on screen.
  assert.equal((calls.reads[0] as MockQuery).kind, 'query');
  assert.deepEqual(rows, [{ id: 'h1', paperId: 'paper-7', quote: 'first' }]);
});

test('the paper id is trimmed before it becomes the filter', async () => {
  const { overrides, calls } = fakeFirestore();
  await listUserHighlights('uid-1', '  paper-7  ', overrides);
  assert.deepEqual(calls.filters, [{ field: 'paperId', operator: '==', value: 'paper-7' }]);
});

test('no paper means no read at all rather than the whole collection', async () => {
  const { overrides, calls } = fakeFirestore([fakeDoc('h1', { paperId: 'other' })]);

  assert.deepEqual(await listUserHighlights('uid-1', '', overrides), []);
  assert.deepEqual(await listUserHighlights('uid-1', '   ', overrides), []);
  assert.deepEqual(await listUserHighlights('uid-1', undefined, overrides), []);
  assert.equal(calls.reads.length, 0);
});

test('an anonymous reader never touches Firestore', async () => {
  const { overrides, calls } = fakeFirestore();
  assert.deepEqual(await listUserHighlights('', 'paper-7', overrides), []);
  assert.equal(calls.reads.length, 0);
});

test('a failed read degrades to no highlights instead of throwing', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { overrides } = fakeFirestore();
  overrides.readDocuments = async () => { throw new Error('offline'); };

  assert.deepEqual(await listUserHighlights('uid-1', 'paper-7', overrides), []);
});

const SPAN = {
  paperId: 'arxiv:2401.00001',
  level: 'university',
  language: 'en',
  sectionId: 'intro',
  paragraphIndex: 1,
  quote: 'small errors pile up',
  paperTitle: 'A paper',
};

test('a passage across paragraphs keeps where it ends', () => {
  const stored = normalizeUserHighlight({ ...SPAN, endParagraphIndex: 3, endQuote: 'by the fifth turn' });
  assert.equal(stored?.endParagraphIndex, 3);
  assert.equal(stored?.endQuote, 'by the fifth turn');

  const backwards = normalizeUserHighlight({ ...SPAN, endParagraphIndex: 1, endQuote: 'by the fifth turn' });
  assert.equal(backwards && 'endParagraphIndex' in backwards, false);
  const noEndQuote = normalizeUserHighlight({ ...SPAN, endParagraphIndex: 3 });
  assert.equal(noEndQuote && 'endParagraphIndex' in noEndQuote, false);
});

// A font command the paragraph keeps (its removal would change a formula) must
// stay in the stored quote: unwrapped on its own, the quote no longer occurs.
test('a selection over a font command the paragraph keeps still marks after it is saved', () => {
  for (const paragraph of [
    'cost $5 and \\textbf{$10} rebate for every buyer',
    'intro \\[ \\textbf{x \\] rest} tail of it',
    'cost $ \\textbf{b $ c} end of the sentence here',
    'a \\textbf{bold} word, cost $5 and \\textbf{$10} rebate for every buyer',
  ]) {
    const normalized = normalizeLatexText(paragraph);
    const start = normalized.indexOf('\\textbf{');
    assert.notEqual(start, -1, paragraph);
    const anchor = buildRangeAnchor(paragraph, start, normalized.length);
    const stored = normalizeUserHighlight({ ...SPAN, quote: anchor?.quote });
    assert.equal(stored?.quote, anchor?.quote, paragraph);
    for (const highlight of [{ quote: anchor?.quote, pending: true }, { quote: stored?.quote, source: 'user' }]) {
      const ranges = resolveHighlightRanges(paragraph, [highlight]);
      assert.deepEqual(ranges.map(range => [range.start, range.end]), [[start, normalized.length]], paragraph);
    }
  }
  // The same passage as a quote saved before this change.
  const ranges = resolveHighlightRanges('cost $5 and \\textbf{$10} rebate for every buyer', [{ quote: '\\textbf{$10} rebate for every', source: 'user' }]);
  assert.equal(ranges.length, 1);
});

// Unwrapping a font command with a space inside its braces next to a space
// outside left two in the paragraph, and the stored quote, which collapses
// them, then matched nothing: the keyboard marks the whole paragraph.
test('a whole paragraph with a spaced font command still marks after it is saved', () => {
  for (const paragraph of [
    '\\textbf{Keywords:} \\emph{ deep learning}, robotics and control',
    'We compare the \\textit{in vivo } and in vitro results here',
    'an empty \\emph{} wrapper between spaces in a sentence',
    'a \\textbf{ \\emph{ nested } } word inside a sentence',
  ]) {
    const normalized = normalizeLatexText(paragraph);
    const anchor = buildRangeAnchor(paragraph, 0, normalized.length);
    const stored = normalizeUserHighlight({ ...SPAN, quote: anchor?.quote });
    for (const highlight of [{ quote: anchor?.quote, pending: true }, { quote: stored?.quote, source: 'user' }]) {
      const ranges = resolveHighlightRanges(paragraph, [highlight]);
      assert.deepEqual(ranges.map(range => [range.start, range.end]), [[0, normalized.length]], paragraph);
    }
  }
});

// Font commands that paint nothing sit beside the words a reader sees. A quote
// that took them along passed the 400 characters a quote is stored at, and the
// cut left only them: the highlight was saved and never painted.
test('a selection beside font commands that paint nothing still marks after it is saved', () => {
  const empty = '\\emph{}'.repeat(60);
  for (const [paragraph, words] of [
    [`prefix ${empty} \\textbf{selected words} suffix`, 'selected words'],
    [`prefix \\textbf{${empty} selected words} suffix`, 'selected words'],
    [`prefix \\textbf{${empty}selected words${empty}} suffix`, 'selected words'],
    [`prefix \\textbf{selected words} ${empty} suffix`, 'selected words'],
    // The keyboard marks a whole paragraph.
    [`${empty} selected words and more`, 'selected words and more'],
    [`selected words and more ${empty}`, 'selected words and more'],
  ]) {
    const start = normalizeLatexText(paragraph).indexOf(words);
    const anchor = buildRangeAnchor(paragraph, start, start + words.length);
    const stored = normalizeUserHighlight({ ...SPAN, quote: anchor?.quote });
    assert.equal(stored?.quote, anchor?.quote, paragraph);
    assert.deepEqual(
      resolveHighlightRanges(paragraph, [{ quote: stored?.quote, source: 'user' }]).map(range => [range.start, range.end]),
      [[start, start + words.length]],
      paragraph,
    );
  }
});

// The id is a fingerprint of the quote, so selecting again a passage saved on
// main must store the quote main stored, or it writes a second document.
test('selecting again a passage saved with a font command keeps its id', () => {
  const paragraph = 'a \\textbf{HERMES} harness for agents';
  const saved = normalizeUserHighlight({ ...SPAN, quote: '\\textbf{HERMES} harness' });
  const start = normalizeLatexText(paragraph).indexOf('HERMES');
  const again = normalizeUserHighlight({ ...SPAN, quote: buildRangeAnchor(paragraph, start, start + 'HERMES harness'.length)?.quote });
  assert.equal(buildHighlightId(again!), buildHighlightId(saved!));
});

test('a passage inside one paragraph keeps the id it always had', () => {
  assert.equal(buildHighlightId(SPAN), buildHighlightId({ ...SPAN, endParagraphIndex: undefined }));
  assert.notEqual(buildHighlightId(SPAN), buildHighlightId({ ...SPAN, endParagraphIndex: 3, endQuote: 'by the fifth turn' }));
});

test('a passage across paragraphs marks the end of the first, every middle one whole, and the start of the last', () => {
  const texts: Record<number, string> = { 2: 'The middle paragraph, whole.' };
  const passage = { ...SPAN, endParagraphIndex: 3, endQuote: 'by the fifth turn' };
  assert.deepEqual(passageSegments(passage, (_, index) => texts[index] ?? null), [
    { paragraphIndex: 1, quote: 'small errors pile up' },
    { paragraphIndex: 2, quote: 'The middle paragraph, whole.' },
    { paragraphIndex: 3, quote: 'by the fifth turn' },
  ]);

  const index = indexHighlightsByParagraph([{ ...passage, id: 'h1', kind: 'user' }], { paragraphText: (_, i) => texts[i] ?? null });
  assert.deepEqual([...index.keys()], ['intro:1', 'intro:2', 'intro:3']);
  assert.equal(index.get('intro:3')?.[0].id, 'h1');
});

test('the card and the copied note show where a passage ends', () => {
  assert.equal(passageQuote({ quote: 'small errors pile up' }), 'small errors pile up');
  assert.equal(passageQuote({ quote: 'small errors pile up', endQuote: 'by the fifth turn' }), 'small errors pile up … by the fifth turn');
});

/** What the margin prints for a stored passage: `passageQuote`, painted as the card paints prose. */
function marginText(passage: Parameters<typeof passageQuote>[0]) {
  const html = renderToStaticMarkup(createElement(ScientificText, null, passageQuote(passage)));
  return html.replace(/^<span class="scientific-text">/, '').replace(/<\/span>$/, '');
}

// The quote is the slice of the saved text a selection covers, so a selection
// that starts or ends inside a font command is stored with the brace or the
// command it cut. The card paints neither; the margin and the copied note
// print the words the card paints, and what is stored stays as it is.
test('the margin and the copied note print the words a selection cut across a font command paints', () => {
  const paragraph = 'We call it a \\textbf{HERMES}, a harness for \\emph{nested \\textbf{agents}} and more, at 12% cost.';
  const painted = normalizeLatexText(paragraph);
  const cases: [string, string][] = [
    ['RMES, a harness', 'RMES}, a harness'],
    ['a harness for neste', 'a harness for \\emph{neste'],
    ['RMES, a harness for neste', 'RMES}, a harness for \\emph{neste'],
    ['S, a harness for nested agents and more, a', 'S}, a harness for \\emph{nested \\textbf{agents}} and more, a'],
    ['ested agents and more, at 12\\% cost.', 'ested \\textbf{agents}} and more, at 12\\% cost.'],
    ['nested agen', 'nested \\textbf{agen'],
    ['HERMES, a harness', '\\textbf{HERMES}, a harness'],
  ];
  for (const [words, quote] of cases) {
    const start = painted.indexOf(words);
    assert.notEqual(start, -1, words);
    const stored = normalizeUserHighlight({ ...SPAN, quote: buildRangeAnchor(paragraph, start, start + words.length)?.quote });
    assert.ok(stored, words);
    assert.equal(stored.quote, quote);
    assert.deepEqual(
      resolveHighlightRanges(paragraph, [{ quote: stored.quote, source: 'user' }]).map(range => [range.start, range.end]),
      [[start, start + words.length]],
      words,
    );
    assert.equal(passageQuote(stored), words);
    assert.equal(marginText(stored), displayProse(words));
    assert.equal(annotationMarkdown({ quote: passageQuote(stored) }), `> *${words}*`);
  }
});

test('every font command a selection cuts across is gone from the margin, whichever way it cuts', () => {
  for (const command of ['textbf', 'textit', 'textsl', 'textsc', 'textrm', 'textsf', 'textup', 'texttt', 'emph']) {
    const paragraph = `We use the \\${command}{agent harness} for tasks.`;
    const painted = normalizeLatexText(paragraph);
    for (const [words, quote] of [
      ['harness for tasks.', 'harness} for tasks.'],
      ['We use the agent', `We use the \\${command}{agent`],
      ['use the agent harness for', `use the \\${command}{agent harness} for`],
    ]) {
      const start = painted.indexOf(words);
      const stored = normalizeUserHighlight({ ...SPAN, quote: buildRangeAnchor(paragraph, start, start + words.length)?.quote });
      assert.ok(stored, words);
      assert.equal(stored.quote, quote);
      assert.equal(passageQuote(stored), words, command);
    }
  }
});

test('a passage across paragraphs prints each end as painted', () => {
  const first = 'We use the \\textbf{agent harness} for tasks';
  const last = 'We then \\emph{test the agents} again';
  const start = buildRangeAnchor(first, normalizeLatexText(first).indexOf('harness'), normalizeLatexText(first).length);
  const end = buildRangeAnchor(last, 0, normalizeLatexText(last).indexOf('agents') - 1);
  assert.equal(start?.quote, 'harness} for tasks');
  assert.equal(end?.quote, 'We then \\emph{test the');
  const stored = normalizeUserHighlight({ ...SPAN, quote: start?.quote, endParagraphIndex: 3, endQuote: end?.quote });
  assert.ok(stored);
  assert.equal(passageQuote(stored), 'harness for tasks … We then test the');
  assert.equal(marginText(stored), 'harness for tasks … We then test the');
  assert.equal(annotationMarkdown({ quote: passageQuote(stored), note: 'Why?' }), '> *harness for tasks … We then test the*\n\nWhy?');
});

// A quote is stored at 400 characters, which can end inside a font command:
// after its opener, or inside its name.
test('a passage stored at 400 characters prints the words painted before the cut', () => {
  for (let cut = 1; cut <= 13; cut += 1) {
    const filler = `${'x'.repeat(399 - cut)} `;
    const paragraph = `${filler}\\textbf{beta} and the rest of the sentence goes on`;
    const stored = normalizeUserHighlight({ ...SPAN, quote: buildRangeAnchor(paragraph, 0, normalizeLatexText(paragraph).length)?.quote });
    assert.ok(stored, String(cut));
    assert.equal(stored.quote.length, 400);
    assert.equal(passageQuote(stored), cut > 8 ? `${filler}${'beta'.slice(0, cut - 8)}` : filler.trim(), String(cut));
  }
});

test('braces that belong to the text stay in the margin', () => {
  for (const [quote, words] of [
    ['the set {a, b} has two members', 'the set {a, b} has two members'],
    ['the braces \\{ and \\} are text', 'the braces \\{ and \\} are text'],
    ['a line break \\\\ and \\textit{ \\emph{done} } here', 'a line break \\\\ and done here'],
    ['an open brace { stays too', 'an open brace { stays too'],
  ]) {
    assert.equal(passageQuote({ quote }), words, quote);
  }
});
