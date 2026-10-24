import type { TestNamespace } from './test-types.ts';
import type { QuotaReading } from './request-quota-ledger.ts';
type MockProvider = (url: string, options?: RequestInit) => Response | Promise<Response>;
type QuotaAction = { action: string; periodKey: string; subjectKey: string; amount?: number; tally?: string };
type QuotaState = { reservations: number; releases?: number; periodKeys: string[] };
type QuotaScriptState = { actions: QuotaAction[] };
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodePaperKey } from '../src/utils/public-navigation.ts';
import { OPENALEX_PEER_REVIEWED_FILTER } from '../src/utils/publication-status.ts';
import reportApi from './index.ts';
import { PaperRewriteSession } from './ai-rewrite-session.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { handleHarvestOpenAlex } from './openalex-api.ts';
import { fetchWithDeadline, OPENALEX_HARVEST_DAILY_UNITS, OPENALEX_NEW_FOLLOWS_DAILY_UNITS, OPENALEX_OBSERVATION_MARGIN, OPENALEX_TIER_PERCENT, OPENALEX_UNIT_USD, readOpenAlexBudget } from './provider-runtime.ts';
import { PACE_RETRY_AFTER_SECONDS } from './upstream-pace.ts';
import { dribblingFetch, settleWithin, withStubbedFetch } from '../src/test-support/deadline-harness.ts';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import type { WorkerEnv } from './env.ts';

async function withWorkerFetchMock<Result>(fetchImplementation: typeof fetch, callback: () => Promise<Result>) {
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = fetchImplementation;
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (): Promise<Response | null | undefined> => null,
      put: async (): Promise<unknown> => undefined,
    },
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

test('allows the notification preferences PUT request through CORS', async () => {
  const request = new Request('https://papertok-report-api.example/notifications/preferences', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://mugar123.github.io',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization, content-type',
    },
  });

  const response = await reportApi.fetch(request, {});

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
  assert.match(response.headers.get('access-control-allow-methods')!, /(?:^|,\s*)PUT(?:,|$)/);
});

test('the retired /locale route no longer reveals the caller\'s country', async () => {
  // PaperTok is English-only, so nothing chooses a language from the country.
  const request = new Request('https://papertok-report-api.example/locale', {
    headers: { origin: 'https://mugar123.github.io' },
  });
  Object.defineProperty(request, 'cf', { value: { country: 'MX' } });

  const response = await reportApi.fetch(request, {});

  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /MX/);
});

test('the retired /ai/hooks and /ai/explain routes answer 405 and spend nothing', async () => {
  const ledger = recordingLedger();
  const fetched: string[] = [];
  const env = {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    AI_PROVIDER: 'nan',
    NAN_API_KEY: 'sk-test-key',
    GEMINI_API_KEY: 'gemini-test-key',
    REQUEST_QUOTA_LEDGER: ledger.binding,
  };
  await withWorkerFetchMock(async input => {
    fetched.push(String((input as Request)?.url || input));
    return new Response('{}');
  }, async () => {
    for (const path of ['/ai/hooks', '/ai/explain']) {
      const response = await reportApi.fetch(new Request(`https://papertok-report-api.example${path}`, {
        method: 'POST',
        headers: {
          origin: 'https://mugar123.github.io',
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          papers: [{ id: 'p1', title: 'A paper', abstract: 'x'.repeat(300) }],
          paper: { title: 'A paper', abstract: 'x'.repeat(300) },
          level: 'university',
        }),
      }), env);
      assert.equal(response.status, 405, path);
    }
  });

  assert.deepEqual(fetched, []);
  assert.deepEqual(ledger.reservations, []);
});

test('returns an unhealthy status when the email provider works but the scheduler is stale', async () => {
  const env = {
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'PaperTok <hello@papertok.app>',
    NOTIFICATION_STORE: {
      get: async () => ({
        scheduledAt: '2026-01-01T07:00:00.000Z',
        completedAt: '2026-01-01T07:01:00.000Z',
        scanned: 1,
      }),
    } as KVNamespace & { get(): Promise<object> },
  };
  const response = await withWorkerFetchMock(async () => new Response(JSON.stringify({
    data: [{ name: 'papertok.app', status: 'verified' }],
  }), { headers: { 'content-type': 'application/json' } }), () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/health/email',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), env));

  assert.equal(response.status, 503);
  const payload = await response.json<{ available: boolean; schedule: { fresh: boolean; code: string } }>();
  assert.equal(payload.available, true);
  assert.equal(payload.schedule.fresh, false);
  assert.equal(payload.schedule.code, 'EMAIL_SCHEDULE_STALE');
});

test('serves the email health probe from the edge cache', async () => {
  // Edge caching keeps repeated health requests off the provider API.
  let providerCalls = 0;
  const env = {
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'PaperTok <hello@papertok.app>',
    EMAIL_DELIVERY_LEDGER: { idFromName: ((): unknown => 'day') as TestNamespace['idFromName'], get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response('{}') })) as TestNamespace['get'] } as Env['REQUEST_QUOTA_LEDGER'],
    NOTIFICATION_STORE: {
      get: async () => ({
        scheduledAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        scanned: 1,
      }),
    } as KVNamespace & { get(): Promise<object> },
  };
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  const stored = new Map<string, Response>();
  (globalThis as TestGlobals).caches = {
    default: {
      async match(key): Promise<Response | null | undefined> {
        const hit = stored.get(String((key as Request).url));
        return hit ? hit.clone() : null;
      },
      async put(key, response): Promise<void> {
        stored.set(String((key as Request).url), response.clone());
      },
    },
  };
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ data: [{ name: 'papertok.app', status: 'verified' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const emailHealthRequest = () => new Request(
      'https://papertok-report-api.example/health/email',
      { headers: { origin: 'https://mugar123.github.io' } },
    );
    const first = await reportApi.fetch(emailHealthRequest(), env);
    const second = await reportApi.fetch(emailHealthRequest(), env);

    assert.equal(first.status, 200);
    assert.match(first.headers.get('cache-control')!, /s-maxage=300/);
    assert.equal(second.status, 200);
    assert.equal(providerCalls, 1);
    assert.equal((await second.json<{ available: boolean }>()).available, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('reports a missing email delivery ledger binding as unhealthy', async () => {
  const env = {
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'PaperTok <hello@papertok.app>',
    NOTIFICATION_STORE: {
      get: async () => ({
        scheduledAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        scanned: 1,
      }),
    } as KVNamespace & { get(): Promise<object> },
  };
  const response = await withWorkerFetchMock(async () => new Response(JSON.stringify({
    data: [{ name: 'papertok.app', status: 'verified' }],
  }), { headers: { 'content-type': 'application/json' } }), () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/health/email',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), env));

  assert.equal(response.status, 503);
  const payload = await response.json<{ available: boolean; schedule: { fresh: boolean }; ledger: { ok: boolean; code: string } }>();
  assert.equal(payload.available, true);
  assert.equal(payload.schedule.fresh, true);
  assert.equal(payload.ledger.ok, false);
  assert.equal(payload.ledger.code, 'EMAIL_DELIVERY_LEDGER_MISSING');
});

test('proxies OpenReview forum papers while excluding imported public records', async () => {
  let upstreamUrl = '';
  const response = await withWorkerFetchMock(async url => {
    upstreamUrl = String(url);
    return new Response(JSON.stringify({
      count: 2,
      notes: [
        { id: 'imported', forum: 'imported', domain: 'DBLP.org/2026', content: { title: { value: 'Imported' } } },
        {
          id: 'submission',
          forum: 'submission',
          domain: 'ICLR.cc/2026/Conference',
          content: { title: { value: 'Learning result' }, abstract: { value: 'Abstract.' } },
        },
      ],
    }), { headers: { 'content-type': 'application/json' } });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/openreview?q=machine%20learning&limit=5&sort=recent',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(response.status, 200);
  assert.match(upstreamUrl, /api2\.openreview\.net\/notes\/search/);
  assert.match(upstreamUrl, /source=forum/);
  // api2 refuses `query` with a 400 (measured 2026-10-16); the search text is `term`.
  assert.equal(new URL(upstreamUrl).searchParams.get('term'), 'machine learning');
  assert.equal(new URL(upstreamUrl).searchParams.has('query'), false);
  const payload = await response.json<{ notes: Array<{ id: string }> }>();
  assert.equal(payload.notes.length, 1);
  assert.equal(payload.notes[0].id, 'submission');
});

// api2's search accepts `sort=cdate:desc` and does nothing with it: measured
// 2026-09-02, `cdate:asc`, `cdate:desc`, `tmdate:*` and no sort at all returned
// the same sequence for three different queries (`tcdate`, `mdate` and `pdate`
// are refused with a 400). So the recent ordering is the Worker's to produce,
// over the relevance pool `limit * 3` already fetches, and with the same date
// precedence the client shows on the card: `pdate`, then `cdate`, then `tcdate`.
test('orders OpenReview by date itself because api2 accepts the sort and ignores it', async () => {
  const notes = [
    { id: 'older', forum: 'older', domain: 'ICLR.cc/2024/Conference', cdate: 1_700_000_000_000, content: { title: { value: 'Older' } } },
    { id: 'newest', forum: 'newest', domain: 'ICLR.cc/2026/Conference', cdate: 1_760_000_000_000, content: { title: { value: 'Newest' } } },
    {
      id: 'published-late',
      forum: 'published-late',
      domain: 'ICLR.cc/2025/Conference',
      cdate: 1_710_000_000_000,
      pdate: 1_780_000_000_000,
      content: { title: { value: 'Published late' } },
    },
  ];
  const upstream: { searchParams: { has: (arg0: string) => unknown; }; }[]|URL[] = [];
  const fetchMock: typeof fetch = async url => {
    upstream.push(new URL(String(url)));
    return new Response(JSON.stringify({ count: 3, notes }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const recent = await withWorkerFetchMock(fetchMock, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/openreview?q=neuroscience&limit=5&sort=recent',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(recent.status, 200);
  assert.equal(upstream[0].searchParams.has('sort'), false, 'a sort api2 ignores is not worth sending');
  assert.deepEqual((await recent.json<{ notes: Array<{ id: unknown }> }>()).notes.map(note => note.id), ['published-late', 'newest', 'older']);

  const relevance = await withWorkerFetchMock(fetchMock, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/openreview?q=neuroscience&limit=5',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(relevance.status, 200);
  assert.deepEqual((await relevance.json<{ notes: Array<{ id: unknown }> }>()).notes.map(note => note.id), ['older', 'newest', 'published-late'], 'relevance keeps the upstream order');
});

test('proxies Hugging Face paper search through the specialist source contract', async () => {
  const response = await withWorkerFetchMock(async url => {
    assert.match(String(url), /huggingface\.co\/api\/papers\/search/);
    return new Response(JSON.stringify([{ paper: { id: '2607.12345', title: 'Model paper' } }]), {
      headers: { 'content-type': 'application/json' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/huggingface?q=language%20models&limit=4',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(response.status, 200);
  const payload = await response.json<{ papers: Array<{ paper: { id: string } }> }>();
  assert.equal(payload.papers[0].paper.id, '2607.12345');
});

test('gives every source upstream a deadline it can be cut with', async () => {
  let seenSignal: AbortSignal | null | undefined;
  const response = await withWorkerFetchMock(async (url, options) => {
    assert.match(String(url), /ebi\.ac\.uk\/europepmc/);
    seenSignal = options?.signal;
    return new Response(JSON.stringify({ resultList: { result: [] } }), {
      headers: { 'content-type': 'application/json' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/europepmc?q=malaria&limit=4',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(response.status, 200);
  // A hung provider used to hold the subrequest open with nothing to cut it.
  assert.ok(seenSignal, 'the upstream fetch carries no AbortSignal');
  assert.equal(seenSignal.aborted, false);
});

test('an aborted source upstream answers as a failure, not as a hung request', async () => {
  // What the deadline does once it fires. Asserted with an immediate rejection
  // rather than a real six-second wait, which would cost that on every run.
  const response = await withWorkerFetchMock(async () => {
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/europepmc?q=malaria&limit=4',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(response.status, 502);
});

test('validates and batches NIH iCite PubMed identifiers', async () => {
  let upstreamUrl = '';
  const response = await withWorkerFetchMock(async url => {
    upstreamUrl = String(url);
    return new Response(JSON.stringify({ data: [{ pmid: 123, citation_count: 7 }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/enrich/icite?pmids=123,456',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(response.status, 200);
  assert.match(upstreamUrl, /icite\.od\.nih\.gov\/api\/pubs/);
  assert.match(upstreamUrl, /pmids=123%2C456/);
  assert.deepEqual(await response.json(), { data: [{ pmid: 123, citation_count: 7 }] });
});

const SCOPUS_EGRESS = Object.freeze({
  SCOPUS_PROXY_URL: 'https://scopus-proxy.example',
  SCOPUS_PROXY_SECRET: 's'.repeat(48),
});

function openAlexEnv(extra = {}) {
  return {
    OPENALEX_API_KEY: 'worker-key',
    REQUEST_QUOTA_LEDGER: {
      idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
      get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) })) as TestNamespace['get'],
    } as Env['REQUEST_QUOTA_LEDGER'],
    ...extra,
  };
}

test('rebuilds the OpenAlex URL and attaches the key the caller cannot supply', async () => {
  let upstreamUrl = '';
  const response = await withWorkerFetchMock(
    async url => {
      upstreamUrl = String(url);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
    () => reportApi.fetch(new Request(
      // A caller-supplied key and an unknown parameter must not survive.
      'https://papertok-report-api.example/openalex/works?filter=doi:10.1%2Fa&per-page=50&api_key=stolen&callback=evil',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), openAlexEnv()),
  );

  assert.equal(response.status, 200);
  const target = new URL(upstreamUrl);
  assert.equal(target.origin + target.pathname, 'https://api.openalex.org/works');
  assert.equal(target.searchParams.get('filter'), 'doi:10.1/a');
  assert.equal(target.searchParams.get('per-page'), '50');
  assert.equal(target.searchParams.get('api_key'), 'worker-key');
  assert.equal(target.searchParams.get('callback'), null);
});

test('refuses an entity outside the allowlist and a path that tries to climb out', async () => {
  const attempts = [
    '/openalex/secrets',
    // A raw `../` never reaches the route: the URL parser resolves it first.
    // A percent-encoded one does, so it is checked on the decoded form.
    '/openalex/works/%2e%2e%2f%2e%2e%2fadmin',
    `/openalex/works/${'a'.repeat(241)}`,
  ];
  await withWorkerFetchMock(async () => {
    throw new Error('No upstream request should be made');
  }, async () => {
    for (const pathname of attempts) {
      const response = await reportApi.fetch(new Request(
        `https://papertok-report-api.example${pathname}`,
        { headers: { origin: 'https://mugar123.github.io' } },
      ), openAlexEnv());
      assert.equal(response.status, 400, pathname);
    }
  });
});

test('serves a guest without a session, because the guest feed reads OpenAlex', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(JSON.stringify({ results: [{ id: 'W1' }] }), { status: 200 }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/openalex/works?filter=doi:10.1%2Fa',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), openAlexEnv()),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: [{ id: 'W1' }] });
});

test('an OpenAlex 404 is cached for an hour, an OpenAlex outage is not cached', async () => {
  const upstreamCalls = (status: number) => withCountedUpstream(
    async () => new Response(JSON.stringify({ error: 'x' }), { status }),
    async () => {
      await withIdentityAndCacheStore(async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await reportApi.fetch(new Request(
            'https://papertok-report-api.example/openalex/works/doi:10.1/unindexed',
            { headers: { origin: 'https://mugar123.github.io' } },
          ), openAlexEnv());
          assert.equal(response.status, status);
          if (status === 404) assert.equal(maxAgeSeconds(response), 3600);
        }
      });
    },
  );

  assert.equal((await upstreamCalls(404)).length, 1, 'the second 404 comes from the edge');
  assert.equal((await upstreamCalls(503)).length, 2, 'an outage is asked again');
});

test('relays an OpenAlex refusal with its own wait instead of flattening it', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(
      JSON.stringify({ error: 'Rate limit exceeded', message: 'Insufficient budget.' }),
      {
        status: 429,
        headers: {
          'retry-after': '3564',
          'x-ratelimit-remaining-usd': '0',
          'x-ratelimit-limit-usd': '0.1',
        },
      },
    ),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/openalex/works?filter=doi:10.1%2Fa',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), openAlexEnv()),
  );

  // Flattening this into a 502 would leave the client guessing how long to wait,
  // and since the daily budget resets at midnight UTC that wait can be hours.
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3564');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  // Not simple response headers: without this the browser hides them.
  assert.match(response.headers.get('access-control-expose-headers')!, /retry-after/);
  assert.match(response.headers.get('access-control-expose-headers')!, /x-ratelimit-remaining-usd/);
});

test('reports the remaining OpenAlex budget as a number', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response('{"results":[]}', {
      status: 200,
      headers: { 'x-ratelimit-remaining-usd': '0.87', 'x-ratelimit-limit-usd': '1', 'x-ratelimit-remaining': '8700' },
    }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/openalex',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { OPENALEX_API_KEY: 'worker-key' }),
  );

  assert.equal(response.status, 200);
  const health = await response.json<{ configured: boolean; available: boolean; budget: { remainingUsd: number; limitUsd: number; remainingCalls: number } }>();
  assert.equal(health.configured, true);
  assert.equal(health.available, true);
  assert.equal(health.budget.remainingUsd, 0.87);
  assert.equal(health.budget.limitUsd, 1);
  assert.equal(health.budget.remainingCalls, 8700);
});

test('reports an exhausted OpenAlex budget as unhealthy, naming the shortfall', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(
      JSON.stringify({ error: 'Rate limit exceeded', message: 'Insufficient budget. Resets at midnight UTC' }),
      { status: 429, headers: { 'x-ratelimit-remaining-usd': '0', 'x-ratelimit-limit-usd': '0.1' } },
    ),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/openalex',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), {}),
  );

  assert.equal(response.status, 503);
  const health = await response.json<{ configured: boolean; available: boolean; status: number; budget: { remainingUsd: number }; message: string }>();
  assert.equal(health.configured, false);
  assert.equal(health.available, false);
  assert.equal(health.status, 429);
  assert.equal(health.budget.remainingUsd, 0);
  assert.match(health.message, /Insufficient budget/);
});

test('reports Scopus as unconfigured without contacting the egress', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw new Error('No upstream request should be made');
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/health/scopus',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(response.status, 503);
  const health = await response.json<{ configured: boolean; available: boolean; code: string }>();
  assert.equal(health.configured, false);
  assert.equal(health.available, false);
  assert.equal(health.code, 'SCOPUS_NOT_CONFIGURED');
});

test('names the Elsevier error code when the key is refused from this network', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(
      JSON.stringify({ 'service-error': { status: { statusCode: 'AUTHENTICATION_ERROR', statusText: 'Invalid API Key' } } }),
      { status: 401 },
    ),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), SCOPUS_EGRESS),
  );

  assert.equal(response.status, 503);
  const health = await response.json<{ available: boolean; status: number; code: string; message: string; insttoken: boolean }>();
  assert.equal(health.available, false);
  assert.equal(health.status, 401);
  assert.equal(health.code, 'AUTHENTICATION_ERROR');
  assert.equal(health.message, 'Invalid API Key');
  assert.equal(health.insttoken, false);
});

test('falls back to the STANDARD view and reports that the abstract is missing', async () => {
  const requestedViews: Array<string | null> = [];
  const response = await withWorkerFetchMock(
    async url => {
      const view = new URL(url as string | URL).searchParams.get('view');
      requestedViews.push(view);
      if (view === 'COMPLETE') return new Response('{}', { status: 403 });
      return new Response(
        JSON.stringify({
          'search-results': {
            'opensearch:totalResults': '1234',
            entry: [{ 'dc:title': 'A result without an abstract' }],
          },
        }),
        { status: 200, headers: { 'X-RateLimit-Remaining': '19998', 'X-PaperTok-Insttoken': 'true' } },
      );
    },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), SCOPUS_EGRESS),
  );

  assert.deepEqual(requestedViews, ['COMPLETE', 'STANDARD']);
  assert.equal(response.status, 200);
  const health = await response.json<{ available: boolean; view: string; hasAbstract: boolean; results: number; insttoken: boolean; quota: { remaining: number }; attempts: Array<{ view: unknown; status: unknown }> }>();
  assert.equal(health.available, true);
  assert.equal(health.view, 'STANDARD');
  assert.equal(health.hasAbstract, false);
  assert.equal(health.results, 1234);
  assert.equal(health.insttoken, true);
  assert.equal(health.quota.remaining, 19998);
  assert.deepEqual(health.attempts.map(attempt => [attempt.view, attempt.status]), [['COMPLETE', 403], ['STANDARD', 200]]);
});

test('records what every view answered when Scopus refuses both of them', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(
      JSON.stringify({ 'service-error': { status: { statusCode: 'GENERAL_SYSTEM_ERROR', statusText: 'System Error Occurred' } } }),
      { status: 500, headers: { 'X-ELS-ReqId': 'req-42' } },
    ),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), SCOPUS_EGRESS),
  );

  assert.equal(response.status, 503);
  const health = await response.json<{ available: boolean; view: unknown; code: string; attempts: Array<{ view: unknown; requestId: string }> }>();
  assert.equal(health.available, false);
  assert.equal(health.view, null);
  assert.equal(health.code, 'GENERAL_SYSTEM_ERROR');
  assert.deepEqual(health.attempts.map(attempt => attempt.view), ['COMPLETE', 'STANDARD', 'DEFAULT']);
  assert.equal(health.attempts[0].requestId, 'req-42');
});

test('reports a COMPLETE view that carries the abstract', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(
      JSON.stringify({
        'search-results': {
          'opensearch:totalResults': '7',
          entry: [{ 'dc:title': 'A complete result', 'dc:description': 'The abstract Scopus returned.' }],
        },
      }),
      { status: 200 },
    ),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), SCOPUS_EGRESS),
  );

  assert.equal(response.status, 200);
  const health = await response.json<{ available: boolean; view: string; hasAbstract: boolean }>();
  assert.equal(health.available, true);
  assert.equal(health.view, 'COMPLETE');
  assert.equal(health.hasAbstract, true);
});

test('falls past a view the account is not entitled to, which Scopus refuses with 401', async () => {
  const requestedViews: Array<string | null> = [];
  const response = await withWorkerFetchMock(
    async url => {
      const view = new URL(url as string | URL).searchParams.get('view');
      requestedViews.push(view);
      if (view === 'COMPLETE') {
        return new Response(
          JSON.stringify({ 'service-error': { status: { statusCode: 'AUTHORIZATION_ERROR' } } }),
          { status: 401 },
        );
      }
      return new Response(
        JSON.stringify({ 'search-results': { entry: [{ 'dc:title': 'A STANDARD result' }] } }),
        { status: 200 },
      );
    },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), SCOPUS_EGRESS),
  );

  assert.deepEqual(requestedViews, ['COMPLETE', 'STANDARD']);
  assert.equal(response.status, 200);
  const health = await response.json<{ available: boolean; view: string; hasAbstract: boolean }>();
  assert.equal(health.available, true);
  assert.equal(health.view, 'STANDARD');
  assert.equal(health.hasAbstract, false);
});

test('spends a single upstream call when the answering view is pinned', async () => {
  const requestedViews: Array<string | null> = [];
  await withWorkerFetchMock(
    async url => {
      requestedViews.push(new URL(url as string | URL).searchParams.get('view'));
      return new Response(
        JSON.stringify({ 'search-results': { entry: [{ 'dc:title': 'A STANDARD result' }] } }),
        { status: 200 },
      );
    },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { ...SCOPUS_EGRESS, SCOPUS_VIEW: 'STANDARD' }),
  );

  assert.deepEqual(requestedViews, ['STANDARD']);
});

test('reaches Scopus through the egress and never contacts Elsevier itself', async () => {
  let upstreamUrl = '';
  let sentHeaders = null;
  await withWorkerFetchMock(
    async (url, options) => {
      upstreamUrl = String(url);
      sentHeaders = new Headers(options!.headers);
      return new Response(
        JSON.stringify({ 'search-results': { entry: [{ 'dc:title': 'A result' }] } }),
        { status: 200 },
      );
    },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), SCOPUS_EGRESS),
  );

  const target = new URL(upstreamUrl);
  assert.equal(target.origin, 'https://scopus-proxy.example');
  assert.equal(target.pathname, '/scopus');
  assert.equal(sentHeaders!.get('authorization'), `Bearer ${SCOPUS_EGRESS.SCOPUS_PROXY_SECRET}`);
  // The Elsevier key lives on the egress; this Worker must not carry one.
  assert.equal(sentHeaders!.get('X-ELS-APIKey'), null);
});

test('requires Firebase authentication before a secret-backed source can be used', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw new Error('No upstream request should be made');
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/scopus?terms=physics',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), { FIREBASE_WEB_API_KEY: 'firebase-test-key' }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: 'AUTH_REQUIRED' });
});

test('does not spend protected-provider quota for an invalid authenticated query', async () => {
  let quotaReservations = 0;
  const originalCaches = (globalThis as TestGlobals).caches;
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => (request as Request).url.includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : null,
      put: async (): Promise<unknown> => undefined,
    },
  };
  try {
    const response = await reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/core',
      {
        headers: {
          origin: 'https://mugar123.github.io',
          authorization: 'Bearer test-token',
        },
      },
    ), {
      FIREBASE_WEB_API_KEY: 'firebase-test-key',
      REQUEST_QUOTA_LEDGER: {
        idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
        get: ((): Pick<DurableObjectStub, 'fetch'> => ({
          fetch: async () => {
            quotaReservations += 1;
            return new Response(JSON.stringify({ accepted: true }));
          },
        })) as TestNamespace['get'],
      } as Env['REQUEST_QUOTA_LEDGER'],
    });

    assert.equal(response.status, 400);
    assert.equal(quotaReservations, 0);
  } finally {
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('does not spend protected-provider quota for an authenticated cache hit', async () => {
  let quotaReservations = 0;
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('No upstream request should be made');
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => {
        if ((request as Request).url.includes('/auth/')) {
          return new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } });
        }
        if ((request as Request).url.includes('/cache/sources/core')) {
          return new Response(JSON.stringify({ results: [{ id: 'cached-paper' }] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return null;
      },
      put: async (): Promise<unknown> => undefined,
    },
  };
  try {
    const response = await reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/core?q=physics&limit=4',
      {
        headers: {
          origin: 'https://mugar123.github.io',
          authorization: 'Bearer test-token',
        },
      },
    ), {
      FIREBASE_WEB_API_KEY: 'firebase-test-key',
      REQUEST_QUOTA_LEDGER: {
        idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
        get: ((): Pick<DurableObjectStub, 'fetch'> => ({
          fetch: async () => {
            quotaReservations += 1;
            return new Response(JSON.stringify({ accepted: true }));
          },
        })) as TestNamespace['get'],
      } as Env['REQUEST_QUOTA_LEDGER'],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [{ id: 'cached-paper' }] });
    assert.equal(quotaReservations, 0);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('canonical source cache keys ignore unknown query parameters', async () => {
  const responses = new Map();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ notes: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => responses.get((request as Request).url)?.clone() || null,
      put: async (request, response): Promise<unknown> => responses.set((request as Request).url, response.clone()),
    },
  };
  try {
    const base = 'https://papertok-report-api.example/sources/openreview?q=security&limit=4';
    const options = { headers: { origin: 'https://mugar123.github.io' } };
    const first = await reportApi.fetch(new Request(`${base}&nonce=one`, options), {});
    const second = await reportApi.fetch(new Request(`${base}&nonce=two`, options), {});
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('duplicate cache parameters cannot create cache variants for one upstream request', async () => {
  const responses = new Map();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ notes: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => responses.get((request as Request).url)?.clone() || null,
      put: async (request, response): Promise<unknown> => responses.set((request as Request).url, response.clone()),
    },
  };
  try {
    const base = 'https://papertok-report-api.example/sources/openreview?q=security&limit=4';
    const options = { headers: { origin: 'https://mugar123.github.io' } };
    const first = await reportApi.fetch(new Request(base, options), {});
    const second = await reportApi.fetch(new Request(`${base}&limit=nonce`, options), {});
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

// `/health` is where an operator learns a key is missing, and for Semantic Scholar
// that is not a footnote: without the key both `/sources/s2` and `/related` are
// refused by the anonymous pool, so a flag that reported "configured" regardless
// of the environment would hide a dead source behind a green check.
test('/health reports whether the Semantic Scholar key is configured', async () => {
  const read = async (env: WorkerEnv) => (await (await reportApi.fetch(
    new Request('https://papertok-report-api.example/health'),
    env,
  )).json<{ semanticScholarKeyConfigured: unknown }>()).semanticScholarKeyConfigured;

  assert.equal(await read({ SEMANTIC_SCHOLAR_API_KEY: 's2-test-key' }), true);
  assert.equal(await read({ SEMANTIC_SCHOLAR_API_KEY: '' }), false);
  assert.equal(await read({}), false);
});

test('adds baseline browser hardening headers to JSON responses', async () => {
  const response = await reportApi.fetch(new Request('https://papertok-report-api.example/health'), {});
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('permissions-policy')!, /camera=\(\)/);
});

// --- G2: plazos de red -------------------------------------------------------

// An upstream that answers its headers and then never finishes the body. The
// stream fails only when the caller's own deadline cuts it, which is the whole
// point: a deadline that stops at the headers leaves this hanging forever.
function stalledBodyResponse(signal: AbortSignal|null|undefined, contentType = 'application/json') {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      const fail = () => controller.error(signal?.reason ?? new Error('aborted'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    },
  }), { headers: { 'content-type': contentType } });
}

// Every deadline in the code under test becomes `ms`, so a test can watch one
// fire without paying six real seconds for it. Patching `AbortSignal.timeout`
// also pins the mechanism: a timer cleared in a `finally` ignores this patch and
// the request hangs, which is exactly the failure these tests exist to catch.
async function withShortDeadlines<Result>(ms: number, callback: () => Promise<Result>) {
  const original = AbortSignal.timeout;
  AbortSignal.timeout = () => original.call(AbortSignal, ms);
  try {
    return await callback();
  } finally {
    AbortSignal.timeout = original;
  }
}

const HUNG = Symbol('hung');

async function answeredWithin(ms: number|undefined, promise: Promise<Response>) {
  const result = await Promise.race([
    promise,
    new Promise<typeof HUNG>(resolve => setTimeout(() => resolve(HUNG), ms)),
  ]);
  assert.notEqual(result, HUNG, `the request was still hanging after ${ms}ms`);
  return result as Response;
}

test('cuts a source upstream that sends its headers and then stalls the body', async () => {
  const response = await withShortDeadlines(25, () => withWorkerFetchMock(
    async (_url, options) => stalledBodyResponse(options?.signal),
    () => answeredWithin(2_000, reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/europepmc?q=malaria&limit=4',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), {})),
  ));

  assert.equal(response.status, 502);
});

test('cuts an arXiv upstream that sends its headers and then stalls the body', async () => {
  const response = await withShortDeadlines(25, () => withWorkerFetchMock(
    async (_url, options) => stalledBodyResponse(options?.signal, 'application/atom+xml'),
    () => answeredWithin(2_000, reportApi.fetch(new Request(
      'https://papertok-report-api.example/arxiv?search_query=all:malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), {})),
  ));

  assert.equal(response.status, 502);
});

const ARXIV_URL = 'https://papertok-report-api.example/arxiv?search_query=all:malaria';
const ATOM_FEED = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const arxivThrough = (env: WorkerEnv, upstream: typeof fetch) => withWorkerFetchMock(upstream, () => reportApi.fetch(new Request(
  ARXIV_URL, { headers: { origin: 'https://mugar123.github.io' } },
), env));
const IS_ARXIV_PACE = (key: string) => key === 'arxiv:pace';

// One request every three seconds is arXiv's published policy, and the Worker
// is the one client arXiv sees. A miss takes a seat on the beat before it goes
// upstream; a seat that is not free within the wait budget is refused here,
// with no arXiv call spent.
test('an arXiv miss takes a seat on the three-second beat before going upstream', async () => {
  const state: QuotaScriptState = { actions: [] };
  let upstreamCalls = 0;
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state) },
    async () => { upstreamCalls += 1; return new Response(ATOM_FEED, { headers: { 'content-type': 'application/atom+xml' } }); },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  const seat = state.actions.find(a => a.action === 'reserve' && IS_ARXIV_PACE(a.periodKey));
  assert.ok(seat, `no seat taken on the arXiv beat: ${JSON.stringify(state.actions)}`);
});

test('refuses an arXiv miss with 429 and retry-after when the beat has no seat, without calling arXiv', async () => {
  const state: QuotaScriptState = { actions: [] };
  let upstreamCalls = 0;
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: IS_ARXIV_PACE }) },
    async () => { upstreamCalls += 1; return new Response(ATOM_FEED); },
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'PROVIDER_RATE_LIMITED');
  assert.equal(response.headers.get('retry-after'), '4');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(upstreamCalls, 0);
});

// The beat is courtesy towards arXiv, not the protection of a key: a ledger
// that is missing or down must not take the source down with it.
test('an arXiv miss goes upstream unpaced when there is no ledger to keep the beat', async () => {
  let upstreamCalls = 0;
  const response = await arxivThrough(
    {},
    async () => { upstreamCalls += 1; return new Response(ATOM_FEED, { headers: { 'content-type': 'application/atom+xml' } }); },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
});

// A 429 from arXiv, a stall, and a bad answer used to leave as the same
// `502 arXiv unavailable`. The client retries a 502 at once, which is the one
// thing that makes a rate limit worse.
test('relays an arXiv refusal as 429 UPSTREAM_RATE_LIMITED with the status that caused it', async () => {
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async () => new Response('Rate exceeded.', { status: 429 }),
  );

  assert.equal(response.status, 429);
  const body = await response.json<{ code: string; upstreamStatus: number }>();
  assert.equal(body.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(body.upstreamStatus, 429);
  assert.match(response.headers.get('retry-after')!, /^\d+$/);
});

test('names an arXiv stall as UPSTREAM_TIMEOUT', async () => {
  const response = await withShortDeadlines(25, () => arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async (_url, options) => stalledBodyResponse(options?.signal, 'application/atom+xml'),
  ));

  assert.equal(response.status, 502);
  assert.equal((await response.json<{ code: string }>()).code, 'UPSTREAM_TIMEOUT');
});

test('caches an arXiv answer for an hour at the edge', async () => {
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async () => new Response(ATOM_FEED, { headers: { 'content-type': 'application/atom+xml' } }),
  );

  assert.match(response.headers.get('cache-control')!, /s-maxage=3600\b/);
});

// Every specialist route, not just the one that happened to be covered when this
// suite was written. `/sources/scopus` and `/sources/physics` do not go through
// `fetchJsonUpstream`, and that is precisely how they kept their unbounded waits
// through a fix that was supposed to have closed them.
const SOURCE_ROUTES: Array<[string, WorkerEnv]> = [
  ['/sources/biorxiv?category=neuroscience', {}],
  ['/sources/europepmc?q=malaria', {}],
  ['/sources/pubmed?q=malaria', {}],
  ['/sources/s2?q=malaria', {}],
  ['/sources/core?q=malaria', {}],
  ['/sources/osti?q=malaria', {}],
  ['/sources/nasa?q=malaria', {}],
  ['/sources/physics?q=malaria', { NASA_ADS_API_TOKEN: 'ads-test-token' }],
  ['/sources/scopus?terms=physics', SCOPUS_EGRESS],
  ['/sources/openreview?q=malaria', {}],
  ['/sources/huggingface?q=malaria', {}],
  ['/enrich/icite?pmids=123', {}],
  ['/resources/huggingface?arxiv_id=2607.12345', {}],
];

const AUTHENTICATED_ENV = {
  FIREBASE_WEB_API_KEY: 'firebase-test-key',
  REQUEST_QUOTA_LEDGER: {
    idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'],
};

// A signed-in caller without an Identity Toolkit round trip: the Worker caches a
// verified identity, so seeding that cache is how a protected route is reached.
async function withCachedIdentity<Result>(callback: () => Promise<Result>) {
  const originalCaches = (globalThis as TestGlobals).caches;
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => (String((request as Request).url).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : null),
      put: async (): Promise<unknown> => undefined,
    },
  };
  try {
    return await callback();
  } finally {
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

for (const [route, extraEnv] of SOURCE_ROUTES) {
  test(`gives ${route.split('?')[0]} an upstream deadline it can be cut with`, async () => {
    let seenSignal: AbortSignal | null | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      seenSignal ??= options?.signal;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    try {
      await withCachedIdentity(() => reportApi.fetch(new Request(
        `https://papertok-report-api.example${route}`,
        { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
      ), { ...AUTHENTICATED_ENV, ...extraEnv }));
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(seenSignal, `${route} reaches its upstream with no AbortSignal`);
    assert.equal(seenSignal.aborted, false);
  });
}

// CORE answered in 7-8 s when measured; the shared six-second deadline cut
// every such search into a 502 before the edge cache could keep it.
test('answers a CORE search that takes longer than the shared source deadline', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, options: RequestInit = {}) => new Promise((resolve, reject) => {
    const answer = setTimeout(() => resolve(new Response(JSON.stringify({ results: [{ id: 'slow-paper' }] }), {
      headers: { 'content-type': 'application/json' },
    })), 6_500);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(answer);
      reject(options.signal!.reason);
    }, { once: true });
  }));
  try {
    const response = await withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/core?q=robotics',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [{ id: 'slow-paper' }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The feed sends CORE its labels as `"A" OR "B"`, and CORE answers a query
// that starts with a quoted phrase with a 500 (tester report, 2026-10-20).
test('sends CORE the query inside parentheses', async () => {
  const upstream: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    upstream.push(new URL(String(url)));
    return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const response = await withCachedIdentity(() => reportApi.fetch(new Request(
      `https://papertok-report-api.example/sources/core?q=${encodeURIComponent('"Signal Processing" OR "Power & Energy Systems"')}`,
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV));

    assert.equal(response.status, 200);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].searchParams.get('q'), '("Signal Processing" OR "Power & Energy Systems")');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to INSPIRE when NASA ADS stalls instead of waiting on it', async () => {
  let inspireQuery = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.adsabs.harvard.edu')) return stalledBodyResponse(options?.signal);
    inspireQuery = String(url);
    return new Response(JSON.stringify({ hits: { hits: [], total: 0 } }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const response = await withShortDeadlines(25, () => withCachedIdentity(
      () => answeredWithin(2_000, reportApi.fetch(new Request(
        'https://papertok-report-api.example/sources/physics?q=malaria&fallback_q=malaria',
        { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
      ), { ...AUTHENTICATED_ENV, NASA_ADS_API_TOKEN: 'ads-test-token' })),
    ));

    assert.equal(response.status, 200);
    assert.match(inspireQuery, /inspirehep\.net/);
    // The reason names the stall rather than hiding it behind a generic
    // "unavailable": a hung provider and a refusing one need different answers.
    assert.equal((await response.json<{ _papertok: { fallbackReason: string } }>())._papertok.fallbackReason, 'ads_timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('answers 503 AUTH_UNAVAILABLE when Identity Toolkit cannot be reached', async () => {
  // A well-formed token on purpose: a malformed one is now refused locally, and
  // this test is about Google being unreachable, not about the token.
  const response = await withWorkerFetchMock(async () => {
    throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/core?q=malaria',
    { headers: { origin: 'https://mugar123.github.io', authorization: `Bearer ${fakeIdToken()}` } },
  ), { FIREBASE_WEB_API_KEY: 'firebase-test-key' }));

  // Not 401: telling a user their session expired because Google was unreachable
  // sends them to sign in again for nothing.
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'AUTH_UNAVAILABLE' });
});

test('still answers 401 AUTH_REQUIRED when Identity Toolkit refuses the token', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(JSON.stringify({ error: { message: 'INVALID_ID_TOKEN' } }), { status: 400 }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/core?q=malaria',
      { headers: { origin: 'https://mugar123.github.io', authorization: `Bearer ${fakeIdToken()}` } },
    ), { FIREBASE_WEB_API_KEY: 'firebase-test-key' }),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: 'AUTH_REQUIRED' });
});

test('answers an OpenAlex stall as a gateway timeout', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/openalex/works?per-page=1',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), openAlexEnv()));

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

test('answers an OpenAlex network failure with CORS headers instead of throwing', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw new TypeError('Network connection lost');
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/openalex/works?per-page=1',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), openAlexEnv()));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { code: 'OPENALEX_UNREACHABLE' });
  // Without this header the browser reports an opaque CORS failure, and the 429
  // relay with its `retry-after` -- which this route goes out of its way to
  // preserve -- is lost with it.
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

// The helper G5 and G8 were told to reuse, tested on the contract that note
// promises them. Reuses the harness the client-side sweep built, so both halves
// of the tree describe a stalled upstream the same way.
test('enforces its deadline even when the caller brings a signal of its own', async () => {
  // In the Worker a caller signal is a *cancellation* -- `request.signal`, the
  // browser that hung up -- not a budget. Letting it replace the deadline would
  // hand the next route that passes one an unbounded wait, which is the whole
  // failure this helper exists to remove.
  const caller = new AbortController(); // never fires
  const outcome = await withStubbedFetch(dribblingFetch(), () => settleWithin(2_000, async () => {
    const response = await fetchWithDeadline('https://upstream.example/', { signal: caller.signal }, 25);
    await response.text();
  }));

  assert.equal(outcome, 'TimeoutError');
});

test('still lets a caller cancellation be told apart from its own deadline', async () => {
  // The guard on over-correcting: combining the two must not relabel a hang-up
  // as a timeout. `AbortSignal.any` keeps whichever fired first as the reason.
  const caller = new AbortController();
  caller.abort(new DOMException('the client hung up', 'AbortError'));
  const outcome = await withStubbedFetch(dribblingFetch(), () => settleWithin(2_000, async () => {
    const response = await fetchWithDeadline('https://upstream.example/', { signal: caller.signal }, 25);
    await response.text();
  }));

  assert.equal(outcome, 'AbortError');
});

// --- G5: the cache key is the upstream call ---------------------------------
// Every test below asks the same question in a different place: do two requests
// that reach the same upstream also reach the same cache entry? Before G5 they
// did not, and on the routes OpenAlex bills that was money: one identical query,
// billed against a $1/day budget again for every spelling of it.

// A cache that actually remembers, plus a signed-in caller. `withCachedIdentity`
// answers the auth lookup but stores nothing, and what these tests measure is
// whether the second request finds what the first one put away.
async function withIdentityAndCacheStore<Result>(callback: (stored: Map<string, Response>) => Promise<Result>) {
  const originalCaches = (globalThis as TestGlobals).caches;
  const stored = new Map<string, Response>();
  (globalThis as TestGlobals).caches = {
    default: {
      async match(request): Promise<Response | null | undefined> {
        if (String((request as Request).url).includes('/auth/')) {
          return new Response(JSON.stringify({ uid: 'user-1' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return stored.get(String((request as Request).url))?.clone() || null;
      },
      async put(request, response): Promise<void> {
        stored.set(String((request as Request).url), response.clone());
      },
    },
  };
  try {
    return await callback(stored);
  } finally {
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

async function withCountedUpstream<Result>(handler: MockProvider, callback: (calls: string[]) => Promise<Result>) {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options);
  };
  try {
    await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls;
}

const BROWSER = Object.freeze({ origin: 'https://mugar123.github.io' });
const SIGNED_IN = Object.freeze({ ...BROWSER, authorization: 'Bearer test-token' });
// The citation graph is the route that reaches `cacheResponse` with both an
// identity and a billed OpenAlex spend, so the budget tests below run on it.
const CITATION_GRAPH_URL = 'https://papertok-report-api.example/citation-graph?doi=10.1234/abc&limit=8';
const citationGraphPage = async (url: RequestInfo | URL) => new Response(
  JSON.stringify(String(url).includes('opencitations') ? [] : { id: 'https://openalex.org/W1', results: [] }),
  { headers: { 'content-type': 'application/json' } },
);

test('the same DOI in a different shape is the same citation graph', async () => {
  const citationGraphUpstream = async (url: string|string[]) => new Response(
    JSON.stringify(url.includes('opencitations') ? [] : { id: 'https://openalex.org/W1', results: [] }),
    { headers: { 'content-type': 'application/json' } },
  );
  let afterFirst = 0;
  const calls = await withCountedUpstream(citationGraphUpstream, async collected => {
    await withIdentityAndCacheStore(async () => {
      const shapes = ['10.1234/AbC', 'https://doi.org/10.1234/abc'];
      for (const doi of shapes) {
        const response = await reportApi.fetch(new Request(
          `https://papertok-report-api.example/citation-graph?doi=${encodeURIComponent(doi)}&limit=8`,
          { headers: SIGNED_IN },
        ), AUTHENTICATED_ENV);
        assert.equal(response.status, 200);
        afterFirst ||= collected.length;
      }
    });
  });

  // `normalizeCitationDoi` lowercases and strips the `doi.org` prefix, so every
  // capitalisation of one DOI is one upstream question -- and each miss is worth
  // up to nine billed OpenAlex calls, which is 2^n ways to spend the day's budget.
  assert.equal(calls.length, afterFirst);
});

test('a limit the route clamps cannot buy a second cache entry', async () => {
  const calls = await withCountedUpstream(
    async () => new Response(JSON.stringify({ notes: [] }), {
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await withIdentityAndCacheStore(async () => {
        for (const limit of [11, 12]) {
          const response = await reportApi.fetch(new Request(
            `https://papertok-report-api.example/sources/openreview?q=security&limit=${limit}`,
            { headers: BROWSER },
          ), {});
          assert.equal(response.status, 200);
        }
      });
    },
  );

  // `getSafeLimit` clamps both to ten. The test that was already here used
  // `limit=4` against `limit=4&limit=nonce`, which `searchParams.get` collapses
  // before either layer sees it -- so it never touched this.
  assert.equal(calls.length, 1);
});

test('whitespace around an OpenAlex filter is trimmed once, for the key and the call alike', async () => {
  const calls = await withCountedUpstream(
    async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    async () => {
      await withIdentityAndCacheStore(async () => {
        for (const filter of ['doi:10.1/x', '%20doi:10.1/x%20']) {
          const response = await reportApi.fetch(new Request(
            `https://papertok-report-api.example/openalex/works?filter=${filter}`,
            { headers: BROWSER },
          ), openAlexEnv());
          assert.equal(response.status, 200);
        }
      });
    },
  );

  assert.equal(calls.length, 1);
  // The trim used to happen only on the way into the key, so these two shared an
  // entry while asking OpenAlex two different questions: whichever arrived first
  // owned the answer for six hours, and the Origin gate is not a frontier that
  // stops an outsider from being first.
  assert.match(calls[0], /filter=doi%3A10\.1%2Fx&/);
});

// --- PAP-86: one OpenAlex answer for every location, and for every request in flight ---
// The edge cache is per data centre, so every location asks OpenAlex the same
// questions again. On launch day the daily ceiling ran out of units while the
// health readings showed dollars left on the key (an inference from those
// readings, not a relay measurement). The relay carries no identity: an answer
// depends only on the canonical upstream parameters, so it can be shared.

/** The KV namespace the relay shares its answers through, remembering TTLs. */
function fakeOpenAlexStore() {
  const entries = new Map<string, { value: string; metadata: unknown; ttl?: number }>();
  return {
    entries,
    getWithMetadata: async (key: string) => {
      const stored = entries.get(key);
      return stored ? { value: stored.value, metadata: stored.metadata } : { value: null, metadata: null };
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }) => {
      entries.set(key, { value, metadata: options?.metadata, ttl: options?.expirationTtl });
    },
  } as unknown as KVNamespace & { entries: typeof entries };
}

const OPENALEX_LIST_URL = 'https://papertok-report-api.example/openalex/works?filter=primary_topic.id:T10001&per-page=25';

test('an OpenAlex answer fetched in one location is served from the shared store in the next', async () => {
  const store = fakeOpenAlexStore();
  const ledger = recordingLedger();
  const env = openAlexEnv({ NOTIFICATION_STORE: store, REQUEST_QUOTA_LEDGER: ledger.binding });
  const bodies: string[] = [];
  const calls = await withCountedUpstream(
    async () => new Response(JSON.stringify({ results: [{ id: 'W1' }] }), { status: 200 }),
    async () => {
      // Two locations: each gets an empty edge cache of its own.
      for (let location = 0; location < 2; location += 1) {
        await withIdentityAndCacheStore(async () => {
          const response = await reportApi.fetch(new Request(OPENALEX_LIST_URL, { headers: BROWSER }), env);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('access-control-allow-origin'), BROWSER.origin);
          bodies.push(await response.text());
        });
      }
    },
  );

  assert.equal(calls.length, 1, 'the second location asks the store, not OpenAlex');
  assert.equal(ledger.reservations.length, 1, 'and reserves nothing for it');
  assert.equal(bodies[1], bodies[0]);
  const [entry] = [...store.entries.values()];
  assert.ok(entry, 'the answer is in the shared store');
  assert.equal(entry.ttl, 24 * 60 * 60, 'kept for a day');
});

test('a trailing slash on an OpenAlex path shares the entry, reservation and call of the same upstream URL', async () => {
  const store = fakeOpenAlexStore();
  const ledger = recordingLedger();
  const env = openAlexEnv({ NOTIFICATION_STORE: store, REQUEST_QUOTA_LEDGER: ledger.binding });
  const calls = await withCountedUpstream(
    async () => new Response(JSON.stringify({ results: [{ id: 'W1' }] }), { status: 200 }),
    async () => {
      await withIdentityAndCacheStore(async () => {
        for (const path of ['/openalex/works?search=graphene', '/openalex/works/?search=graphene']) {
          const response = await reportApi.fetch(new Request(`https://papertok-report-api.example${path}`, { headers: BROWSER }), env);
          assert.equal(response.status, 200, path);
        }
      });
    },
  );

  // Both spellings are rebuilt as https://api.openalex.org/works?search=graphene.
  assert.equal(calls.length, 1);
  assert.equal(ledger.reservations.length, 1);
  assert.equal(store.entries.size, 1);
});

test('a work OpenAlex has not indexed is shared for an hour; a refusal and an outage are not shared', async () => {
  const sharedAfter = async (status: number) => {
    const store = fakeOpenAlexStore();
    await withCountedUpstream(
      async () => new Response(JSON.stringify({ error: 'x' }), { status }),
      async () => {
        await withIdentityAndCacheStore(async () => {
          const response = await reportApi.fetch(new Request(
            'https://papertok-report-api.example/openalex/works/doi:10.1/unindexed',
            { headers: BROWSER },
          ), openAlexEnv({ NOTIFICATION_STORE: store }));
          assert.equal(response.status, status);
        });
      },
    );
    return [...store.entries.values()];
  };

  const notFound = await sharedAfter(404);
  assert.equal(notFound.length, 1);
  assert.equal(notFound[0].ttl, 60 * 60);
  assert.deepEqual(await sharedAfter(429), [], 'a refusal is not an answer');
  assert.deepEqual(await sharedAfter(503), [], 'neither is an outage');
});

test('a 404 served from the shared store keeps its own status', async () => {
  const store = fakeOpenAlexStore();
  const env = openAlexEnv({ NOTIFICATION_STORE: store });
  const statuses: number[] = [];
  const calls = await withCountedUpstream(
    async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    async () => {
      for (let location = 0; location < 2; location += 1) {
        await withIdentityAndCacheStore(async () => {
          const response = await reportApi.fetch(new Request(
            'https://papertok-report-api.example/openalex/works/doi:10.1/unindexed',
            { headers: BROWSER },
          ), env);
          statuses.push(response.status);
          assert.equal(maxAgeSeconds(response), 3600);
        });
      }
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(statuses, [404, 404]);
});

test('identical OpenAlex misses in flight share one upstream call and one reservation', async () => {
  const ledger = recordingLedger();
  const env = openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const origins = ['https://mugar123.github.io', 'https://papertok.app', 'https://mugar123.github.io'];

  const responses = await withWorkerFetchMock(async () => {
    calls += 1;
    await gate;
    return new Response(JSON.stringify({ results: [{ id: 'W1' }] }), { status: 200 });
  }, async () => {
    const pending = origins.map(origin => reportApi.fetch(new Request(OPENALEX_LIST_URL, { headers: { origin } }), env));
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    const settled = await Promise.all(pending);
    // The edge cache of this harness remembers nothing, so a request after the
    // shared one has settled is a miss of its own: nothing stays coalesced.
    await reportApi.fetch(new Request(OPENALEX_LIST_URL, { headers: BROWSER }), env);
    return settled;
  });

  assert.equal(calls, 2, 'three requests in flight are one call; the one after them is its own');
  assert.equal(ledger.reservations.length, 2);
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origins[index], 'each answer carries its own origin');
    assert.deepEqual(await response.json(), { results: [{ id: 'W1' }] });
  }
});

// A refusal answers one request's reservation under that request's tier, and
// the harvest and a reader can ask for one URL under different tiers (PAP-88).
test('a ledger refusal is not shared: each identical request waiting behind it is refused by its own reservation', async () => {
  const ledger = recordingLedger(() => ({ accepted: false, scope: 'global' }));
  const env = openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
  const responses = await withWorkerFetchMock(async () => {
    throw new Error('A refused reservation makes no upstream call');
  }, () => Promise.all([BROWSER, BROWSER, { origin: 'https://papertok.app' }].map(headers => (
    reportApi.fetch(new Request(OPENALEX_LIST_URL, { headers }), env)
  ))));

  assert.equal(ledger.reservations.length, 3, 'one answer from the ledger for each');
  for (const response of responses) {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '300');
    assert.deepEqual(await response.json(), { code: 'PROVIDER_RATE_LIMITED' });
  }
  assert.equal(responses[2].headers.get('access-control-allow-origin'), 'https://papertok.app');
});

test('a repeated PubMed identifier does not buy a second iCite entry', async () => {
  const calls = await withCountedUpstream(
    async () => new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await withIdentityAndCacheStore(async () => {
        for (const pmids of ['123,123,456', '123,456']) {
          const response = await reportApi.fetch(new Request(
            `https://papertok-report-api.example/enrich/icite?pmids=${pmids}`,
            { headers: BROWSER },
          ), {});
          assert.equal(response.status, 200);
        }
      });
    },
  );

  assert.equal(calls.length, 1);
});

// --- G5: a degraded answer does not own its entry for the full TTL ----------

function maxAgeSeconds(response: Response) {
  return Number(response.headers.get('cache-control')!.match(/s-maxage=(\d+)/)![1]);
}

async function physicsAnswer(env: WorkerEnv, adsHandler: () => Response | PromiseLike<Response>) {
  return withIdentityAndCacheStore(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => (String(url).includes('adsabs')
      ? adsHandler()
      : new Response(JSON.stringify({ hits: { hits: [], total: 0 } }), {
        headers: { 'content-type': 'application/json' },
      }));
    try {
      return await reportApi.fetch(new Request(
        'https://papertok-report-api.example/sources/physics?q=galaxies&fallback_q=galaxies',
        { headers: SIGNED_IN },
      ), { ...AUTHENTICATED_ENV, ...env });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('a transient NASA ADS failure does not own the physics entry for six hours', async () => {
  const response = await physicsAnswer(
    { NASA_ADS_API_TOKEN: 'ads-test-token' },
    () => new Response('upstream exploded', { status: 500 }),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json<{ _papertok: { fallbackReason: string } }>())._papertok.fallbackReason, 'ads_500');
  // A one-second hiccup used to blank that query for everybody until the
  // afternoon, because `cacheResponse` gave the fallback the full 21600.
  assert.equal(maxAgeSeconds(response), 120);
  // And it does not get to be served stale for a day on top of that, nor to sit
  // in the browser longer than it sits at the edge.
  assert.doesNotMatch(response.headers.get('cache-control')!, /stale-while-revalidate/);
  assert.equal(Number(response.headers.get('cache-control')!.match(/max-age=(\d+)/)![1]), 120);
});

test('a healthy NASA ADS answer keeps the full physics TTL', async () => {
  const response = await physicsAnswer(
    { NASA_ADS_API_TOKEN: 'ads-test-token' },
    () => new Response(JSON.stringify({ response: { docs: [{ bibcode: 'X' }] } }), {
      headers: { 'content-type': 'application/json' },
    }),
  );

  assert.equal(maxAgeSeconds(response), 21600);
});

test('NASA ADS being unconfigured is a steady state, not a degraded one', async () => {
  const response = await physicsAnswer({}, () => {
    throw new Error('NASA ADS should not be contacted without a token');
  });

  const payload = await response.json<{ _papertok: { fallbackReason: string } }>();
  assert.equal(payload._papertok.fallbackReason, 'ads_not_configured');
  // INSPIRE is then the real answer, not a consolation prize, and it earns the
  // same six hours the primary provider would have.
  assert.equal(maxAgeSeconds(response), 21600);
});

async function citationGraphAnswer(upstream: MockProvider) {
  return withIdentityAndCacheStore(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => upstream(String(url));
    try {
      return await reportApi.fetch(new Request(
        'https://papertok-report-api.example/citation-graph?doi=10.1234/abc&limit=8',
        { headers: SIGNED_IN },
      ), AUTHENTICATED_ENV);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

// One cold graph against an upstream that answers `works/doi:` with `lookup`,
// recording when each call starts and when the lookup ends.
async function coldGraph(lookup: (url: URL) => Response | Promise<Response>) {
  const events: string[] = [];
  await withCountedUpstream(async (address) => {
    const url = new URL(String(address));
    if (url.pathname.startsWith('/works/doi:')) {
      events.push(`lookup${url.searchParams.has('api_key') ? '' : ' without key'}`);
      const response = await lookup(url);
      events.push('lookup done');
      return response;
    }
    if (url.pathname.includes('/index/v2/references/')) events.push('references');
    return Response.json(url.hostname.includes('opencitations') ? [] : { results: [] });
  }, async () => {
    await withIdentityAndCacheStore(async () => {
      const response = await reportApi.fetch(new Request(CITATION_GRAPH_URL, { headers: SIGNED_IN }), {
        ...AUTHENTICATED_ENV,
        OPENALEX_API_KEY: 'worker-key',
      });
      assert.equal(response.status, 200);
    });
  });
  return events;
}

test('a citation graph asks OpenCitations for references while the OpenAlex lookup is out', async () => {
  const events = await coldGraph(async () => {
    await new Promise(resolve => { setTimeout(resolve, 20); });
    return Response.json({ id: 'https://openalex.org/W1', cited_by_count: 3 });
  });
  assert.ok(events.indexOf('references') < events.indexOf('lookup done'), events.join(', '));
});

test('a DOI OpenAlex has not indexed is looked up once, not again without the key', async () => {
  const events = await coldGraph(() => Response.json({ error: 'not found' }, { status: 404 }));
  assert.deepEqual(events.filter(event => event.startsWith('lookup') && event !== 'lookup done'), ['lookup']);
});

test('a refused OpenAlex key is asked again without it', async () => {
  const events = await coldGraph(url => (url.searchParams.has('api_key')
    ? Response.json({ error: 'budget spent' }, { status: 429 })
    : Response.json({ id: 'https://openalex.org/W1', cited_by_count: 3 })));
  assert.deepEqual(events.filter(event => event.startsWith('lookup') && event !== 'lookup done'), ['lookup', 'lookup without key']);
});

test('a citation graph carries rebuilt abstracts, and none where OpenAlex has no usable one', async () => {
  const index = (text: string) => text.split(' ').reduce<Record<string, number[]>>((positions, word, position) => {
    (positions[word] ||= []).push(position);
    return positions;
  }, {});
  const abstract = 'We measure how often a graph keeps the abstracts of the papers it shows.';
  const works = [
    { id: 'https://openalex.org/W11', title: 'With abstract', cited_by_count: 9, abstract_inverted_index: index(abstract) },
    { id: 'https://openalex.org/W12', title: 'An editorial', type: 'editorial', cited_by_count: 8, abstract_inverted_index: index(abstract) },
    { id: 'https://openalex.org/W13', title: 'Without abstract', cited_by_count: 7 },
  ];
  let body: { references: Array<{ title: string; abstract: string }> } | null = null;
  await withCountedUpstream(async (address) => {
    const url = new URL(String(address));
    if (url.pathname.includes('/index/v2/references/')) return Response.json(works.map(work => ({ cited: `openalex:${work.id.split('/').pop()}` })));
    if (url.hostname.includes('opencitations')) return Response.json([]);
    if (url.pathname.startsWith('/works/doi:')) return Response.json({ id: 'https://openalex.org/W1', cited_by_count: 0 });
    return Response.json({ results: works });
  }, async () => {
    await withIdentityAndCacheStore(async () => {
      const response = await reportApi.fetch(new Request(CITATION_GRAPH_URL, { headers: SIGNED_IN }), AUTHENTICATED_ENV);
      body = await response.json();
    });
  });

  assert.deepEqual(body!.references.map(paper => [paper.title, paper.abstract]), [
    ['With abstract', abstract],
    ['An editorial', ''],
    ['Without abstract', ''],
  ]);
});

test('an OpenCitations failure does not own the citation graph for a week', async () => {
  const response = await citationGraphAnswer((url: string|string[]) => (url.includes('opencitations')
    ? new Response('gateway timeout', { status: 504 })
    : new Response(JSON.stringify({ id: 'https://openalex.org/W1', results: [] }), {
      headers: { 'content-type': 'application/json' },
    })));

  const payload = await response.json<{ degraded: boolean }>();
  assert.equal(payload.degraded, true);
  assert.equal(maxAgeSeconds(response), 120);
});

test('a heavily cited paper is partial by design and keeps its week', async () => {
  // The correction this test exists to hold: `partial` is also what a healthy
  // answer looks like. Past three hundred citations the route asks OpenAlex for
  // citing works on purpose, and shortening the TTL of the most-cited papers in
  // the corpus because nothing failed would be a fix worse than the fault.
  const response = await citationGraphAnswer((url: string|string[]) => {
    if (url.includes('opencitations')) {
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'https://openalex.org/W1',
      cited_by_count: 5_000,
      results: [],
    }), { headers: { 'content-type': 'application/json' } });
  });

  const payload = await response.json<{ partial: boolean; degraded: boolean }>();
  assert.equal(payload.partial, true);
  assert.equal(payload.degraded, false);
  assert.equal(maxAgeSeconds(response), 604800);
});

test('a citing working paper from OpenAlex is not peer reviewed and is marked one, and a citing work with no venue is unknown', async () => {
  // OpenAlex returns the IMF series as it returns Nature: `article`, in a
  // `journal`, published version (probed 2026-10-19).
  const citingWork = (id: string, title: string, source: { id: string; display_name: string; type: string } | null) => ({
    id: `https://openalex.org/${id}`,
    title,
    type: 'article',
    primary_location: { is_published: true, source },
  });
  const response = await citationGraphAnswer((url: string|string[]) => {
    if (url.includes('opencitations')) {
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'https://openalex.org/W1',
      cited_by_count: 5_000,
      results: [
        citingWork('W7215107402', 'Working paper', { id: 'https://openalex.org/S4210171147', display_name: 'IMF Working Paper', type: 'journal' }),
        citingWork('W2919115771', 'Journal article', { id: 'https://openalex.org/S137773608', display_name: 'Nature', type: 'journal' }),
        citingWork('W3', 'No venue', null),
      ],
    }), { headers: { 'content-type': 'application/json' } });
  });

  const { citations } = await response.json<{ citations: Array<{ title: string; peerReviewed?: boolean; workingPaper?: boolean }> }>();
  const byTitle = new Map(citations.map(paper => [paper.title, paper]));
  assert.equal(byTitle.get('Working paper')!.peerReviewed, false);
  assert.equal(byTitle.get('Working paper')!.workingPaper, true);
  assert.equal(byTitle.get('Journal article')!.peerReviewed, true);
  assert.equal(byTitle.get('Journal article')!.workingPaper, undefined);
  assert.equal(byTitle.get('No venue')!.peerReviewed, undefined);
});

test('a reference only OpenCitations Meta describes leaves its access unknown', async () => {
  // OpenCitations Meta has no access data. A `false` here showed "Closed
  // access" on the related card, and opening the card can only set it to open
  // (PAP-92).
  const response = await citationGraphAnswer(url => {
    if (url.includes('/works/doi:')) return Response.json({ id: 'https://openalex.org/W1', cited_by_count: 0 });
    if (url.includes('/index/v2/references/')) return Response.json([{ cited: 'omid:br/1 doi:10.5555/ref1' }]);
    if (url.includes('/meta/v1/metadata/')) {
      return Response.json([{ id: 'doi:10.5555/ref1 omid:br/1', title: 'Indexed by Meta alone', type: 'journal article' }]);
    }
    return Response.json(url.includes('opencitations') ? [] : { results: [] });
  });

  const { references } = await response.json<{ references: Array<{ title: string; openAccess?: boolean }> }>();
  assert.deepEqual(references.map(paper => [paper.title, paper.openAccess]), [['Indexed by Meta alone', undefined]]);
});

// --- G5: billed spend reaches the ledger, with a daily ceiling --------------

function recordingLedger(answer: (key: string) => QuotaReading = () => ({ accepted: true })) {
  const reservations: Array<{ periodKey: string; amount: number; limit: number; tally?: string; percent?: number }> = [];
  return {
    reservations,
    binding: {
      idFromName: (periodKey: string): unknown => periodKey,
      get: (periodKey: unknown): Pick<DurableObjectStub, 'fetch'> => ({
        fetch: async (_url, options) => {
          const body = JSON.parse(options!.body as string);
          reservations.push({ periodKey: periodKey as string, amount: body.amount, limit: body.globalLimit, tally: body.tally, percent: body.percent });
          return new Response(JSON.stringify(answer(periodKey as string)));
        },
      }),
    } as Env['REQUEST_QUOTA_LEDGER'],
  };
}

test('a cold citation graph reserves both OpenAlex ceilings in one call for what it may spend', async () => {
  const ledger = recordingLedger();
  await withCountedUpstream(citationGraphPage, async () => {
    await withIdentityAndCacheStore(async () => {
      const response = await reportApi.fetch(new Request(
        CITATION_GRAPH_URL,
        { headers: SIGNED_IN },
      ), { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: ledger.binding });
      assert.equal(response.status, 200);
    });
  });

  // The `openalex:*` ceiling used to cover only `/openalex/*`. A miss here can
  // make seven calls -- one `works/doi:` lookup, then up to three batches for
  // references and three for citations -- of which OpenAlex bills the six
  // batches, and the route reserves those six before the work starts, minute
  // and day together.
  const openAlex = ledger.reservations.filter(entry => entry.periodKey.startsWith('openalex:'));
  assert.deepEqual(openAlex.map(entry => entry.amount), [6]);
  assert.match(openAlex[0].periodKey, /^openalex:day:\d{4}-\d{2}-\d{2}$/);
  assert.equal(openAlex[0].limit, 8_000);
});

// The ledger itself behind every period key, so the ceilings are checked the way
// the Durable Object checks them, and every call to it is counted.
// Two misses in a row against ceilings of one: the second is refused by whichever
// ceiling is spent, and each miss is one call to the ledger. One paper by DOI
// is the request allowed the whole ceiling, so a ceiling of one is not already
// spent by a smaller share of it (PAP-88).
async function secondOpenAlexMiss(limits: Record<string, string>) {
  const ledger = inMemoryQuotaLedger();
  const env = openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding, ...limits });
  const relay = (doi: string) => reportApi.fetch(new Request(
    `https://papertok-report-api.example/openalex/works?filter=doi:${doi}&per-page=1`,
    { headers: BROWSER },
  ), env);
  const responses = await withWorkerFetchMock(
    async () => new Response('{"results":[]}', { headers: { 'content-type': 'application/json' } }),
    () => withIdentityAndCacheStore(async () => [await relay('10.1/x'), await relay('10.1/y')]),
  );
  return { responses, calls: ledger.calls };
}

test('the costliest cold citation graph spends exactly what it reserves', async () => {
  // 21 candidates known by OpenAlex id and 19 by DOI alone, per relation: the
  // split that needs the most batches of twenty from 40 candidates.
  const rows = (field: string, prefix: string) => Array.from({ length: 40 }, (_, index) => ({
    [field]: index < 21 ? `openalex:W${prefix}${index}` : `doi:10.9999/${prefix}${index}`,
  }));
  const ledger = recordingLedger();
  const calls = await withCountedUpstream(async (url) => {
    const address = String(url);
    if (address.includes('/index/v2/references/')) return Response.json(rows('cited', '1'));
    if (address.includes('/index/v2/citations/')) return Response.json(rows('citing', '2'));
    if (address.includes('opencitations')) return Response.json([]);
    return Response.json({ id: 'https://openalex.org/W1', cited_by_count: 40, results: [] });
  }, async () => {
    await withIdentityAndCacheStore(async () => {
      const response = await reportApi.fetch(new Request(CITATION_GRAPH_URL, { headers: SIGNED_IN }), {
        ...AUTHENTICATED_ENV,
        REQUEST_QUOTA_LEDGER: ledger.binding,
      });
      assert.equal(response.status, 200);
    });
  });

  const reserved = ledger.reservations.filter(entry => entry.periodKey.startsWith('openalex:'));
  const spent = calls.filter(address => address.startsWith('https://api.openalex.org/')).length;
  assert.equal(spent, 7);
  // Six of the seven are billed: the `works/doi:` lookup is one entity, free.
  assert.deepEqual(reserved.map(entry => entry.amount), [spent - 1]);
});

test('an OpenAlex search reserves the ten list calls it is billed as', async () => {
  const reserved = async (query: string) => {
    const ledger = recordingLedger();
    await withWorkerFetchMock(
      async () => Response.json({ results: [] }),
      () => withIdentityAndCacheStore(() => reportApi.fetch(new Request(
        `https://papertok-report-api.example/openalex/works?${query}`,
        { headers: BROWSER },
      ), openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding }))),
    );
    return ledger.reservations.map(entry => entry.amount);
  };

  assert.deepEqual(await reserved('search=ultracold%20gas'), [10]);
  assert.deepEqual(await reserved('filter=title_and_abstract.search:ultracold,type:article'), [10]);
  assert.deepEqual(await reserved('filter=raw_author_name.search:Ada%20Lovelace'), [10]);
  assert.deepEqual(await reserved('filter=publication_year:2019,type:article'), [1]);
});

// PAP-86: one entity by id or DOI is "Free" on OpenAlex's price list
// (help.openalex.org/access/example-costs/), and the relay reserved a list call
// for it: every card opened and every author clicked took a unit of the day's
// ceiling. The autocomplete endpoint is not on that list, and a `filter=doi:`
// batch is a list, so both still reserve one.
test('an OpenAlex entity by id or DOI reserves nothing and is still fetched', async () => {
  const reservedFor = async (path: string) => {
    const ledger = recordingLedger();
    let upstream = '';
    const response = await withWorkerFetchMock(
      async (url) => {
        upstream = String(url);
        return Response.json({ id: 'https://openalex.org/W1' });
      },
      () => withIdentityAndCacheStore(() => reportApi.fetch(new Request(
        `https://papertok-report-api.example/openalex/${path}`,
        { headers: BROWSER },
      ), openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding }))),
    );
    return { amounts: ledger.reservations.map(entry => entry.amount), status: response.status, upstream };
  };

  const work = await reservedFor('works/W2741809807');
  assert.deepEqual(work.amounts, []);
  assert.equal(work.status, 200);
  assert.match(work.upstream, /^https:\/\/api\.openalex\.org\/works\/W2741809807\?/);
  assert.deepEqual((await reservedFor('works/doi:10.1000/xyz123')).amounts, []);
  assert.deepEqual((await reservedFor('authors/A5023888391')).amounts, []);
  assert.deepEqual((await reservedFor('autocomplete/topics?q=quantum')).amounts, [1]);
  assert.deepEqual((await reservedFor('works?filter=doi:10.1000/a|10.1000/b')).amounts, [1]);
});

test('the per-minute OpenAlex ceiling refuses within the day and asks for a minute', async () => {
  const { responses, calls } = await secondOpenAlexMiss({ OPENALEX_GLOBAL_MINUTE_LIMIT: '1', OPENALEX_GLOBAL_DAILY_LIMIT: '100' });

  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 429);
  assert.deepEqual(await responses[1].json(), { code: 'PROVIDER_RATE_LIMITED' });
  assert.equal(responses[1].headers.get('retry-after'), '60');
  assert.equal(calls.length, 2, 'one ledger call per miss');
});

test('the daily OpenAlex ceiling refuses a request the per-minute one would allow', async () => {
  const { responses, calls } = await secondOpenAlexMiss({ OPENALEX_GLOBAL_MINUTE_LIMIT: '100', OPENALEX_GLOBAL_DAILY_LIMIT: '1' });

  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 429);
  assert.deepEqual(await responses[1].json(), { code: 'PROVIDER_RATE_LIMITED' });
  // Bounded on purpose. The true wait is the seconds left until UTC midnight, and
  // handing the client six hours is a tab that stops asking until it is reloaded.
  assert.equal(responses[1].headers.get('retry-after'), '300');
  assert.equal(calls.length, 2, 'one ledger call per miss');
});

test('a cached citation graph spends nothing against either ceiling', async () => {
  const ledger = recordingLedger();
  let afterFirst = 0;
  const calls = await withCountedUpstream(citationGraphPage, async collected => {
    await withIdentityAndCacheStore(async () => {
      const env = { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: ledger.binding };
      const request = () => reportApi.fetch(new Request(
        CITATION_GRAPH_URL,
        { headers: SIGNED_IN },
      ), env);
      await request();
      afterFirst = collected.length;
      ledger.reservations.length = 0;
      assert.equal((await request()).status, 200);
    });
  });

  assert.ok(afterFirst > 0, 'the first request reached the upstreams');
  assert.equal(calls.length, afterFirst, 'the second request was served from the cache');
  assert.deepEqual(ledger.reservations, []);
});

test('an OpenAlex outage on the current work degrades the graph, a 404 does not', async () => {
  // The worst case the `degraded` flag exists for, and the one the audit's own
  // `partial === true` rule would have missed entirely: `fetchOpenAlexCurrentWork`
  // swallows every error and answers `null`, so with OpenCitations empty too the
  // route used to return `{references: [], citations: [], partial: false}` -- and
  // cache that for seven days.
  const graphWith = (status: number) => citationGraphAnswer((url: string|string[]) => (url.includes('/works/doi:')
    ? new Response('nope', { status })
    : new Response(JSON.stringify(url.includes('opencitations') ? [] : { results: [] }), {
      headers: { 'content-type': 'application/json' },
    })));

  const outage = await graphWith(503);
  assert.equal((await outage.json<{ degraded: boolean }>()).degraded, true);
  assert.equal(maxAgeSeconds(outage), 120);

  // A DOI OpenAlex has never heard of is an answer, not an outage: the graph
  // built without it is the real one and keeps its week.
  const unknown = await graphWith(404);
  assert.equal((await unknown.json<{ degraded: boolean }>()).degraded, false);
  assert.equal(maxAgeSeconds(unknown), 604800);
});

test('a rejected OpenAlex batch is a short answer, not a complete one', async () => {
  // `Promise.allSettled` over the batches means a rejected chunk returns fewer
  // papers and looks exactly like a full result. Seven days of looking like one.
  const response = await citationGraphAnswer((url: string|string[]) => {
    if (url.includes('/works/doi:')) {
      return new Response(JSON.stringify({ id: 'https://openalex.org/W1' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('opencitations')) {
      return new Response(JSON.stringify([{ cited: 'doi:10.5555/ref1', creation: '2020-01-01' }]), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // Only the batch that resolves the references fails. The citing-works call
    // answers normally, so nothing else in the route can raise the flag and the
    // assertion below has to come from the batch itself.
    if (url.includes('filter=cites')) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('upstream exploded', { status: 500 });
  });

  const payload = await response.json<{ degraded: boolean; references: unknown }>();
  assert.equal(payload.degraded, true);
  assert.deepEqual(payload.references, []);
  assert.equal(maxAgeSeconds(response), 120);
});

// --- /sources/pubmed and /sources/s2 -----------------------------------------
// These two used to be called straight from the browser. PubMed as three serial
// E-utilities requests with no key and no abort signal, Semantic Scholar behind a
// module-variable limiter that counted per tab. Both now run here.

// Both new routes fail closed when the ledger binding is missing, the same way
// `/openalex/*` does: an unreachable ceiling is not a reason to spend somebody
// else's rate limit. Tests that are about the proxying therefore have to supply
// one, and production supplies it through `wrangler.toml`.
const OPEN_ROUTE_ENV = {
  REQUEST_QUOTA_LEDGER: {
    idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'],
};

function countingQuotaLedger(state: QuotaState, accepted = true) {
  return {
    idFromName: (name: string): unknown => {
      state.periodKeys.push(String(name));
      return `quota-${name}`;
    },
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (url) => {
        state.reservations += 1;
        if (String(url).endsWith('/release')) state.releases = (state.releases ?? 0) + 1;
        return new Response(JSON.stringify(accepted ? { accepted: true } : { accepted: false, scope: 'global' }));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];
}

test('runs the whole PubMed chain in the Worker and returns the three payloads', async () => {
  const upstream: URL[] = [];
  const response = await withWorkerFetchMock(async url => {
    const requested = new URL(String(url));
    upstream.push(requested);
    if (requested.pathname.endsWith('esearch.fcgi')) {
      return new Response(JSON.stringify({ esearchresult: { count: '412', idlist: ['31000001', '31000002'] } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requested.pathname.endsWith('esummary.fcgi')) {
      return new Response(JSON.stringify({ result: { 31000001: { uid: '31000001', title: 'One' } } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('<PubmedArticleSet><PubmedArticle/></PubmedArticleSet>', {
      headers: { 'content-type': 'application/xml' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria&page=3&limit=25',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  assert.equal(response.status, 200);
  const payload = await response.json<{ esearchresult: { idlist: unknown; count: string }; result: Array<{ title: string }>; efetch: string; _papertok: { efetch: string } }>();
  assert.deepEqual(payload.esearchresult.idlist, ['31000001', '31000002']);
  assert.equal(payload.esearchresult.count, '412');
  assert.equal(payload.result['31000001'].title, 'One');
  assert.match(payload.efetch, /PubmedArticleSet/);
  assert.equal(payload._papertok.efetch, 'ok');

  const byEndpoint = Object.fromEntries(upstream.map(url => [url.pathname.split('/').pop(), url]));
  assert.deepEqual(Object.keys(byEndpoint).sort(), ['efetch.fcgi', 'esearch.fcgi', 'esummary.fcgi']);
  // Page three of twenty-five starts at fifty, not at zero: paging has to reach
  // the second and third screen of a category, not re-serve the first.
  assert.equal(byEndpoint['esearch.fcgi'].searchParams.get('retstart'), '50');
  assert.equal(byEndpoint['esearch.fcgi'].searchParams.get('retmax'), '25');
  assert.equal(byEndpoint['esummary.fcgi'].searchParams.get('id'), '31000001,31000002');
  assert.equal(byEndpoint['efetch.fcgi'].searchParams.get('id'), '31000001,31000002');
  // NCBI asks automated callers to identify themselves on every request.
  assert.equal(byEndpoint['esearch.fcgi'].searchParams.get('tool'), 'papertok');
  assert.equal(byEndpoint['esearch.fcgi'].searchParams.get('email'), 'app@papertok.io');
});

test('attaches the NCBI key only when configured and never one the caller sent', async () => {
  const withoutKey: string[] = [];
  await withWorkerFetchMock(async url => {
    withoutKey.push(String(url));
    return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), {
      headers: { 'content-type': 'application/json' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria&api_key=caller-key',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  // The upstream URL is rebuilt from a fixed parameter list, so a key a caller
  // tried to smuggle in cannot reach NCBI and be billed to somebody else's quota.
  assert.equal(withoutKey.length, 1);
  assert.ok(!withoutKey[0].includes('api_key'), `caller api_key reached NCBI: ${withoutKey[0]}`);

  const withKey: string[] = [];
  await withWorkerFetchMock(async url => {
    withKey.push(String(url));
    return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), {
      headers: { 'content-type': 'application/json' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), { ...OPEN_ROUTE_ENV, NCBI_API_KEY: 'worker-key' }));

  assert.match(withKey[0], /api_key=worker-key/);
});

test('keeps the PubMed summaries when only the abstract half fails', async () => {
  const response = await withWorkerFetchMock(async url => {
    const requested = new URL(String(url));
    if (requested.pathname.endsWith('esearch.fcgi')) {
      return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['31000001'] } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requested.pathname.endsWith('esummary.fcgi')) {
      return new Response(JSON.stringify({ result: { 31000001: { uid: '31000001', title: 'One' } } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('nope', { status: 503 });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  // Losing efetch loses the abstracts, which the client can still get from
  // OpenAlex and Europe PMC. Losing the records too would lose the batch.
  assert.equal(response.status, 200);
  const payload = await response.json<{ result: Array<{ title: string }>; efetch: string; _papertok: { efetch: string } }>();
  assert.equal(payload.result['31000001'].title, 'One');
  assert.equal(payload.efetch, '');
  assert.equal(payload._papertok.efetch, 'unavailable');
  // ...but a degraded answer does not get the healthy answer's ten minutes. A
  // one-second hiccup at NCBI must not leave a whole category without abstracts
  // for everybody until the TTL runs out.
  assert.match(response.headers.get('cache-control')!, /s-maxage=120\b/);
  assert.doesNotMatch(response.headers.get('cache-control')!, /stale-while-revalidate/);
});

// NCBI counts per second. A burst of route misses spends esearch calls all at
// once and then twice as many esummary+efetch calls all at once -- eight misses
// are past the 10 req/s the key buys, and 3 of the 8 came back 429 (measured
// 2026-09-01, reproduced 2026-09-02). The window is a second, so one retry after
// a short wait lands in the next one. `retry-after: 0` here so the test does not
// sleep; in production NCBI sends none and the route waits 300-800 ms.
test('retries a PubMed call NCBI refused for a second instead of losing the batch', async () => {
  const calls: string[] = [];
  const response = await withWorkerFetchMock(async url => {
    const endpoint = new URL(String(url)).pathname.split('/').pop()!;
    calls.push(endpoint);
    if (endpoint === 'esearch.fcgi') {
      return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['31000001'] } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (endpoint === 'esummary.fcgi') {
      if (calls.filter(name => name === 'esummary.fcgi').length === 1) {
        return new Response(JSON.stringify({ error: 'API rate limit exceeded' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ result: { 31000001: { uid: '31000001', title: 'One' } } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('<PubmedArticleSet><PubmedArticle/></PubmedArticleSet>', {
      headers: { 'content-type': 'application/xml' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  assert.equal(response.status, 200);
  const payload = await response.json<{ result: Array<{ title: string }>; _papertok: { efetch: string } }>();
  assert.equal(payload.result['31000001'].title, 'One');
  assert.equal(payload._papertok.efetch, 'ok');
  assert.equal(calls.filter(name => name === 'esummary.fcgi').length, 2, 'refused once, retried once');
  assert.equal(calls.filter(name => name === 'esearch.fcgi').length, 1, 'a call that succeeded is not repeated');
});

test('a second PubMed refusal is relayed as a refusal, not retried again', async () => {
  let attempts = 0;
  const response = await withWorkerFetchMock(async () => {
    attempts += 1;
    return new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(attempts, 2, 'esearch: one refusal, one retry, then the refusal is relayed');
});

test('does not retry a PubMed refusal whose advertised wait the route cannot afford', async () => {
  let attempts = 0;
  const response = await withWorkerFetchMock(async () => {
    attempts += 1;
    return new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(attempts, 1, 'thirty seconds do not fit in a six-second route');
});

test('drops identifiers PubMed did not answer with before putting them in a URL', async () => {
  const upstream: URL[] = [];
  await withWorkerFetchMock(async url => {
    const requested = new URL(String(url));
    upstream.push(requested);
    if (requested.pathname.endsWith('esearch.fcgi')) {
      return new Response(JSON.stringify({ esearchresult: { count: '2', idlist: ['31000001', '../../evil'] } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ result: {} }), { headers: { 'content-type': 'application/json' } });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/pubmed?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  const summary = upstream.find(url => url.pathname.endsWith('esummary.fcgi'));
  assert.equal(summary!.searchParams.get('id'), '31000001');
});

test('refuses a PubMed request with no query without spending the shared ceiling', async () => {
  const state: QuotaState = { reservations: 0, periodKeys: [] };
  const originalCaches = (globalThis as TestGlobals).caches;
  (globalThis as TestGlobals).caches = { default: { match: async (): Promise<Response | null | undefined> => null, put: async (): Promise<unknown> => undefined } };
  try {
    const response = await reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state) });

    assert.equal(response.status, 400);
    assert.equal(state.reservations, 0);
  } finally {
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('serves a cached PubMed answer without an upstream call or a reservation', async () => {
  const state: QuotaState = { reservations: 0, periodKeys: [] };
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('No upstream request should be made');
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => ((request as Request).url.includes('/cache/sources/pubmed')
        ? new Response(JSON.stringify({ esearchresult: { idlist: ['1'] } }), { headers: { 'content-type': 'application/json' } })
        : null),
      put: async (): Promise<unknown> => undefined,
    },
  };
  try {
    const response = await reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state) });

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 0);
    // The ceiling exists to bound calls to NCBI. A cache hit makes none, so it
    // must not consume one either -- otherwise repeated queries cost quota.
    assert.equal(state.reservations, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('refuses PubMed with retry-after once the shared per-minute ceiling is full', async () => {
  const state: QuotaState = { reservations: 0, periodKeys: [] };
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('No upstream request should be made');
  };
  (globalThis as TestGlobals).caches = { default: { match: async (): Promise<Response | null | undefined> => null, put: async (): Promise<unknown> => undefined } };
  try {
    const response = await reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state, false) });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal((await response.json<{ code: string }>()).code, 'PROVIDER_RATE_LIMITED');
    assert.equal(upstreamCalls, 0);
    assert.match(state.periodKeys[0], /^pubmed:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('proxies Semantic Scholar search with the Worker key and a bounded offset', async () => {
  let upstreamUrl = '';
  let upstreamHeaders: Record<string, string> = {};
  const response = await withWorkerFetchMock(async (url, options) => {
    upstreamUrl = String(url);
    upstreamHeaders = options?.headers as Record<string, string> || {};
    return new Response(JSON.stringify({ total: 3, data: [{ paperId: 'abc', title: 'One' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/s2?q=malaria&page=90&limit=25',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), { ...OPEN_ROUTE_ENV, SEMANTIC_SCHOLAR_API_KEY: 's2-test-key' }));

  assert.equal(response.status, 200);
  assert.equal((await response.json<{ data: Array<{ paperId: string }> }>()).data[0].paperId, 'abc');
  assert.match(upstreamUrl, /graph\/v1\/paper\/search/);
  assert.equal(upstreamHeaders['x-api-key'], 's2-test-key');
  // Semantic Scholar answers offset + limit past a thousand with a 400. Paging
  // off the end has to run out of records, not turn into a dead source.
  const offset = Number(new URL(upstreamUrl).searchParams.get('offset'));
  assert.ok(offset + 25 <= 1000, `offset ${offset} would be refused by Semantic Scholar`);
});

test('leaves the Semantic Scholar key off entirely when none is configured', async () => {
  let upstreamCalls = 0;
  let upstreamHeaders: Record<string, string> = {};
  await withWorkerFetchMock(async (_url, options) => {
    upstreamCalls += 1;
    upstreamHeaders = options?.headers as Record<string, string> || {};
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/s2?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  assert.equal(upstreamCalls, 1, 'the request never reached Semantic Scholar, so the header assertion proves nothing');
  assert.equal(upstreamHeaders['x-api-key'], undefined);
});

test('charges /related and /sources/s2 to the same Semantic Scholar ceiling', async () => {
  const state: QuotaState = { reservations: 0, periodKeys: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ recommendedPapers: [] }), {
    headers: { 'content-type': 'application/json' },
  });
  try {
    await withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=20',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: countingQuotaLedger(state) }));

    await withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state) }));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // One namespace, because both spend the same provider allowance. A limiter with
  // one counter per route is the per-tab limiter this replaced, wearing a hat.
  // The pace keys are the same namespace's beat, counted separately below.
  const minuteKeys = state.periodKeys.filter(key => key.startsWith('s2:') && !key.endsWith(':pace'));
  assert.equal(minuteKeys.length, 2, `expected both routes on the s2 ceiling, saw ${JSON.stringify(state.periodKeys)}`);
  const paceKeys = state.periodKeys.filter(key => key === 's2:pace');
  assert.equal(paceKeys.length, 2, 'both routes have to keep the same beat');
  // Both requests went through: nothing was refused, so nothing is given back.
  // A release on the accepted path would mint a minute unit out of nothing.
  assert.equal(state.releases ?? 0, 0);
});

test('asks Semantic Scholar for twenty whatever the client asked, so one paper is one entry', async () => {
  let upstreamUrl = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    upstreamUrl = String(url);
    return new Response(JSON.stringify({ recommendedPapers: [] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=8',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The feed seeds from twenty and the sheet shows eight. With `limit` in the key
  // those were two misses and two provider calls for one list of which the
  // second is a prefix of the first -- at one request a second, a refusal.
  assert.match(upstreamUrl, /limit=20/);
});

test('serves the sheet and the feed the same /related entry for one paper', async () => {
  const stored = new Map<string, Response>();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ recommendedPapers: [] }), { headers: { 'content-type': 'application/json' } });
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => (String((request as Request).url).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : stored.get((request as Request).url)?.clone() || null),
      put: async (request, response): Promise<unknown> => stored.set((request as Request).url, response.clone()),
    },
  };
  try {
    const ask = (limit: number) => reportApi.fetch(new Request(
      `https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=${limit}`,
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV);

    await ask(20);
    await ask(8);
    await ask(20);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }

  assert.equal(upstreamCalls, 1);
  assert.equal(stored.size, 1);
});

// Semantic Scholar's 429 reached the browser from `/sources/s2` as a 429 with a
// code and from `/related` as `502 Related papers unavailable` -- the one shape a
// client retries at once. Both routes spend the same key; they relay the same way.
test('/related relays a Semantic Scholar refusal with its code, its status and a short wait', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    () => withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=20',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV)),
  );

  assert.equal(response.status, 429);
  const body = await response.json<{ code: string; upstreamStatus: number }>();
  assert.equal(body.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(body.upstreamStatus, 429);
  // Semantic Scholar names no wait and its window is one second: a minute here
  // is fifty-nine seconds of a reader waiting for a slot that opened long ago.
  assert.equal(response.headers.get('retry-after'), '2');
  // And the page can read it: unexposed, a browser hands the client `null`
  // and the two-second wait is indistinguishable from a failure (PAP-49).
  assert.match(response.headers.get('access-control-expose-headers') || '', /\bretry-after\b/);
});

test('/related names a stalled Semantic Scholar instead of dressing it as a generic failure', async () => {
  const response = await withWorkerFetchMock(
    async () => { throw new DOMException('aborted due to timeout', 'TimeoutError'); },
    () => withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=20',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV)),
  );

  assert.equal(response.status, 502);
  const body = await response.json<{ error: string; code: string; upstreamStatus: unknown }>();
  assert.equal(body.error, 'Related papers unavailable');
  assert.equal(body.code, 'UPSTREAM_TIMEOUT');
  assert.equal(body.upstreamStatus, undefined, 'a stall has no status to relay');
});



test('tells a client refused by Semantic Scholar search to wait a second, not a minute', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), OPEN_ROUTE_ENV),
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '2');
});

// The ledger accepts the minute and refuses every second: what the route must do
// then is answer 429 itself, with the short wait, and never call the provider.
function paceRefusingLedger(state: { periodKeys: string[] }) {
  let lastName = '';
  return {
    idFromName: (name: string): unknown => {
      lastName = String(name);
      state.periodKeys.push(lastName);
      return `quota-${lastName}`;
    },
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async () => new Response(JSON.stringify(
        lastName.endsWith(':pace') ? { accepted: false, scope: 'user' } : { accepted: true },
      )),
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];
}

test('refuses a Semantic Scholar search itself when no second is free, without spending the provider', async () => {
  const state: { periodKeys: string[] } = { periodKeys: [] };
  let upstreamCalls = 0;
  const response = await withWorkerFetchMock(
    async () => { upstreamCalls += 1; return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }); },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: paceRefusingLedger(state) }),
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'PROVIDER_RATE_LIMITED');
  // Not a literal: the same constant the beat derives from its own wait budget,
  // so raising the budget cannot leave this header quietly lying.
  assert.equal(response.headers.get('retry-after'), PACE_RETRY_AFTER_SECONDS);
  assert.equal(upstreamCalls, 0, 'a request the beat refused must not reach Semantic Scholar');
  assert.ok(state.periodKeys.includes('s2:pace'), `the beat was never consulted: ${JSON.stringify(state.periodKeys)}`);
});

// One fake ledger for every quota-accounting test. It is told, per period key,
// what to do -- `refuse` answers not-accepted, `unavailable` answers non-2xx
// (what `callRequestQuotaLedger` reports as QUOTA_LEDGER_UNAVAILABLE), `broken`
// throws (a Durable Object that cannot be reached at all) -- and it records
// every reserve and every release with the key it was aimed at, so a test can
// assert that a refund names exactly the key and subject the reserve named.
function scriptedQuotaLedger(state: QuotaScriptState, { refuse = () => false, unavailable = () => false, broken = () => false }: { refuse?: (key: string) => boolean; unavailable?: (key: string) => boolean; broken?: (key: string) => boolean } = {}) {
  let lastName = '';
  return {
    idFromName: (name: string): unknown => { lastName = String(name); return `quota-${lastName}`; },
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (url, options) => {
        const action = String(url).split('/').pop()!;
        const body = JSON.parse(options!.body as string);
        state.actions.push({ action, periodKey: lastName, subjectKey: body.subjectKey, amount: body.amount, tally: body.tally });
        if (action === 'release') return new Response(JSON.stringify({ released: true }));
        if (broken(lastName)) throw new Error(`ledger unreachable: ${lastName}`);
        if (unavailable(lastName)) return new Response('down', { status: 500 });
        if (refuse(lastName)) return new Response(JSON.stringify({ accepted: false, scope: 'user' }));
        return new Response(JSON.stringify({ accepted: true }));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];
}

// The period keys the gates use, as predicates: the minute ceiling is
// `s2:<minute>`, the beat is `s2:pace`, identity is `provider:<minute>`, and
// OpenAlex is `openalex:day:<date>`, which checks the minute as its subject.
const IS_MINUTE = (key: string) => key.startsWith('s2:') && !key.endsWith(':pace');
const IS_PACE = (key: string) => key.endsWith(':pace');
const IS_IDENTITY = (key: string) => key.startsWith('provider:');
const IS_OPENALEX = (key: string) => key.startsWith('openalex:');

const releasesOf = (state: QuotaScriptState) => state.actions.filter((a: { action: string; }) => a.action === 'release');

// A refund is a refund only if it names the key and the subject the reserve
// named: a recomputed key credits the next period, a different subject credits
// somebody else.
function assertRefunded(state: QuotaScriptState, isKey: (key: string) => boolean) {
  const reserve = state.actions.find(a => a.action === 'reserve' && isKey(a.periodKey));
  const release = releasesOf(state).find(a => isKey(a.periodKey));
  assert.ok(reserve, `no reserve matched: ${JSON.stringify(state.actions)}`);
  assert.ok(release, `no release matched: ${JSON.stringify(state.actions)}`);
  assert.equal(release.periodKey, reserve.periodKey);
  assert.equal(release.subjectKey, reserve.subjectKey);
}

test('gives the minute back when the beat refuses, to the same minute it was taken from', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await withWorkerFetchMock(
    async () => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: IS_PACE }) }),
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'PROVIDER_RATE_LIMITED');
  const minuteReserve = state.actions.find(a => a.action === 'reserve' && !a.periodKey.endsWith(':pace'));
  const releases = state.actions.filter(a => a.action === 'release');
  assert.ok(minuteReserve, `no minute reservation seen: ${JSON.stringify(state.actions)}`);
  assert.equal(releases.length, 1, `expected exactly one release, saw ${JSON.stringify(releases)}`);
  // The refund has to name the minute the reserve named, and the same subject:
  // a minute recomputed at release time credits the next one when the request
  // straddled the boundary, and a different subject credits somebody else.
  assert.equal(releases[0].periodKey, minuteReserve.periodKey);
  assert.equal(releases[0].subjectKey, minuteReserve.subjectKey);
});

const RELATED_URL = 'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345';
const RELAY_WORKS_URL = 'https://papertok-report-api.example/openalex/works?filter=doi:10.1%2Fa&per-page=50';
const relatedThrough = (ledger: WorkerEnv['REQUEST_QUOTA_LEDGER'], upstream: typeof fetch = async () => new Response(
  JSON.stringify({ recommendedPapers: [] }), { headers: { 'content-type': 'application/json' } },
)) => withWorkerFetchMock(upstream, () => withCachedIdentity(() => reportApi.fetch(new Request(RELATED_URL, {
  headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' },
}), { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: ledger })));

// L1: the identity gate refuses after the minute unit was already taken.
test('gives the minute unit back when the identity quota refuses after it', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await relatedThrough(scriptedQuotaLedger(state, { refuse: IS_IDENTITY }));

  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'PROVIDER_RATE_LIMITED');
  assertRefunded(state, IS_MINUTE);
  assert.equal(releasesOf(state).length, 1, 'only the minute unit was held');
});

// L4: the beat refuses after both the minute unit and the identity unit were
// taken. The beat used to refund the minute on its own and had no way to know
// the identity unit existed; now the owner of both refunds both.
test('gives the minute unit and the identity unit back when the beat refuses after them', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await relatedThrough(scriptedQuotaLedger(state, { refuse: IS_PACE }));

  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'PROVIDER_RATE_LIMITED');
  assertRefunded(state, IS_MINUTE);
  assertRefunded(state, IS_IDENTITY);
  assert.equal(releasesOf(state).length, 2, 'the minute and identity units were held');
});

// L5: the OpenAlex budget refuses after the identity unit was taken. The
// citation graph has no minute ceiling entry, so the identity unit is the only
// thing at risk.
test('gives the identity unit back when the OpenAlex budget refuses after it', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await withWorkerFetchMock(citationGraphPage, () => withCachedIdentity(() => reportApi.fetch(
    new Request(CITATION_GRAPH_URL, { headers: SIGNED_IN }),
    { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: IS_OPENALEX }) },
  )));

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60', 'the OpenAlex minute ceiling names its own wait');
  assertRefunded(state, IS_IDENTITY);
  assert.equal(releasesOf(state).length, 1, 'only the identity unit was held');
});

// The relay reaches the budget without `cacheResponse`, so nothing else would
// give back a unit the budget took before refusing. Both ceilings are one call,
// so a refusal holds nothing.
test('a refused /openalex relay holds no OpenAlex unit', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await withWorkerFetchMock(
    async () => new Response('{"results":[]}', { headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      RELAY_WORKS_URL,
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { ...OPEN_ROUTE_ENV, REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: IS_OPENALEX }) }),
  );

  assert.equal(response.status, 429);
  assert.equal(state.actions.filter(a => a.action === 'reserve' && IS_OPENALEX(a.periodKey)).length, 1);
  assert.equal(releasesOf(state).length, 0);
});

// The accepted path gives nothing back: every unit taken was spent on a real
// provider call. A refund here would mint quota out of nothing.
test('gives nothing back when every gate accepts', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await relatedThrough(scriptedQuotaLedger(state));

  assert.equal(response.status, 200);
  assert.equal(releasesOf(state).length, 0, JSON.stringify(state.actions));
});

// L2a: the identity gate's Durable Object cannot be reached, with the minute
// unit already taken. The throw reaches the router's catch and becomes a 502;
// the unit has to come back on the way.
test('gives the minute unit back when the identity ledger throws after it', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await relatedThrough(scriptedQuotaLedger(state, { broken: IS_IDENTITY }));

  assert.equal(response.status, 502);
  assertRefunded(state, IS_MINUTE);
  assert.equal(releasesOf(state).length, 1, 'only the minute unit was held before the identity ledger threw');
});

// L2b: the beat's Durable Object cannot be reached, with both units taken.
test('gives both units back when the pace ledger throws after them', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await relatedThrough(scriptedQuotaLedger(state, { broken: IS_PACE }));

  assert.equal(response.status, 502);
  assertRefunded(state, IS_MINUTE);
  assertRefunded(state, IS_IDENTITY);
  assert.equal(releasesOf(state).length, 2, 'the minute and identity units were held before the pace ledger threw');
});

// L3: the beat's Durable Object answers but not-ok -- QUOTA_LEDGER_UNAVAILABLE
// -- which `awaitSharedPace` reports as a 503. `s2:pace` is a different object
// from `s2:<minute>`, so it can fail with the minute unit already accepted.
test('gives both units back when the pace ledger is unavailable after them', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await relatedThrough(scriptedQuotaLedger(state, { unavailable: IS_PACE }));

  assert.equal(response.status, 503);
  assert.equal((await response.json<{ code: string }>()).code, 'PROVIDER_QUOTA_NOT_CONFIGURED');
  assertRefunded(state, IS_MINUTE);
  assertRefunded(state, IS_IDENTITY);
  assert.equal(releasesOf(state).length, 2, 'the minute and identity units were held before the pace ledger was unavailable');
});

// Not a leak: a fetch that fails may still have reached the provider -- a
// timeout is a send that got no answer, a 429 is a send that counted -- and the
// ledger counts sends. Refunding here would let it count fewer sends than were
// made, and under sustained pressure exceed the one-a-second the beat exists
// to keep. So the units stay spent. This test is the decision, pinned.
test('gives nothing back when the fetcher fails, because the send may have happened', async () => {
  const state: QuotaScriptState = { actions: [] };
  const response = await withWorkerFetchMock(
    async () => { throw new Error('provider hung up'); },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state) }),
  );

  assert.equal(response.status, 502);
  assert.ok(state.actions.some(a => a.action === 'reserve' && IS_MINUTE(a.periodKey)), 'the minute unit was taken');
  assert.equal(releasesOf(state).length, 0, `a refund after the fetcher: ${JSON.stringify(releasesOf(state))}`);
});

test('does not put PubMed on the Semantic Scholar beat', async () => {
  const state: QuotaState = { periodKeys: [], reservations: 0 };
  await withWorkerFetchMock(
    async () => new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), { headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state) }),
  );

  assert.deepEqual(state.periodKeys.filter(key => key.endsWith(':pace')), [], 'NCBI counts ten a second and has its own retry; it needs no beat');
});

test('keeps two different PubMed queries in two different cache entries', async () => {
  const stored = new Map<string, Response>();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => stored.get((request as Request).url)?.clone() || null,
      put: async (request, response): Promise<unknown> => stored.set((request as Request).url, response.clone()),
    },
  };
  try {
    const ask = (query: string) => reportApi.fetch(new Request(
      `https://papertok-report-api.example/sources/pubmed?q=${query}&limit=25`,
      { headers: { origin: 'https://mugar123.github.io' } },
    ), OPEN_ROUTE_ENV);

    await ask('malaria');
    await ask('tuberculosis');
    await ask('malaria');

    // A route with no entry in `CACHE_PARAMS_BY_PATH` gets an empty parameter
    // list, which collapses every query onto one entry keyed by origin alone --
    // and the first answer is then served to everybody who asks for anything.
    assert.equal(upstreamCalls, 2);
    assert.equal(stored.size, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

// The body of a cached answer is the same whoever asks -- same upstream URL,
// same canonical parameters -- and the only thing that ever differed by origin
// was the CORS header stored with it. Keying on the origin protected that
// header at the price of one upstream call per origin: for `/health/scopus`,
// which is cached precisely to guard a weekly provider allowance, a monitor
// without an `Origin` and a browser with one were two calls for one answer.
test('one cached answer serves every allowed origin, each with its own CORS header', async () => {
  const stored = new Map<string, Response>();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } });
  };
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request): Promise<Response | null | undefined> => stored.get((request as Request).url)?.clone() || null,
      put: async (request, response): Promise<unknown> => stored.set((request as Request).url, response.clone()),
    },
  };
  try {
    const url = 'https://papertok-report-api.example/sources/s2?q=malaria';
    const ask = (headers: { origin?: string; }) => reportApi.fetch(new Request(url, { headers }), OPEN_ROUTE_ENV);

    const bare = await ask({});
    const apex = await ask({ origin: 'https://papertok.app' });
    const www = await ask({ origin: 'https://www.papertok.app' });

    assert.equal(upstreamCalls, 1, 'three askers, one provider call');
    assert.equal(stored.size, 1, 'three askers, one entry');
    assert.equal(bare.headers.get('access-control-allow-origin'), null, 'no Origin, no CORS header');
    assert.equal(apex.headers.get('access-control-allow-origin'), 'https://papertok.app');
    assert.equal(www.headers.get('access-control-allow-origin'), 'https://www.papertok.app');
    // Intermediate and browser caches must not cross-serve either.
    assert.equal(www.headers.get('vary'), 'Origin');
    assert.deepEqual(await www.json(), { data: [] }, 'the shared body is the body');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

// `serveCached` carries `status: cached.status` forward explicitly (:327) --
// every other cached route always stores a 200, so nothing about them can tell
// a real status passthrough apart from a hardcoded one. Only these three
// health routes cache a status that varies with provider health, and this is
// the route the whole task is about: `/health/scopus` is cached to protect a
// *weekly* Elsevier allowance, so a cached unhealthy result silently becoming
// a false-positive 200 for the next caller would misreport provider health
// with nothing to catch it. Scopus left unconfigured is the cleanest way to
// make the probe report unhealthy -- `checkScopusHealth` returns before it
// ever reaches the network, so this needs no fetch mock to fake a bad answer.
test('serves a cached unhealthy Scopus probe as 503, not a false-positive 200, to a different origin', async () => {
  const stored = new Map<string, Response>();
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  (globalThis as TestGlobals).caches = {
    default: {
      async match(key): Promise<Response | null | undefined> {
        const hit = stored.get(String((key as Request).url));
        return hit ? hit.clone() : null;
      },
      async put(key, response): Promise<void> {
        stored.set(String((key as Request).url), response.clone());
      },
    },
  };
  // Canary: an unconfigured Scopus egress must answer without ever reaching
  // the network. If it did, this would throw instead of silently agreeing.
  globalThis.fetch = async () => {
    throw new Error('unexpected upstream call for an unconfigured Scopus egress');
  };
  try {
    const scopusHealthRequest = (origin: string) => new Request(
      'https://papertok-report-api.example/health/scopus',
      { headers: { origin } },
    );
    const first = await reportApi.fetch(scopusHealthRequest('https://papertok.app'), {});
    const second = await reportApi.fetch(scopusHealthRequest('https://www.papertok.app'), {});

    assert.equal(first.status, 503, 'unconfigured Scopus is unhealthy on the miss');
    assert.equal(stored.size, 1, 'one entry for the one path, regardless of origin');
    assert.equal(second.status, 503, 'still 503 on the cache hit -- not defaulted to 200');
    assert.equal(first.headers.get('access-control-allow-origin'), 'https://papertok.app');
    assert.equal(
      second.headers.get('access-control-allow-origin'),
      'https://www.papertok.app',
      "the second, different origin gets its own header, not the first caller's",
    );
    assert.equal((await second.json<{ code: string }>()).code, 'SCOPUS_NOT_CONFIGURED');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
});

test('relays an upstream refusal as a refusal instead of flattening it to 502', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(JSON.stringify({ message: 'Too Many Requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), OPEN_ROUTE_ENV),
  );

  // 502 says "this source is broken", and a client that believes that retries
  // straight away -- which is the one thing that makes a rate limit worse.
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal((await response.json<{ code: string }>()).code, 'UPSTREAM_RATE_LIMITED');
});

test('falls back to a minute when the upstream refused without saying for how long', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), OPEN_ROUTE_ENV),
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});

// A 400 of our own making (a URL we built wrong) and an outage of theirs both
// left the Worker as the same `Specialist source unavailable` 502; the one
// number that told them apart -- `Upstream error: 400` -- lived only in
// `wrangler tail`. That is how the OpenReview `tcdate` bug stayed invisible
// for weeks. Scopus already relayed `upstreamStatus`; every source does now.
test('names the upstream status on every source so a 400 of ours is not a 502 of theirs', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response(JSON.stringify({ name: 'SearchError', message: 'No mapping found for [tcdate]' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/openreview?q=neuroscience',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), {}),
  );

  assert.equal(response.status, 502);
  const body = await response.json<{ error: string; upstreamStatus: number; code: unknown }>();
  assert.equal(body.error, 'Specialist source unavailable');
  assert.equal(body.upstreamStatus, 400);
  assert.equal(body.code, undefined, 'a plain upstream error carries no code, only its status');
});

test('names a timed-out upstream instead of dressing it as a generic failure', async () => {
  const response = await withWorkerFetchMock(
    async () => { throw new DOMException('aborted due to timeout', 'TimeoutError'); },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/openreview?q=neuroscience',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), {}),
  );

  assert.equal(response.status, 502);
  const body = await response.json<{ code: string; upstreamStatus: unknown }>();
  assert.equal(body.code, 'UPSTREAM_TIMEOUT');
  assert.equal(body.upstreamStatus, undefined, 'a stall has no status to relay');
});

/* ============================================================
   /ai/rewrite
   ============================================================ */

// These go through `reportApi.fetch`, not through `handlePaperRewrite`, and
// that is the whole point of them. The rewrite handler had a full suite of its
// own and every test in it imported the module directly, so a `main` entrypoint
// that never registered the route passed everything green while the browser got
// the generic 404 on every rewrite.

const REWRITE_ROUTE = 'https://papertok-report-api.example/ai/rewrite';

function rewriteEnvironment(overrides: WorkerEnv = {}): WorkerEnv {
  const env: WorkerEnv = { ...AUTHENTICATED_ENV, GEMINI_API_KEY: 'gemini-test-key', ...overrides };
  env.PAPER_REWRITE_SESSION = {
    newUniqueId: (() => 'rewrite-session') as unknown as Env['PAPER_REWRITE_SESSION']['newUniqueId'],
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async request => new PaperRewriteSession({}, env).fetch(request as Request),
    })) as TestNamespace['get'],
  } as Env['PAPER_REWRITE_SESSION'];
  return env;
}

const REWRITE_ENV = rewriteEnvironment();

function rewriteRequest(method = 'POST', origin = 'https://mugar123.github.io') {
  return new Request(REWRITE_ROUTE, {
    method,
    ...(method === 'POST' ? {
      body: JSON.stringify({
        paper: { title: 'A study of things', pdfUrl: 'https://arxiv.org/pdf/2601.00001.pdf' },
        level: 'university',
        language: 'en',
      }),
    } : {}),
    headers: {
      origin,
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
  });
}

/** One Gemini SSE line, in the CRLF form the real endpoint sends. */
function geminiFrame(text: string, extra = {}) {
  return `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, ...extra }],
  })}\r\n\r\n`;
}

function rewriteUpstream(url: RequestInfo | URL, frames: string[]) {
  return String(url).includes('generativelanguage.googleapis.com')
    ? new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })
    // Anything else on this route is the PDF download.
    : new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      headers: { 'content-type': 'application/pdf' },
    });
}

test('the router serves POST /ai/rewrite instead of dropping it into the 404', async () => {
  const section = `${JSON.stringify({
    kind: 'intro',
    heading: 'Why it matters',
    paragraphs: ['Because of this.'],
  })}\n`;

  // The body is drained inside the mock's scope on purpose. The 200 now commits
  // before the download and the model run — that is what keeps the browser's
  // stall timer from killing a long paper — so by the time `fetch` resolves the
  // detached pump has not made a single upstream call yet. Reading the body
  // afterwards, as this test first did, restores the real `globalThis.fetch`
  // first and sends the pump to the actual network: three seconds of it, and an
  // `error` line instead of the sections.
  const { response, body } = await withWorkerFetchMock(
    async url => rewriteUpstream(url, [geminiFrame(section), geminiFrame('', { finishReason: 'STOP' })]),
    () => withCachedIdentity(async () => {
      const streamed = await reportApi.fetch(rewriteRequest(), REWRITE_ENV);
      return { response: streamed, body: await streamed.text() };
    }),
  );

  assert.equal(response.status, 200);
  // Streamed, not wrapped in `json()`: the first line has to leave before the
  // last one exists.
  assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');

  const events = body.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ['meta', 'section', 'done']);
  assert.equal(events[1].heading, 'Why it matters');
});

test('/ai/rewrite refuses anything but POST', async () => {
  const response = await reportApi.fetch(rewriteRequest('GET'), REWRITE_ENV);

  // Not the generic GET fallthrough further down: a rewrite is a POST, and the
  // route has to say so itself.
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

test('the /ai/rewrite preflight is answered before the route is reached', async () => {
  const response = await reportApi.fetch(new Request(REWRITE_ROUTE, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://mugar123.github.io',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  }), REWRITE_ENV);

  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-methods')!, /(?:^|,\s*)POST(?:,|$)/);
  assert.match(response.headers.get('access-control-allow-headers')!, /authorization/);
});

test('/ai/rewrite refuses an origin that is not on the list', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw new Error('No upstream request should be made');
  }, () => reportApi.fetch(rewriteRequest('POST', 'https://evil.example'), REWRITE_ENV));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('the rewrite session still requires Firebase identity before provider work', async () => {
  const request = rewriteRequest();
  request.headers.delete('authorization');
  const response = await withWorkerFetchMock(async () => {
    throw new Error('Unauthenticated rewrites must not contact a provider');
  }, () => reportApi.fetch(request, REWRITE_ENV));
  assert.equal(response.status, 401);
  assert.equal((await response.json<{ code: string }>()).code, 'AI_AUTH_REQUIRED');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

test('a missing rewrite session binding fails closed instead of running on edge CPU', async () => {
  const response = await reportApi.fetch(rewriteRequest(), { ...REWRITE_ENV, PAPER_REWRITE_SESSION: undefined });
  assert.equal(response.status, 503);
  assert.equal((await response.json<{ code: string }>()).code, 'AI_NOT_CONFIGURED');
});

test('an unavailable rewrite session returns a retryable error with CORS', async () => {
  const response = await reportApi.fetch(rewriteRequest(), {
    ...REWRITE_ENV,
    PAPER_REWRITE_SESSION: {
      newUniqueId: REWRITE_ENV.PAPER_REWRITE_SESSION!.newUniqueId,
      get: () => { throw new Error('Session unavailable'); },
    } as unknown as Env['PAPER_REWRITE_SESSION'],
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json<{ code: string }>()).code, 'AI_UNAVAILABLE');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

test('relays a rewrite refusal with its own status, code and quota', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw new Error('No upstream request should be made');
  }, () => withCachedIdentity(() => reportApi.fetch(rewriteRequest(), rewriteEnvironment({
    REQUEST_QUOTA_LEDGER: {
      idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
      get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response(JSON.stringify({ accepted: false, scope: 'user' })) })) as TestNamespace['get'],
    } as Env['REQUEST_QUOTA_LEDGER'],
  }))));

  // The quota block is what tells the reader when the uses come back; flattening
  // this to a bare 502 would lose both the reason and the reset time.
  assert.equal(response.status, 429);
  const payload = await response.json<{ code: string; quota: { scope: string; resetAt: unknown } }>();
  assert.equal(payload.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(payload.quota.scope, 'user');
  assert.ok(payload.quota.resetAt);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

test('closes the API host to crawlers with its own robots.txt', async () => {
  // Un rastreador no manda `origin`, asi que la ruta tiene que contestar sin el.
  const response = await reportApi.fetch(
    new Request('https://api.papertok.app/robots.txt'),
    {},
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^text\/plain/);
  const body = await response.text();
  assert.match(body, /^User-agent: \*$/m);
  assert.match(body, /^Disallow: \/$/m);
  assert.doesNotMatch(body, /^Allow: \//m);
});

// --- bioRxiv outages are answered once per two minutes, not once per visit ---
// api.biorxiv.org hangs on some calls (4 of 6 over 20 s on 2026-09-23) and on
// 2026-09-24 answered every call with an empty 200. A failure used to go out
// as an uncached 502, so each cold visit paid the six-second deadline again
// (audit 2026-09-23, issue 11b). It is now a degraded, briefly cached answer.

async function bioRxivAnswer(upstream: typeof fetch) {
  return withWorkerFetchMock(upstream, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/biorxiv?category=neuroscience&page=1&limit=10',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));
}

test('a bioRxiv timeout is a degraded empty answer, cached for two minutes', async () => {
  const response = await bioRxivAnswer(async () => {
    throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  });

  assert.equal(response.status, 200);
  const payload = await response.json<{ collection: unknown; _papertok: { degraded: string } }>();
  assert.deepEqual(payload.collection, []);
  assert.equal(payload._papertok.degraded, 'UPSTREAM_TIMEOUT');
  assert.equal(maxAgeSeconds(response), 120);
  assert.doesNotMatch(response.headers.get('cache-control')!, /stale-while-revalidate/);
});

test('an empty or non-JSON bioRxiv body and a bioRxiv 5xx are degraded too', async () => {
  const empty = await bioRxivAnswer(async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal((await empty.json<{ _papertok: { degraded: string } }>())._papertok.degraded, 'UPSTREAM_INVALID');
  assert.equal(maxAgeSeconds(empty), 120);

  const outage = await bioRxivAnswer(async () => new Response('down', { status: 503 }));
  assert.equal((await outage.json<{ _papertok: { degraded: string } }>())._papertok.degraded, 'UPSTREAM_503');
});

test('a healthy bioRxiv answer keeps its ten minutes and says nothing is degraded', async () => {
  const response = await bioRxivAnswer(async () => new Response(JSON.stringify({
    messages: [{ status: 'ok' }],
    collection: [{ doi: '10.1101/2026.09.01.000001', title: 'A preprint', category: 'neuroscience' }],
  }), { headers: { 'content-type': 'application/json' } }));

  const payload = await response.json<{ collection: { length: number }; _papertok: { degraded: unknown } }>();
  assert.equal(payload.collection.length, 1);
  assert.equal(payload._papertok?.degraded, undefined);
  assert.equal(maxAgeSeconds(response), 600);
});

test('bioRxiv pages of any limit share one upstream call and one cache entry', async () => {
  const collection = Array.from({ length: 30 }, (_, index) => ({ doi: `10.1101/2026.09.01.${index}`, title: `Preprint ${index}` }));
  const calls = await withCountedUpstream(async () => Response.json({ collection }), async () => {
    await withIdentityAndCacheStore(async () => {
      for (const limit of [8, 2, 10]) {
        const response = await reportApi.fetch(new Request(
          `https://papertok-report-api.example/sources/biorxiv?category=neuroscience&page=1&limit=${limit}`,
          { headers: { origin: 'https://mugar123.github.io' } },
        ), {});
        // The whole group of thirty: the client keeps the first `limit`.
        assert.equal((await response.json<{ collection: unknown[] }>()).collection.length, 30);
      }
    });
  });
  assert.equal(calls.filter(url => url.startsWith('https://api.biorxiv.org/')).length, 1);
});

/**
 * The share pages (worker/share-pages.ts) as the router serves them: public,
 * GET and HEAD, and with no Origin, because the caller is Vercel relaying a
 * crawler. What a miss may spend goes through the same ledgers as everything
 * else here: its own ceiling first, then OpenAlex's shared budget.
 */
const APP_SHELL = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const SHARED_DOI_KEY = encodePaperKey('doi', '10.1145/3555174');
const SHARED_WORK = {
  id: 'https://openalex.org/W4304195660',
  doi: 'https://doi.org/10.1145/3555174',
  title: 'Characterizing Alternative Monetization Strategies on YouTube',
  publication_year: 2022,
  publication_date: '2022-11-07',
  type: 'article',
  authorships: [{ author: { display_name: 'Yiqing Hua' } }],
};

function crawlerRequest(path: string, { method = 'GET' } = {}) {
  return new Request(`https://papertok-report-api.example${path}`, {
    method,
    // A Spanish-speaking crawler still gets the English page: PaperTok is English-only.
    headers: { 'user-agent': 'facebookexternalhit/1.1', 'accept-language': 'es-ES,es;q=0.9' },
  });
}

function shareUpstream(urls: Array<{ address: string; authorization: string | null }>, { work = SHARED_WORK } = {}) {
  return async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const address = String(url);
    urls.push({ address, authorization: new Headers(init.headers).get('authorization') });
    if (address === 'https://papertok.app/index.html') {
      return new Response(APP_SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (address.startsWith('https://api.openalex.org/works/doi:10.1145/3555174')) {
      return new Response(JSON.stringify(work), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected upstream ${address}`);
  };
}

test('a crawler gets a paper page with no Origin, from OpenAlex under the Worker key', async () => {
  const urls: Array<{ address: string; authorization: string | null }> = [];
  const response = await withWorkerFetchMock(
    shareUpstream(urls),
    () => reportApi.fetch(crawlerRequest(`/share/paper/${SHARED_DOI_KEY}`), openAlexEnv()),
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^text\/html/);
  assert.match(html, /<title>Characterizing Alternative Monetization Strategies on YouTube<\/title>/);
  assert.match(html, /<html lang="en">/);
  const openAlex = urls.find(entry => entry.address.startsWith('https://api.openalex.org/'));
  assert.ok(openAlex, 'the paper came from OpenAlex');
  assert.match(openAlex.address, /[?&]api_key=worker-key(&|$)/, 'under the key the browser cannot hold');
  assert.match(openAlex.address, /[?&]mailto=app%40papertok\.io(&|$)/);
});

test('a share page answers HEAD without a body and refuses anything but GET and HEAD', async () => {
  const urls: never[] = [];
  const head = await withWorkerFetchMock(
    shareUpstream(urls),
    () => reportApi.fetch(crawlerRequest(`/share/paper/${SHARED_DOI_KEY}`, { method: 'HEAD' }), openAlexEnv()),
  );
  const post = await withWorkerFetchMock(
    shareUpstream(urls),
    () => reportApi.fetch(crawlerRequest(`/share/paper/${SHARED_DOI_KEY}`, { method: 'POST' }), openAlexEnv()),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('a share lookup its ceiling refuses spends nothing upstream and answers the generic head', async () => {
  const urls: Array<{ address: string; authorization: string | null }> = [];
  const state: QuotaScriptState = { actions: [] };
  const response = await withWorkerFetchMock(
    shareUpstream(urls),
    () => reportApi.fetch(crawlerRequest(`/share/paper/${SHARED_DOI_KEY}`), {
      ...openAlexEnv(),
      REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: (key: string) => key.startsWith('share:') }),
    }),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>PaperTok — Discover scientific research<\/title>/);
  assert.equal(urls.some(entry => entry.address.startsWith('https://api.openalex.org/')), false);
  assert.equal(
    state.actions.some(action => action.periodKey.startsWith('openalex:')),
    false,
    'OpenAlex budget untouched',
  );
});

test('a share lookup checks its minute and day ceilings in one ledger call', async () => {
  const state: QuotaScriptState = { actions: [] };
  await withWorkerFetchMock(
    shareUpstream([]),
    () => reportApi.fetch(crawlerRequest(`/share/paper/${SHARED_DOI_KEY}`), {
      ...openAlexEnv(),
      REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state),
    }),
  );
  const lookups = state.actions.filter(action => action.periodKey.startsWith('share:') && !action.periodKey.startsWith('share:arxiv:'));
  assert.equal(lookups.length, 1, JSON.stringify(state.actions));
  assert.match(lookups[0].periodKey, /^share:day:\d{4}-\d{2}-\d{2}$/);
});

// The hourly arXiv unit was taken before the seat and kept when no seat came,
// so a burst of previews for a fresh preprint drained the hour without a
// single call to arXiv (review of 2026-09-25).
test('an arXiv call a share page could not seat gives its hourly unit back', async () => {
  const urls: string[] = [];
  const state: QuotaScriptState = { actions: [] };
  const response = await withWorkerFetchMock(
    async (url) => {
      const address = String(url);
      urls.push(address);
      if (address === 'https://papertok.app/index.html') {
        return new Response(APP_SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (address.startsWith('https://api.openalex.org/works')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected upstream ${address}`);
    },
    () => reportApi.fetch(crawlerRequest(`/share/paper/${encodePaperKey('arxiv', '2609.28470')}`), {
      ...openAlexEnv(),
      REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: IS_ARXIV_PACE }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    state.actions.filter(action => action.periodKey.startsWith('share:arxiv:')).map(action => action.action),
    ['reserve', 'release'],
  );
  assert.equal(urls.some(url => url.includes('export.arxiv.org')), false, 'no seat, no call');
});

test('a list page reads the public document anonymously, as a visitor would', async () => {
  const urls: { address: string; authorization: string|null; }[] = [];
  const shareId = '0123456789abcdef0123456789abcdef';
  const documents: Record<string, Record<string, unknown>> = {
    [`publicLists/${shareId}`]: {
      title: { stringValue: 'Tutoring with language models' },
      papers: { arrayValue: {} },
    },
  };
  const upstream = shareUpstream(urls);
  const response = await withWorkerFetchMock(
    async (url, init) => {
      const address = String(url);
      const prefix = 'https://firestore.googleapis.com/v1/projects/papertok-test/databases/(default)/documents/';
      if (address.startsWith(prefix)) {
        urls.push({ address, authorization: new Headers(init?.headers).get('authorization') });
        const fields = documents[address.slice(prefix.length)];
        return fields
          ? new Response(JSON.stringify({ name: address, fields }), { status: 200 })
          : new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
      }
      return upstream(url, init);
    },
    () => reportApi.fetch(crawlerRequest(`/share/list/${shareId}`), openAlexEnv({ FIREBASE_PROJECT_ID: 'papertok-test' })),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Tutoring with language models \| PaperTok public list<\/title>/);
  const reads = urls.filter(entry => entry.address.includes('firestore.googleapis.com'));
  assert.equal(reads.length, 1);
  assert.equal(reads.every(entry => entry.authorization === null), true, 'no credential: the rules decide as for anyone');
});

// The PDF relay behind the touch-screen viewer. It must stay a relay for the
// hosts the AI routes already read, never a general proxy.
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%fake\n');
const pdfRelay = (target: string, env: WorkerEnv, upstream: typeof fetch, origin = 'https://mugar123.github.io') => withWorkerFetchMock(
  upstream,
  () => reportApi.fetch(new Request(
    `https://papertok-report-api.example/pdf?url=${encodeURIComponent(target)}`,
    { headers: { ...(origin ? { origin } : {}), 'cf-connecting-ip': '192.0.2.1' } },
  ), { PDF_RATE_LIMIT_SECRET: 'test-only-pdf-rate-limit-key-32-bytes', ...env }),
);
const pdfUpstream = (calls: string[]) => async (url: RequestInfo | URL) => {
  calls.push(String(url));
  return new Response(PDF_BYTES, { headers: { 'content-type': 'application/pdf' } });
};

test('relays an arXiv PDF to the app with CORS and an edge-cacheable answer', async () => {
  const calls: string[] = [];
  const response = await pdfRelay(
    'https://arxiv.org/pdf/2601.00001',
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    pdfUpstream(calls),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
  assert.match(response.headers.get('cache-control')!, /s-maxage=86400/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PDF_BYTES);
  assert.deepEqual(calls, ['https://arxiv.org/pdf/2601.00001']);
});

test('refuses to relay a PDF from a host outside the allowlist, without fetching it', async () => {
  const calls: string[] = [];
  for (const target of ['https://evil.example/paper.pdf', 'http://arxiv.org/pdf/2601.00001', 'not a url']) {
    const response = await pdfRelay(target, { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) }, pdfUpstream(calls));
    assert.equal(response.status, 400, target);
    assert.equal((await response.json<{ code: string }>()).code, 'PDF_HOST_NOT_ALLOWED');
  }
  assert.equal(calls.length, 0);
});

test('refuses a PDF relay request without the app as its origin', async () => {
  const calls: string[] = [];
  for (const origin of ['', 'https://evil.example']) {
    const response = await pdfRelay(
      'https://arxiv.org/pdf/2601.00001',
      { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
      pdfUpstream(calls),
      origin,
    );
    assert.equal(response.status, 403, origin || '(no origin)');
  }
  assert.equal(calls.length, 0);
});

test('does not follow a redirect off the PDF allowlist', async () => {
  const calls: string[] = [];
  const response = await pdfRelay(
    'https://arxiv.org/pdf/2601.00001',
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/x.pdf' } });
    },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(calls, ['https://arxiv.org/pdf/2601.00001']);
});

test('refuses to relay an answer that is not a PDF', async () => {
  const response = await pdfRelay(
    'https://arxiv.org/pdf/2601.00001',
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async () => new Response('<html>captcha</html>', { headers: { 'content-type': 'text/html' } }),
  );

  assert.equal(response.status, 415);
  assert.equal((await response.json<{ reason: string }>()).reason, 'not_pdf');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a PDF relay miss is refused with 429 when the shared minute ceiling is spent, without fetching', async () => {
  const calls: string[] = [];
  const response = await pdfRelay(
    'https://arxiv.org/pdf/2601.00001',
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }, { refuse: (key: string) => key.startsWith('pdf:') }) },
    pdfUpstream(calls),
  );

  assert.equal(response.status, 429);
  assert.equal(calls.length, 0);
});

test('a PDF relay closes when there is no ledger to bound it', async () => {
  const calls: string[] = [];
  const response = await pdfRelay('https://arxiv.org/pdf/2601.00001', {}, pdfUpstream(calls));

  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

// --- PAP-88: the day's OpenAlex budget, spent in order of what matters ---------
// On launch day every OpenAlex request stopped at once when the day's ceiling
// ran out, the paper a reader had just opened included. Each miss now reserves
// under a tier read from the URL the Worker is about to pay for, and a lower
// tier stops at a smaller share of the ceiling, so the reads the feed's
// harvest and an opened paper need keep working longest.

const relayPath = (path: string) => (path.startsWith('https://') ? path : `https://papertok-report-api.example/openalex/${path}`);

test('each OpenAlex request shape reserves under its tier', async () => {
  const tallied = async (path: string) => {
    const ledger = recordingLedger();
    await withWorkerFetchMock(
      async () => Response.json({ results: [] }),
      () => reportApi.fetch(new Request(relayPath(path), { headers: BROWSER }), openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding })),
    );
    return ledger.reservations.map(entry => `${entry.tally} ${entry.amount}`);
  };
  const shapes: Array<[string, string[]]> = [
    // One paper being opened: the public page's fallback by arXiv landing page.
    ['works?filter=locations.landing_page_url:http://arxiv.org/abs/2601.00001|https://arxiv.org/abs/2601.00001&per_page=1', ['essential.list 1']],
    // The feed's topic lane and working-paper series. Since #272 only the
    // harvest asks for them, and it spends `feed` whatever it asks; from a
    // reader they are exploration like any other list.
    ['works?filter=primary_topic.id:T10604,type:article&per-page=25', ['exploration.list 1']],
    ['works?filter=primary_location.source.id:S2809516038|S4210171147,type:article|report&per-page=6', ['exploration.list 1']],
    // Shown cards, by DOI, OpenAlex id or arXiv landing page.
    ['works?filter=doi:10.1000/a|10.1000/b&per-page=50', ['enrichment.list 1']],
    ['works?filter=openalex:W1|W2&per_page=50&select=id,doi,ids', ['enrichment.list 1']],
    ['works?filter=locations.landing_page_url:http://arxiv.org/abs/2601.00001|https://arxiv.org/abs/2601.00001&per_page=50', ['enrichment.list 1']],
    // A graph expansion, a profile's reviewed works (negated series are not
    // the working-paper lane), a profile lookup by ORCID, a count probe.
    ['works?filter=openalex:W1|W2&per-page=50&select=id,ids', ['exploration.list 1']],
    [`works?filter=author.id:A1,primary_location.is_published:true,${OPENALEX_PEER_REVIEWED_FILTER}&per-page=25`, ['exploration.list 1']],
    ['authors?filter=orcid:0000-0002-1825-0097&per-page=1', ['exploration.list 1']],
    ['works?filter=institutions.ror:https://ror.org/05a28rw58&per-page=1&select=id', ['exploration.list 1']],
    ['works?search=ultracold%20gas', ['exploration.search 10']],
    ['autocomplete/authors?q=ada', ['exploration.list 1']],
    // One entity by id is free and never asks the ledger.
    ['works/W2741809807', []],
  ];
  for (const [path, expected] of shapes) {
    assert.deepEqual(await tallied(path), expected, path);
  }

  const graph = recordingLedger();
  await withCountedUpstream(citationGraphPage, () => withIdentityAndCacheStore(() => reportApi.fetch(
    new Request(CITATION_GRAPH_URL, { headers: SIGNED_IN }),
    { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: graph.binding },
  )));
  assert.deepEqual(
    graph.reservations.filter(entry => entry.periodKey.startsWith('openalex:')).map(entry => `${entry.tally} ${entry.amount}`),
    ['exploration.graph 6'],
  );
});

test("past the exploration share an exploration miss is refused with its tier named, while the harvest's miss at the same usage and a stored exploration answer are still served", async () => {
  const ceiling = 1_000;
  const ledger = inMemoryQuotaLedger();
  const env = openAlexEnv({
    REQUEST_QUOTA_LEDGER: ledger.binding,
    NOTIFICATION_STORE: fakeOpenAlexStore(),
    OPENALEX_GLOBAL_DAILY_LIMIT: String(ceiling),
  });
  const stored = relayPath('authors?filter=last_known_institutions.id:I1&per-page=25');
  const explored = relayPath('authors?filter=last_known_institutions.id:I2&per-page=25');
  const feed = relayPath('works?filter=primary_topic.id:T10604,type:article&per-page=25');
  // A fresh edge cache for every request: another location, or a later hour.
  const ask = (url: string) => withIdentityAndCacheStore(() => reportApi.fetch(new Request(url, { headers: BROWSER }), env));
  const harvest = (url: string) => withIdentityAndCacheStore(() => handleHarvestOpenAlex(new Request(url), env));

  const calls = await withCountedUpstream(async () => Response.json({ results: [] }), async () => {
    assert.equal((await ask(stored)).status, 200);
    // The rest of the day's usage up to the exploration share, spent elsewhere.
    const share = Math.floor(ceiling * OPENALEX_TIER_PERCENT.exploration / 100);
    await reserveRequestQuota(ledger.binding, {
      periodKey: `openalex:day:${new Date().toISOString().slice(0, 10)}`,
      subject: 'elsewhere',
      subjectLimit: ceiling,
      globalLimit: ceiling,
      amount: share - 1,
    });

    const refused = await ask(explored);
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { code: 'PROVIDER_RATE_LIMITED' });
    assert.equal(refused.headers.get('retry-after'), '300');
    assert.equal(refused.headers.get('x-papertok-budget-tier'), 'exploration');
    assert.equal(refused.headers.get('access-control-allow-origin'), BROWSER.origin);
    const exposed = refused.headers.get('access-control-expose-headers')!.split(',').map(name => name.trim());
    assert.ok(exposed.includes('retry-after') && exposed.includes('x-papertok-budget-tier'), exposed.join());

    assert.equal((await harvest(feed)).status, 200, 'the harvest still has its share');
    assert.equal((await ask(stored)).status, 200, 'a stored answer needs no budget');
  });
  assert.equal(calls.length, 2, 'the first stored answer and the harvest miss; nothing for the refusal or the stored read');
});

// A reader and the harvest can ask for the same URL under different tiers: a
// batch of cards by DOI is enrichment (80 %) from a reader and `feed` (95 %)
// from the harvest. Identical misses in flight share one call, and a reader's
// refusal at 80 % used to be shared the same way, ending a harvest run's
// enrichment phase.
const CARD_BATCH = relayPath('works?filter=doi:10.1000/a|10.1000/b&per-page=50');
const CARD_ANSWER = { results: [{ id: 'https://openalex.org/W1' }] };

// Holds whoever reaches it until it is opened, so a second request can arrive
// while the first still waits on the ledger or on OpenAlex.
function gate() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  const reached = new Promise<void>(resolve => { reach = resolve; });
  return { open, reached, pass: () => { reach(); return opened; } };
}

// Long enough for a request that has just started to reach the miss in flight.
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

// The day's ledger with 8,000 of a 10,000-unit ceiling spent: enrichment's
// share is used up and `feed`'s is not. With `held`, every call to the ledger
// after that waits at the gate.
async function dayAtEightThousand(held?: ReturnType<typeof gate>) {
  const ledger = inMemoryQuotaLedger();
  await reserveRequestQuota(ledger.binding, {
    periodKey: `openalex:day:${new Date().toISOString().slice(0, 10)}`,
    subject: 'elsewhere',
    subjectLimit: 10_000,
    globalLimit: 10_000,
    amount: 8_000,
  });
  const binding = held
    ? {
      idFromName: (name: string): unknown => name,
      get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => ({
        fetch: async (url, init) => {
          await held.pass();
          return ledger.binding!.get(name as DurableObjectId).fetch(url, init);
        },
      }),
    } as Env['REQUEST_QUOTA_LEDGER']
    : ledger.binding;
  return openAlexEnv({ REQUEST_QUOTA_LEDGER: binding, OPENALEX_GLOBAL_DAILY_LIMIT: '10000' });
}

test("at 8,000 of 10,000 units a reader's card batch is refused, and the harvest asking for the same batch meanwhile is answered under its own tier", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T15:00:00Z') });
  const ledger = gate();
  const env = await dayAtEightThousand(ledger);
  const upstream: string[] = [];
  const [reader, ...harvest] = await withWorkerFetchMock(async (url) => {
    upstream.push(String(url));
    return Response.json(CARD_ANSWER);
  }, async () => {
    const reader = reportApi.fetch(new Request(CARD_BATCH, { headers: BROWSER }), env);
    await ledger.reached;
    // Two harvest requests, so the requests the refusal leaves waiting are
    // seen to share one new miss.
    const harvest = [handleHarvestOpenAlex(new Request(CARD_BATCH), env), handleHarvestOpenAlex(new Request(CARD_BATCH), env)];
    await settle();
    ledger.open();
    return Promise.all([reader, ...harvest]);
  });

  assert.equal(reader.status, 429);
  assert.equal(reader.headers.get('x-papertok-budget-tier'), 'enrichment');
  for (const response of harvest) {
    assert.equal(response.status, 200, "the reader's refusal is not the harvest's");
    assert.deepEqual(await response.json(), CARD_ANSWER);
  }
  assert.equal(upstream.length, 1);
  const { report } = await readOpenAlexBudget(env);
  assert.ok(report);
  assert.equal(report.tiers.feed.used, 1, 'one reservation for both harvest requests');
});

test('a request whose own tier is used up gets the answer of a miss already in flight at no unit, but starts none of its own', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T15:00:00Z') });
  const env = await dayAtEightThousand();
  const openAlex = gate();
  const upstream: string[] = [];
  const reader = () => reportApi.fetch(new Request(CARD_BATCH, { headers: BROWSER }), env);
  const [harvest, joined, alone] = await withWorkerFetchMock(async (url) => {
    upstream.push(String(url));
    await openAlex.pass();
    return Response.json(CARD_ANSWER);
  }, async () => {
    const harvest = handleHarvestOpenAlex(new Request(CARD_BATCH), env);
    await openAlex.reached;
    const joined = reader();
    await settle();
    openAlex.open();
    return [await harvest, await joined, await reader()];
  });

  assert.equal(harvest.status, 200);
  assert.equal(joined.status, 200, 'it joined the call the harvest was making');
  assert.deepEqual(await joined.json(), CARD_ANSWER);
  assert.equal(joined.headers.get('access-control-allow-origin'), BROWSER.origin);
  assert.equal(alone.status, 429, 'with nothing in flight, its tier refuses it');
  assert.equal(alone.headers.get('x-papertok-budget-tier'), 'enrichment');
  assert.equal(upstream.length, 1);
  const { report } = await readOpenAlexBudget(env);
  assert.ok(report);
  assert.equal(report.tiers.feed.used, 1);
  assert.equal(report.tiers.enrichment.used, 0, 'joining spent nothing');
});

test("OpenAlex's own refusal of a miss in flight is shared with the requests waiting on it", async () => {
  const ledger = recordingLedger();
  const env = openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
  const openAlex = gate();
  const upstream: string[] = [];
  const responses = await withWorkerFetchMock(async (url) => {
    upstream.push(String(url));
    await openAlex.pass();
    return Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'retry-after': '3600' } });
  }, async () => {
    const reader = reportApi.fetch(new Request(CARD_BATCH, { headers: BROWSER }), env);
    await openAlex.reached;
    const harvest = handleHarvestOpenAlex(new Request(CARD_BATCH), env);
    await settle();
    openAlex.open();
    return Promise.all([reader, harvest]);
  });

  for (const response of responses) {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '3600');
    assert.equal(response.headers.get('x-papertok-budget-tier'), null, "OpenAlex's refusal, not the Worker's");
  }
  assert.equal(upstream.length, 1, 'the harvest did not ask OpenAlex again');
  assert.equal(ledger.reservations.length, 1, 'nor reserve again');
});

test('a refusal at the full ceiling and a minute refusal also name the tier', async () => {
  const limits = [
    { OPENALEX_GLOBAL_MINUTE_LIMIT: '1', OPENALEX_GLOBAL_DAILY_LIMIT: '100' },
    { OPENALEX_GLOBAL_MINUTE_LIMIT: '100', OPENALEX_GLOBAL_DAILY_LIMIT: '1' },
  ];
  for (const limit of limits) {
    const { responses } = await secondOpenAlexMiss(limit);
    assert.equal(responses[1].status, 429, JSON.stringify(limit));
    // Without it the client would close OpenAlex for the whole tab, entity
    // reads that cost nothing included.
    assert.equal(responses[1].headers.get('x-papertok-budget-tier'), 'essential', JSON.stringify(limit));
  }
});

test('a share page for a DOI or a work reserves nothing; one for an arXiv id reserves enrichment.share', async () => {
  const openAlexReservations = async (key: string | null) => {
    const state: QuotaScriptState = { actions: [] };
    await withWorkerFetchMock(
      async (url) => {
        const address = String(url);
        if (address === 'https://papertok.app/index.html') {
          return new Response(APP_SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        if (address.startsWith('https://api.openalex.org/works/')) return Response.json(SHARED_WORK);
        if (address.startsWith('https://api.openalex.org/works?')) return Response.json({ results: [] });
        throw new Error(`unexpected upstream ${address}`);
      },
      () => reportApi.fetch(crawlerRequest(`/share/paper/${key}`), {
        ...openAlexEnv(),
        REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: IS_ARXIV_PACE }),
      }),
    );
    return state.actions
      .filter(action => action.periodKey.startsWith('openalex:'))
      .map(action => `${action.tally} ${action.amount}`);
  };

  assert.deepEqual(await openAlexReservations(SHARED_DOI_KEY), []);
  assert.deepEqual(await openAlexReservations(encodePaperKey('openalex', 'W4304195660')), []);
  assert.deepEqual(await openAlexReservations(encodePaperKey('arxiv', '2609.28470')), ['enrichment.share 1']);
});

// OpenAlex reports what is left of the key's day on its answers. On launch day
// the ledger refused at its configured 8000 while the key still had 2,460
// calls (PAP-86); the ceiling now follows the key, less a margin, whenever a
// reading for today arrives.
const budgetHeaders = (units: number, resetSeconds: number) => ({
  'x-ratelimit-remaining-usd': (units * OPENALEX_UNIT_USD).toFixed(4),
  'x-ratelimit-reset': String(resetSeconds),
});

test("a remaining budget OpenAlex reports for today closes billed misses at the margin; a reading from yesterday's counter does not; a work by id is still relayed", async t => {
  // Half a minute past midnight UTC: OpenAlex's counter for the day before may
  // still be answering.
  const now = Date.parse('2026-10-22T00:00:30Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const untilTomorrow = (Date.parse('2026-10-23T00:00:00Z') - now) / 1000;
  const ledger = inMemoryQuotaLedger();
  const env = openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
  const answers: Record<string, Record<string, string>> = {
    // Yesterday's counter, five seconds from its reset, nothing left.
    '/works/W1': budgetHeaders(0, 5),
    '/works': budgetHeaders(0, 5),
    // Today's counter, with exactly the margin left.
    '/works/W2': budgetHeaders(OPENALEX_OBSERVATION_MARGIN, untilTomorrow),
    '/works/W3': budgetHeaders(OPENALEX_OBSERVATION_MARGIN, untilTomorrow),
  };
  const relay = (path: string) => reportApi.fetch(new Request(relayPath(path), { headers: BROWSER }), env);
  const upstream: string[] = [];
  const statuses = await withWorkerFetchMock(async (url) => {
    const { pathname } = new URL(String(url));
    upstream.push(pathname);
    return Response.json({ id: 'https://openalex.org/W1', results: [] }, { headers: answers[pathname] });
  }, async () => [
    (await relay('works/W1')).status,
    (await relay('works?filter=doi:10.1000/a&per-page=1')).status,
    (await relay('works/W2')).status,
    await relay('works?filter=doi:10.1000/b&per-page=1'),
    (await relay('works/W3')).status,
  ]);

  const [first, afterStale, second, refused, third] = statuses as [number, number, number, Response, number];
  assert.deepEqual([first, afterStale, second, third], [200, 200, 200, 200]);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { code: 'PROVIDER_RATE_LIMITED' });
  assert.equal(refused.headers.get('x-papertok-budget-tier'), 'essential');
  assert.deepEqual(upstream, ['/works/W1', '/works', '/works/W2', '/works/W3'], 'the refused miss asked OpenAlex nothing');
});

test("OpenAlex's own refusal reporting an empty key closes billed misses at once", async t => {
  const now = Date.parse('2026-10-22T15:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const ledger = inMemoryQuotaLedger();
  const env = openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding });
  let calls = 0;
  const responses = await withWorkerFetchMock(async () => {
    calls += 1;
    return Response.json({ error: 'Rate limit exceeded' }, {
      status: 429,
      headers: { ...budgetHeaders(0, (Date.parse('2026-10-23T00:00:00Z') - now) / 1000), 'retry-after': '32400' },
    });
  }, async () => [
    await reportApi.fetch(new Request(relayPath('works?filter=doi:10.1000/a&per-page=1'), { headers: BROWSER }), env),
    await reportApi.fetch(new Request(relayPath('works?filter=doi:10.1000/b&per-page=1'), { headers: BROWSER }), env),
  ]);

  assert.equal(responses[0].status, 429);
  assert.equal(responses[0].headers.get('x-papertok-budget-tier'), null, "OpenAlex's refusal is relayed as its own");
  assert.equal(responses[1].status, 429);
  assert.equal(responses[1].headers.get('x-papertok-budget-tier'), 'essential');
  assert.equal(calls, 1);
});

// Before the readings, a work opened by id reached no Durable Object at all.
// Filing its reading must not make the reader, or everyone waiting on the same
// miss, wait for a ledger that is slow or stuck.
test('a reading the ledger does not take does not hold the answer it came with', { timeout: 5_000 }, async t => {
  const now = Date.parse('2026-10-22T15:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const actions: string[] = [];
  const env = openAlexEnv({
    REQUEST_QUOTA_LEDGER: {
      idFromName: (name: string): unknown => name,
      get: (name: unknown): Pick<DurableObjectStub, 'fetch'> => ({
        fetch: async (_url, init) => {
          const { action } = JSON.parse(String(init!.body));
          actions.push(`${action} ${name}`);
          return action === 'observe' ? new Promise<Response>(() => {}) : Response.json({ accepted: true });
        },
      }),
    } as Env['REQUEST_QUOTA_LEDGER'],
  });
  const relay = (path: string) => reportApi.fetch(new Request(relayPath(path), { headers: BROWSER }), env);
  const responses = await withWorkerFetchMock(
    async () => Response.json({ id: 'https://openalex.org/W1', results: [] }, {
      headers: budgetHeaders(5_000, (Date.parse('2026-10-23T00:00:00Z') - now) / 1000),
    }),
    () => Promise.all([relay('works/W1'), relay('works/W1'), relay('works?filter=doi:10.1000/a&per-page=1')]),
  );
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  assert.deepEqual(
    actions.sort(),
    ['observe openalex:day:2026-10-22', 'observe openalex:day:2026-10-22', 'reserve openalex:day:2026-10-22'],
    'one reading per upstream answer, the shared miss counted once',
  );
});

test('/health/openalex/budget reports today\'s units by tier and kind with the ceiling and its source, asks OpenAlex nothing, is edge-cacheable and refuses an unknown Origin', async t => {
  const now = Date.parse('2026-10-22T15:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const cap = 1_000;
  const ledger = inMemoryQuotaLedger();
  const env = openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding, OPENALEX_GLOBAL_DAILY_LIMIT: String(cap) });
  const relay = (path: string) => reportApi.fetch(new Request(relayPath(path), { headers: BROWSER }), env);
  const budget = (headers: Record<string, string> = BROWSER) => reportApi.fetch(
    new Request('https://papertok-report-api.example/health/openalex/budget', { headers }),
    env,
  );
  const limitOf = (tier: keyof typeof OPENALEX_TIER_PERCENT) => Math.floor(cap * OPENALEX_TIER_PERCENT[tier] / 100);

  // A harvested feed page, a search and a card batch, then the day pushed past
  // the exploration share by spend the ledger cannot name, and one
  // exploration miss refused.
  const elsewhere = limitOf('exploration') - 12;
  const upstream = await withCountedUpstream(async () => Response.json({ results: [] }), () => withIdentityAndCacheStore(async () => {
    assert.equal((await handleHarvestOpenAlex(new Request(relayPath('works?filter=primary_topic.id:T10604,type:article&per-page=25')), env)).status, 200);
    assert.equal((await relay('works?search=ultracold')).status, 200);
    assert.equal((await relay('works?filter=doi:10.1000/a|10.1000/b&per-page=50')).status, 200);
    await reserveRequestQuota(ledger.binding, {
      periodKey: 'openalex:day:2026-10-22', subject: 'elsewhere', subjectLimit: cap, globalLimit: cap, amount: elsewhere,
    });
    assert.equal((await relay('authors?filter=last_known_institutions.id:I1')).status, 429);
  }));
  assert.equal(upstream.length, 3);
  const used = 12 + elsewhere;

  const report = await withCountedUpstream(async () => { throw new Error('the report asks OpenAlex nothing'); }, async () => {
    await withIdentityAndCacheStore(async () => {
      const response = await budget();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=30, s-maxage=60');
      assert.equal(response.headers.get('access-control-allow-origin'), BROWSER.origin);
      const body = await response.json<Record<string, unknown>>();
      const tier = (name: keyof typeof OPENALEX_TIER_PERCENT, spent: number, refused: number) => ({
        percent: OPENALEX_TIER_PERCENT[name],
        limit: limitOf(name),
        // The nightly run's share of the harvest's day, beside the feed tier it spends.
        ...(name === 'feed' ? { share: OPENALEX_HARVEST_DAILY_UNITS - OPENALEX_NEW_FOLLOWS_DAILY_UNITS } : {}),
        used: spent,
        refused,
        open: used + 1 <= limitOf(name),
      });
      assert.deepEqual(body, {
        provider: 'openalex',
        day: '2026-10-22',
        resetsAt: '2026-10-23T00:00:00.000Z',
        unitUsd: OPENALEX_UNIT_USD,
        cap,
        observedCeiling: null,
        observedAt: null,
        ceiling: cap,
        used,
        remaining: cap - used,
        tiers: {
          essential: tier('essential', 0, 0),
          feed: tier('feed', 1, 0),
          enrichment: tier('enrichment', 1, 0),
          exploration: tier('exploration', 10, 1),
        },
        kinds: {
          search: { used: 10, refused: 0 },
          list: { used: 2, refused: 1 },
          graph: { used: 0, refused: 0 },
          share: { used: 0, refused: 0 },
        },
      });
      assert.equal((body.tiers as Record<string, { open: boolean }>).exploration.open, false);
      assert.doesNotMatch(JSON.stringify(body), /[a-f0-9]{64}/, 'no subject hashes');

      const calls = ledger.calls.length;
      assert.equal((await budget()).status, 200);
      assert.equal(ledger.calls.length, calls, 'the second read is served from the edge');
    });
  });
  assert.deepEqual(report, []);

  await withIdentityAndCacheStore(async () => {
    assert.equal((await budget({ origin: 'https://evil.example' })).status, 403);
  });

  // A reading from OpenAlex lowers the ceiling below the cap, and says when.
  const left = 300;
  await withWorkerFetchMock(async () => Response.json({ id: 'https://openalex.org/W1' }, {
    headers: {
      'x-ratelimit-remaining-usd': (left * OPENALEX_UNIT_USD).toFixed(4),
      'x-ratelimit-reset': String((Date.parse('2026-10-23T00:00:00Z') - now) / 1000),
    },
  }), () => relay('works/W1'));
  await withIdentityAndCacheStore(async () => {
    const body = await (await budget()).json<{ observedCeiling: number; observedAt: string; ceiling: number; remaining: number }>();
    assert.equal(body.observedCeiling, used + left - OPENALEX_OBSERVATION_MARGIN);
    assert.equal(body.observedAt, '2026-10-22T15:00:00.000Z');
    assert.equal(body.ceiling, Math.min(cap, used + left - OPENALEX_OBSERVATION_MARGIN));
    assert.equal(body.remaining, body.ceiling - used);
  });
});

// A failing ledger is kept at the edge briefly, so a dashboard or a script
// polling the route during an outage is not one more request each time to the
// object that is already failing.
test('/health/openalex/budget is unavailable without a ledger to read, and asks a failing ledger once however often it is polled', async () => {
  const budgetUrl = 'https://papertok-report-api.example/health/openalex/budget';
  await withIdentityAndCacheStore(async () => {
    const response = await reportApi.fetch(new Request(budgetUrl, { headers: BROWSER }), { OPENALEX_API_KEY: 'worker-key' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'PROVIDER_QUOTA_NOT_CONFIGURED' });
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=10');
  });

  let peeks = 0;
  const failing = {
    idFromName: (name: string): unknown => name,
    get: (): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async () => {
        peeks += 1;
        return new Response('overloaded', { status: 500 });
      },
    }),
  } as unknown as Env['REQUEST_QUOTA_LEDGER'];
  await withIdentityAndCacheStore(async () => {
    for (let poll = 0; poll < 5; poll += 1) {
      const response = await reportApi.fetch(
        new Request(`${budgetUrl}?poll=${poll}`, { headers: BROWSER }),
        { OPENALEX_API_KEY: 'worker-key', REQUEST_QUOTA_LEDGER: failing },
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: 'QUOTA_LEDGER_UNAVAILABLE' });
      assert.equal(response.headers.get('access-control-allow-origin'), BROWSER.origin);
    }
  });
  assert.equal(peeks, 1);
});

// The units are spent once OpenAlex has answered; the shared store is what
// keeps them from being spent again elsewhere. An edge cache that refuses a
// write (it is not guaranteed outside a request to a zone, as in the paper
// harvest's Workflow) must not lose that store write or the answer.
test('the KV entry is written even when the edge put throws', async () => {
  const store = fakeOpenAlexStore();
  const env = openAlexEnv({ NOTIFICATION_STORE: store });
  const globals = globalThis as TestGlobals;
  const realFetch = globalThis.fetch;
  const realCaches = globals.caches;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [{ id: 'W1' }] });
  };
  globals.caches = {
    default: {
      match: async () => null,
      put: async () => { throw new Error('no cache here'); },
    },
  };
  try {
    const first = await reportApi.fetch(new Request(OPENALEX_LIST_URL, { headers: BROWSER }), env);
    assert.equal(first.status, 200);
    assert.equal(store.entries.size, 1, 'the answer reached the shared store');
    const second = await reportApi.fetch(new Request(OPENALEX_LIST_URL, { headers: BROWSER }), env);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { results: [{ id: 'W1' }] });
    assert.equal(calls, 1, 'the second answer came from the store');
  } finally {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete globals.caches;
    else globals.caches = realCaches;
  }
});
