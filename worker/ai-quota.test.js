import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './report-api.js';

/**
 * `GET /ai/quota` — the day's AI allowance, read without spending it.
 *
 * The reader shows how many of the ten daily uses are left. Before this route
 * the only source for that number was the `meta` line of a rewrite already under
 * way, which is to say: after a use had been spent, and never at all on a cache
 * hit or a failure. So the number was invisible in exactly the situations a
 * reader wants it.
 *
 * These go in through `reportApi.fetch` rather than calling the handler, because
 * an unregistered route was how the rewrite itself shipped dead once already.
 */

const QUOTA_ROUTE = 'https://papertok-report-api.example/ai/quota';
const ORIGIN = 'https://mugar123.github.io';

/** A ledger that records every action it is asked for. */
function recordingLedger(reading = { accepted: true, subjectUsage: 3, globalUsage: 9, remaining: 7 }) {
  const actions = [];
  return {
    actions,
    idFromName: () => 'quota-id',
    get: () => ({
      fetch: async (_url, options) => {
        actions.push(JSON.parse(options.body).action);
        return new Response(JSON.stringify(reading));
      },
    }),
  };
}

function quotaEnv(ledger) {
  return {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    AI_DAILY_USER_LIMIT: '10',
    AI_DAILY_GLOBAL_LIMIT: '1000',
    REQUEST_QUOTA_LEDGER: ledger,
  };
}

function quotaRequest({ method = 'GET', origin = ORIGIN, authorization = 'Bearer test-token' } = {}) {
  return new Request(QUOTA_ROUTE, {
    method,
    headers: { origin, ...(authorization ? { authorization } : {}) },
  });
}

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

test('the router serves GET /ai/quota with what is left and the ceiling it is out of', async () => {
  const ledger = recordingLedger();
  const response = await withCachedIdentity(() => reportApi.fetch(quotaRequest(), quotaEnv(ledger)));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.remainingUses, 7);
  // The limit travels with the answer. A reader that hardcoded ten would be
  // wrong the day `AI_DAILY_USER_LIMIT` changes, and would say so confidently.
  assert.equal(payload.dailyLimit, 10);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('reading the allowance does not reserve any of it', async () => {
  const ledger = recordingLedger();
  await withCachedIdentity(() => reportApi.fetch(quotaRequest(), quotaEnv(ledger)));

  // The whole point of the route. A peek that reserved would cost a use every
  // time the reader opened, which is worse than not showing the number at all.
  assert.deepEqual(ledger.actions, ['peek']);
});

test('/ai/quota needs a session, and says so with the code the reader knows', async () => {
  const response = await reportApi.fetch(
    quotaRequest({ authorization: null }),
    quotaEnv(recordingLedger()),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'AI_AUTH_REQUIRED');
});

test('/ai/quota refuses an origin that is not on the list', async () => {
  const ledger = recordingLedger();
  const response = await reportApi.fetch(
    quotaRequest({ origin: 'https://evil.example' }),
    quotaEnv(ledger),
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  // Refused before the ledger is touched: an origin off the list must not even
  // learn whether the account has uses left.
  assert.deepEqual(ledger.actions, []);
});

test('an unreachable ledger is an outage, not an empty allowance', async () => {
  const response = await withCachedIdentity(() => reportApi.fetch(quotaRequest(), {
    ...quotaEnv(recordingLedger()),
    REQUEST_QUOTA_LEDGER: {
      idFromName: () => 'quota-id',
      get: () => ({ fetch: async () => new Response('nope', { status: 500 }) }),
    },
  }));

  // Answering `remainingUses: 0` here would tell a reader with ten uses left
  // that it had none, and the reader would believe it.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AI_UNAVAILABLE');
});

test('a missing ledger binding reads as not configured rather than as an outage', async () => {
  const response = await withCachedIdentity(() => reportApi.fetch(quotaRequest(), {
    ...quotaEnv(recordingLedger()),
    REQUEST_QUOTA_LEDGER: undefined,
  }));

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AI_NOT_CONFIGURED');
});
