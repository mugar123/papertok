import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase/app';
import { inMemoryPersistence, initializeAuth } from 'firebase/auth';
import type { Auth, PopupRedirectResolver } from 'firebase/auth';
import { deferPopupRedirectResolver, preparePopupRedirectResolver } from './popupRedirectResolver.ts';

/**
 * Firebase's browser resolver as Auth sees it on a phone or in Safari: it asks
 * to be loaded while Auth starts. By default the load (Google's gapi scripts)
 * never finishes, as on a stalled connection. Each load request is recorded.
 */
function phoneResolver(load: () => Promise<unknown> = () => new Promise(() => {})) {
  const loads: Auth[] = [];
  class PhoneResolver {
    _redirectPersistence = inMemoryPersistence;
    get _shouldInitProactively() {
      return true;
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
  return { resolver: PhoneResolver as unknown as PopupRedirectResolver, loads };
}

let apps = 0;
// Firebase's own Auth start-up, in its Node build, with the given resolver.
function startAuth(t: TestContext, popupRedirectResolver: PopupRedirectResolver | undefined) {
  apps += 1;
  const app = initializeApp({ apiKey: 'test-key', authDomain: 'papertok.test', projectId: 'papertok-test' }, `popup-resolver-${apps}`);
  t.after(() => deleteApp(app));
  return initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver });
}

function settlesWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>(resolve => setTimeout(resolve, ms, false).unref()),
  ]);
}

test('Auth reports the session without waiting for the popup resolver to load', async (t) => {
  // What `getAuth` does on a phone: Firebase's resolver holds the session
  // until its scripts arrive.
  const eager = phoneResolver();
  const held = startAuth(t, eager.resolver);
  assert.equal(await settlesWithin(held.authStateReady(), 300), false);
  assert.equal(eager.loads.length, 1);

  const deferred = phoneResolver();
  const auth = startAuth(t, deferPopupRedirectResolver(deferred.resolver));
  assert.equal(await settlesWithin(auth.authStateReady(), 2000), true);
  assert.equal(auth.currentUser, null);
  assert.deepEqual(deferred.loads, []);
});

test('preparing loads the resolver of the given Auth, and a failed load is left to the popup', async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const phone = phoneResolver(async () => {
    throw new Error('apis.google.com unreachable');
  });
  const auth = startAuth(t, deferPopupRedirectResolver(phone.resolver));
  await auth.authStateReady();

  preparePopupRedirectResolver(auth);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(phone.loads, [auth]);
  assert.deepEqual(unhandled, []);
});
