import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteAccount, AccountDeletionError } from './accountDeletionService.js';

test('deleteAccount retries 202 slices until complete', async () => {
  const statuses = [];
  const result = await deleteAccount({
    isDemo: false,
    apiBase: 'https://worker.test',
    request: async () => {
      statuses.push(true);
      if (statuses.length < 3) {
        return new Response(JSON.stringify({ complete: false, stage: 'userTree' }), { status: 202 });
      }
      return new Response(JSON.stringify({ complete: true, stage: 'auth' }), { status: 200 });
    },
  });
  assert.equal(result.complete, true);
  assert.equal(statuses.length, 3);
});

test('a 401 after work has started is treated as Auth already gone', async () => {
  let calls = 0;
  const result = await deleteAccount({
    isDemo: false,
    apiBase: 'https://worker.test',
    request: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ complete: false, stage: 'userTree' }), { status: 202 });
      }
      return new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), { status: 401 });
    },
  });
  assert.equal(result.complete, true);
  assert.equal(calls, 2);
});

test('demo mode never calls the Worker', async () => {
  await assert.rejects(
    () => deleteAccount({
      isDemo: true,
      apiBase: 'https://worker.test',
      request: async () => { throw new Error('must not call'); },
    }),
    error => error instanceof AccountDeletionError
      && error.code === 'ACCOUNT_DELETION_UNSUPPORTED_IN_DEMO',
  );
});
