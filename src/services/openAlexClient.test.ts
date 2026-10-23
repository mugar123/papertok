import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAlexClient,
  getOpenAlexRateLimitDelay,
  identifyOpenAlexUrl,
  isOpenAlexBudgetRefusal,
  isOpenAlexRateLimitError,
  parseRetryAfter,
} from './openAlexClient.ts';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
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
  const receivers: unknown[] = [];
  globalThis.fetch = function nativeFetchStub() {
    receivers.push(this);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  try {
    const client = new OpenAlexClient();
    await client.json('https://api.openalex.org/institutions/I1');
    assert.equal(receivers.at(-1), globalThis);
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

test('reads an x-ratelimit-reset epoch as an instant, not as a decades-long delta', () => {
  const now = 1_756_000_000_000;
  const limited = new Response('{}', {
    status: 429,
    headers: { 'X-RateLimit-Reset': String(now / 1000 + 300) },
  });

  assert.equal(getOpenAlexRateLimitDelay(limited, now), 300_000);
});

test('falls back to the default backoff when the reset instant already passed', () => {
  const now = 1_756_000_000_000;
  const limited = new Response('{}', {
    status: 429,
    headers: { 'X-RateLimit-Reset': String(now / 1000 - 60) },
  });

  assert.equal(getOpenAlexRateLimitDelay(limited, now), 60_000);
});

test('caps a runaway backoff at a day, whichever header carries it', () => {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const byReset = new Response('{}', {
    status: 429,
    headers: { 'X-RateLimit-Reset': '999999999' },
  });
  const byRetryAfter = new Response('{}', {
    status: 429,
    headers: { 'Retry-After': '999999999' },
  });

  assert.equal(getOpenAlexRateLimitDelay(byReset, 0), oneDayMs);
  assert.equal(getOpenAlexRateLimitDelay(byRetryAfter, 0), oneDayMs);
});

test('reopens OpenAlex once an epoch-shaped reset has passed', async () => {
  let now = 1_756_000_000_000;
  const client = new OpenAlexClient({
    now: () => now,
    fetchImpl: async () => new Response('{}', {
      status: 429,
      headers: { 'X-RateLimit-Reset': String(now / 1000 + 3600) },
    }),
  });

  await assert.rejects(
    () => client.json('https://api.openalex.org/works/W1'),
    isOpenAlexRateLimitError,
  );
  assert.equal(client.getHealth().rateLimited, true);

  now += 3_600_000 + 1;
  assert.equal(client.getHealth().rateLimited, false);
});

// A short 429 used to be asked again after its wait. Every ask is a miss the
// Worker reserves against the day's OpenAlex ceiling, and a refusal is OpenAlex
// (or the Worker's ledger) saying the budget is what is short -- asking again
// spends more of it to get the same answer. The refusal is the answer: the
// circuit opens for the wait it names and the caller fills the page from the
// other sources (PAP-86).
test('does not ask again after a 429, however short its wait', async () => {
  let calls = 0;
  const delays: unknown[] = [];
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

  await assert.rejects(
    () => client.json('https://api.openalex.org/works/W1', { retries: 1 }),
    (error: unknown) => isOpenAlexRateLimitError(error) && (error as { retryAfterMs: number }).retryAfterMs === 1000,
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
  assert.equal(client.getHealth().rateLimited, true);
});

test('retries a 502 but not a 504 the Worker sends after OpenAlex stalled', async () => {
  const callsFor = async (status: number) => {
    let calls = 0;
    const client = new OpenAlexClient({
      random: () => 0.5,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status });
      },
    });
    await client.fetch('https://api.openalex.org/works/W1', { retries: 2 }).catch(() => null);
    return calls;
  };

  assert.equal(await callsFor(502), 3);
  assert.equal(await callsFor(504), 1);
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
  } as NonNullable<ConstructorParameters<typeof OpenAlexClient>[0]> & Record<string, unknown>);

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
  const result = await limitedClient.json<{ id: string }>('https://api.openalex.org/institutions/I1', {
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
  const resolvers: (() => void)[] = [];
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

test('a priority request jumps the queue instead of waiting behind it', async () => {
  const started: unknown[] = [];
  const resolvers: (() => void)[] = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const client = new OpenAlexClient({
    maxConcurrent: 1,
    fetchImpl: (url) => new Promise(resolve => {
      started.push(new URL(url as string | URL).pathname);
      resolvers.push(() => resolve(new Response('{}', { status: 200 })));
    }),
  });

  const requests = [1, 2, 3].map(id => client.json(`https://api.openalex.org/works/W${id}`));
  await tick();
  // The feed's own search arrives while three entity lookups are already
  // queued; it must be the next request out, not the fourth.
  requests.push(client.json('https://api.openalex.org/works/W4', { priority: true }));
  while (started.length < 4) {
    const next = resolvers.shift();
    if (next) next();
    await tick();
  }
  resolvers.splice(0).forEach(resolve => resolve());
  await Promise.all(requests);
  assert.deepEqual(started, ['/works/W1', '/works/W4', '/works/W2', '/works/W3']);
});

test('a priority request does not wait for a slot the optional lookups are holding', async () => {
  const started: unknown[] = [];
  const resolvers: (() => void)[] = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const client = new OpenAlexClient({
    maxConcurrent: 1,
    fetchImpl: (url) => new Promise(resolve => {
      started.push(new URL(url as string | URL).pathname);
      resolvers.push(() => resolve(new Response('{}', { status: 200 })));
    }),
  });

  const requests = [
    client.json('https://api.openalex.org/works/W1'),
    client.json('https://api.openalex.org/works/W2'),
  ];
  await tick();
  assert.deepEqual(started, ['/works/W1'], 'the queue is full');
  // The feed's search arrives with every slot busy: it must go out now, on a
  // lane of its own, while the queued lookup keeps waiting for a slot.
  requests.push(client.json('https://api.openalex.org/works/W3', { priority: true }));
  await tick();
  assert.deepEqual(started, ['/works/W1', '/works/W3']);
  while (resolvers.length > 0 || started.length < 3) {
    resolvers.splice(0).forEach(resolve => resolve());
    await tick();
  }
  await Promise.all(requests);
  assert.deepEqual(started, ['/works/W1', '/works/W3', '/works/W2']);
});

test('a priority request in flight leaves both slots to the requests behind it', async () => {
  const started: unknown[] = [];
  const resolvers: (() => void)[] = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const client = new OpenAlexClient({
    maxConcurrent: 2,
    fetchImpl: (url) => new Promise(resolve => {
      started.push(new URL(url as string | URL).pathname);
      resolvers.push(() => resolve(new Response('{}', { status: 200 })));
    }),
  });

  // The feed's topic page goes out before the followed-entity lookups the
  // first paint waits for; they still get two slots, and the fourth waits.
  const requests = [
    client.json('https://api.openalex.org/works/W1', { priority: true }),
    ...[2, 3, 4].map(id => client.json(`https://api.openalex.org/works/W${id}`)),
  ];
  await tick();
  assert.deepEqual(started, ['/works/W1', '/works/W2', '/works/W3']);
  while (resolvers.length > 0 || started.length < 4) {
    resolvers.splice(0).forEach(resolve => resolve());
    await tick();
  }
  await Promise.all(requests);
});

test('a lookup that ends beside a priority request hands its slot to the next lookup', async () => {
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const client = new OpenAlexClient({
    maxConcurrent: 2,
    fetchImpl: (url) => new Promise(resolve => {
      const path = new URL(url as string | URL).pathname;
      started.push(path);
      resolvers.set(path, () => resolve(new Response('{}', { status: 200 })));
    }),
  });

  const requests = [
    client.json('https://api.openalex.org/works/W1'),
    client.json('https://api.openalex.org/works/W2'),
  ];
  await tick();
  requests.push(
    client.json('https://api.openalex.org/works/W3', { priority: true }),
    client.json('https://api.openalex.org/works/W4'),
  );
  await tick();
  assert.deepEqual(started, ['/works/W1', '/works/W2', '/works/W3']);
  resolvers.get('/works/W1')!();
  await tick();
  assert.deepEqual(started, ['/works/W1', '/works/W2', '/works/W3', '/works/W4']);
  resolvers.forEach(resolve => resolve());
  await Promise.all(requests);
});

test('cancels an obsolete search request without retrying it', async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = new OpenAlexClient({
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  const request = client.json('https://api.openalex.org/authors?search=obsolete', {
    signal: controller.signal,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();

  await assert.rejects(request, error => (error as Error & { code?: string; status?: number; retryAfterMs?: number }).code === 'aborted');
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
        options!.signal!.addEventListener(
          'abort',
          () => controller.error(options!.signal!.reason ?? new Error('aborted')),
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

test('the persistent store is read from storage once, and reads hand out copies', () => {
  const values = new Map<string, string>();
  let reads = 0;
  const storage = {
    getItem: (key: string) => { reads += 1; return values.has(key) ? values.get(key)! : null; },
    setItem: (key: string, value: string) => values.set(key, value),
  };
  let parses = 0;
  const originalParse = JSON.parse;
  JSON.parse = function countedParse(...args) { parses += 1; return originalParse.apply(this, args); };
  try {
    const client = new OpenAlexClient({ storage, now: () => 1000 });
    client.writePersistent('enrichment:a', { citations: 3, concepts: ['x'] });
    client.writePersistent('enrichment:b', { citations: 5 });
    assert.equal(reads, 1, 'the first write read the blob; the second found it in memory');
    const [readsAfterWrites, parsesAfterWrites] = [reads, parses];
    // The feed reads once per paper: thirteen reads, no trip to storage.
    for (let i = 0; i < 13; i++) client.readPersistent('enrichment:a');
    assert.equal(reads, readsAfterWrites, 'reads do not copy the blob out of storage again');
    assert.equal(parses, parsesAfterWrites, 'nor parse it');
    assert.deepEqual(client.readPersistent('enrichment:b')!.data, { citations: 5 });

    // A caller that edits what it got does not edit the cache.
    const read = client.readPersistent<{ concepts: string[]; citations: number }>('enrichment:a');
    read!.data.concepts.push('y');
    read!.data.citations = 99;
    assert.deepEqual(client.readPersistent('enrichment:a')!.data, { citations: 3, concepts: ['x'] });

    // Another tab writes (the `storage` event, in the browser): the store is
    // let go of, and the next read finds what that tab wrote.
    values.set('papertok_openalex_cache_v1', JSON.stringify({ 'enrichment:a': { data: { citations: 7 }, savedAt: 900 } }));
    client.forgetPersistentStore();
    assert.deepEqual(client.readPersistent('enrichment:a')!.data, { citations: 7 });
    assert.equal(client.readPersistent('enrichment:b'), null, 'and what that tab dropped is gone');
    assert.equal(reads, readsAfterWrites + 1);
  } finally {
    JSON.parse = originalParse;
  }
});

test('SOURCE: a write from another tab lets go of the remembered store', async () => {
  const { readFile } = await import('node:fs/promises');
  const code = await readFile(new URL('./openAlexClient.ts', import.meta.url), 'utf8');
  assert.match(code, /window\.addEventListener\('storage', \(event\) => \{\s*if \(event\.key === null \|\| event\.key === STORAGE_KEY\) this\.forgetPersistentStore\(\);/);
  assert.match(code, /this\.storage === window\.localStorage/, 'only the real localStorage has other tabs');
});

test('a burst of writes reaches storage once, on the next microtask', async () => {
  const values = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    setItem: (key: string, value: string) => { writes += 1; values.set(key, value); },
  };
  const client = new OpenAlexClient({ storage, now: () => 1000 });
  // The enrichment batch: two keys per work, thirty works.
  for (let i = 0; i < 30; i++) {
    client.writePersistent(`enrichment:${i}`, { citations: i });
    client.writePersistent(`enrichment:openalex:W${i}`, { citations: i });
  }
  assert.equal(writes, 0, 'nothing serialised yet');
  assert.deepEqual(client.readPersistent('enrichment:7')!.data, { citations: 7 }, 'but every write is already readable');
  await Promise.resolve();
  assert.equal(writes, 1, 'one serialisation for the sixty writes');
  assert.equal(Object.keys(JSON.parse(values.get('papertok_openalex_cache_v1')!)).length, 60);
  client.writePersistent('enrichment:late', { citations: 1 });
  client.flushPersistent();
  assert.equal(writes, 2, 'flushing on demand writes at once');
  await Promise.resolve();
  assert.equal(writes, 2, 'and the scheduled flush finds nothing pending');
});

test('the store keeps to its caps: no entry over 150k characters, and the blob under 1.2M', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => (values.has(key) ? values.get(key)! : null), setItem: (key: string, value: string) => values.set(key, value) };
  let now = 1000;
  const client = new OpenAlexClient({ storage, now: () => now });
  client.writePersistent('entity-works-v2:huge', { blob: 'x'.repeat(200_000) });
  assert.equal(client.readPersistent('entity-works-v2:huge'), null, 'an entry that alone would crowd the store is not kept');
  // Twelve entries of ~110k characters: the twelfth pushes the blob past the cap,
  // and the oldest low-priority entry goes.
  for (let i = 0; i < 12; i++) {
    now += 1;
    client.writePersistent(`entity-works-v2:${i}`, { blob: 'y'.repeat(110_000) });
  }
  assert.equal(client.readPersistent('entity-works-v2:0'), null, 'the oldest works page was evicted');
  assert.ok(client.readPersistent('entity-works-v2:11'), 'the newest stays');
  client.flushPersistent();
  assert.ok(values.get('papertok_openalex_cache_v1')!.length <= 1_200_000);
});

test('a persistentSlim response is what is kept, and what a cache hit returns', async () => {
  const storage = createStorage();
  let fetches = 0;
  const client = new OpenAlexClient({
    storage,
    now: () => 1000,
    fetchImpl: async () => { fetches += 1; return new Response(JSON.stringify({ results: [{ id: 'W1', big: 'x'.repeat(1000) }], meta: { count: 1 } }), { status: 200 }); },
  });
  const slim = (data: { results: { id: string }[]; meta: { count: number } }) => ({ ids: data.results.map((w) => w.id), total: data.meta.count });
  const first = await client.json('https://api.openalex.org/works?filter=a', { persistentKey: 'entity-works-v2:a', persistentSlim: slim });
  assert.deepEqual(first, { ids: ['W1'], total: 1 });
  const again = await client.json('https://api.openalex.org/works?filter=a', { persistentKey: 'entity-works-v2:a', persistentSlim: slim });
  assert.deepEqual(again, { ids: ['W1'], total: 1 });
  assert.equal(fetches, 1);
  assert.doesNotMatch(storage.getItem('papertok_openalex_cache_v1')!, /xxxx/, 'the raw work never reached storage');
});

// PAP-88: the Worker refuses a miss when its tier's share of the day's
// OpenAlex budget is spent, and names the tier. That refusal is about one kind
// of request: an opened paper, a free entity lookup or a card batch may still
// be served, so it must not close OpenAlex for the whole tab. A 429 without the
// header is OpenAlex refusing the key, and still does.
test('a budget-tier refusal fails that request without closing OpenAlex for the tab; a refusal without it still does', async () => {
  const answers: Record<string, () => Response> = {
    'https://api.openalex.org/works?search=physics': () => new Response('{"code":"PROVIDER_RATE_LIMITED"}', {
      status: 429,
      headers: { 'Retry-After': '300', 'X-PaperTok-Budget-Tier': 'exploration' },
    }),
    'https://api.openalex.org/works/W1': () => new Response(JSON.stringify({ id: 'W1' }), { status: 200 }),
    'https://api.openalex.org/works?filter=doi:10.1/x': () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
    'https://api.openalex.org/works/W2': () => new Response(JSON.stringify({ id: 'W2' }), { status: 200 }),
  };
  const asked: string[] = [];
  const client = new OpenAlexClient({
    storage: null,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      url.searchParams.delete('mailto');
      asked.push(url.toString());
      return answers[decodeURIComponent(url.toString())]();
    },
  });

  await assert.rejects(
    () => client.json('https://api.openalex.org/works?search=physics'),
    (error: unknown) => isOpenAlexRateLimitError(error) && (error as { retryAfterMs: number }).retryAfterMs === 300_000,
  );
  assert.deepEqual(await client.json('https://api.openalex.org/works/W1'), { id: 'W1' });
  assert.equal(client.getHealth().rateLimited, false);

  await assert.rejects(() => client.json('https://api.openalex.org/works?filter=doi:10.1/x'), isOpenAlexRateLimitError);
  assert.equal(client.getHealth().rateLimited, true);
  await assert.rejects(() => client.json('https://api.openalex.org/works/W2'), isOpenAlexRateLimitError);
  assert.equal(asked.length, 3, 'the tab asks nothing once OpenAlex itself refused');
});

// The page tells the two refusals apart: OpenAlex refusing the key is an
// outage with a wait, the Worker holding back one kind of request for the
// day's budget is not, and gets other words.
test('a budget-tier refusal is told apart from OpenAlex refusing the key, through a wrapping error too', async () => {
  const client = new OpenAlexClient({
    storage: null,
    fetchImpl: async (input) => (String(input).includes('search=')
      ? new Response('{"code":"PROVIDER_RATE_LIMITED"}', { status: 429, headers: { 'Retry-After': '300', 'X-PaperTok-Budget-Tier': 'exploration' } })
      : new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })),
  });
  const refusal = (url: string) => client.json(url).then(() => null, (error: unknown) => error);

  const paused = await refusal('https://api.openalex.org/works?search=physics');
  assert.equal(isOpenAlexRateLimitError(paused), true);
  assert.equal(isOpenAlexBudgetRefusal(paused), true);
  assert.equal(isOpenAlexBudgetRefusal(new Error('Paper search failed', { cause: paused })), true);

  const keyRefused = await refusal('https://api.openalex.org/works?filter=doi:10.1/x');
  assert.equal(isOpenAlexRateLimitError(keyRefused), true);
  assert.equal(isOpenAlexBudgetRefusal(keyRefused), false);
  assert.equal(isOpenAlexBudgetRefusal(null), false);
});
