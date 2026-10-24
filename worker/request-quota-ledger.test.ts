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
    })),
  };

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
    })),
  };
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
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response('boom', { status: 500 }) })),
  };

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

// PAP-88: one day's OpenAlex budget, shared by requests that do not matter
// equally. A request names the share of the ceiling it may reach and the name
// its units are counted under; OpenAlex's own remaining budget, when reported,
// lowers the ceiling below the configured cap.
function dayLedger() {
  const harness = storageHarness();
  const ledger = new RequestQuotaLedger({ storage: harness.storage });
  const call = (body: Record<string, unknown>) => ledger.fetch(new Request('https://internal', {
    method: 'POST',
    body: JSON.stringify({ subjectKey: 'e'.repeat(64), subjectLimit: 1_000, globalLimit: 100, ...body }),
  }));
  const read = async (body: Record<string, unknown>) => (await call(body)).json<QuotaReading>();
  return { harness, call, read };
}

test('a reservation past its percent of the ceiling is refused while percent 100 still passes', async () => {
  const { read, harness } = dayLedger();

  assert.equal((await read({ action: 'reserve', amount: 50, percent: 60 })).accepted, true);
  const refused = await read({ action: 'reserve', amount: 11, percent: 60 });
  assert.equal(refused.accepted, false);
  assert.equal(refused.scope, 'global');
  assert.equal(refused.globalUsage, 50, 'a refusal spends nothing');
  // The same eleven units fit under the whole ceiling.
  assert.equal((await read({ action: 'reserve', amount: 11, percent: 100 })).accepted, true);
  assert.equal((await read({ action: 'reserve', amount: 11 })).accepted, true, 'no percent is the whole ceiling');
  assert.equal(harness.values.get('global'), 72);
});

test('a reported remaining budget lowers the ceiling, a later higher reading reopens it, and the cap still bounds it', async () => {
  const { read } = dayLedger();

  await read({ action: 'reserve', amount: 10 });
  // Five units left upstream after the ten already counted: fifteen in all.
  await read({ action: 'observe', remaining: 5 });
  assert.equal((await read({ action: 'reserve', amount: 6 })).accepted, false);
  assert.equal((await read({ action: 'reserve', amount: 5 })).accepted, true);
  assert.equal((await read({ action: 'reserve', amount: 1 })).accepted, false);

  // Credit added upstream mid-day: the next reading reopens the day.
  await read({ action: 'observe', remaining: 20 });
  assert.equal((await read({ action: 'reserve', amount: 20 })).accepted, true);

  // A reading above the cap does not raise the ceiling past it.
  await read({ action: 'observe', remaining: 1_000 });
  assert.equal((await read({ action: 'reserve', amount: 65 })).accepted, true);
  assert.equal((await read({ action: 'reserve', amount: 1 })).accepted, false);
  assert.equal((await read({ action: 'peek' })).globalUsage, 100);
});

test('accepted and refused units are tallied by name, a release gives the used units back, and a peek reads tally and observation without spending', async () => {
  const { read, harness } = dayLedger();

  await read({ action: 'reserve', amount: 3, tally: 'feed.list' });
  await read({ action: 'reserve', amount: 2, tally: 'feed.list' });
  await read({ action: 'reserve', amount: 40, percent: 30, tally: 'exploration.search' });
  await read({ action: 'reserve', amount: 10, percent: 30, tally: 'exploration.search' });
  await read({ action: 'release', amount: 1, tally: 'feed.list' });
  await read({ action: 'observe', remaining: 70 });

  const before = new Map(harness.values);
  const first = await read({ action: 'peek' });
  const second = await read({ action: 'peek' });
  assert.deepEqual(first.tally, {
    used: { 'feed.list': 4, 'exploration.search': 10 },
    refused: { 'exploration.search': 40 },
  });
  assert.equal(first.globalUsage, 14);
  assert.equal(first.observed!.ceiling, 84);
  assert.equal(typeof first.observed!.at, 'number');
  assert.deepEqual(second, first);
  assert.deepEqual(new Map(harness.values), before, 'looking spends nothing');
});

// The tally says what the day's shares refused. A subject's refusal (for
// OpenAlex, the minute's ceiling) is a burst, not a closed tier, and counting
// it would add a write to this object exactly when it is busiest.
test('a refusal by the subject ceiling is not tallied and writes nothing', async () => {
  const { read, harness } = dayLedger();

  await read({ action: 'reserve', amount: 3, subjectLimit: 3, tally: 'feed.list' });
  const before = new Map(harness.values);
  const refused = await read({ action: 'reserve', amount: 1, subjectLimit: 3, tally: 'feed.list' });
  assert.equal(refused.accepted, false);
  assert.equal(refused.scope, 'user');
  assert.deepEqual(new Map(harness.values), before);
  assert.deepEqual((await read({ action: 'peek' })).tally, { used: { 'feed.list': 3 }, refused: {} });
});

// The paper harvest's share of the day is split into parts (followed lanes,
// category lanes): a part is a second subject, checked with the subject and
// the day in one transaction, so neither can be spent past its limit by a
// reservation the other accepted.
test("a reservation naming a part of the subject's allowance stops at the part, spends nothing when refused, and gives the part back on release", async () => {
  const { read, harness } = dayLedger();
  const part = { partKey: 'f'.repeat(64), partLimit: 7 };

  assert.equal((await read({ action: 'reserve', amount: 5, ...part })).accepted, true);
  const before = new Map(harness.values);
  const refused = await read({ action: 'reserve', amount: 3, ...part });
  assert.equal(refused.accepted, false);
  assert.equal(refused.scope, 'part');
  assert.deepEqual(new Map(harness.values), before, 'a refused part spends nothing');
  // The subject and the day still have room for a reservation outside the part.
  assert.equal((await read({ action: 'reserve', amount: 3 })).accepted, true);
  assert.equal(harness.values.get(`subject:${'f'.repeat(64)}`), 5);

  await read({ action: 'release', amount: 5, ...part });
  assert.equal(harness.values.get(`subject:${'f'.repeat(64)}`), 0);
  assert.equal((await read({ action: 'reserve', amount: 7, ...part })).accepted, true);
  assert.equal(harness.values.get('global'), 10);
});

test('the quota client sends a part as a hashed key and its limit', async () => {
  let body: Record<string, unknown> = {};
  const namespace: TestNamespace = {
    idFromName: (value: string): unknown => value,
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (_url, options) => {
        body = JSON.parse(options!.body as string);
        return new Response(JSON.stringify({ accepted: true }));
      },
    })),
  };

  await reserveRequestQuota(namespace as Env['REQUEST_QUOTA_LEDGER'], {
    periodKey: 'openalex:day:2026-10-23', subject: 'openalex:harvest', subjectLimit: 4_000, globalLimit: 10_000,
    part: { subject: 'openalex:harvest:follows', limit: 700 },
  });

  assert.match(String(body.partKey), /^[a-f0-9]{64}$/);
  assert.notEqual(body.partKey, body.subjectKey);
  assert.equal(body.partLimit, 700);
});

test('a malformed percent, tally, remaining or part is refused, not ignored', async () => {
  const { call, harness } = dayLedger();
  const malformed: Array<Record<string, unknown>> = [
    { action: 'reserve', percent: 0 },
    { action: 'reserve', percent: 101 },
    { action: 'reserve', percent: 'x' },
    { action: 'reserve', percent: 50.5 },
    { action: 'reserve', tally: 'Feed list' },
    { action: 'reserve', tally: 'feed' },
    { action: 'observe', remaining: -1 },
    { action: 'observe' },
    { action: 'reserve', partKey: 'f'.repeat(64) },
    { action: 'reserve', partLimit: 7 },
    { action: 'reserve', partKey: 'not a hash', partLimit: 7 },
    { action: 'reserve', partKey: 'f'.repeat(64), partLimit: 0 },
  ];
  for (const body of malformed) {
    const response = await call(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { code: 'INVALID_REQUEST' });
  }
  assert.equal(harness.values.size, 0, 'nothing was written');
});
