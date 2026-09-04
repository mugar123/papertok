import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_RELOAD_KEY,
  FEED_SNAPSHOT_STORAGE_PREFIX,
  applyReloadPolicy,
  clearFeedContinuity,
  consumeAppForcedReload,
  isReloadNavigation,
  markAppForcedReload,
  shouldStartFeedFresh,
} from './appReload.js';
import { FEED_RESUME_STORAGE_PREFIX } from './feedResumeMemory.js';
import { FOLLOWING_ORDER_STORAGE_KEY } from './followingOrderStorage.js';

/**
 * A stand-in for Storage. `Object.keys()` over a real Storage lists the keys it
 * holds, which is what `clearFeedContinuity` sweeps, so the fake is a proxy
 * rather than a plain object with methods on it — otherwise the sweep would
 * see `getItem` and `setItem` as stored keys.
 */
function storageLike(seed = {}) {
  const store = { ...seed };
  return new Proxy({
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _all: () => ({ ...store }),
  }, {
    ownKeys: () => Reflect.ownKeys(store),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (methods, prop) => (prop in methods ? methods[prop] : store[prop]),
  });
}

test('a mark written on the way out is recognised on the way back in', () => {
  const storage = storageLike();
  markAppForcedReload({ storage, now: 1_000 });
  assert.equal(storage.getItem(APP_RELOAD_KEY), '1000');
  assert.equal(consumeAppForcedReload({ storage, now: 1_400 }), true);
});

test('the mark is consumed, so it can only ever excuse one reload', () => {
  const storage = storageLike();
  markAppForcedReload({ storage, now: 1_000 });
  assert.equal(consumeAppForcedReload({ storage, now: 1_100 }), true);
  // The reader reloads a second later: that one is theirs.
  assert.equal(consumeAppForcedReload({ storage, now: 2_100 }), false);
  assert.equal(storage.getItem(APP_RELOAD_KEY), null);
});

test('a stale mark does not excuse a reload minutes later', () => {
  const storage = storageLike();
  markAppForcedReload({ storage, now: 0 });
  assert.equal(consumeAppForcedReload({ storage, now: 60_001 }), false);
});

test('no mark at all is the reader reloading', () => {
  assert.equal(consumeAppForcedReload({ storage: storageLike(), now: 5 }), false);
});

test('a mark from the future is not trusted', () => {
  // A clock that moved backwards must not make every reload look forced.
  const storage = storageLike();
  markAppForcedReload({ storage, now: 10_000 });
  assert.equal(consumeAppForcedReload({ storage, now: 9_000 }), false);
});

test('missing storage answers false rather than throwing', () => {
  assert.equal(consumeAppForcedReload({ storage: null }), false);
  assert.doesNotThrow(() => markAppForcedReload({ storage: null }));
});

test('only a reload the reader asked for starts the feed fresh', () => {
  assert.equal(shouldStartFeedFresh({ isReload: true, wasAppForced: false }), true);
  assert.equal(shouldStartFeedFresh({ isReload: true, wasAppForced: true }), false);
  // A first visit and a link are not reloads at all.
  assert.equal(shouldStartFeedFresh({ isReload: false, wasAppForced: false }), false);
  assert.equal(shouldStartFeedFresh({ isReload: false, wasAppForced: true }), false);
});

test('the navigation type is read from the timing entry, and its absence is not a reload', () => {
  assert.equal(isReloadNavigation({ perf: { getEntriesByType: () => [{ type: 'reload' }] } }), true);
  assert.equal(isReloadNavigation({ perf: { getEntriesByType: () => [{ type: 'navigate' }] } }), false);
  assert.equal(isReloadNavigation({ perf: { getEntriesByType: () => [{ type: 'back_forward' }] } }), false);
  assert.equal(isReloadNavigation({ perf: { getEntriesByType: () => [] } }), false);
  assert.equal(isReloadNavigation({ perf: null }), false);
  assert.equal(isReloadNavigation({ perf: { getEntriesByType: () => { throw new Error('no'); } } }), false);
});

test('clearing continuity drops the place, the order and the snapshot, and nothing else', () => {
  const session = storageLike({
    [`${FEED_RESUME_STORAGE_PREFIX}forYou`]: '{"index":7}',
    [`${FEED_RESUME_STORAGE_PREFIX}following`]: '{"index":2}',
    [FOLLOWING_ORDER_STORAGE_KEY]: '["a","b"]',
    papertok_something_else: 'keep me',
  });
  const local = storageLike({
    [`${FEED_SNAPSHOT_STORAGE_PREFIX}uid_quant-ph`]: '{"papers":[]}',
    papertok_user: 'keep me',
    papertok_interactions: 'keep me',
  });

  const removed = clearFeedContinuity({ session, local });

  assert.equal(session.getItem(`${FEED_RESUME_STORAGE_PREFIX}forYou`), null);
  assert.equal(session.getItem(`${FEED_RESUME_STORAGE_PREFIX}following`), null);
  assert.equal(session.getItem(FOLLOWING_ORDER_STORAGE_KEY), null);
  assert.equal(local.getItem(`${FEED_SNAPSHOT_STORAGE_PREFIX}uid_quant-ph`), null);
  // The reader's own data is not continuity.
  assert.equal(session.getItem('papertok_something_else'), 'keep me');
  assert.equal(local.getItem('papertok_user'), 'keep me');
  assert.equal(local.getItem('papertok_interactions'), 'keep me');
  assert.equal(removed.length, 4);
});

test('the policy clears on a reader reload and leaves everything alone otherwise', () => {
  const seedSession = () => storageLike({ [`${FEED_RESUME_STORAGE_PREFIX}forYou`]: '{"index":7}' });
  const seedLocal = () => storageLike({ [`${FEED_SNAPSHOT_STORAGE_PREFIX}uid_x`]: '{}' });
  const reloadPerf = { getEntriesByType: () => [{ type: 'reload' }] };
  const firstVisitPerf = { getEntriesByType: () => [{ type: 'navigate' }] };

  // The reader pressed reload.
  let session = seedSession();
  let local = seedLocal();
  let result = applyReloadPolicy({ session, local, perf: reloadPerf, now: 1_000 });
  assert.equal(result.fresh, true);
  assert.equal(session.getItem(`${FEED_RESUME_STORAGE_PREFIX}forYou`), null);
  assert.equal(local.getItem(`${FEED_SNAPSHOT_STORAGE_PREFIX}uid_x`), null);

  // The app reloaded itself after a deploy: the place survives.
  session = seedSession();
  local = seedLocal();
  markAppForcedReload({ storage: session, now: 900 });
  result = applyReloadPolicy({ session, local, perf: reloadPerf, now: 1_000 });
  assert.equal(result.fresh, false);
  assert.equal(session.getItem(`${FEED_RESUME_STORAGE_PREFIX}forYou`), '{"index":7}');
  assert.equal(local.getItem(`${FEED_SNAPSHOT_STORAGE_PREFIX}uid_x`), '{}');

  // A first visit or a link is not a reload and must not clear anything.
  session = seedSession();
  local = seedLocal();
  result = applyReloadPolicy({ session, local, perf: firstVisitPerf, now: 1_000 });
  assert.equal(result.fresh, false);
  assert.equal(session.getItem(`${FEED_RESUME_STORAGE_PREFIX}forYou`), '{"index":7}');
});

test('SOURCE: main.jsx marks both of the reloads the app gives itself, and applies the policy before rendering', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../main.jsx', import.meta.url), 'utf8');
  // The chunk-gone reload.
  assert.match(main, /markAppForcedReload\(\)\s*\n\s*window\.location\.reload\(\)/);
  // The service worker's, which workbox performs for us and we only recognise.
  assert.match(main, /addEventListener\('controllerchange', \(\) => \{\s*markAppForcedReload\(\)/);
  // And the policy runs before React mounts, because the feed reads storage on
  // its first render.
  const policyAt = main.indexOf('applyReloadPolicy()');
  const renderAt = main.indexOf('ReactDOM.createRoot');
  assert.ok(policyAt > 0 && renderAt > policyAt, 'the policy is applied before the first render');
});
