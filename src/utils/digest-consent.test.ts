import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_CONSENT_FROM_SIGNUP,
  DIGEST_CONSENT_SPENT,
  readDigestConsent,
  withDigestOptInLock,
  writeDigestConsent,
} from './digest-consent.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    keys: () => [...map.keys()],
  };
}

test('the consent a device remembers belongs to one account', () => {
  const storage = fakeStorage();
  writeDigestConsent('uid-a', DIGEST_CONSENT_FROM_SIGNUP, storage);
  assert.equal(readDigestConsent('uid-a', storage), DIGEST_CONSENT_FROM_SIGNUP);
  assert.equal(readDigestConsent('uid-b', storage), null);
  assert.equal(readDigestConsent(null, storage), null);
});

test('a spent yes replaces the version, and clearing it removes the record', () => {
  const storage = fakeStorage();
  writeDigestConsent('uid-a', DIGEST_CONSENT_FROM_SIGNUP, storage);
  writeDigestConsent('uid-a', DIGEST_CONSENT_SPENT, storage);
  assert.equal(readDigestConsent('uid-a', storage), DIGEST_CONSENT_SPENT);
  writeDigestConsent('uid-a', null, storage);
  assert.equal(readDigestConsent('uid-a', storage), null);
  assert.deepEqual(storage.keys(), []);
});

test('an unknown version reads as no record, so it keeps the old promise', () => {
  const storage = fakeStorage();
  writeDigestConsent('uid-a', DIGEST_CONSENT_FROM_SIGNUP, storage);
  const key = storage.keys()[0]!;
  storage.setItem(key, 'topics-from-signup-99');
  assert.equal(readDigestConsent('uid-a', storage), null);
});

test('a device whose storage throws falls back to no record instead of failing', () => {
  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  writeDigestConsent('uid-a', DIGEST_CONSENT_FROM_SIGNUP, broken);
  assert.equal(readDigestConsent('uid-a', broken), null);
});

// A minimal Web Locks stand-in: one holder per name, the others queue behind it.
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: <R>(name: string, callback: (lock: unknown) => Promise<R>) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name }));
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

test('two tabs starting the same account subscription send it once: the second finds it on', async () => {
  const locks = fakeLocks();
  let stored = false;
  let puts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tab = (waitFor?: Promise<void>) => withDigestOptInLock('uid-a', async () => {
    if (stored) return 'already on';
    if (waitFor) await waitFor;
    puts += 1;
    stored = true;
    return 'subscribed';
  }, locks);
  const first = tab(gate);
  const second = tab();
  release();
  assert.equal(await first, 'subscribed');
  assert.equal(await second, 'already on');
  assert.equal(puts, 1);
});

test('another account subscription is not held back, and the lock is released after a failure', async () => {
  const locks = fakeLocks();
  let other: unknown;
  await withDigestOptInLock('uid-a', async () => {
    other = await withDigestOptInLock('uid-b', async () => 'b', locks);
  }, locks);
  assert.equal(other, 'b');
  await assert.rejects(withDigestOptInLock('uid-a', async () => { throw new Error('offline'); }, locks), /offline/);
  assert.equal(await withDigestOptInLock('uid-a', async () => 'retried', locks), 'retried');
});

test('a browser without Web Locks still runs the task', async () => {
  assert.equal(await withDigestOptInLock('uid-a', async () => 'ran', null), 'ran');
});
