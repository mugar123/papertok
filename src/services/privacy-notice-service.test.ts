import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { readPrivacyNoticeAck, recordPrivacyNoticeShown } from '../utils/nudges.ts';

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

test('a failed transaction leaves the local notice mark', async t => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const warn = t.mock.method(console, 'warn', () => undefined);
  recordPrivacyNoticeShown({
    uid: 'offline', dialogOpen: true, version: '2026-10-25.9', storage, saveToAccount: saveAccountPrivacyNotice,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(readPrivacyNoticeAck('offline', storage), '2026-10-25.9');
});
