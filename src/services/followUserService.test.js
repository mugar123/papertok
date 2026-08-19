import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FOLLOW_COUNT_CAP,
  FOLLOW_PAGE_SIZE,
  FollowUnsupportedError,
  SelfFollowError,
  countFollowedUsers,
  countFollowers,
  followEdgeId,
  followUser,
  isFollowing,
  readFollowedUsersPage,
  readFollowersPage,
  unfollowUser,
} from './followUserService.js';

const ME = 'alice-uid';
const OTHER = 'bob-uid';

function denied() {
  const error = new Error('denied');
  error.code = 'permission-denied';
  return error;
}

function snapshot(data) {
  return { exists: () => data != null, data: () => data };
}

/**
 * Records every Firestore access the service makes, whatever the test swapped
 * in behind it — the recording wraps the override rather than being replaced by
 * it, because half of what these tests assert is *how many* accesses happened.
 */
function fakeApi(overrides = {}) {
  const calls = [];
  const record = (label, pick, implementation) => async (...args) => {
    calls.push([label, ...pick(args)]);
    return implementation(...args);
  };
  const merged = {
    getDocument: async () => snapshot(null),
    setDocument: async () => {},
    deleteDocument: async () => {},
    countEdges: async () => 0,
    readEdgePage: async () => [],
    ...overrides,
  };

  return {
    calls,
    api: {
      database: 'db',
      currentUser: { uid: ME },
      isDemo: false,
      document: (...parts) => parts.join('/'),
      now: () => 'SERVER_TIME',
      ...overrides,
      getDocument: record('get', ([reference]) => [reference], merged.getDocument),
      setDocument: record('set', args => args, merged.setDocument),
      deleteDocument: record('delete', ([reference]) => [reference], merged.deleteDocument),
      countEdges: record('count', ([, field, uid]) => [field, uid], merged.countEdges),
      readEdgePage: record(
        'page',
        ([, field, uid, pageSize, cursor]) => [field, uid, pageSize, cursor ?? null],
        merged.readEdgePage,
      ),
    },
  };
}

// --- the edge id is the design -------------------------------------------

test('the edge id is the follower, the separator, and the target', () => {
  assert.equal(followEdgeId(ME, OTHER), 'alice-uid_bob-uid');
});

test('a uid carrying the separator gets no edge id at all', () => {
  // `{follower}_{target}` only parses back to one pair while no uid contains
  // `_`. firestore.rules refuses those uids for the same reason.
  assert.equal(followEdgeId('a_b', OTHER), '');
  assert.equal(followEdgeId(ME, 'b_c'), '');
  assert.equal(followEdgeId('', OTHER), '');
});

// --- following ------------------------------------------------------------

test('following writes exactly one edge, and its body agrees with its id', async () => {
  const { api, calls } = fakeApi();
  const result = await followUser(OTHER, api);

  assert.deepEqual(result, { following: true, changed: true });
  assert.equal(calls.length, 1);
  const [kind, reference, data] = calls[0];
  assert.equal(kind, 'set');
  assert.equal(reference, 'db/follows/alice-uid_bob-uid');
  assert.deepEqual(data, { followerUid: ME, targetUid: OTHER, createdAt: 'SERVER_TIME' });
});

test('an account cannot follow itself', async () => {
  const { api, calls } = fakeApi();
  await assert.rejects(() => followUser(ME, api), SelfFollowError);
  assert.deepEqual(calls, [], 'a self-follow must not reach Firestore either');
});

test('following twice writes one edge and reports the state, not an error', async () => {
  // The rules answer the second write with permission-denied, because an edge
  // has no mutable state. That is the state the caller asked for, so it is not
  // a failure — but only once a read confirms whose edge it is.
  const { api, calls } = fakeApi({
    setDocument: async () => { throw denied(); },
    getDocument: async () => snapshot({ followerUid: ME, targetUid: OTHER }),
  });

  const result = await followUser(OTHER, api);
  assert.deepEqual(result, { following: true, changed: false });
  // One rejected write, one read to find out why, and no second edge: the
  // composite id means there is nowhere for a duplicate to go.
  assert.deepEqual(calls.map(([kind]) => kind), ['set', 'get']);
});

test('a denial that is not an existing edge of mine still fails', async () => {
  const { api } = fakeApi({
    setDocument: async () => { throw denied(); },
    getDocument: async () => snapshot(null),
  });
  await assert.rejects(() => followUser(OTHER, api), { code: 'permission-denied' });
});

test('a denial over somebody else\'s edge is never swallowed', async () => {
  const { api } = fakeApi({
    setDocument: async () => { throw denied(); },
    getDocument: async () => snapshot({ followerUid: 'carol-uid', targetUid: OTHER }),
  });
  await assert.rejects(() => followUser(OTHER, api), { code: 'permission-denied' });
});

test('a failure that is not a denial is reported as itself', async () => {
  const { api } = fakeApi({
    setDocument: async () => { throw new Error('offline'); },
  });
  await assert.rejects(() => followUser(OTHER, api), /offline/);
});

// --- unfollowing ----------------------------------------------------------

test('unfollowing deletes the edge by id, with no query', async () => {
  const { api, calls } = fakeApi();
  const result = await unfollowUser(OTHER, api);
  assert.deepEqual(result, { following: false, changed: true });
  assert.deepEqual(calls, [['delete', 'db/follows/alice-uid_bob-uid']]);
});

test('unfollowing something already unfollowed is a no-op, not an error', async () => {
  const { api } = fakeApi({
    deleteDocument: async () => { throw denied(); },
    getDocument: async () => snapshot(null),
  });
  assert.deepEqual(await unfollowUser(OTHER, api), { following: false, changed: false });
});

test('a denied delete of an edge that IS there stays a failure', async () => {
  const { api } = fakeApi({
    deleteDocument: async () => { throw denied(); },
    getDocument: async () => snapshot({ followerUid: 'carol-uid', targetUid: OTHER }),
  });
  await assert.rejects(() => unfollowUser(OTHER, api), { code: 'permission-denied' });
});

// --- the follow-state read ------------------------------------------------

test('the follow state is one read, and free for a visitor with no session', async () => {
  const { api, calls } = fakeApi({ getDocument: async () => snapshot({ followerUid: ME }) });
  assert.equal(await isFollowing(OTHER, api), true);
  assert.equal(calls.length, 1);

  const anonymous = fakeApi({ currentUser: null });
  assert.equal(await isFollowing(OTHER, anonymous.api), false);
  assert.deepEqual(anonymous.calls, [], 'a signed-out visitor must not spend a read');

  const self = fakeApi();
  assert.equal(await isFollowing(ME, self.api), false);
  assert.deepEqual(self.calls, [], 'nobody follows themselves, so nothing to ask');
});

// --- counters -------------------------------------------------------------

test('a follower counter is one capped aggregation, never a collection read', async () => {
  const { api, calls } = fakeApi({ countEdges: async () => 7 });
  assert.deepEqual(await countFollowers(OTHER, api), { count: 7, capped: false });
  assert.deepEqual(calls, [['count', 'targetUid', OTHER]]);

  const followed = fakeApi({ countEdges: async () => 3 });
  assert.deepEqual(await countFollowedUsers(ME, followed.api), { count: 3, capped: false });
  assert.deepEqual(followed.calls, [['count', 'followerUid', ME]]);
});

test('past the cap the counter says so instead of lying', async () => {
  const { api } = fakeApi({ countEdges: async () => FOLLOW_COUNT_CAP });
  assert.deepEqual(await countFollowers(OTHER, api), { count: FOLLOW_COUNT_CAP, capped: true });
});

test('the cap is exactly the aggregation billing unit', () => {
  // Firestore bills count() as one read per 1000 index entries. The cap is
  // 1000 so a counter costs one read whatever the graph does, and
  // firestore.rules rejects any query on follows asking for more.
  assert.equal(FOLLOW_COUNT_CAP, 1000);
});

test('an unreadable uid costs nothing at all', async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await countFollowers('', api), { count: 0, capped: false });
  assert.deepEqual(await countFollowedUsers('nope_nope', api), { count: 0, capped: false });
  assert.deepEqual(calls, []);
});

// --- paging ---------------------------------------------------------------

test('a follower page is bounded, and asks for the side of the edge it needs', async () => {
  const rows = [
    { id: 'x_y', data: { followerUid: 'carol-uid', targetUid: OTHER }, cursor: 'CURSOR_1' },
  ];
  const { api, calls } = fakeApi({ readEdgePage: async () => rows });

  const page = await readFollowersPage(OTHER, {}, api);
  assert.deepEqual(page.edges, [{ uid: 'carol-uid', createdAt: null }]);
  assert.equal(page.hasMore, false, 'a short page is the end of the list');
  assert.equal(page.cursor, null);
  assert.deepEqual(calls[0], ['page', 'targetUid', OTHER, FOLLOW_PAGE_SIZE, null]);
});

test('a full page hands back the cursor of its last row', async () => {
  const rows = Array.from({ length: FOLLOW_PAGE_SIZE }, (unused, index) => ({
    id: `f${index}_${OTHER}`,
    data: { followerUid: `follower${index}`, targetUid: OTHER },
    cursor: `CURSOR_${index}`,
  }));
  const { api } = fakeApi({ readEdgePage: async () => rows });

  const page = await readFollowersPage(OTHER, {}, api);
  assert.equal(page.edges.length, FOLLOW_PAGE_SIZE);
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, `CURSOR_${FOLLOW_PAGE_SIZE - 1}`);
});

test('a caller cannot ask for a bigger page than the rules allow', async () => {
  const seen = [];
  const { api } = fakeApi({
    readEdgePage: async (database, field, uid, pageSize) => { seen.push(pageSize); return []; },
  });
  await readFollowersPage(OTHER, { pageSize: 5000 }, api);
  await readFollowedUsersPage(ME, { pageSize: 0 }, api);
  assert.deepEqual(seen, [FOLLOW_PAGE_SIZE, FOLLOW_PAGE_SIZE]);
});

test('the following page reads the other end of the same edge', async () => {
  const rows = [{ id: `${ME}_${OTHER}`, data: { followerUid: ME, targetUid: OTHER }, cursor: 'C' }];
  const { api, calls } = fakeApi({ readEdgePage: async () => rows });

  const page = await readFollowedUsersPage(ME, {}, api);
  assert.deepEqual(page.edges, [{ uid: OTHER, createdAt: null }]);
  assert.deepEqual(calls[0], ['page', 'followerUid', ME, FOLLOW_PAGE_SIZE, null]);
});

test('an over-long page from Firestore is still clamped client-side', async () => {
  const rows = Array.from({ length: 90 }, (unused, index) => ({
    id: `f${index}`, data: { followerUid: `follower${index}`, targetUid: OTHER }, cursor: index,
  }));
  const { api } = fakeApi({ readEdgePage: async () => rows });
  const page = await readFollowersPage(OTHER, {}, api);
  assert.equal(page.edges.length, FOLLOW_PAGE_SIZE);
});

// --- guards ---------------------------------------------------------------

test('every follow operation refuses demo mode', async () => {
  const { api } = fakeApi({ isDemo: true });
  await assert.rejects(() => followUser(OTHER, api), FollowUnsupportedError);
  await assert.rejects(() => unfollowUser(OTHER, api), FollowUnsupportedError);
  await assert.rejects(() => countFollowers(OTHER, api), FollowUnsupportedError);
  await assert.rejects(() => readFollowersPage(OTHER, {}, api), FollowUnsupportedError);
});

test('writing an edge requires a session', async () => {
  const { api } = fakeApi({ currentUser: null });
  await assert.rejects(() => followUser(OTHER, api), /Authentication is required/);
  await assert.rejects(() => unfollowUser(OTHER, api), /Authentication is required/);
});

test('reading counters and pages does NOT require a session', async () => {
  const { api } = fakeApi({ currentUser: null, countEdges: async () => 2 });
  assert.deepEqual(await countFollowers(OTHER, api), { count: 2, capped: false });
  assert.deepEqual((await readFollowersPage(OTHER, {}, api)).edges, []);
});

// --- structural -----------------------------------------------------------

test('SOURCE: no query in this service is issued without a ceiling', async () => {
  const source = await readFile(new URL('./followUserService.js', import.meta.url), 'utf8');
  const queries = source.match(/query\(\s*\n?[\s\S]*?\n\s*\)\)/g) || [];
  assert.ok(queries.length > 0, 'expected at least one query to guard');
  for (const shape of queries) {
    assert.match(shape, /limit\(/, `unbounded query: ${shape}`);
  }
  assert.doesNotMatch(source, /getDocs\((?!query\()/, 'every getDocs goes through a bounded query');
  assert.doesNotMatch(
    source,
    /getCountFromServer\((?!query\()/,
    'every aggregation goes through a bounded query',
  );
});

test('SOURCE: the follow service never touches users/{uid}/following', async () => {
  // That subcollection is authors and topics for the feed. Mixing users into it
  // would put social data on the feed's read path and break its owner-only
  // contract at the same time.
  const source = await readFile(new URL('./followUserService.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /'following'/);
  assert.doesNotMatch(code, /'users'/);
});

test('SOURCE: nothing on the feed path imports the follow service', async () => {
  // The invariant the cost test in interactionProfileLoader.test.js protects,
  // asserted where it can actually be broken: by an import.
  for (const path of [
    '../context/FeedContext.jsx',
    '../components/Feed/FeedContainer.jsx',
    '../components/Feed/PaperCard.jsx',
    '../utils/interactionProfileLoader.js',
    '../services/interactionProfileStore.js',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /followUserService/, `${path} must stay off the follow graph`);
  }
});
