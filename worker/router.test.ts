import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import worker from './index.ts';
import { routeForLog } from './router.ts';
import { PAPER_STORE_PING_CRON } from './paper-store.ts';
import { testD1 } from './test-support/sqlite-d1.ts';
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

// The paper store's D1 with its migrations, counting the statements it runs;
// `onStatement` runs as each one starts.
function countingPaperStore(onStatement = () => {}) {
  const { binding } = testD1();
  const store = { statements: 0 };
  const counted = <Result>(execute: () => Promise<Result>) => {
    store.statements += 1;
    onStatement();
    return execute();
  };
  const PAPER_STORE = {
    prepare(sql: string) {
      const statement = binding.prepare(sql);
      return { first: () => counted(() => statement.first()), all: () => counted(() => statement.all()), run: () => counted(() => statement.run()) };
    },
  } as unknown as D1Database;
  return { store, PAPER_STORE };
}

function consoleLines(t: TestContext) {
  const lines: unknown[][] = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, level, (...args: unknown[]) => { lines.push(args); });
  return lines;
}

const minute = { scheduledTime: Date.parse('2026-10-31T21:43:00Z'), cron: PAPER_STORE_PING_CRON };

test('the minute cron runs one statement on the paper store, no other job and no log line', async t => {
  const lines = consoleLines(t);
  const { store, PAPER_STORE } = countingPaperStore();
  const notifications: string[] = [];
  const NOTIFICATION_STORE = Object.fromEntries(['get', 'put', 'list', 'delete'].map(method => [method, async () => {
    notifications.push(method);
    return method === 'list' ? { keys: [], list_complete: true } : null;
  }])) as unknown as KVNamespace;
  const harvests: unknown[] = [];
  const PAPER_HARVEST = { create: async (options: unknown) => { harvests.push(options); } } as unknown as WorkerEnv['PAPER_HARVEST'];
  const jobs: Promise<unknown>[] = [];
  await worker.scheduled(minute, { PAPER_STORE, NOTIFICATION_STORE, PAPER_HARVEST }, { waitUntil: job => jobs.push(job) });
  await Promise.all(jobs);
  assert.equal(store.statements, 1);
  assert.deepEqual(notifications, []);
  assert.deepEqual(harvests, []);
  assert.deepEqual(lines, []);
});

test('a paper store ping held past 2 s writes one line with its duration only', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T21:43:20Z') });
  const lines = consoleLines(t);
  const { PAPER_STORE } = countingPaperStore(() => t.mock.timers.tick(25_400));
  const jobs: Promise<unknown>[] = [];
  await worker.scheduled(minute, { PAPER_STORE }, { waitUntil: job => jobs.push(job) });
  await Promise.allSettled(jobs);
  assert.deepEqual(lines.map(args => args.map(arg => JSON.parse(String(arg)))), [[{ event: 'slow_paper_store_ping', totalMs: 25_400 }]]);
});

test('a paper store ping that fails fails the cron run instead of passing as a quiet minute', async t => {
  consoleLines(t);
  const PAPER_STORE = { prepare: () => ({ first: async () => { throw new Error('D1_ERROR: storage operation exceeded timeout'); } }) } as unknown as D1Database;
  const jobs: Promise<unknown>[] = [];
  await assert.rejects(worker.scheduled(minute, { PAPER_STORE }, { waitUntil: job => jobs.push(job) }), /D1_ERROR/);
  await Promise.allSettled(jobs);
});

// Cloudflare hands the handler the expression as wrangler.toml spells it, and
// the handler runs the email schedule for any expression it does not know: a
// respelled ping cron would run that schedule every minute.
test('wrangler.toml triggers the paper store ping by the expression the handler dispatches', () => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const crons = /^crons\s*=\s*(\[[^\]\n]*\])/m.exec(config)?.[1];
  assert.ok(crons, 'wrangler.toml lists [triggers] crons');
  assert.ok((JSON.parse(crons) as string[]).includes(PAPER_STORE_PING_CRON));
});

for (const path of ['/recommendations', '/store/feed', '/lists/attribute']) {
  test(`retired route ${path} does not call a provider`, async () => {
    const response = await worker.fetch(new Request(`https://worker.test${path}`), {});
    assert.equal(response.status, 404);
  });
}
