import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, inMemoryPersistence, initializeAuth, onAuthStateChanged } from 'firebase/auth';
import type { Auth, Persistence, PopupRedirectResolver } from 'firebase/auth';
import type { PopupReadiness } from './popupRedirectResolver.ts';
import { deferPopupRedirectResolver, preparePopupRedirectResolver } from './popupRedirectResolver.ts';

/**
 * Firebase's browser resolver as Auth sees it. On a phone or in Safari it asks
 * to be loaded while Auth starts; on other desktop browsers it does not. By
 * default the load (Google's gapi scripts) never finishes, as on a stalled
 * connection. Each load request is recorded.
 */
function firebaseResolver({ phone = true, load = () => new Promise(() => {}) }: { phone?: boolean; load?: () => Promise<unknown> } = {}) {
  const loads: Auth[] = [];
  class FirebaseResolver {
    _redirectPersistence = inMemoryPersistence;
    get _shouldInitProactively() {
      return phone;
    }
    _initialize(auth: Auth) {
      loads.push(auth);
      return load();
    }
    async _completeRedirectFn() {
      return null;
    }
    _overrideRedirectResult() {}
  }
  return { resolver: FirebaseResolver as unknown as PopupRedirectResolver, loads };
}

const config = { apiKey: 'test-key', authDomain: 'papertok.test', projectId: 'papertok-test' };
let apps = 0;
// Firebase's own Auth start-up, in its Node build, with the given resolver.
function startAuth(t: TestContext, popupRedirectResolver: PopupRedirectResolver | undefined) {
  apps += 1;
  const app = initializeApp(config, `popup-resolver-${apps}`);
  t.after(() => deleteApp(app));
  return initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver });
}

// A device that kept a session: Auth restores the stored reader and checks it
// with accounts:lookup, which a local stand-in for the Auth API answers.
async function startSignedIn(t: TestContext, popupRedirectResolver: PopupRedirectResolver | undefined) {
  const api = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ users: [{ localId: 'reader', email: 'reader@example.com', emailVerified: true }] }));
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });

  apps += 1;
  const name = `popup-resolver-${apps}`;
  const stored = new Map<string, unknown>([[`firebase:authUser:${config.apiKey}:${name}`, {
    uid: 'reader',
    email: 'reader@example.com',
    emailVerified: true,
    isAnonymous: false,
    stsTokenManager: { refreshToken: 'refresh-token', accessToken: 'id-token', expirationTime: Date.now() + 3_600_000 },
  }]]);
  class StoredSession {
    static type = 'LOCAL';
    type = 'LOCAL';
    async _isAvailable() {
      return true;
    }
    async _set(key: string, value: unknown) {
      stored.set(key, value);
    }
    async _get(key: string) {
      return stored.get(key) ?? null;
    }
    async _remove(key: string) {
      stored.delete(key);
    }
    _addListener() {}
    _removeListener() {}
  }

  const app = initializeApp(config, name);
  t.after(() => deleteApp(app));
  const auth = initializeAuth(app, { persistence: StoredSession as unknown as Persistence, popupRedirectResolver });
  connectAuthEmulator(auth, `http://127.0.0.1:${(api.address() as AddressInfo).port}`, { disableWarnings: true });
  return auth;
}

function settlesWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>(resolve => setTimeout(resolve, ms, false).unref()),
  ]);
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('Auth reports the session without waiting for the popup resolver to load', async (t) => {
  // What `getAuth` does on a phone: Firebase's resolver holds the session
  // until its scripts arrive.
  const eager = firebaseResolver();
  const held = startAuth(t, eager.resolver);
  assert.equal(await settlesWithin(held.authStateReady(), 300), false);
  assert.equal(eager.loads.length, 1);

  const deferred = firebaseResolver();
  const auth = startAuth(t, deferPopupRedirectResolver(deferred.resolver));
  assert.equal(await settlesWithin(auth.authStateReady(), 2000), true);
  assert.equal(auth.currentUser, null);
  assert.deepEqual(deferred.loads, []);
});

// A load the test finishes itself.
function controlledLoad() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { load: () => promise, finish: () => finish() };
}

const turnsReady = (readiness: PopupReadiness) => new Promise<void>(resolve => readiness.subscribe(resolve));

test('on a phone, controls wait for the load and are let through the moment it finishes', async (t) => {
  const load = controlledLoad();
  const phone = firebaseResolver({ load: load.load });
  const auth = startAuth(t, deferPopupRedirectResolver(phone.resolver));

  const readiness = preparePopupRedirectResolver(auth);
  assert.equal(readiness.ready, false, 'not ready before Auth has even reported');
  const ready = turnsReady(readiness);
  await auth.authStateReady();
  await nextTurn();
  assert.deepEqual(phone.loads, [auth]);
  assert.equal(readiness.ready, false, 'not ready while the scripts load');

  load.finish();
  assert.equal(await settlesWithin(ready, 100), true);
  assert.equal(readiness.ready, true);
});

test('a failed load lets presses through, leaving the load and its error to Firebase', async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const phone = firebaseResolver({
    load: async () => {
      throw new Error('apis.google.com unreachable');
    },
  });
  const auth = startAuth(t, deferPopupRedirectResolver(phone.resolver));
  const readiness = preparePopupRedirectResolver(auth);

  assert.equal(await settlesWithin(turnsReady(readiness), 2000), true);
  // A rejection nobody handled is reported after this turn.
  await nextTurn();

  assert.equal(readiness.ready, true);
  assert.deepEqual(phone.loads, [auth]);
  assert.deepEqual(unhandled, []);
});

test('a load that never finishes holds the controls for a bounded time only', async (t) => {
  const phone = firebaseResolver();
  const auth = startAuth(t, deferPopupRedirectResolver(phone.resolver));
  await auth.authStateReady();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const readiness = preparePopupRedirectResolver(auth);
  await nextTurn();
  assert.deepEqual(phone.loads, [auth]);

  // About as long as the load took on an emulated mid-range phone over Slow
  // 4G: still worth waiting for.
  t.mock.timers.tick(2_000);
  assert.equal(readiness.ready, false);
  // Nobody is held for half a minute.
  t.mock.timers.tick(28_000);
  assert.equal(readiness.ready, true);
});

test('where Firebase loads the resolver at the tap, nothing loads and no control waits', async (t) => {
  const desktop = firebaseResolver({ phone: false });
  const auth = startAuth(t, deferPopupRedirectResolver(desktop.resolver));

  const readiness = preparePopupRedirectResolver(auth);
  assert.equal(readiness.ready, true);
  await auth.authStateReady();
  await nextTurn();

  assert.deepEqual(desktop.loads, []);
});

// What Auth had reported each time the resolver started loading.
function recordReports(t: TestContext) {
  const reports: string[] = [];
  const atLoad: string[][] = [];
  return {
    atLoad,
    load: async () => {
      atLoad.push([...reports]);
    },
    listen(auth: Auth) {
      t.after(onAuthStateChanged(auth, user => reports.push(user?.uid ?? 'nobody')));
    },
  };
}

test('with nobody signed in, the resolver loads after Auth has reported the session', async (t) => {
  const reported = recordReports(t);
  const phone = firebaseResolver({ load: reported.load });
  const auth = startAuth(t, deferPopupRedirectResolver(phone.resolver));
  reported.listen(auth);

  assert.equal(await settlesWithin(turnsReady(preparePopupRedirectResolver(auth)), 2000), true);

  assert.deepEqual(phone.loads, [auth]);
  assert.deepEqual(reported.atLoad, [['nobody']]);
});

test('a restored session loads the resolver too, after Auth has reported the reader', async (t) => {
  const reported = recordReports(t);
  const phone = firebaseResolver({ load: reported.load });
  const auth = await startSignedIn(t, deferPopupRedirectResolver(phone.resolver));
  reported.listen(auth);

  assert.equal(await settlesWithin(turnsReady(preparePopupRedirectResolver(auth)), 2000), true);

  assert.equal(auth.currentUser?.uid, 'reader');
  assert.deepEqual(phone.loads, [auth]);
  assert.deepEqual(reported.atLoad, [['reader']]);
});
