import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { loadAccountNotice, privacyNoticeStatus, readPrivacyNoticeAck, recordPrivacyNoticeShown, rememberPrivacyNotice, syncLocalPrivacyNotice } from '../utils/nudges.ts';

const firestore = `
  export * from ${JSON.stringify(import.meta.resolve('firebase/firestore'))};
  const records = new Map();
  export const doc = (_, ...parts) => parts.join('/');
  export const getDoc = async path => {
    if (path === 'users/offline/settings/privacyNotice') throw new Error('offline');
    return { get: key => records.get(path)?.[key], metadata: { fromCache: false } };
  };
  export const setDoc = (path, data) => records.set(path, data);
  export const runTransaction = (_, update) => update({ get: getDoc, set: setDoc });
`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier !== 'firebase/firestore' ? next(specifier, context) : {
      url: 'data:text/javascript,' + encodeURIComponent(firestore),
      shortCircuit: true,
    };
  },
});
const { readAccountPrivacyNotice, saveAccountPrivacyNotice } = await import('./privacy-notice-service.ts');
hooks.deregister();

test('an older device cannot downgrade the account notice from .9 to .8', async () => {
  await saveAccountPrivacyNotice('reader', '2026-10-25.9');
  await saveAccountPrivacyNotice('reader', '2026-10-25.8');
  assert.equal(await readAccountPrivacyNotice('reader', new AbortController().signal), '2026-10-25.9');
});

test('a missing notice record is created and a later numeric suffix upgrades it', async () => {
  const { signal } = new AbortController();
  assert.equal(await readAccountPrivacyNotice('new-reader', signal), null);
  await saveAccountPrivacyNotice('new-reader', '2026-10-25.9');
  assert.equal(await readAccountPrivacyNotice('new-reader', signal), '2026-10-25.9');
  await saveAccountPrivacyNotice('new-reader', '2026-10-25.10');
  assert.equal(await readAccountPrivacyNotice('new-reader', signal), '2026-10-25.10');
});

function browserStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test('a browser-only baseline record settles the notice on a second device after sync', async () => {
  const phone = browserStorage();
  const laptop = browserStorage();
  const uid = 'baseline-reader';
  const { signal } = new AbortController();
  const status = (storage: ReturnType<typeof browserStorage>, account: Awaited<ReturnType<typeof loadAccountNotice>>) => {
    if (account === 'failed') assert.fail('the account read should succeed');
    return privacyNoticeStatus({
      user: { uid },
      signedIn: true,
      version: '2026-11-20.9',
      effectiveAt: '2026-11-20T23:59:59Z',
      account,
      storage,
    });
  };
  rememberPrivacyNotice(uid, '2026-11-07', phone);
  assert.equal(status(phone, null), 'settled');
  assert.equal(await readAccountPrivacyNotice(uid, signal), null);
  assert.equal(status(laptop, { uid, version: null }), 'owed');
  assert.equal(syncLocalPrivacyNotice({ uid: 'another-reader', storage: phone, saveToAccount: saveAccountPrivacyNotice }), undefined);
  assert.equal(await readAccountPrivacyNotice('another-reader', signal), null);

  await syncLocalPrivacyNotice({ uid, storage: phone, saveToAccount: saveAccountPrivacyNotice });
  assert.equal(await readAccountPrivacyNotice(uid, signal), '2026-11-07');
  assert.equal(status(laptop, null), 'ask-account');
  const account = await loadAccountNotice({ uid, read: readAccountPrivacyNotice, signal, storage: laptop });
  assert.equal(status(laptop, account), 'settled');
});

test('a failed sync keeps the browser record available to retry', async () => {
  const storage = browserStorage();
  const uid = 'retry-reader';
  rememberPrivacyNotice(uid, '2026-11-07', storage);
  await assert.rejects(async () => syncLocalPrivacyNotice({
    uid, storage, saveToAccount: (account, version) => {
      assert.equal(account, uid);
      assert.equal(version, '2026-11-07');
      return Promise.reject(new Error('offline'));
    },
  }), /offline/);
  assert.equal(readPrivacyNoticeAck(uid, storage), '2026-11-07');
  await syncLocalPrivacyNotice({ uid, storage, saveToAccount: saveAccountPrivacyNotice });
  assert.equal(await readAccountPrivacyNotice(uid, new AbortController().signal), '2026-11-07');
});

test('a failed transaction leaves the local notice mark', async t => {
  const storage = browserStorage();
  const warn = t.mock.method(console, 'warn', () => undefined);
  recordPrivacyNoticeShown({
    uid: 'offline', dialogOpen: true, version: '2026-10-25.9', storage, saveToAccount: saveAccountPrivacyNotice,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(readPrivacyNoticeAck('offline', storage), '2026-10-25.9');
});
