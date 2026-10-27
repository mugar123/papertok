import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteConfirmedAccount } from './delete-confirmed-account.ts';
import { readPrivacyNoticeAck, rememberPrivacyNotice } from '../../utils/nudges.ts';

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
};

test('the sign-in window opens from the click, before anything is awaited or deleted', async () => {
  const calls: string[] = [];
  const done = deleteConfirmedAccount({
    reauthenticate: () => { calls.push('reauthenticate'); return Promise.resolve('uid-a'); },
    onSignedIn: () => { calls.push('signedIn'); },
    deleteAccount: (uid) => { calls.push(`delete ${uid}`); return Promise.resolve(); },
    onDeleted: () => { calls.push('deleted'); },
  });
  // Still inside the click: only the sign-in may have started.
  assert.deepEqual(calls, ['reauthenticate']);
  await done;
  assert.deepEqual(calls, ['reauthenticate', 'signedIn', 'delete uid-a', 'deleted']);
});

test('account A confirms, account B takes the session during the popup: A is deleted, not B', async () => {
  let session = 'uid-a';
  const deleted: string[] = [];
  await deleteConfirmedAccount({
    reauthenticate: () => {
      const confirmed = session;
      session = 'uid-b';
      return Promise.resolve(confirmed);
    },
    onSignedIn: () => {},
    deleteAccount: (uid) => { deleted.push(uid); return Promise.resolve(); },
    onDeleted: () => {},
  });
  assert.equal(session, 'uid-b');
  assert.deepEqual(deleted, ['uid-a']);
});

test('this browser forgets the privacy notice of the deleted account only, even if the session has moved on', async () => {
  const storage = fakeStorage();
  rememberPrivacyNotice('uid-a', '2026-10-26', storage);
  rememberPrivacyNotice('uid-b', '2026-10-26', storage);
  await deleteConfirmedAccount({
    reauthenticate: () => Promise.resolve('uid-a'),
    onSignedIn: () => {},
    deleteAccount: () => Promise.resolve(),
    onDeleted: () => {},
    storage,
  });
  assert.equal(readPrivacyNoticeAck('uid-a', storage), null);
  assert.equal(readPrivacyNoticeAck('uid-b', storage), '2026-10-26', 'the account that holds the session now');
});

test('a deletion that fails forgets nothing: the account still exists and has read this version', async () => {
  const storage = fakeStorage();
  rememberPrivacyNotice('uid-a', '2026-10-26', storage);
  await assert.rejects(deleteConfirmedAccount({
    reauthenticate: () => Promise.resolve('uid-a'),
    onSignedIn: () => {},
    deleteAccount: () => Promise.reject(new Error('ACCOUNT_DELETION_FAILED')),
    onDeleted: () => {},
    storage,
  }), /ACCOUNT_DELETION_FAILED/);
  assert.equal(readPrivacyNoticeAck('uid-a', storage), '2026-10-26');
});

test('a sign-in that fails deletes nothing and reaches the caller', async () => {
  const calls: string[] = [];
  const storage = fakeStorage();
  rememberPrivacyNotice('uid-a', '2026-10-26', storage);
  await assert.rejects(deleteConfirmedAccount({
    reauthenticate: () => Promise.reject(new Error('popup closed')),
    onSignedIn: () => { calls.push('signedIn'); },
    deleteAccount: (uid) => { calls.push(`delete ${uid}`); return Promise.resolve(); },
    onDeleted: () => { calls.push('deleted'); },
    storage,
  }), /popup closed/);
  assert.deepEqual(calls, []);
  assert.equal(readPrivacyNoticeAck('uid-a', storage), '2026-10-26', 'nor forgets anything');
});
