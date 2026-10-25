import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { WorkerEnv } from './env.ts';
import type { LedgerTransaction } from './ledger-storage.ts';
import type { TestGlobals, TestNamespace } from './test-types.ts';
import { RequestQuotaLedger } from './request-quota-ledger.ts';
import reportApi from './index.ts';

const PDF = '%PDF-1.7\n%test\n';
const SECRET = 'test-only-pdf-rate-limit-key-32-bytes';
const NATIVE = 'papertok-report-api.papertok-mugar123.workers.dev';

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-24T12:00:00Z') });
  const objects = new Map<string, ReturnType<typeof object>>();
  const requests: string[] = [];
  const upstream: string[] = [];
  let cached = false;
  function object() {
    const values = new Map<string, unknown>();
    let alarm: number | null = null;
    let pending = Promise.resolve();
    const transaction: LedgerTransaction = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key, value) => values.set(key, value),
      delete: key => values.delete(key),
    };
    const ledger = new RequestQuotaLedger({ storage: {
      // Durable Object storage serializes conflicting transactions. The fixture
      // must do the same when requests reach it concurrently.
      transaction: <T>(callback: (tx: LedgerTransaction) => Promise<T>) => {
        const result = pending.then(() => callback(transaction));
        pending = result.then(() => undefined, () => undefined);
        return result;
      },
      getAlarm: async () => alarm,
      setAlarm: async value => { alarm = Number(value); },
      deleteAll: async () => values.clear(),
    } });
    return { ledger, values, alarm: () => alarm };
  }
  const namespace: TestNamespace = {
    idFromName: name => name,
    get: id => ({ fetch: async (url, init) => {
      const name = String(id);
      if (!objects.has(name)) objects.set(name, object());
      requests.push(String(init?.body));
      return objects.get(name)!.ledger.fetch(new Request(String(url), init));
    } }),
  };
  const env: WorkerEnv = {
    REQUEST_QUOTA_LEDGER: namespace as Env['REQUEST_QUOTA_LEDGER'],
    PDF_RATE_LIMIT_SECRET: SECRET,
  };
  const globals = globalThis as TestGlobals;
  const previousCaches = globals.caches;
  globals.caches = { default: {
    match: async () => cached ? new Response(PDF, { headers: { 'content-type': 'application/pdf' } }) : undefined,
    put: async () => undefined,
  } };
  t.after(() => {
    if (previousCaches) globals.caches = previousCaches;
    else delete globals.caches;
  });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    upstream.push(String(input));
    return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
  });
  const ask = (ip = '192.0.2.1', host = 'api.papertok.app', options: RequestInit = {}) => reportApi.fetch(
    new Request(`https://${host}/pdf?url=${encodeURIComponent('https://arxiv.org/pdf/2601.00001')}`, {
      ...options, headers: { origin: 'https://papertok.app', 'cf-connecting-ip': ip, ...options.headers },
    }), env,
  );
  return { env, ask, objects, requests, upstream, cache: (value: boolean) => { cached = value; } };
}

test('a concurrent burst shares the IP allowance across domains and leaves quota for another reader', async t => {
  const h = harness(t);
  const responses = await Promise.all(Array.from({ length: 120 }, (_, i) => h.ask('192.0.2.1', i % 2 ? NATIVE : 'api.papertok.app')));
  assert.equal(responses.filter(response => response.status === 200).length, 30);
  assert.equal(responses.filter(response => response.status === 429).length, 90);
  assert.equal(h.upstream.length, 30);
  const refusal = responses.find(response => response.status === 429)!;
  assert.deepEqual(await refusal.json(), { code: 'PROVIDER_RATE_LIMITED' });
  assert.equal(refusal.headers.get('access-control-allow-origin'), 'https://papertok.app');
  assert.equal(refusal.headers.get('access-control-expose-headers'), 'retry-after');
  assert.equal(refusal.headers.get('retry-after'), '60');
  assert.equal(refusal.headers.get('cache-control'), 'no-store');
  assert.equal((await h.ask('192.0.2.2')).status, 200);
  assert.equal(h.upstream.length, 31);
  assert.equal(h.objects.get('pdf:2026-10-24T12:00')!.values.get('global'), 31);
});

test('cached PDFs count against the IP allowance without spending the upstream ceiling', async t => {
  const h = harness(t);
  h.cache(true);
  for (let i = 0; i < 30; i++) assert.equal((await h.ask()).status, 200);
  assert.equal((await h.ask()).status, 429);
  assert.equal(h.upstream.length, 0);
  assert.equal(h.objects.get('pdf:2026-10-24T12:00')!.values.get('global'), 0);
  h.cache(false);
  assert.equal((await h.ask('192.0.2.2')).status, 200);
  assert.equal(h.upstream.length, 1);
});

test('the shared ceiling still refuses misses while allowing a different reader to use a cached PDF', async t => {
  const h = harness(t);
  const responses = await Promise.all(Array.from({ length: 150 }, (_, i) => h.ask(`192.0.2.${Math.floor(i / 30) + 1}`)));
  assert.equal(responses.filter(response => response.status === 200).length, 120);
  assert.equal(responses.filter(response => response.status === 429).length, 30);
  assert.equal(h.upstream.length, 120);
  h.cache(true);
  assert.equal((await h.ask('192.0.2.200')).status, 200);
  assert.equal(h.objects.get('pdf:2026-10-24T12:00')!.values.get('global'), 120);
});

test('IP identifiers change each minute, contain no address, and are deleted by the cleanup alarm', async t => {
  const h = harness(t);
  for (let i = 0; i < 30; i++) assert.equal((await h.ask()).status, 200);
  t.mock.timers.tick(59_000);
  const blocked = await h.ask();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '1');
  const first = h.objects.get('pdf:2026-10-24T12:00')!;
  assert.equal(first.alarm(), Date.parse('2026-10-24T12:02:00Z'));
  const firstSubject = [...first.values.keys()].find(key => key.startsWith('subject:'))!;
  assert.match(firstSubject, /^subject:[a-f0-9]{64}$/);
  t.mock.timers.tick(1_000);
  assert.equal((await h.ask('192.0.2.1', NATIVE)).status, 200);
  const next = h.objects.get('pdf:2026-10-24T12:01')!;
  const nextSubject = [...next.values.keys()].find(key => key.startsWith('subject:'))!;
  assert.notEqual(nextSubject, firstSubject);
  assert.equal(next.values.get('global'), 1);
  for (const request of h.requests) {
    assert.equal(request.includes('192.0.2.1'), false);
    assert.equal(request.includes(SECRET), false);
    assert.equal(request.includes('arxiv.org'), false);
  }
  t.mock.timers.tick(60_000);
  await first.ledger.alarm();
  assert.equal(first.values.size, 0);
  assert.equal(next.values.get('global'), 1);
});

test('equivalent IPv6 addresses and readers behind the same IP share an allowance', async t => {
  const h = harness(t);
  for (let i = 0; i < 30; i++) assert.equal((await h.ask('2001:db8::1')).status, 200);
  assert.equal((await h.ask('2001:0db8:0:0:0:0:0:1', NATIVE)).status, 429);
  assert.equal((await h.ask('2001:db8::2', NATIVE)).status, 200);
});

test('missing identity, secret or ledger fails closed even for a cached PDF', async t => {
  const h = harness(t);
  h.cache(true);
  for (const ip of ['', 'not-an-ip', '999.0.0.1', '192.0.2.1, 192.0.2.2', '2001:broken::1']) {
    assert.equal((await h.ask(ip, NATIVE, { headers: { 'x-forwarded-for': '192.0.2.5' } })).status, 503);
  }
  for (const secret of [undefined, 'short']) {
    h.env.PDF_RATE_LIMIT_SECRET = secret;
    assert.equal((await h.ask()).status, 503);
  }
  h.env.PDF_RATE_LIMIT_SECRET = SECRET;
  delete h.env.REQUEST_QUOTA_LEDGER;
  assert.equal((await h.ask()).status, 503);
  assert.equal(h.requests.length, 0);
  assert.equal(h.upstream.length, 0);
});

test('preflight, rejected methods, bad origins and disallowed PDFs spend no quota', async t => {
  const h = harness(t);
  assert.equal((await h.ask('192.0.2.1', NATIVE, { method: 'OPTIONS' })).status, 204);
  assert.equal((await h.ask('192.0.2.1', NATIVE, { method: 'POST' })).status, 405);
  assert.equal((await h.ask('192.0.2.1', NATIVE, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await reportApi.fetch(new Request('https://api.papertok.app/pdf?url=https://evil.example/a.pdf', {
    headers: { origin: 'https://papertok.app', 'cf-connecting-ip': '192.0.2.1' },
  }), h.env)).status, 400);
  assert.equal(h.requests.length, 0);
  assert.equal(h.upstream.length, 0);
});
