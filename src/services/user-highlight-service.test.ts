import type { Firestore, CollectionReference, Query, QueryConstraint, QueryFieldFilterConstraint, QueryLimitConstraint, FieldPath, WhereFilterOp } from 'firebase/firestore';
type MockCollection = CollectionReference & { kind: string; segments: string[] };
type MockQuery = Query & { kind: string; source: Query; constraints: (QueryConstraint & { kind: string })[] };
type MockFilter = QueryFieldFilterConstraint & { kind: string; field: string | FieldPath; operator: WhereFilterOp; value: unknown };
type MockLimit = QueryLimitConstraint & { kind: string; count: number };
import test from 'node:test';
import assert from 'node:assert/strict';
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
import { normalizeLatexText } from '../utils/latex.ts';

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
