import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi, { fetchWithDeadline } from './report-api.js';
import { PACE_RETRY_AFTER_SECONDS } from './upstream-pace.js';
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
  const upstream = [];
  const fetchMock = async url => {
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
  assert.deepEqual((await recent.json()).notes.map(note => note.id), ['published-late', 'newest', 'older']);

  const relevance = await withWorkerFetchMock(fetchMock, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/openreview?q=neuroscience&limit=5',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {}));

  assert.equal(relevance.status, 200);
  assert.deepEqual((await relevance.json()).notes.map(note => note.id), ['older', 'newest', 'published-late'], 'relevance keeps the upstream order');
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

// `/health` is where an operator learns a key is missing, and for Semantic Scholar
// that is not a footnote: without the key both `/sources/s2` and `/related` are
// refused by the anonymous pool, so a flag that reported "configured" regardless
// of the environment would hide a dead source behind a green check.
test('/health reports whether the Semantic Scholar key is configured', async () => {
  const read = async env => (await (await reportApi.fetch(
    new Request('https://papertok-report-api.example/health'),
    env,
  )).json()).semanticScholarKeyConfigured;

  assert.equal(await read({ SEMANTIC_SCHOLAR_API_KEY: 's2-test-key' }), true);
  assert.equal(await read({ SEMANTIC_SCHOLAR_API_KEY: '' }), false);
  assert.equal(await read({}), false);
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
    idFromName: () => 'quota-id',
    get: () => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) }),
  },
};

function countingQuotaLedger(state, accepted = true) {
  return {
    idFromName: name => {
      state.periodKeys.push(String(name));
      return `quota-${name}`;
    },
    get: () => ({
      fetch: async () => {
        state.reservations += 1;
        return new Response(JSON.stringify(accepted ? { accepted: true } : { accepted: false, scope: 'global' }));
      },
    }),
  };
}

test('runs the whole PubMed chain in the Worker and returns the three payloads', async () => {
  const upstream = [];
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
  const payload = await response.json();
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
  const withoutKey = [];
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

  const withKey = [];
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
  const payload = await response.json();
  assert.equal(payload.result['31000001'].title, 'One');
  assert.equal(payload.efetch, '');
  assert.equal(payload._papertok.efetch, 'unavailable');
  // ...but a degraded answer does not get the healthy answer's ten minutes. A
  // one-second hiccup at NCBI must not leave a whole category without abstracts
  // for everybody until the TTL runs out.
  assert.match(response.headers.get('cache-control'), /s-maxage=120\b/);
  assert.doesNotMatch(response.headers.get('cache-control'), /stale-while-revalidate/);
});

// NCBI counts per second. A burst of route misses spends esearch calls all at
// once and then twice as many esummary+efetch calls all at once -- eight misses
// are past the 10 req/s the key buys, and 3 of the 8 came back 429 (measured
// 2026-09-01, reproduced 2026-09-02). The window is a second, so one retry after
// a short wait lands in the next one. `retry-after: 0` here so the test does not
// sleep; in production NCBI sends none and the route waits 300-800 ms.
test('retries a PubMed call NCBI refused for a second instead of losing the batch', async () => {
  const calls = [];
  const response = await withWorkerFetchMock(async url => {
    const endpoint = new URL(String(url)).pathname.split('/').pop();
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
  const payload = await response.json();
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
  assert.equal((await response.json()).code, 'UPSTREAM_RATE_LIMITED');
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
  const upstream = [];
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
  assert.equal(summary.searchParams.get('id'), '31000001');
});

test('refuses a PubMed request with no query without spending the shared ceiling', async () => {
  const state = { reservations: 0, periodKeys: [] };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => undefined } };
  try {
    const response = await reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state) });

    assert.equal(response.status, 400);
    assert.equal(state.reservations, 0);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('serves a cached PubMed answer without an upstream call or a reservation', async () => {
  const state = { reservations: 0, periodKeys: [] };
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('No upstream request should be made');
  };
  globalThis.caches = {
    default: {
      match: async request => (request.url.includes('/cache/sources/pubmed')
        ? new Response(JSON.stringify({ esearchresult: { idlist: ['1'] } }), { headers: { 'content-type': 'application/json' } })
        : null),
      put: async () => undefined,
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
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('refuses PubMed with retry-after once the shared per-minute ceiling is full', async () => {
  const state = { reservations: 0, periodKeys: [] };
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error('No upstream request should be made');
  };
  globalThis.caches = { default: { match: async () => null, put: async () => undefined } };
  try {
    const response = await reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state, false) });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal((await response.json()).code, 'PROVIDER_RATE_LIMITED');
    assert.equal(upstreamCalls, 0);
    assert.match(state.periodKeys[0], /^pubmed:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test('proxies Semantic Scholar search with the Worker key and a bounded offset', async () => {
  let upstreamUrl = '';
  let upstreamHeaders = {};
  const response = await withWorkerFetchMock(async (url, options) => {
    upstreamUrl = String(url);
    upstreamHeaders = options?.headers || {};
    return new Response(JSON.stringify({ total: 3, data: [{ paperId: 'abc', title: 'One' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/s2?q=malaria&page=90&limit=25',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), { ...OPEN_ROUTE_ENV, SEMANTIC_SCHOLAR_API_KEY: 's2-test-key' }));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].paperId, 'abc');
  assert.match(upstreamUrl, /graph\/v1\/paper\/search/);
  assert.equal(upstreamHeaders['x-api-key'], 's2-test-key');
  // Semantic Scholar answers offset + limit past a thousand with a 400. Paging
  // off the end has to run out of records, not turn into a dead source.
  const offset = Number(new URL(upstreamUrl).searchParams.get('offset'));
  assert.ok(offset + 25 <= 1000, `offset ${offset} would be refused by Semantic Scholar`);
});

test('leaves the Semantic Scholar key off entirely when none is configured', async () => {
  let upstreamCalls = 0;
  let upstreamHeaders = {};
  await withWorkerFetchMock(async (_url, options) => {
    upstreamCalls += 1;
    upstreamHeaders = options?.headers || {};
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  }, () => reportApi.fetch(new Request(
    'https://papertok-report-api.example/sources/s2?q=malaria',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), OPEN_ROUTE_ENV));

  assert.equal(upstreamCalls, 1, 'the request never reached Semantic Scholar, so the header assertion proves nothing');
  assert.equal(upstreamHeaders['x-api-key'], undefined);
});

test('charges /related and /sources/s2 to the same Semantic Scholar ceiling', async () => {
  const state = { reservations: 0, periodKeys: [] };
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
  const stored = new Map();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ recommendedPapers: [] }), { headers: { 'content-type': 'application/json' } });
  };
  globalThis.caches = {
    default: {
      match: async request => (String(request.url).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : stored.get(request.url)?.clone() || null),
      put: async (request, response) => stored.set(request.url, response.clone()),
    },
  };
  try {
    const ask = limit => reportApi.fetch(new Request(
      `https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=${limit}`,
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV);

    await ask(20);
    await ask(8);
    await ask(20);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
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
  const body = await response.json();
  assert.equal(body.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(body.upstreamStatus, 429);
  // Semantic Scholar names no wait and its window is one second: a minute here
  // is fifty-nine seconds of a reader waiting for a slot that opened long ago.
  assert.equal(response.headers.get('retry-after'), '2');
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
  const body = await response.json();
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
function paceRefusingLedger(state) {
  let lastName = '';
  return {
    idFromName: name => {
      lastName = String(name);
      state.periodKeys.push(lastName);
      return `quota-${lastName}`;
    },
    get: () => ({
      fetch: async () => new Response(JSON.stringify(
        lastName.endsWith(':pace') ? { accepted: false, scope: 'user' } : { accepted: true },
      )),
    }),
  };
}

test('refuses a Semantic Scholar search itself when no second is free, without spending the provider', async () => {
  const state = { periodKeys: [] };
  let upstreamCalls = 0;
  const response = await withWorkerFetchMock(
    async () => { upstreamCalls += 1; return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }); },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: paceRefusingLedger(state) }),
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'PROVIDER_RATE_LIMITED');
  // Not a literal: the same constant the beat derives from its own wait budget,
  // so raising the budget cannot leave this header quietly lying.
  assert.equal(response.headers.get('retry-after'), PACE_RETRY_AFTER_SECONDS);
  assert.equal(upstreamCalls, 0, 'a request the beat refused must not reach Semantic Scholar');
  assert.ok(state.periodKeys.includes('s2:pace'), `the beat was never consulted: ${JSON.stringify(state.periodKeys)}`);
});

test('does not put PubMed on the Semantic Scholar beat', async () => {
  const state = { periodKeys: [], reservations: 0 };
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
  const stored = new Map();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.caches = {
    default: {
      match: async request => stored.get(request.url)?.clone() || null,
      put: async (request, response) => stored.set(request.url, response.clone()),
    },
  };
  try {
    const ask = query => reportApi.fetch(new Request(
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
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
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
  assert.equal((await response.json()).code, 'UPSTREAM_RATE_LIMITED');
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
  const body = await response.json();
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
  const body = await response.json();
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

const REWRITE_ENV = {
  ...AUTHENTICATED_ENV,
  GEMINI_API_KEY: 'gemini-test-key',
};

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
function geminiFrame(text, extra = {}) {
  return `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, ...extra }],
  })}\r\n\r\n`;
}

function rewriteUpstream(url, frames) {
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
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
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
  assert.match(response.headers.get('access-control-allow-methods'), /(?:^|,\s*)POST(?:,|$)/);
  assert.match(response.headers.get('access-control-allow-headers'), /authorization/);
});

test('/ai/rewrite refuses an origin that is not on the list', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw new Error('No upstream request should be made');
  }, () => reportApi.fetch(rewriteRequest('POST', 'https://evil.example'), REWRITE_ENV));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('relays a rewrite refusal with its own status, code and quota', async () => {
  const response = await withWorkerFetchMock(async () => {
    throw new Error('No upstream request should be made');
  }, () => withCachedIdentity(() => reportApi.fetch(rewriteRequest(), {
    ...REWRITE_ENV,
    REQUEST_QUOTA_LEDGER: {
      idFromName: () => 'quota-id',
      get: () => ({ fetch: async () => new Response(JSON.stringify({ accepted: false, scope: 'user' })) }),
    },
  })));

  // The quota block is what tells the reader when the uses come back; flattening
  // this to a bare 502 would lose both the reason and the reset time.
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.equal(payload.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(payload.quota.scope, 'user');
  assert.ok(payload.quota.resetAt);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

test('the thread-anchor route is origin-gated and public', async () => {
  const blocked = await reportApi.fetch(new Request(
    'https://papertok-report-api.example/thread-anchor?ids=doi:10.1234/abc',
    { headers: { origin: 'https://evil.example' } },
  ), {});
  assert.equal(blocked.status, 403);

  // No Origin at all is not one of our browsers: a cross-origin fetch always
  // carries it, and the API host has no same-origin page. Refusing it keeps a
  // script from draining Firestore through the service account.
  const anonymous = await reportApi.fetch(new Request(
    'https://papertok-report-api.example/thread-anchor?ids=doi:10.1234/abc',
  ), {});
  assert.equal(anonymous.status, 403);
  assert.equal((await anonymous.json()).code, 'ORIGIN_NOT_ALLOWED');

  const anonymousInvalidate = await reportApi.fetch(new Request(
    'https://papertok-report-api.example/thread-anchor/invalidate',
    { method: 'POST', body: '{"keys":["k"]}' },
  ), {});
  assert.equal(anonymousInvalidate.status, 403);

  const allowed = await reportApi.fetch(new Request(
    'https://papertok-report-api.example/thread-anchor?ids=doi:10.1234/abc',
    { headers: { origin: 'https://mugar123.github.io' } },
  ), {});
  // No service account and no KV: the route exists and fails closed as
  // unavailable, which is what the browser treats as "use Firestore".
  assert.equal(allowed.status, 503);
  assert.equal((await allowed.json()).code, 'THREAD_ANCHOR_UNAVAILABLE');
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://mugar123.github.io');
});

test('closes the API host to crawlers with its own robots.txt', async () => {
  // Un rastreador no manda `origin`, asi que la ruta tiene que contestar sin el.
  const response = await reportApi.fetch(
    new Request('https://api.papertok.app/robots.txt'),
    {},
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  const body = await response.text();
  assert.match(body, /^User-agent: \*$/m);
  assert.match(body, /^Disallow: \/$/m);
  assert.doesNotMatch(body, /^Allow: \//m);
});
