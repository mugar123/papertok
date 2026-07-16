import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAlexClient,
  identifyOpenAlexUrl,
  isOpenAlexRateLimitError,
  parseRetryAfter,
} from './openAlexClient.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('adds the PaperTok identity once to OpenAlex URLs', () => {
  const identified = identifyOpenAlexUrl('https://api.openalex.org/works?filter=doi:test');
  const url = new URL(identified);
  assert.equal(url.searchParams.get('mailto'), 'app@papertok.io');
  assert.equal(url.searchParams.getAll('mailto').length, 1);
});

test('keeps the native fetch receiver bound to the global object', async () => {
  const originalFetch = globalThis.fetch;
  let receiver = null;
  globalThis.fetch = function nativeFetchStub() {
    receiver = this;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  try {
    const client = new OpenAlexClient();
    await client.json('https://api.openalex.org/institutions/I1');
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parses Retry-After seconds and HTTP dates', () => {
  const now = Date.parse('2026-07-15T20:00:00Z');
  assert.equal(parseRetryAfter('12', now), 12000);
  assert.equal(parseRetryAfter('Wed, 15 Jul 2026 20:01:00 GMT', now), 60000);
});

test('retries a short 429 using Retry-After', async () => {
  let calls = 0;
  const delays = [];
  const client = new OpenAlexClient({
    now: () => 1000,
    random: () => 0.5,
    sleep: async delayMs => delays.push(delayMs),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } })
        : new Response(JSON.stringify({ id: 'W1' }), { status: 200 });
    },
  });

  const data = await client.json('https://api.openalex.org/works/W1', { retries: 1 });

  assert.equal(data.id, 'W1');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
});

test('deduplicates identical requests and caches their response', async () => {
  let calls = 0;
  const client = new OpenAlexClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ results: [{ id: 'W1' }] }), { status: 200 });
    },
  });

  const [first, second] = await Promise.all([
    client.json('https://api.openalex.org/works?search=physics'),
    client.json('https://api.openalex.org/works?search=physics'),
  ]);
  const third = await client.json('https://api.openalex.org/works?search=physics');

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test('opens a circuit after a long 429 without issuing another request', async () => {
  let calls = 0;
  const client = new OpenAlexClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
    },
    retries: 0,
  });

  await assert.rejects(
    () => client.json('https://api.openalex.org/institutions?search=Leiden'),
    isOpenAlexRateLimitError,
  );
  await assert.rejects(
    () => client.json('https://api.openalex.org/works?search=physics'),
    isOpenAlexRateLimitError,
  );

  assert.equal(calls, 1);
  assert.equal(client.getHealth().rateLimited, true);
});

test('cancels queued requests after an active request opens the circuit', async () => {
  let calls = 0;
  const client = new OpenAlexClient({
    maxConcurrent: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
    },
  });

  const requests = [1, 2, 3].map(id => (
    client.json(`https://api.openalex.org/works/W${id}`).catch(error => error)
  ));
  const errors = await Promise.all(requests);

  assert.equal(calls, 1);
  assert.equal(errors.every(isOpenAlexRateLimitError), true);
});

test('returns stale persistent data while OpenAlex is unavailable', async () => {
  let now = 10000;
  const storage = createStorage();
  const successfulClient = new OpenAlexClient({
    storage,
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify({ id: 'I1' }), { status: 200 }),
  });
  await successfulClient.json('https://api.openalex.org/institutions/I1', {
    persistentKey: 'institution:I1',
    persistentTtlMs: 1000,
  });

  now += 2000;
  const limitedClient = new OpenAlexClient({
    storage,
    now: () => now,
    fetchImpl: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
  });
  const result = await limitedClient.json('https://api.openalex.org/institutions/I1', {
    persistentKey: 'institution:I1',
    persistentTtlMs: 1000,
    staleIfError: true,
    returnMeta: true,
  });

  assert.equal(result.data.id, 'I1');
  assert.equal(result.meta.stale, true);
});

test('limits concurrent OpenAlex requests', async () => {
  let active = 0;
  let maxActive = 0;
  const resolvers = [];
  const client = new OpenAlexClient({
    maxConcurrent: 2,
    fetchImpl: () => new Promise(resolve => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      resolvers.push(() => {
        active -= 1;
        resolve(new Response('{}', { status: 200 }));
      });
    }),
  });

  const requests = [1, 2, 3].map(id => client.json(`https://api.openalex.org/works/W${id}`));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(maxActive, 2);
  resolvers.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setTimeout(resolve, 0));
  resolvers.splice(0).forEach(resolve => resolve());
  await Promise.all(requests);
});
