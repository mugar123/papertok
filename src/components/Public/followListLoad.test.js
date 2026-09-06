import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RETRY_DELAY_MS } from '../../utils/boundedRead.js';
import { FirestoreRestError } from '../../utils/firestoreRest.js';
import {
  followListCache,
  followRowProfileCache,
  ownProfileCache,
  ownProfileKey,
  readFollowList,
} from '../../utils/profileSessionCaches.js';
import {
  nextWaitingStatus,
  prefetchFollowList,
  readFollowPage,
  resolveRowProfiles,
} from './followListLoad.js';

/**
 * What the follow sheet and the counter's prefetch share: one page of edges
 * as rows, and the account behind each row, delivered one at a time and
 * cached for the tab. The network is faked at the REST client; everything
 * above it is real, including the session caches (cleared per test).
 */

const UID = 'profile-uid';

const EDGE = (follower, target = UID) => ({
  id: `${follower}_${target}`,
  name: `projects/p/databases/(default)/documents/follows/${follower}_${target}`,
  fields: {
    followerUid: { stringValue: follower },
    targetUid: { stringValue: target },
    createdAt: { timestampValue: '2026-08-20T22:00:36.679Z' },
  },
  data: { followerUid: follower, targetUid: target, createdAt: new Date('2026-08-20T22:00:36.679Z') },
});

const PROFILE = (uid) => ({
  exists: true,
  id: uid,
  data: { handle: `h-${uid}`, displayName: `Name ${uid}`, visibility: 'public' },
});

/** The document each uid answers with — a value, an Error to throw, or a queue of those. */
function fakeRest({ pages = [], profiles = {} } = {}) {
  const requests = [];
  const next = (answer) => (Array.isArray(answer) ? answer.shift() : answer);
  return {
    requests,
    rest: {
      async runQuery(structuredQuery, options = {}) {
        requests.push({ kind: 'query', field: structuredQuery.where.fieldFilter.field.fieldPath, signal: options.signal ?? null });
        const answer = next(pages);
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
      async getDocument(path, options = {}) {
        const uid = path.split('/').pop();
        requests.push({ kind: 'get', uid, signal: options.signal ?? null });
        const answer = next(profiles[uid]);
        if (answer instanceof Error) throw answer;
        if (answer === undefined) return { exists: false, id: uid, data: null };
        return answer;
      },
    },
  };
}

const overridesFor = (rest) => ({ rest, currentUser: null, isDemo: false });

function unavailable() {
  return new FirestoreRestError('Firestore could not be reached.', { code: 'unavailable' });
}

/** A hand-cranked clock for `patientRead`, so nothing here waits in real time. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(callback, ms) { const id = nextId; nextId += 1; pending.set(id, { callback, ms }); return id; },
    clearTimer(id) { pending.delete(id); },
    /** Fires the timers armed for `matchMs` (every one when omitted). */
    fire(matchMs) {
      const entries = [...pending.entries()]
        .filter(([, entry]) => matchMs === undefined || entry.ms === matchMs);
      entries.forEach(([id]) => pending.delete(id));
      entries.forEach(([, entry]) => entry.callback());
    },
    get armed() { return pending.size; },
  };
}

const patience = (timers) => ({
  attempts: 2,
  ms: 6000,
  setTimer: timers.setTimer,
  clearTimer: timers.clearTimer,
  checkOffline: () => false,
  subscribeOnline: () => () => {},
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test.beforeEach(() => {
  followListCache.clear();
  followRowProfileCache.clear();
  ownProfileCache.clear();
});

/**
 * The reads are anonymous — no token, so no CORS preflight per request — and
 * the rules open every public profile to that. The one document anonymity
 * cannot read is the reader's own profile while it is private, and that one
 * the tab already holds.
 */
test('the reader\'s own row comes from the own-profile cache, with no request', async () => {
  ownProfileCache.set(ownProfileKey('me'), { profile: { uid: 'me', handle: 'myself', displayName: 'Me' } });
  const { requests, rest } = fakeRest({ profiles: { me: PROFILE('me') } });
  const delivered = [];

  resolveRowProfiles(
    [{ uid: 'me', profile: undefined }],
    { onProfile: (uid, profile) => delivered.push([uid, profile]) },
    { ...overridesFor(rest), currentUser: { uid: 'me' } },
  );
  await tick();

  assert.equal(requests.length, 0);
  assert.deepEqual(delivered, [['me', { uid: 'me', handle: 'myself', displayName: 'Me' }]]);
  assert.equal(followRowProfileCache.get('me').handle, 'myself');
});

test('without a cached own profile the reader\'s row is read like any other', async () => {
  const { requests, rest } = fakeRest({ profiles: { me: PROFILE('me') } });
  const delivered = [];

  resolveRowProfiles(
    [{ uid: 'me', profile: undefined }],
    { onProfile: (uid, profile) => delivered.push([uid, profile]) },
    { ...overridesFor(rest), currentUser: { uid: 'me' } },
  );
  await tick(); await tick();

  assert.equal(requests.length, 1);
  assert.equal(delivered[0][1].handle, 'h-me');
});

/**
 * What a slow notice may do to the tab's status. Over REST a dead network
 * rejects in a few milliseconds, and `patientRead` reports every transient
 * rejection as "slow" — measured: the sheet said "taking longer than usual"
 * 44 ms after opening, and later notices pushed a tab that had already
 * reached its stalled verdict back onto the skeleton, Retry button and all.
 */
test('a slow notice says nothing before the wait has been felt, unless the browser is offline', () => {
  assert.equal(nextWaitingStatus('loading', 44, { offline: false }), null);
  assert.equal(nextWaitingStatus('loading', 1199, { offline: false }), null);
  assert.equal(nextWaitingStatus('loading', 1200, { offline: false }), 'slow');
  assert.equal(nextWaitingStatus('loading', 2, { offline: true }), 'offline');
  assert.equal(nextWaitingStatus(undefined, 1500, {}), 'slow', 'a tab with no entry yet is a loading tab');
});

test('a slow notice may move between the waiting states, but never take back a verdict or rows', () => {
  assert.equal(nextWaitingStatus('slow', 3000, { offline: true }), 'offline');
  assert.equal(nextWaitingStatus('offline', 3000, { offline: false }), 'slow');
  assert.equal(nextWaitingStatus('slow', 3000, { offline: false }), null, 'already saying it');
  assert.equal(nextWaitingStatus('stalled', 30000, { offline: false }), null);
  assert.equal(nextWaitingStatus('error', 30000, { offline: false }), null);
  assert.equal(nextWaitingStatus('ready', 30000, { offline: true }), null);
});

test('a page comes back as rows, each carrying whatever the profile cache already knows', async () => {
  followRowProfileCache.set('a', { uid: 'a', handle: 'h-a' });
  const { requests, rest } = fakeRest({ pages: [[EDGE('a'), EDGE('b')]] });
  const controller = new AbortController();

  const page = await readFollowPage(UID, 'followers', { signal: controller.signal }, overridesFor(rest));

  assert.deepEqual(requests, [{ kind: 'query', field: 'targetUid', signal: controller.signal }]);
  assert.deepEqual(page.rows, [
    { uid: 'a', profile: { uid: 'a', handle: 'h-a' } },
    { uid: 'b', profile: undefined },
  ]);
  assert.equal(page.hasMore, false);
  assert.equal(page.cursor, null);
});

test('the following tab reads the other side of the edge', async () => {
  const { requests, rest } = fakeRest({ pages: [[EDGE(UID, 'c')]] });

  const page = await readFollowPage(UID, 'following', {}, overridesFor(rest));

  assert.equal(requests[0].field, 'followerUid');
  assert.deepEqual(page.rows.map(row => row.uid), ['c']);
});

test('an unknown tab or no uid costs nothing and yields an empty page', async () => {
  const { requests, rest } = fakeRest();
  assert.deepEqual(await readFollowPage(UID, 'friends', {}, overridesFor(rest)), { rows: [], cursor: null, hasMore: false });
  assert.deepEqual(await readFollowPage('', 'followers', {}, overridesFor(rest)), { rows: [], cursor: null, hasMore: false });
  assert.equal(requests.length, 0);
});

test('a found profile, a confirmed absence and a denial each settle their row, and are cached', async () => {
  const { rest } = fakeRest({
    profiles: {
      found: PROFILE('found'),
      gone: { exists: false, id: 'gone', data: null },
      hidden: new FirestoreRestError('denied', { code: 'permission-denied', status: 403 }),
    },
  });
  const delivered = [];
  const rows = [{ uid: 'found', profile: undefined }, { uid: 'gone', profile: undefined }, { uid: 'hidden', profile: undefined }];

  resolveRowProfiles(rows, { onProfile: (uid, profile) => delivered.push([uid, profile]) }, overridesFor(rest));
  await tick(); await tick();

  assert.deepEqual(delivered.sort(), [
    ['found', { uid: 'found', handle: 'h-found', displayName: 'Name found', visibility: 'public', pinnedLists: [], pinnedShareIds: [] }],
    ['gone', null],
    ['hidden', null],
  ]);
  assert.equal(followRowProfileCache.get('found').handle, 'h-found');
  assert.equal(followRowProfileCache.get('gone'), null);
  assert.equal(followRowProfileCache.get('hidden'), null);
});

test('a row whose profile is already known is not read again', async () => {
  const { requests, rest } = fakeRest({ profiles: { known: PROFILE('known') } });
  const delivered = [];

  resolveRowProfiles(
    [{ uid: 'known', profile: { uid: 'known' } }, { uid: 'gone-known', profile: null }],
    { onProfile: (uid, profile) => delivered.push([uid, profile]) },
    overridesFor(rest),
  );
  await tick();

  assert.equal(requests.length, 0);
  assert.deepEqual(delivered, []);
});

test('a transient failure settles nothing — the row stays pending, and nothing is cached as gone', async () => {
  const { requests, rest } = fakeRest({ profiles: { flaky: [unavailable(), PROFILE('flaky')] } });
  const timers = fakeTimers();
  const delivered = [];

  resolveRowProfiles(
    [{ uid: 'flaky', profile: undefined }],
    { onProfile: (uid, profile) => delivered.push([uid, profile]), patience: patience(timers) },
    overridesFor(rest),
  );
  await tick(); await tick();

  assert.deepEqual(delivered, [], 'the network dropping a request is not an answer');
  assert.equal(followRowProfileCache.get('flaky'), undefined, 'and it must not be cached as an absent account');
  assert.ok(timers.armed > 0, 'a retry is scheduled');

  // The retry, on the hand-cranked clock, answers — and the row settles then.
  timers.fire(DEFAULT_RETRY_DELAY_MS);
  await tick(); await tick();

  assert.equal(requests.filter(request => request.kind === 'get').length, 2);
  assert.deepEqual(delivered, [['flaky', { uid: 'flaky', handle: 'h-flaky', displayName: 'Name flaky', visibility: 'public', pinnedLists: [], pinnedShareIds: [] }]]);
  assert.equal(followRowProfileCache.get('flaky').handle, 'h-flaky');
});

test('a closed sheet ends the requests behind its rows', async () => {
  const { requests, rest } = fakeRest({ profiles: { a: PROFILE('a') } });
  const controller = new AbortController();

  resolveRowProfiles([{ uid: 'a', profile: undefined }], { signal: controller.signal }, overridesFor(rest));
  await tick();

  assert.equal(requests[0].signal, controller.signal);
});

test('a prefetch fills the session cache with the page and the accounts behind it, once', async () => {
  const { requests, rest } = fakeRest({ pages: [[EDGE('a'), EDGE('b')]], profiles: { a: PROFILE('a'), b: PROFILE('b') } });

  prefetchFollowList(UID, 'followers', overridesFor(rest));
  prefetchFollowList(UID, 'followers', overridesFor(rest));
  await tick(); await tick(); await tick();

  assert.deepEqual(readFollowList(UID, 'followers').rows.map(row => row.uid), ['a', 'b']);
  assert.equal(followRowProfileCache.get('a').handle, 'h-a');
  assert.equal(followRowProfileCache.get('b').handle, 'h-b');
  assert.equal(requests.filter(request => request.kind === 'query').length, 1, 'the second prefetch found the first in flight');

  prefetchFollowList(UID, 'followers', overridesFor(rest));
  await tick();
  assert.equal(requests.filter(request => request.kind === 'query').length, 1, 'a cached page is never re-read by a prefetch');
});

test('a prefetch that fails leaves no trace: no page, and no account marked gone', async () => {
  const { rest } = fakeRest({ pages: [unavailable()] });

  prefetchFollowList(UID, 'followers', overridesFor(rest));
  await tick(); await tick();

  assert.equal(readFollowList(UID, 'followers'), undefined);

  const flaky = fakeRest({ pages: [[EDGE(UID, 'z')]], profiles: { z: unavailable() } });
  prefetchFollowList(UID, 'following', overridesFor(flaky.rest));
  await tick(); await tick(); await tick();

  assert.deepEqual(readFollowList(UID, 'following').rows.map(row => row.uid), ['z']);
  assert.equal(followRowProfileCache.get('z'), undefined);
});
