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
