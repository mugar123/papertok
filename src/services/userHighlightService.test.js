import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHighlightsQuery,
  listUserHighlights,
  MAX_HIGHLIGHTS_PER_PAPER,
} from './userHighlightService.js';

/**
 * Stand-ins for the Firestore builders. They record what the service asked for,
 * which is the whole point of these tests: the bug was not in the result, it was
 * in how many documents had to be billed to produce it.
 */
function fakeFirestore(docs = []) {
  const calls = { collections: [], filters: [], caps: [], reads: [] };
  const overrides = {
    database: { tag: 'database' },
    collectionRef: (database, ...segments) => {
      calls.collections.push({ database, segments });
      return { kind: 'collection', segments };
    },
    matching: (field, operator, value) => {
      calls.filters.push({ field, operator, value });
      return { kind: 'where', field, operator, value };
    },
    cap: (count) => {
      calls.caps.push(count);
      return { kind: 'limit', count };
    },
    composeQuery: (source, ...constraints) => ({ kind: 'query', source, constraints }),
    readDocuments: async (target) => {
      calls.reads.push(target);
      return { docs };
    },
  };
  return { overrides, calls };
}

function fakeDoc(id, data) {
  return { id, data: () => data };
}

test('the highlights query filters by paper and caps server-side', () => {
  const { overrides, calls } = fakeFirestore();
  const built = buildHighlightsQuery('uid-1', 'paper-7', overrides);

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
  assert.equal(calls.reads[0].kind, 'query');
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
