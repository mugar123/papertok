import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestQuotaLedger, reserveRequestQuota } from './request-quota-ledger.js';

function storageHarness() {
  const values = new Map();
  let alarm = null;
  const transaction = {
    get: key => values.get(key),
    put: (key, value) => values.set(key, value),
  };
  return {
    values,
    storage: {
      transaction: callback => callback(transaction),
      getAlarm: async () => alarm,
      setAlarm: async value => { alarm = value; },
      deleteAll: async () => values.clear(),
    },
  };
}

test('reserves subject and global quota atomically', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const payload = {
    action: 'reserve',
    subjectKey: 'a'.repeat(64),
    subjectLimit: 2,
    globalLimit: 10,
  };

  const first = await ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify(payload),
  }));
  const second = await ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify(payload),
  }));
  const third = await ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify(payload),
  }));

  assert.deepEqual(await first.json(), {
    accepted: true, subjectUsage: 1, globalUsage: 1, remaining: 1,
  });
  assert.equal((await second.json()).accepted, true);
  assert.deepEqual(await third.json(), {
    accepted: false, scope: 'user', subjectUsage: 2, globalUsage: 2,
  });
});

test('quota client hashes the user identity before sending it to storage', async () => {
  let body;
  const namespace = {
    idFromName: value => value,
    get: () => ({
      fetch: async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ accepted: true, remaining: 3 }));
      },
    }),
  };

  const result = await reserveRequestQuota(namespace, {
    periodKey: 'ai:2026-08-13',
    subject: 'firebase-user-id',
    subjectLimit: 4,
    globalLimit: 100,
  });

  assert.equal(result.accepted, true);
  assert.match(body.subjectKey, /^[a-f0-9]{64}$/);
  assert.equal(body.subjectKey.includes('firebase-user-id'), false);
});
