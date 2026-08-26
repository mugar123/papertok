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

test('reserves several units in one round trip and refuses the one that would cross', async () => {
  // Reserving one unit at a time either costs a trip per unit or, worse, lets the
  // ledger take the first unit of a request whose remaining units it would have
  // refused -- which is exactly how a route that spends nine OpenAlex calls used
  // to pass a ceiling built for one.
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  // The two ceilings are deliberately far apart, so each assertion below can only
  // be answered by the check it is aiming at: with both set to ten, the global
  // one alone refuses everything the subject one would have, and a subject check
  // that ignored the amount would pass unnoticed.
  const reserve = (amount, limits = { subjectLimit: 10, globalLimit: 100 }) => ledger.fetch(
    new Request('https://internal', {
      method: 'POST',
      body: JSON.stringify({ action: 'reserve', subjectKey: 'a'.repeat(64), ...limits, amount }),
    }),
  );

  assert.deepEqual(await (await reserve(4)).json(), {
    accepted: true, subjectUsage: 4, globalUsage: 4, remaining: 6,
  });
  const refused = await (await reserve(7)).json();
  assert.equal(refused.accepted, false);
  assert.equal(refused.scope, 'user');
  // Refused, not clamped: the usage stays where it was, so a rejected reservation
  // never leaves a partial spend behind.
  assert.equal(refused.subjectUsage, 4);
  assert.equal((await (await reserve(6)).json()).accepted, true);
});

test('the global ceiling also refuses on what the reservation would spend', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const reserve = amount => ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({
      action: 'reserve',
      subjectKey: 'a'.repeat(64),
      subjectLimit: 1_000,
      globalLimit: 10,
      amount,
    }),
  }));

  assert.equal((await (await reserve(9)).json()).accepted, true);
  const refused = await (await reserve(4)).json();
  assert.equal(refused.accepted, false);
  assert.equal(refused.scope, 'global');
  assert.equal(refused.globalUsage, 9);
});

test('a reservation that names no amount still spends exactly one', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const response = await ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({
      action: 'reserve',
      subjectKey: 'a'.repeat(64),
      subjectLimit: 1,
      globalLimit: 1,
    }),
  }));

  assert.deepEqual(await response.json(), {
    accepted: true, subjectUsage: 1, globalUsage: 1, remaining: 0,
  });
});

test('a zero or negative amount is refused rather than treated as one', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  for (const amount of [0, -3, 'many']) {
    const response = await ledger.fetch(new Request('https://internal', {
      method: 'POST',
      body: JSON.stringify({
        action: 'reserve',
        subjectKey: 'a'.repeat(64),
        subjectLimit: 5,
        globalLimit: 5,
        amount,
      }),
    }));
    assert.equal(response.status, 400, `amount ${amount} should not be accepted`);
  }
});

test('a release gives back as much as was reserved, not one unit of it', async () => {
  // The half of `amount` that only exists because both features landed together:
  // handing one unit back to a caller that reserved nine would leak eight of them
  // on every refund.
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const call = (action, amount) => ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({
      action,
      subjectKey: 'd'.repeat(64),
      subjectLimit: 50,
      globalLimit: 50,
      amount,
    }),
  }));

  await call('reserve', 9);
  const released = await (await call('release', 9)).json();

  assert.equal(released.subjectUsage, 0);
  assert.equal(released.globalUsage, 0);
});

test('peeking reports the allowance without spending any of it', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const subjectKey = 'b'.repeat(64);
  const call = body => ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify({ subjectKey, subjectLimit: 10, globalLimit: 100, ...body }),
  }));

  await call({ action: 'reserve' });
  await call({ action: 'reserve' });

  const first = await (await call({ action: 'peek' })).json();
  const second = await (await call({ action: 'peek' })).json();

  assert.deepEqual(first, { accepted: true, subjectUsage: 2, globalUsage: 2, remaining: 8 });
  // The number the reader is shown must not move because the reader looked at
  // it: two peeks in a row have to agree, and agree with the reservation count.
  assert.deepEqual(second, first);
  assert.equal(harness.values.get(`subject:${subjectKey}`), 2);
  assert.equal(harness.values.get('global'), 2);
});

test('a peek past the ceiling reports nothing left rather than a negative', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const subjectKey = 'c'.repeat(64);
  const call = body => ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify({ subjectKey, subjectLimit: 1, globalLimit: 100, ...body }),
  }));

  await call({ action: 'reserve' });
  // The allowance can be over-spent across a limit change, and "-3 uses today"
  // is not a thing the reader can render.
  harness.values.set(`subject:${subjectKey}`, 4);

  assert.equal((await (await call({ action: 'peek' })).json()).remaining, 0);
});
