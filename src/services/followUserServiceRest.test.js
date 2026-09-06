import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_PAGE_SIZE,
  readFollowedUsersPage,
  readFollowersPage,
} from './followUserService.js';

/**
 * The page reader itself, over REST — the default behind `readEdgePage`,
 * which followUserService.test.js always swaps out. The api is built by hand
 * here so that default is the thing under test, with only the network faked.
 */

const ME = 'alice-uid';
const OTHER = 'bob-uid';

function fakeRest(rows) {
  const queries = [];
  return {
    queries,
    rest: {
      async runQuery(structuredQuery, options = {}) {
        queries.push({ structuredQuery, signal: options.signal ?? null });
        return rows;
      },
    },
  };
}

function restApi(rest) {
  return { database: 'db', currentUser: null, isDemo: false, rest };
}

/** A row exactly as `firestoreRest.runQuery` hands it back. */
function edgeRow(follower, target, stamp) {
  return {
    id: `${follower}_${target}`,
    name: `projects/p/databases/(default)/documents/follows/${follower}_${target}`,
    fields: {
      followerUid: { stringValue: follower },
      targetUid: { stringValue: target },
      createdAt: { timestampValue: stamp },
    },
    data: { followerUid: follower, targetUid: target, createdAt: new Date(stamp) },
  };
}

test('a follower page is one query for the side of the edge, newest first, under the ceiling', async () => {
  const { queries, rest } = fakeRest([edgeRow('alice-uid', 'bob-uid', '2026-08-20T22:00:36.679Z')]);

  const page = await readFollowersPage(OTHER, {}, restApi(rest));

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].structuredQuery, {
    from: [{ collectionId: 'follows' }],
    where: { fieldFilter: { field: { fieldPath: 'targetUid' }, op: 'EQUAL', value: { stringValue: 'bob-uid' } } },
    orderBy: [
      { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
    ],
    limit: FOLLOW_PAGE_SIZE,
  });
  assert.deepEqual(page.edges, [{ uid: 'alice-uid', createdAt: new Date('2026-08-20T22:00:36.679Z') }]);
  assert.equal(page.hasMore, false);
  assert.equal(page.cursor, null);
});

test('the following page reads the other end, from the follower side', async () => {
  const { queries, rest } = fakeRest([edgeRow('alice-uid', 'carol-uid', '2026-08-21T10:00:00Z')]);

  const page = await readFollowedUsersPage(ME, {}, restApi(rest));

  assert.deepEqual(queries[0].structuredQuery.where, {
    fieldFilter: { field: { fieldPath: 'followerUid' }, op: 'EQUAL', value: { stringValue: 'alice-uid' } },
  });
  assert.deepEqual(page.edges.map(edge => edge.uid), ['carol-uid']);
});

test('a full page\'s cursor is its last row, and the next page starts strictly after it', async () => {
  const rows = Array.from({ length: FOLLOW_PAGE_SIZE }, (unused, index) => (
    edgeRow(`f${index}`, 'bob-uid', `2026-08-${String(30 - (index % 28)).padStart(2, '0')}T00:00:00Z`)
  ));
  const last = rows[FOLLOW_PAGE_SIZE - 1];
  const { queries, rest } = fakeRest(rows);

  const first = await readFollowersPage(OTHER, {}, restApi(rest));
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.cursor, {
    createdAt: { timestampValue: last.fields.createdAt.timestampValue },
    name: last.name,
  });

  await readFollowersPage(OTHER, { cursor: first.cursor }, restApi(rest));
  assert.deepEqual(queries[1].structuredQuery.startAt, {
    values: [
      { timestampValue: last.fields.createdAt.timestampValue },
      { referenceValue: last.name },
    ],
    before: false,
  });
  assert.equal(queries[1].structuredQuery.limit, FOLLOW_PAGE_SIZE);
});

test('a page with no cursor sends no startAt at all', async () => {
  const { queries, rest } = fakeRest([]);

  await readFollowersPage(OTHER, { cursor: null }, restApi(rest));

  assert.equal('startAt' in queries[0].structuredQuery, false);
});

test('the caller\'s signal reaches the request, so a closed sheet ends the read', async () => {
  const { queries, rest } = fakeRest([]);
  const controller = new AbortController();

  await readFollowersPage(OTHER, { signal: controller.signal }, restApi(rest));

  assert.equal(queries[0].signal, controller.signal);
});
