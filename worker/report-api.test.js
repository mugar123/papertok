import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './report-api.js';

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
