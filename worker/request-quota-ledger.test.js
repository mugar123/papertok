import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestQuotaLedger, releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.js';

function storageHarness() {
  const values = new Map();
  let alarm = null;
  const transaction = {
    get: key => values.get(key),
    put: (key, value) => values.set(key, value),
    delete: key => values.delete(key),
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

test('a released use goes back to the subject and to the global counter', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const payload = {
    subjectKey: 'b'.repeat(64),
    subjectLimit: 2,
    globalLimit: 10,
  };
  const call = action => ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify({ ...payload, action }),
  })).then(response => response.json());

  await call('reserve');
  await call('reserve');
  assert.equal((await call('reserve')).accepted, false);

  // Nothing was delivered for the second use, so it comes back and the subject
  // can ask again — the whole point: a provider outage must not burn the day.
  assert.deepEqual(await call('release'), {
    released: true, subjectUsage: 1, globalUsage: 1, remaining: 1,
  });
  assert.equal((await call('reserve')).accepted, true);
});

test('a release cannot mint quota that was never reserved', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const call = action => ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({ action, subjectKey: 'c'.repeat(64), subjectLimit: 2, globalLimit: 10 }),
  })).then(response => response.json());

  await call('release');
  await call('release');

  assert.equal(harness.values.get(`subject:${'c'.repeat(64)}`), 0);
  assert.equal(harness.values.get('global'), 0);
});

test('an action the ledger does not know is still refused', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const response = await ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({ action: 'settle', subjectKey: 'd'.repeat(64), subjectLimit: 2, globalLimit: 10 }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: 'INVALID_REQUEST' });
});

test('the release client hides the identity exactly like the reserve one', async () => {
  const bodies = [];
  const periods = [];
  const namespace = {
    idFromName: value => { periods.push(value); return value; },
    get: () => ({
      fetch: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ released: true }));
      },
    }),
  };
  const options = {
    periodKey: 'ai:2026-08-23',
    subject: 'ai:firebase-user-id',
    subjectLimit: 10,
    globalLimit: 1_000,
  };

  await reserveRequestQuota(namespace, options);
  await releaseRequestQuota(namespace, options);

  assert.deepEqual(bodies.map(body => body.action), ['reserve', 'release']);
  assert.equal(bodies[0].subjectKey, bodies[1].subjectKey);
  assert.match(bodies[1].subjectKey, /^[a-f0-9]{64}$/);
  assert.equal(bodies[1].subjectKey.includes('firebase-user-id'), false);
  assert.deepEqual(periods, ['ai:2026-08-23', 'ai:2026-08-23']);
});

test('an unreachable ledger is reported as unavailable, not as unconfigured', async () => {
  const namespace = {
    idFromName: value => value,
    get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
  };

  assert.deepEqual(await reserveRequestQuota(namespace, {
    periodKey: 'ai:2026-08-23', subject: 'ai:uid', subjectLimit: 10, globalLimit: 1_000,
  }), { accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' });
  assert.deepEqual(await reserveRequestQuota(null, {
    periodKey: 'ai:2026-08-23', subject: 'ai:uid', subjectLimit: 10, globalLimit: 1_000,
  }), { accepted: false, code: 'QUOTA_LEDGER_NOT_CONFIGURED' });
});
