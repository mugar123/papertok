import type { Firestore, CollectionReference, Query, QueryConstraint, QueryFieldFilterConstraint, QueryLimitConstraint, FieldPath, WhereFilterOp } from 'firebase/firestore';
type MockCollection = CollectionReference & { kind: string; segments: string[] };
type MockQuery = Query & { kind: string; source: Query; constraints: (QueryConstraint & { kind: string })[] };
type MockFilter = QueryFieldFilterConstraint & { kind: string; field: string | FieldPath; operator: WhereFilterOp; value: unknown };
type MockLimit = QueryLimitConstraint & { kind: string; count: number };
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHighlightsQuery,
  listUserHighlights,
  MAX_HIGHLIGHTS_PER_PAPER,
} from './userHighlightService.ts';

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
