import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './index.ts';
import { routeForLog } from './router.ts';
import type { WorkerEnv } from './env.ts';
import type { TestGlobals, TestNamespace } from './test-types.ts';
import type { runEmailNotificationSchedule } from './email-notifications.ts';
type ScheduleSummary = Awaited<ReturnType<typeof runEmailNotificationSchedule>>;

const ORIGIN = 'http://localhost:5173';
const request = (path: string, method = 'GET', origin = ORIGIN) => new Request(`https://api.papertok.test${path}`, {
  method,
  headers: origin ? { origin } : {},
});

for (const path of ['/missing', '/share/paper/missing', '/account/delete', '/related', '/notifications/unsubscribe']) {
  test(`OPTIONS ${path} runs before route access checks`, async () => {
    const response = await worker.fetch(request(path, 'OPTIONS'), {});
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, PUT, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-headers'), 'authorization, content-type');
    assert.equal(response.headers.get('access-control-max-age'), '86400');
  });
}

test('a disallowed preflight still returns 204 without granting CORS', async () => {
  const response = await worker.fetch(request('/account/delete', 'OPTIONS', 'https://other.example'), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('unknown paths preserve GET 404 and other-method 405 with allowed-origin CORS', async () => {
  for (const method of ['GET', 'POST', 'HEAD']) {
    const response = await worker.fetch(request('/missing', method), {});
    assert.equal(response.status, method === 'GET' ? 404 : 405);
    assert.deepEqual(await response.json(), { error: method === 'GET' ? 'Not found' : 'Method not allowed' });
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('the public configuration health route does not become origin-gated', async () => {
  const response = await worker.fetch(request('/health', 'GET', 'https://other.example'), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json<{ ok: boolean }>()).ok, true);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('/health names the deployed version by id and tag only', async () => {
  const versionOf = async (env: WorkerEnv) => (await (await worker.fetch(request('/health'), env)).json<{ version: { id: string; tag: string | null } | null }>()).version;
  const metadata = { id: '0f6c2a51-6b0e-4f3d-9d6a-2c1e8f7b4a90', tag: 'd162b083', timestamp: '2026-10-16T09:00:00.000Z' };

  assert.deepEqual(await versionOf({ CF_VERSION_METADATA: metadata }), { id: metadata.id, tag: 'd162b083' });
  assert.deepEqual(await versionOf({ CF_VERSION_METADATA: { ...metadata, tag: '' } }), { id: metadata.id, tag: null });
  assert.equal(await versionOf({}), null);
});

async function warningsDuring(callback: () => Promise<void>) {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

const failureLines = (warnings: unknown[][]) => warnings.map(args => {
  assert.equal(args.length, 1);
  const [line] = args;
  assert.ok(typeof line === 'string');
  return JSON.parse(line);
});

test('a relayed refusal leaves one log line with the route and status, without the id or the query', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => new Response('{"error":"Rate limit exceeded"}', { status: 429 });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  let response: Response | undefined;
  let warnings: unknown[][];
  try {
    warnings = await warningsDuring(async () => {
      response = await worker.fetch(request('/openalex/works/W2741809807?search=my+private+question'), {
        REQUEST_QUOTA_LEDGER: {
          idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
          get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) })) as TestNamespace['get'],
        } as WorkerEnv['REQUEST_QUOTA_LEDGER'],
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }

  assert.equal(response?.status, 429);
  assert.deepEqual(failureLines(warnings), [{ route: '/openalex/works', status: 429 }]);
});

test('an unsubscribe failure is logged without its token', async () => {
  const path = '/notifications/unsubscribe?token=abcdefghijklmnop0123';
  let response: Response | undefined;
  const warnings = await warningsDuring(async () => {
    response = await worker.fetch(request(path), {});
  });

  assert.equal(response?.status, 503);
  assert.deepEqual(failureLines(warnings), [{ route: '/notifications/unsubscribe', status: 503 }]);
});

test('an uncaught throw is logged as the 500 the reader gets, and still thrown', async () => {
  const path = '/notifications/unsubscribe?token=abcdefghijklmnop0123';
  const warnings = await warningsDuring(async () => {
    await assert.rejects(
      worker.fetch(request(path), {
        NOTIFICATION_STORE: { get: async () => { throw new Error('KV unavailable'); } } as KVNamespace & { get(): Promise<never> },
      }),
      /KV unavailable/,
    );
  });

  assert.deepEqual(failureLines(warnings), [{ route: '/notifications/unsubscribe', status: 500 }]);
});

test('answers below 500 other than 429 leave no log line', async () => {
  const statuses: number[] = [];
  const warnings = await warningsDuring(async () => {
    for (const path of ['/health', '/missing', '/openalex/secrets']) {
      statuses.push((await worker.fetch(request(path), {})).status);
    }
  });

  assert.deepEqual(statuses, [200, 404, 400]);
  assert.deepEqual(warnings, []);
});

test('the logged route keeps only the fixed part of the path', () => {
  const cases = {
    '/openalex/works/W2741809807': '/openalex/works',
    '/openalex/works/doi:10.1038/nature12373': '/openalex/works',
    '/openalex/W2741809807': '/openalex',
    '/share/paper/arxiv%3A2609.28470': '/share',
    '/share/list/x7Kq2mPz': '/share',
    '/notifications/unsubscribe': '/notifications/unsubscribe',
    '/sources/s2': '/sources/s2',
    '/citation-graph': '/citation-graph',
    '/health': '/health',
    '/health/openalex': '/health/openalex',
    '/health/openalex/budget': '/health/openalex/budget',
    '/10.1038/nature12373': '/',
    '/203.0.113.7': '/',
  };
  for (const [pathname, route] of Object.entries(cases)) {
    assert.equal(routeForLog(pathname), route, pathname);
  }
});

for (const method of ['GET', 'POST']) {
  test(`unsubscribe ${method} bypasses the notification Origin gate and stays HTML`, async () => {
    const response = await worker.fetch(request('/notifications/unsubscribe', method, 'https://other.example'), {
      NOTIFICATION_STORE: { get: async () => null } as KVNamespace & { get(): Promise<null> },
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type')!, /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(await response.text(), /<html lang="en">/);
  });
}

test('unsubscribe PUT still goes through the notification Origin gate', async () => {
  const response = await worker.fetch(request('/notifications/unsubscribe', 'PUT', 'https://other.example'), {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { code: 'EMAIL_ORIGIN_NOT_ALLOWED' });
});

for (const path of ['/related', '/citation-graph', '/sources/core', '/sources/physics', '/sources/scopus']) {
  test(`${path} requires identity before validating a query or reading the cache`, async () => {
    const response = await worker.fetch(request(path), { FIREBASE_WEB_API_KEY: 'test-key' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: 'AUTH_REQUIRED' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  });
}

test('the scheduled entry point passes the event time and keeps the job alive with waitUntil', async () => {
  const jobs: Promise<ScheduleSummary>[] = [];
  const saved: Array<{ key: string; value: ScheduleSummary }> = [];
  const scheduledTime = Date.parse('2026-10-13T07:20:00Z');
  await worker.scheduled({ scheduledTime }, {
    NOTIFICATION_STORE: { put: async (key: string, value: string) => saved.push({ key, value: JSON.parse(value) }) } as KVNamespace & { put(key: string, value: string): Promise<number> },
  }, { waitUntil: job => jobs.push(job) });
  assert.equal(jobs.length, 1);
  const [summary] = await Promise.all(jobs);
  assert.equal(summary.scheduledAt, '2026-10-13T07:20:00.000Z');
  assert.equal(summary.disabled, true);
  assert.equal(summary.sent, 0);
  assert.ok(saved.some(({ value }) => value.scheduledAt === '2026-10-13T07:20:00.000Z'));
});

for (const path of ['/recommendations', '/store/feed', '/lists/attribute']) {
  test(`retired route ${path} does not call a provider`, async () => {
    const response = await worker.fetch(new Request(`https://worker.test${path}`), {});
    assert.equal(response.status, 404);
  });
}
