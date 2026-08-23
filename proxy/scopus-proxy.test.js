import assert from 'node:assert/strict';
import test from 'node:test';

import scopusProxy, { createScopusProxy } from './scopus-proxy.js';

const SECRET = 'a'.repeat(48);
const ENV = { PROXY_SHARED_SECRET: SECRET, ELSEVIER_API_KEY: 'test-key' };

function request(path, { secret = SECRET, method = 'GET' } = {}) {
  return new Request(`https://scopus-proxy.example${path}`, {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

async function withUpstream(implementation, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('refuses a caller that does not present the shared secret', async () => {
  const response = await withUpstream(async () => {
    throw new Error('No upstream request should be made');
  }, () => createScopusProxy(ENV)(request('/scopus?query=test', { secret: '' })));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: 'PROXY_AUTH_REQUIRED' });
});

test('refuses a secret of the right length but the wrong value', async () => {
  const response = await withUpstream(async () => {
    throw new Error('No upstream request should be made');
  }, () => createScopusProxy(ENV)(request('/scopus?query=test', { secret: 'b'.repeat(48) })));

  assert.equal(response.status, 401);
});

test('refuses to serve at all when the shared secret is too short to protect the key', async () => {
  const response = await withUpstream(async () => {
    throw new Error('No upstream request should be made');
  }, () => createScopusProxy({ ...ENV, PROXY_SHARED_SECRET: 'short' })(
    request('/scopus?query=test', { secret: 'short' }),
  ));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'PROXY_NOT_CONFIGURED' });
});

test('serves exactly one route and one method', async () => {
  const proxy = createScopusProxy(ENV);
  await withUpstream(async () => {
    throw new Error('No upstream request should be made');
  }, async () => {
    assert.equal((await proxy(request('/anything?query=test'))).status, 404);
    assert.equal((await proxy(request('/scopus?query=test', { method: 'POST' }))).status, 405);
  });
});

test('rebuilds the upstream URL instead of forwarding what the caller asked for', async () => {
  let upstreamUrl = '';
  const response = await withUpstream(async url => {
    upstreamUrl = String(url);
    return new Response('{}', { status: 200 });
  }, () => createScopusProxy(ENV)(request(
    // A caller-supplied host, path and extra parameters must not survive.
    '/scopus?query=TITLE-ABS-KEY%28%22robotics%22%29&count=8&start=16&view=COMPLETE&apiKey=stolen&url=https://evil.test',
  )));

  assert.equal(response.status, 200);
  const target = new URL(upstreamUrl);
  assert.equal(target.origin + target.pathname, 'https://api.elsevier.com/content/search/scopus');
  assert.equal(target.searchParams.get('query'), 'TITLE-ABS-KEY("robotics")');
  assert.equal(target.searchParams.get('count'), '8');
  assert.equal(target.searchParams.get('start'), '16');
  assert.equal(target.searchParams.get('view'), 'COMPLETE');
  assert.equal(target.searchParams.get('apiKey'), null);
  assert.equal(target.searchParams.get('url'), null);
});

test('clamps the paging parameters and drops a view Scopus does not offer', async () => {
  let upstreamUrl = '';
  await withUpstream(async url => {
    upstreamUrl = String(url);
    return new Response('{}', { status: 200 });
  }, () => createScopusProxy(ENV)(request('/scopus?query=test&count=9999&start=-5&view=SECRET')));

  const target = new URL(upstreamUrl);
  assert.equal(target.searchParams.get('count'), '25');
  assert.equal(target.searchParams.get('start'), '0');
  assert.equal(target.searchParams.get('view'), null);
});

test('rejects an empty or oversized query before spending an upstream call', async () => {
  const proxy = createScopusProxy(ENV);
  await withUpstream(async () => {
    throw new Error('No upstream request should be made');
  }, async () => {
    assert.equal((await proxy(request('/scopus'))).status, 400);
    assert.equal((await proxy(request(`/scopus?query=${'x'.repeat(501)}`))).status, 400);
  });
});

test('sends the Elsevier credentials and never echoes them back', async () => {
  let sentHeaders = null;
  const response = await withUpstream(async (url, options) => {
    sentHeaders = options.headers;
    return new Response('{"search-results":{}}', {
      status: 200,
      headers: { 'X-RateLimit-Remaining': '19998', 'X-ELS-ReqId': 'req-7', 'set-cookie': 'session=leak' },
    });
  }, () => createScopusProxy({ ...ENV, ELSEVIER_INST_TOKEN: 'inst-token' })(request('/scopus?query=test')));

  assert.equal(sentHeaders['X-ELS-APIKey'], 'test-key');
  assert.equal(sentHeaders['X-ELS-Insttoken'], 'inst-token');

  const body = await response.text();
  assert.equal(body, '{"search-results":{}}');
  assert.equal(response.headers.get('X-RateLimit-Remaining'), '19998');
  assert.equal(response.headers.get('X-ELS-ReqId'), 'req-7');
  assert.equal(response.headers.get('X-PaperTok-Insttoken'), 'true');
  // Only the allowlisted upstream headers are relayed.
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('X-ELS-APIKey'), null);
  assert.doesNotMatch(body, /test-key|inst-token/);
});

test('relays the upstream status so the Worker can tell a refusal from an outage', async () => {
  const response = await withUpstream(
    async () => new Response(
      JSON.stringify({ 'service-error': { status: { statusCode: 'AUTHENTICATION_ERROR' } } }),
      { status: 401 },
    ),
    () => createScopusProxy(ENV)(request('/scopus?query=test')),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json())['service-error'].status.statusCode, 'AUTHENTICATION_ERROR');
});

test('answers the health route without a secret and without naming the key', async () => {
  const response = await withUpstream(async () => {
    throw new Error('No upstream request should be made');
  }, () => createScopusProxy(ENV)(request('/health', { secret: '' })));

  assert.equal(response.status, 200);
  const health = await response.json();
  assert.deepEqual(health, { ok: true, configured: true, insttoken: false });
});

test('importing the module under Node starts no server and still exposes a handler', () => {
  // Deno Deploy runs the file directly, so the module calls `Deno.serve` at load
  // time. That call must stay behind a runtime guard: importing it here proves
  // the guard holds, since Node has no `Deno` global to serve with.
  assert.equal(typeof scopusProxy.fetch, 'function');
});

// --- G2: plazos de red y comparación del secreto -----------------------------

test('gives the Elsevier call a deadline that covers the body as well', async () => {
  let seenSignal;
  const response = await withUpstream(async (_url, options) => {
    seenSignal = options?.signal;
    return new Response(JSON.stringify({ 'search-results': { entry: [] } }), { status: 200 });
  }, () => createScopusProxy(ENV)(request('/scopus?query=test')));

  assert.equal(response.status, 200);
  // The Worker waits on this proxy and this proxy waits on Elsevier. Without a
  // deadline here the chain hangs link by link, and the Worker's own deadline
  // only ever cuts its half of it.
  assert.ok(seenSignal, 'the Elsevier fetch carries no AbortSignal');
  assert.equal(seenSignal.aborted, false);
});

test('answers a stalled Elsevier with a status the Worker can read', async () => {
  const response = await withUpstream(async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  }, () => createScopusProxy(ENV)(request('/scopus?query=test')));

  // Putting a deadline on the fetch without catching what it throws would turn a
  // hang into an uncaught exception, which Deno answers with a bare 500.
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { code: 'SCOPUS_UPSTREAM_TIMEOUT' });
});

test('answers an unreachable Elsevier without leaking the failure as an exception', async () => {
  const response = await withUpstream(async () => {
    throw new TypeError('error sending request');
  }, () => createScopusProxy(ENV)(request('/scopus?query=test')));

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { code: 'SCOPUS_UPSTREAM_UNREACHABLE' });
});

test('compares the shared secret without letting its length leak through timing', async () => {
  const digests = [];
  const originalDigest = crypto.subtle.digest;
  crypto.subtle.digest = (algorithm, data) => {
    digests.push(algorithm);
    return originalDigest.call(crypto.subtle, algorithm, data);
  };
  try {
    const refuse = secret => withUpstream(async () => {
      throw new Error('No upstream request should be made');
    }, () => createScopusProxy(ENV)(request('/scopus?query=test', { secret })));

    const wrongLength = await refuse('b');
    const wrongValue = await refuse('b'.repeat(SECRET.length));

    assert.equal(wrongLength.status, 401);
    assert.equal(wrongValue.status, 401);
    assert.deepEqual(await wrongLength.json(), await wrongValue.json());
    // Both refusals hashed both values. The early return this replaces did no
    // hashing at all when the lengths differed, which is how the length of the
    // secret was readable from the outside.
    assert.equal(digests.length, 4, 'a wrong-length secret still takes a shorter path');
  } finally {
    crypto.subtle.digest = originalDigest;
  }
});
