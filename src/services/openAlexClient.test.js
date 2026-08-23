import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAlexClient,
  getOpenAlexRateLimitDelay,
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

test('recognizes the exhausted OpenAlex allowance returned as HTTP 403', () => {
  const response = new Response('{}', {
    status: 403,
    headers: {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '120',
    },
  });

  assert.equal(getOpenAlexRateLimitDelay(response, 0), 120_000);
  assert.equal(getOpenAlexRateLimitDelay(new Response('{}', { status: 403 }), 0), 0);
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

test('cancels an obsolete search request without retrying it', async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = new OpenAlexClient({
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  const request = client.json('https://api.openalex.org/authors?search=obsolete', {
    signal: controller.signal,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();

  await assert.rejects(request, error => error.code === 'aborted');
  assert.equal(calls, 1);
});

test('routes OpenAlex through the Worker when one is configured', () => {
  const identified = identifyOpenAlexUrl(
    'https://api.openalex.org/works?filter=doi:10.1/a&per-page=50',
    'app@papertok.io',
    'https://papertok-report-api.example/',
  );
  const url = new URL(identified);

  assert.equal(url.origin, 'https://papertok-report-api.example');
  assert.equal(url.pathname, '/openalex/works');
  assert.equal(url.searchParams.get('filter'), 'doi:10.1/a');
  assert.equal(url.searchParams.get('per-page'), '50');
  // OpenAlex now bills per call, so the credential stays in the Worker; the
  // polite pool that `mailto` joined no longer exists.
  assert.equal(url.searchParams.get('mailto'), null);
});

test('never forwards a credential the caller supplied', () => {
  const url = new URL(identifyOpenAlexUrl(
    'https://api.openalex.org/works?filter=doi:10.1/a&api_key=stolen',
    'app@papertok.io',
    'https://papertok-report-api.example',
  ));
  assert.equal(url.searchParams.get('api_key'), null);
});

test('keeps the entity path, including an identifier that carries a slash', () => {
  const url = new URL(identifyOpenAlexUrl(
    'https://api.openalex.org/works/doi:10.1016%2Fj.jmst.2026.06.058',
    'app@papertok.io',
    'https://papertok-report-api.example',
  ));
  assert.equal(url.pathname, '/openalex/works/doi:10.1016%2Fj.jmst.2026.06.058');
});

test('still goes direct when no Worker is configured, as it did before', () => {
  const url = new URL(identifyOpenAlexUrl(
    'https://api.openalex.org/works?filter=doi:10.1/a',
    'app@papertok.io',
    '',
  ));
  assert.equal(url.hostname, 'api.openalex.org');
  assert.equal(url.searchParams.get('mailto'), 'app@papertok.io');
});

test('cuts a response whose headers arrive and whose body never finishes', async () => {
  // `json()` reads the body far from `fetchOnce`, and the response is cached and
  // cloned on the way there. A timer cleared when `fetch` resolved therefore
  // stopped covering the one part of the exchange that stalls.
  const client = new OpenAlexClient({
    fetchImpl: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":'));
        options.signal.addEventListener(
          'abort',
          () => controller.error(options.signal.reason ?? new Error('aborted')),
          { once: true },
        );
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  const hung = Symbol('hung');
  const outcome = await Promise.race([
    client.json('https://api.openalex.org/works/W1', { timeoutMs: 25, retries: 0 })
      .then(() => 'resolved', error => error.code),
    new Promise(resolve => setTimeout(() => resolve(hung), 2_000)),
  ]);

  assert.notEqual(outcome, hung, 'the request was still hanging after 2000ms');
  assert.equal(outcome, 'timeout');
});
