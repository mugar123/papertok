import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteConfirmedAccount } from './deleteConfirmedAccount.ts';

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

test('a sign-in that fails deletes nothing and reaches the caller', async () => {
  const calls: string[] = [];
  await assert.rejects(deleteConfirmedAccount({
    reauthenticate: () => Promise.reject(new Error('popup closed')),
    onSignedIn: () => { calls.push('signedIn'); },
    deleteAccount: (uid) => { calls.push(`delete ${uid}`); return Promise.resolve(); },
    onDeleted: () => { calls.push('deleted'); },
  }), /popup closed/);
  assert.deepEqual(calls, []);
});
