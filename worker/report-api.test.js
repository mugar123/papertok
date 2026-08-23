import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi, { fetchWithDeadline } from './report-api.js';
import { dribblingFetch, settleWithin, withStubbedFetch } from '../src/test-support/deadlineHarness.js';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.js';

async function withWorkerFetchMock(fetchImplementation, callback) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = fetchImplementation;
  globalThis.caches = {
    default: {
      match: async () => null,
      put: async () => undefined,
    },
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
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
  assert.match(response.headers.get('access-control-allow-methods'), /(?:^|,\s*)PUT(?:,|$)/);
});

test('returns only the Cloudflare country code for automatic language selection', async () => {
  const request = new Request('https://papertok-report-api.example/locale', {
    headers: { origin: 'https://mugar123.github.io' },
  });
  Object.defineProperty(request, 'cf', { value: { country: 'MX' } });

  const response = await reportApi.fetch(request, {});

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
  assert.deepEqual(await response.json(), { country: 'MX' });
});

test('returns an unhealthy status when the email provider works but the scheduler is stale', async () => {
  const env = {
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'xkeysib-test',
    BREVO_FROM_EMAIL: 'papertok@example.com',
    NOTIFICATION_STORE: {
      get: async () => ({
        scheduledAt: '2026-01-01T07:00:00.000Z',
        completedAt: '2026-01-01T07:01:00.000Z',
        scanned: 1,
      }),
    },
  };
  const response = await withWorkerFetchMock(async () => new Response(JSON.stringify({
    senders: [{ active: true, email: 'papertok@example.com' }],
  }), { headers: { 'content-type': 'application/json' } }), () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/health/email',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), env));

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.available, true);
  assert.equal(payload.schedule.fresh, false);
  assert.equal(payload.schedule.code, 'EMAIL_SCHEDULE_STALE');
});

test('serves the email health probe from the edge cache', async () => {
  // Brevo shares one rate limit between this probe and real digest delivery, so
  // an anonymous route that hits `/v3/senders` per request can starve the cron.
  let providerCalls = 0;
  const env = {
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'xkeysib-test',
    BREVO_FROM_EMAIL: 'papertok@example.com',
    EMAIL_DELIVERY_LEDGER: { idFromName: () => 'day', get: () => ({ fetch: async () => new Response('{}') }) },
    NOTIFICATION_STORE: {
      get: async () => ({
        scheduledAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        scanned: 1,
      }),
    },
  };
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const stored = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = stored.get(String(key.url));
        return hit ? hit.clone() : null;
      },
      async put(key, response) {
        stored.set(String(key.url), response.clone());
      },
    },
  };
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ senders: [{ active: true, email: 'papertok@example.com' }] }), {
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
    assert.match(first.headers.get('cache-control'), /s-maxage=300/);
    assert.equal(second.status, 200);
    assert.equal(providerCalls, 1);
    assert.equal((await second.json()).available, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('reports a missing email delivery ledger binding as unhealthy', async () => {
  const env = {
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'xkeysib-test',
    BREVO_FROM_EMAIL: 'papertok@example.com',
    NOTIFICATION_STORE: {
      get: async () => ({
        scheduledAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        scanned: 1,
      }),
    },
  };
  const response = await withWorkerFetchMock(async () => new Response(JSON.stringify({
    senders: [{ active: true, email: 'papertok@example.com' }],
  }), { headers: { 'content-type': 'application/json' } }), () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/health/email',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), env));

  assert.equal(response.status, 503);
  const payload = await response.json();
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
  const payload = await response.json();
  assert.equal(payload.notes.length, 1);
  assert.equal(payload.notes[0].id, 'submission');
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
  const payload = await response.json();
  assert.equal(payload.papers[0].paper.id, '2607.12345');
});

test('gives every source upstream a deadline it can be cut with', async () => {
  let seenSignal;
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
      idFromName: () => 'quota-id',
      get: () => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) }),
    },
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
  assert.match(response.headers.get('access-control-expose-headers'), /retry-after/);
  assert.match(response.headers.get('access-control-expose-headers'), /x-ratelimit-remaining-usd/);
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
  const health = await response.json();
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
  const health = await response.json();
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
  const health = await response.json();
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
  const health = await response.json();
  assert.equal(health.available, false);
  assert.equal(health.status, 401);
  assert.equal(health.code, 'AUTHENTICATION_ERROR');
  assert.equal(health.message, 'Invalid API Key');
  assert.equal(health.insttoken, false);
});

test('falls back to the STANDARD view and reports that the abstract is missing', async () => {
  const requestedViews = [];
  const response = await withWorkerFetchMock(
    async url => {
      const view = new URL(url).searchParams.get('view');
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
  const health = await response.json();
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
  const health = await response.json();
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
  const health = await response.json();
  assert.equal(health.available, true);
  assert.equal(health.view, 'COMPLETE');
  assert.equal(health.hasAbstract, true);
});

test('falls past a view the account is not entitled to, which Scopus refuses with 401', async () => {
  const requestedViews = [];
  const response = await withWorkerFetchMock(
    async url => {
      const view = new URL(url).searchParams.get('view');
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
  const health = await response.json();
  assert.equal(health.available, true);
  assert.equal(health.view, 'STANDARD');
  assert.equal(health.hasAbstract, false);
});

test('spends a single upstream call when the answering view is pinned', async () => {
  const requestedViews = [];
  await withWorkerFetchMock(
    async url => {
      requestedViews.push(new URL(url).searchParams.get('view'));
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
      sentHeaders = new Headers(options.headers);
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
  assert.equal(sentHeaders.get('authorization'), `Bearer ${SCOPUS_EGRESS.SCOPUS_PROXY_SECRET}`);
  // The Elsevier key lives on the egress; this Worker must not carry one.
  assert.equal(sentHeaders.get('X-ELS-APIKey'), null);
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
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async request => request.url.includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : null,
      put: async () => undefined,
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
        idFromName: () => 'quota-id',
        get: () => ({
          fetch: async () => {
            quotaReservations += 1;
            return new Response(JSON.stringify({ accepted: true }));
          },
        }),
      },
    });

    assert.equal(response.status, 400);
    assert.equal(quotaReservations, 0);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('does not spend protected-provider quota for an authenticated cache hit', async () => {
  let quotaReservations = 0;
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('No upstream request should be made');
  };
  globalThis.caches = {
    default: {
      match: async request => {
        if (request.url.includes('/auth/')) {
          return new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } });
        }
        if (request.url.includes('/cache/sources/core')) {
          return new Response(JSON.stringify({ results: [{ id: 'cached-paper' }] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return null;
      },
      put: async () => undefined,
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
        idFromName: () => 'quota-id',
        get: () => ({
          fetch: async () => {
            quotaReservations += 1;
            return new Response(JSON.stringify({ accepted: true }));
          },
        }),
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [{ id: 'cached-paper' }] });
    assert.equal(quotaReservations, 0);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('canonical source cache keys ignore unknown query parameters', async () => {
  const responses = new Map();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ notes: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.caches = {
    default: {
      match: async request => responses.get(request.url)?.clone() || null,
      put: async (request, response) => responses.set(request.url, response.clone()),
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
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('duplicate cache parameters cannot create cache variants for one upstream request', async () => {
  const responses = new Map();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ notes: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.caches = {
    default: {
      match: async request => responses.get(request.url)?.clone() || null,
      put: async (request, response) => responses.set(request.url, response.clone()),
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
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('adds baseline browser hardening headers to JSON responses', async () => {
  const response = await reportApi.fetch(new Request('https://papertok-report-api.example/health'), {});
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
});

// --- G2: plazos de red -------------------------------------------------------

// An upstream that answers its headers and then never finishes the body. The
// stream fails only when the caller's own deadline cuts it, which is the whole
// point: a deadline that stops at the headers leaves this hanging forever.
function stalledBodyResponse(signal, contentType = 'application/json') {
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
async function withShortDeadlines(ms, callback) {
  const original = AbortSignal.timeout;
  AbortSignal.timeout = () => original.call(AbortSignal, ms);
  try {
    return await callback();
  } finally {
    AbortSignal.timeout = original;
  }
}

const HUNG = Symbol('hung');

async function answeredWithin(ms, promise) {
  const result = await Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(HUNG), ms)),
  ]);
  assert.notEqual(result, HUNG, `the request was still hanging after ${ms}ms`);
  return result;
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

// Every specialist route, not just the one that happened to be covered when this
// suite was written. `/sources/scopus` and `/sources/physics` do not go through
// `fetchJsonUpstream`, and that is precisely how they kept their unbounded waits
// through a fix that was supposed to have closed them.
const SOURCE_ROUTES = [
  ['/sources/biorxiv?category=neuroscience', {}],
  ['/sources/europepmc?q=malaria', {}],
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
    idFromName: () => 'quota-id',
    get: () => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) }),
  },
};

// A signed-in caller without an Identity Toolkit round trip: the Worker caches a
// verified identity, so seeding that cache is how a protected route is reached.
async function withCachedIdentity(callback) {
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async request => (String(request.url).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : null),
      put: async () => undefined,
    },
  };
  try {
    return await callback();
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

for (const [route, extraEnv] of SOURCE_ROUTES) {
  test(`gives ${route.split('?')[0]} an upstream deadline it can be cut with`, async () => {
    let seenSignal;
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
    assert.equal((await response.json())._papertok.fallbackReason, 'ads_timeout');
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
// did not, and on the routes OpenAlex bills that was money -- `categories=zzz1`,
// `zzz2`, ... each cost two calls against a $1/day budget for one identical query.

// A cache that actually remembers, plus a signed-in caller. `withCachedIdentity`
// answers the auth lookup but stores nothing, and what these tests measure is
// whether the second request finds what the first one put away.
async function withIdentityAndCacheStore(callback) {
  const originalCaches = globalThis.caches;
  const stored = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        if (String(request.url).includes('/auth/')) {
          return new Response(JSON.stringify({ uid: 'user-1' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return stored.get(String(request.url))?.clone() || null;
      },
      async put(request, response) {
        stored.set(String(request.url), response.clone());
      },
    },
  };
  try {
    return await callback(stored);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

async function withCountedUpstream(handler, callback) {
  const calls = [];
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
const TRENDS_BASE = 'https://papertok-report-api.example/report/trends'
  + '?from=2026-01-01&to=2026-02-01&previous_from=2025-12-01&previous_to=2026-01-01';

const trendsPage = async () => new Response(
  JSON.stringify({ meta: { count: 1 }, group_by: [] }),
  { headers: { 'content-type': 'application/json' } },
);

test('two discarded trend filters are one billed query, not two', async () => {
  const calls = await withCountedUpstream(trendsPage, async () => {
    await withIdentityAndCacheStore(async () => {
      for (const categories of ['zzz1', 'zzz2']) {
        const response = await reportApi.fetch(new Request(
          `${TRENDS_BASE}&categories=${categories}`,
          { headers: SIGNED_IN },
        ), AUTHENTICATED_ENV);
        assert.equal(response.status, 200);
      }
    });
  });

  // Two calls -- one pair of periods -- not four. `normalizeReportFilters` throws
  // away anything outside `REPORT_OPENALEX_FIELDS`, so both requests ask OpenAlex
  // the identical question; keying on what arrived made each one a fresh miss,
  // and an authenticated caller sustains sixty of those a minute.
  assert.equal(calls.length, 2);
});

test('reordering and recasing a trend filter does not buy a second cache entry', async () => {
  const calls = await withCountedUpstream(trendsPage, async () => {
    await withIdentityAndCacheStore(async () => {
      for (const query of ['categories=cs,math&countries=US', 'categories=math,cs&countries=us']) {
        const response = await reportApi.fetch(new Request(
          `${TRENDS_BASE}&${query}`,
          { headers: SIGNED_IN },
        ), AUTHENTICATED_ENV);
        assert.equal(response.status, 200);
      }
    });
  });

  // `normalizeReportFilters` sorts and uppercases, so the upstream filter is
  // byte-identical in both cases.
  assert.equal(calls.length, 2);
});

test('the same DOI in a different shape is the same citation graph', async () => {
  const citationGraphUpstream = async url => new Response(
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

function maxAgeSeconds(response) {
  return Number(response.headers.get('cache-control').match(/s-maxage=(\d+)/)[1]);
}

async function physicsAnswer(env, adsHandler) {
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
  assert.equal((await response.json())._papertok.fallbackReason, 'ads_500');
  // A one-second hiccup used to blank that query for everybody until the
  // afternoon, because `cacheResponse` gave the fallback the full 21600.
  assert.equal(maxAgeSeconds(response), 120);
  // And it does not get to be served stale for a day on top of that, nor to sit
  // in the browser longer than it sits at the edge.
  assert.doesNotMatch(response.headers.get('cache-control'), /stale-while-revalidate/);
  assert.equal(Number(response.headers.get('cache-control').match(/max-age=(\d+)/)[1]), 120);
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

  const payload = await response.json();
  assert.equal(payload._papertok.fallbackReason, 'ads_not_configured');
  // INSPIRE is then the real answer, not a consolation prize, and it earns the
  // same six hours the primary provider would have.
  assert.equal(maxAgeSeconds(response), 21600);
});

async function citationGraphAnswer(upstream) {
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

test('an OpenCitations failure does not own the citation graph for a week', async () => {
  const response = await citationGraphAnswer(url => (url.includes('opencitations')
    ? new Response('gateway timeout', { status: 504 })
    : new Response(JSON.stringify({ id: 'https://openalex.org/W1', results: [] }), {
      headers: { 'content-type': 'application/json' },
    })));

  const payload = await response.json();
  assert.equal(payload.degraded, true);
  assert.equal(maxAgeSeconds(response), 120);
});

test('a heavily cited paper is partial by design and keeps its week', async () => {
  // The correction this test exists to hold: `partial` is also what a healthy
  // answer looks like. Past three hundred citations the route asks OpenAlex for
  // citing works on purpose, and shortening the TTL of the most-cited papers in
  // the corpus because nothing failed would be a fix worse than the fault.
  const response = await citationGraphAnswer(url => {
    if (url.includes('opencitations')) {
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'https://openalex.org/W1',
      cited_by_count: 5_000,
      results: [],
    }), { headers: { 'content-type': 'application/json' } });
  });

  const payload = await response.json();
  assert.equal(payload.partial, true);
  assert.equal(payload.degraded, false);
  assert.equal(maxAgeSeconds(response), 604800);
});

// --- G5: billed spend reaches the ledger, with a daily ceiling --------------

function recordingLedger(answer = () => ({ accepted: true })) {
  const reservations = [];
  return {
    reservations,
    binding: {
      idFromName: periodKey => periodKey,
      get: periodKey => ({
        fetch: async (_url, options) => {
          const body = JSON.parse(options.body);
          reservations.push({ periodKey, amount: body.amount, limit: body.globalLimit });
          return new Response(JSON.stringify(answer(periodKey)));
        },
      }),
    },
  };
}

test('a cold trend report reserves both OpenAlex periods for what it actually spends', async () => {
  const ledger = recordingLedger();
  await withCountedUpstream(trendsPage, async () => {
    await withIdentityAndCacheStore(async () => {
      const response = await reportApi.fetch(new Request(
        `${TRENDS_BASE}&categories=cs`,
        { headers: SIGNED_IN },
      ), { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: ledger.binding });
      assert.equal(response.status, 200);
    });
  });

  // This route spent two billed OpenAlex calls per miss and reserved none of
  // them: the `openalex:*` ceiling only ever covered `/openalex/*`.
  const openAlex = ledger.reservations.filter(entry => entry.periodKey.startsWith('openalex:'));
  assert.deepEqual(openAlex.map(entry => entry.amount), [2, 2]);
  assert.match(openAlex[0].periodKey, /^openalex:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.match(openAlex[1].periodKey, /^openalex:day:\d{4}-\d{2}-\d{2}$/);
  assert.equal(openAlex[1].limit, 8_000);
});

test('the daily OpenAlex ceiling refuses a request the per-minute one would allow', async () => {
  const ledger = recordingLedger(periodKey => ({ accepted: !periodKey.startsWith('openalex:day:') }));
  const response = await withIdentityAndCacheStore(() => reportApi.fetch(new Request(
    'https://papertok-report-api.example/openalex/works?filter=doi:10.1/x',
    { headers: BROWSER },
  ), openAlexEnv({ REQUEST_QUOTA_LEDGER: ledger.binding })));

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { code: 'PROVIDER_RATE_LIMITED' });
  // Bounded on purpose. The true wait is the seconds left until UTC midnight, and
  // handing the client six hours is a tab that stops asking until it is reloaded.
  assert.equal(response.headers.get('retry-after'), '300');
});

test('a cached trend report spends nothing against either ceiling', async () => {
  const ledger = recordingLedger();
  const calls = await withCountedUpstream(trendsPage, async () => {
    await withIdentityAndCacheStore(async () => {
      const env = { ...AUTHENTICATED_ENV, REQUEST_QUOTA_LEDGER: ledger.binding };
      const request = () => reportApi.fetch(new Request(
        `${TRENDS_BASE}&categories=cs`,
        { headers: SIGNED_IN },
      ), env);
      await request();
      ledger.reservations.length = 0;
      assert.equal((await request()).status, 200);
    });
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(ledger.reservations, []);
});

test('an OpenAlex outage on the current work degrades the graph, a 404 does not', async () => {
  // The worst case the `degraded` flag exists for, and the one the audit's own
  // `partial === true` rule would have missed entirely: `fetchOpenAlexCurrentWork`
  // swallows every error and answers `null`, so with OpenCitations empty too the
  // route used to return `{references: [], citations: [], partial: false}` -- and
  // cache that for seven days.
  const graphWith = status => citationGraphAnswer(url => (url.includes('/works/doi:')
    ? new Response('nope', { status })
    : new Response(JSON.stringify(url.includes('opencitations') ? [] : { results: [] }), {
      headers: { 'content-type': 'application/json' },
    })));

  const outage = await graphWith(503);
  assert.equal((await outage.json()).degraded, true);
  assert.equal(maxAgeSeconds(outage), 120);

  // A DOI OpenAlex has never heard of is an answer, not an outage: the graph
  // built without it is the real one and keeps its week.
  const unknown = await graphWith(404);
  assert.equal((await unknown.json()).degraded, false);
  assert.equal(maxAgeSeconds(unknown), 604800);
});

test('a rejected OpenAlex batch is a short answer, not a complete one', async () => {
  // `Promise.allSettled` over the batches means a rejected chunk returns fewer
  // papers and looks exactly like a full result. Seven days of looking like one.
  const response = await citationGraphAnswer(url => {
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

  const payload = await response.json();
  assert.equal(payload.degraded, true);
  assert.deepEqual(payload.references, []);
  assert.equal(maxAgeSeconds(response), 120);
});
