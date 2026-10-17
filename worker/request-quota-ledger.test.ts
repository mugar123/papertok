import type { LedgerTransaction } from './ledger-storage.ts';
import type { QuotaReading } from './request-quota-ledger.ts';
import type { TestNamespace } from './test-types.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestQuotaLedger, releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.ts';

function storageHarness() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const transaction = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => values.set(key, value),
    delete: (key: string) => values.delete(key),
  };
  return {
    values,
    storage: {
      transaction: <T>(callback: (transaction: LedgerTransaction) => Promise<T>) => callback(transaction),
      getAlarm: async () => alarm,
      setAlarm: async (value: number) => { alarm = value; },
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

  assert.deepEqual(await first.json<QuotaReading>(), {
    accepted: true, subjectUsage: 1, globalUsage: 1, remaining: 1,
  });
  assert.equal((await second.json<{ accepted: boolean }>()).accepted, true);
  assert.deepEqual(await third.json<QuotaReading>(), {
    accepted: false, scope: 'user', subjectUsage: 2, globalUsage: 2,
  });
});

test('quota client hashes the user identity before sending it to storage', async () => {
  let body;
  const namespace: TestNamespace = {
    idFromName: (value: string): unknown => value,
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (_url, options) => {
        body = JSON.parse(options!.body as string);
        return new Response(JSON.stringify({ accepted: true, remaining: 3 }));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];

  const result = await reserveRequestQuota(namespace as Env['REQUEST_QUOTA_LEDGER'], {
    periodKey: 'ai:2026-08-13',
    subject: 'firebase-user-id',
    subjectLimit: 4,
    globalLimit: 100,
  });

  assert.equal(result.accepted, true);
  assert.match(body!.subjectKey, /^[a-f0-9]{64}$/);
  assert.equal(body!.subjectKey.includes('firebase-user-id'), false);
});

test('a released use goes back to the subject and to the global counter', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const payload = {
    subjectKey: 'b'.repeat(64),
    subjectLimit: 2,
    globalLimit: 10,
  };
  const call = (action: string) => ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify({ ...payload, action }),
  })).then(response => response.json<QuotaReading>());

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
  const call = (action: string) => ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({ action, subjectKey: 'c'.repeat(64), subjectLimit: 2, globalLimit: 10 }),
  })).then(response => response.json<QuotaReading>());

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
  assert.deepEqual(await response.json<QuotaReading>(), { code: 'INVALID_REQUEST' });
});

test('the release client hides the identity exactly like the reserve one', async () => {
  const bodies: Array<{ action: string; subjectKey: string }> = [];
  const periods: string[] = [];
  const namespace: TestNamespace = {
    idFromName: (value: string): unknown => { periods.push(value); return value; },
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (_url, options) => {
        bodies.push(JSON.parse(options!.body as string));
        return new Response(JSON.stringify({ released: true }));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];
  const options = {
    periodKey: 'ai:2026-08-23',
    subject: 'ai:firebase-user-id',
    subjectLimit: 10,
    globalLimit: 1_000,
  };

  await reserveRequestQuota(namespace as Env['REQUEST_QUOTA_LEDGER'], options);
  await releaseRequestQuota(namespace as Env['REQUEST_QUOTA_LEDGER'], options);

  assert.deepEqual(bodies.map(body => body.action), ['reserve', 'release']);
  assert.equal(bodies[0].subjectKey, bodies[1].subjectKey);
  assert.match(bodies[1].subjectKey, /^[a-f0-9]{64}$/);
  assert.equal(bodies[1].subjectKey.includes('firebase-user-id'), false);
  assert.deepEqual(periods, ['ai:2026-08-23', 'ai:2026-08-23']);
});

test('an unreachable ledger is reported as unavailable, not as unconfigured', async () => {
  const namespace: TestNamespace = {
    idFromName: (value: string): unknown => value,
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response('boom', { status: 500 }) })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];

  assert.deepEqual(await reserveRequestQuota(namespace as Env['REQUEST_QUOTA_LEDGER'], {
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
  const reserve = (amount: number, limits = { subjectLimit: 10, globalLimit: 100 }) => ledger.fetch(
    new Request('https://internal', {
      method: 'POST',
      body: JSON.stringify({ action: 'reserve', subjectKey: 'a'.repeat(64), ...limits, amount }),
    }),
  );

  assert.deepEqual(await (await reserve(4)).json<QuotaReading>(), {
    accepted: true, subjectUsage: 4, globalUsage: 4, remaining: 6,
  });
  const refused = await (await reserve(7)).json<{ accepted: boolean; scope: string; subjectUsage: number }>();
  assert.equal(refused.accepted, false);
  assert.equal(refused.scope, 'user');
  // Refused, not clamped: the usage stays where it was, so a rejected reservation
  // never leaves a partial spend behind.
  assert.equal(refused.subjectUsage, 4);
  assert.equal((await (await reserve(6)).json<{ accepted: boolean }>()).accepted, true);
});

test('the global ceiling also refuses on what the reservation would spend', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const reserve = (amount: number) => ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({
      action: 'reserve',
      subjectKey: 'a'.repeat(64),
      subjectLimit: 1_000,
      globalLimit: 10,
      amount,
    }),
  }));

  assert.equal((await (await reserve(9)).json<{ accepted: boolean }>()).accepted, true);
  const refused = await (await reserve(4)).json<{ accepted: boolean; scope: string; globalUsage: number }>();
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

  assert.deepEqual(await response.json<QuotaReading>(), {
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
  const call = (action: string, amount: number) => ledger.fetch(new Request('https://internal', {
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
  const released = await (await call('release', 9)).json<{ subjectUsage: number; globalUsage: number }>();

  assert.equal(released.subjectUsage, 0);
  assert.equal(released.globalUsage, 0);
});

test('peeking reports the allowance without spending any of it', async () => {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const subjectKey = 'b'.repeat(64);
  const call = (body: { action: string; }) => ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify({ subjectKey, subjectLimit: 10, globalLimit: 100, ...body }),
  }));

  await call({ action: 'reserve' });
  await call({ action: 'reserve' });

  const first = await (await call({ action: 'peek' })).json<QuotaReading>();
  const second = await (await call({ action: 'peek' })).json<QuotaReading>();

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
  const call = (body: { action: string; }) => ledger.fetch(new Request('https://internal', {
    method: 'POST', body: JSON.stringify({ subjectKey, subjectLimit: 1, globalLimit: 100, ...body }),
  }));

  await call({ action: 'reserve' });
  // The allowance can be over-spent across a limit change, and "-3 uses today"
  // is not a thing the reader can render.
  harness.values.set(`subject:${subjectKey}`, 4);

  assert.equal((await (await call({ action: 'peek' })).json<{ remaining: number }>()).remaining, 0);
});
