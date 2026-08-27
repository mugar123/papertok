import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './report-api.js';

/**
 * `POST /ai/annotate` — one passage, explained where the reader is standing.
 *
 * These go in through `reportApi.fetch` rather than calling
 * `handlePassageAnnotation`, for the reason the quota suite already learned the
 * hard way: an unregistered route is how a feature ships dead. A handler that
 * passes every unit test and is never reached by the router answers 405, which
 * is exactly what this route did on the first deploy of it — the handler was
 * written, tested and correct, and the browser got "method not allowed" because
 * nothing routed to it.
 */

const ROUTE = 'https://papertok-report-api.example/ai/annotate';
const ORIGIN = 'https://mugar123.github.io';

const PASSAGE = {
  paper: { title: 'Correlators of Worldline Proper Length' },
  quote: 'esa cantidad deja de ser un número',
  context: 'Los autores calculan cuánto tiempo propio transcurre, y encuentran que esa cantidad deja de ser un número en cuanto la gravedad cuántica entra en juego.',
  level: 'university',
  language: 'es',
};

function recordingLedger({ accepted = true, remaining = 6 } = {}) {
  const actions = [];
  return {
    actions,
    idFromName: () => 'quota-id',
    get: () => ({
      fetch: async (_url, options) => {
        actions.push(JSON.parse(options.body).action);
        return new Response(JSON.stringify({ accepted, remaining, subjectUsage: 4, globalUsage: 9 }));
      },
    }),
  };
}

function annotationEnv(ledger, overrides = {}) {
  return {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    GEMINI_API_KEY: 'gemini-test-key',
    AI_DAILY_USER_LIMIT: '10',
    AI_DAILY_GLOBAL_LIMIT: '1000',
    REQUEST_QUOTA_LEDGER: ledger,
    ...overrides,
  };
}

function annotationRequest({
  body = PASSAGE,
  method = 'POST',
  origin = ORIGIN,
  authorization = 'Bearer test-token',
} = {}) {
  return new Request(ROUTE, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

/** A signed-in caller without an Identity Toolkit round trip. */
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

/** Stands in for Gemini, and records what it was actually asked. */
async function withModel(reply, callback) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return reply();
  };
  try {
    return { result: await callback(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function modelSaid(text) {
  return () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('the router actually serves POST /ai/annotate', async () => {
  const ledger = recordingLedger();
  const { result: response, calls } = await withModel(
    modelSaid('Antes medías un tiempo y salía un valor. Ahora sale un abanico de valores.'),
    () => withCachedIdentity(() => reportApi.fetch(annotationRequest(), annotationEnv(ledger))),
  );

  // 405 here means the handler is never reached: the route is not registered.
  assert.notEqual(response.status, 405, 'the route is not registered in the router');
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.note, 'Antes medías un tiempo y salía un valor. Ahora sale un abanico de valores.');
  assert.equal(payload.remainingUses, 6);
  assert.equal(payload.language, 'es');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');

  // And it asked the model about the passage, with the paragraph as context.
  assert.equal(calls.length, 1);
  const prompt = calls[0].body.contents[0].parts[0].text;
  assert.match(prompt, /esa cantidad deja de ser un número/);
  assert.match(prompt, /solo como contexto/);
});

test('it costs one of the day\'s uses, reserved before the model is asked', async () => {
  const ledger = recordingLedger();
  await withModel(
    modelSaid('Una explicación corta.'),
    () => withCachedIdentity(() => reportApi.fetch(annotationRequest(), annotationEnv(ledger))),
  );

  assert.deepEqual(ledger.actions, ['reserve']);
});

test('a provider failure hands the use back', async () => {
  const ledger = recordingLedger();
  const { result: response } = await withModel(
    () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 }),
    () => withCachedIdentity(() => reportApi.fetch(annotationRequest(), annotationEnv(ledger))),
  );

  // A 503 from the provider is congestion, not a broken request, so it comes
  // back as the code that tells the reader to try again in a moment.
  assert.equal((await response.json()).code, 'AI_BUSY');
  // Reserved, then released: an outage at the provider must not cost the reader
  // one of ten daily uses.
  assert.deepEqual(ledger.actions, ['reserve', 'release']);
});

test('an exhausted allowance is refused before the model is asked', async () => {
  const ledger = recordingLedger({ accepted: false, remaining: 0 });
  const { result: response, calls } = await withModel(
    modelSaid('no debería llegar aquí'),
    () => withCachedIdentity(() => reportApi.fetch(annotationRequest(), annotationEnv(ledger))),
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(calls.length, 0);
  // Nothing to refund: the reservation never succeeded.
  assert.deepEqual(ledger.actions, ['reserve']);
});

test('it needs a session, and says so with the code the reader knows', async () => {
  const response = await reportApi.fetch(
    annotationRequest({ authorization: null }),
    annotationEnv(recordingLedger()),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'AI_AUTH_REQUIRED');
});

test('it refuses an origin that is not on the list, before touching the ledger', async () => {
  const ledger = recordingLedger();
  const response = await reportApi.fetch(
    annotationRequest({ origin: 'https://evil.example' }),
    annotationEnv(ledger),
  );

  assert.equal(response.status, 403);
  assert.deepEqual(ledger.actions, []);
});

test('a selection too short to identify a passage is refused, and costs nothing', async () => {
  const ledger = recordingLedger();
  const { result: response, calls } = await withModel(
    modelSaid('no debería llegar aquí'),
    () => withCachedIdentity(() => reportApi.fetch(
      annotationRequest({ body: { ...PASSAGE, quote: 'corto' } }),
      annotationEnv(ledger),
    )),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'AI_INVALID_REQUEST');
  assert.equal(calls.length, 0);
  assert.deepEqual(ledger.actions, []);
});

test('without a provider key it is not configured, rather than broken', async () => {
  const ledger = recordingLedger();
  const response = await withCachedIdentity(() => reportApi.fetch(
    annotationRequest(),
    annotationEnv(ledger, { GEMINI_API_KEY: '' }),
  ));

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AI_NOT_CONFIGURED');
  assert.deepEqual(ledger.actions, []);
});

test('GET is not how you ask for an annotation', async () => {
  const response = await reportApi.fetch(
    annotationRequest({ method: 'GET' }),
    annotationEnv(recordingLedger()),
  );
  assert.equal(response.status, 405);
});
