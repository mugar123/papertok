import type { TestNamespace } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './index.ts';

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
  quote: 'that quantity stops being a number',
  context: 'The authors compute how much proper time elapses, and find that that quantity stops being a number as soon as quantum gravity comes into play.',
  level: 'university',
  // A legacy client may still send Spanish; the product is English-only now.
  language: 'es',
};

function recordingLedger({ accepted = true, remaining = 6 } = {}) {
  const actions: string[] = [];
  return {
    actions,
    idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (_url: RequestInfo | URL, options?: RequestInit) => {
        actions.push(JSON.parse(options!.body as string).action);
        return new Response(JSON.stringify({ accepted, remaining, subjectUsage: 4, globalUsage: 9 }));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'] & { actions: typeof actions };
}

function annotationEnv(ledger: TestNamespace | undefined, overrides = {}) {
  return {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    GEMINI_API_KEY: 'gemini-test-key',
    AI_DAILY_USER_LIMIT: '10',
    AI_DAILY_GLOBAL_LIMIT: '1000',
    REQUEST_QUOTA_LEDGER: ledger as WorkerEnv['REQUEST_QUOTA_LEDGER'],
    ...overrides,
  };
}

function annotationRequest({
  body = PASSAGE,
  method = 'POST',
  origin = ORIGIN,
  authorization = 'Bearer test-token',
}: { body?: unknown; method?: string; origin?: string; authorization?: string | null } = {}) {
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

/** Stands in for Gemini, and records what it was actually asked. */
async function withModel<Result>(reply: () => Response, callback: () => Promise<Result>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: { contents: Array<{ parts: Array<{ text: string }> }>; model: string; chat_template_kwargs: { enable_thinking: boolean }; messages: Array<{ content: string }> } }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options!.body as string) });
    return reply();
  };
  try {
    return { result: await callback(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function modelSaid(text: string) {
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

  const payload = await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>();
  assert.equal(payload.note, 'Antes medías un tiempo y salía un valor. Ahora sale un abanico de valores.');
  assert.equal(payload.remainingUses, 6);
  // A legacy `language: 'es'` is accepted and ignored: the answer is English.
  assert.equal(payload.language, 'en');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');

  // And it asked the model about the passage, with the paragraph as context.
  assert.equal(calls.length, 1);
  const prompt = calls[0].body.contents[0].parts[0].text;
  assert.match(prompt, /that quantity stops being a number/);
  assert.match(prompt, /context only/);
  assert.match(prompt, /Explain WHAT THAT PASSAGE MEANS/);
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
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_BUSY');
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
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_QUOTA_EXHAUSTED');
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
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_AUTH_REQUIRED');
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
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_INVALID_REQUEST');
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
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_NOT_CONFIGURED');
  assert.deepEqual(ledger.actions, []);
});

test('a quota ledger that is merely unreachable is not «not configured»', async () => {
  const unreachable = {
    idFromName: ((): unknown => 'quota-id') as TestNamespace['idFromName'],
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({ fetch: async () => new Response('boom', { status: 500 }) })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];
  const { result: [outage, missing], calls } = await withModel(
    modelSaid('no debería llegar aquí'),
    () => withCachedIdentity(async () => [
      await reportApi.fetch(annotationRequest(), annotationEnv(unreachable)),
      await reportApi.fetch(annotationRequest(), annotationEnv(undefined)),
    ]),
  );

  // Transient: the reader gets a retry button instead of «not available yet».
  assert.equal(outage.status, 503);
  assert.equal((await outage.json<{ code: string }>()).code, 'AI_UNAVAILABLE');
  assert.equal(missing.status, 503);
  assert.equal((await missing.json<{ code: string }>()).code, 'AI_NOT_CONFIGURED');
  assert.equal(calls.length, 0);
});

test('GET is not how you ask for an annotation', async () => {
  const response = await reportApi.fetch(
    annotationRequest({ method: 'GET' }),
    annotationEnv(recordingLedger()),
  );
  assert.equal(response.status, 405);
});

/** A body that arrives in pieces, which is how a `content-length` cap is dodged. */
function chunked(bytes: Uint8Array, size = 8_192) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
      controller.close();
    },
  });
}

test('an oversized chunked passage is cut off at the cap', { timeout: 10_000 }, async () => {
  const ledger = recordingLedger();
  const bytes = new TextEncoder().encode(JSON.stringify({ ...PASSAGE, context: 'x'.repeat(21_000) }));
  const request = new Request(ROUTE, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: 'Bearer test-token' },
    body: chunked(bytes),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  // The model double is the watchdog here: without it a body that gets through
  // reaches the real Gemini endpoint and the run hangs on the open internet.
  const { result: response, calls } = await withModel(
    modelSaid('no debería llegar aquí'),
    () => withCachedIdentity(() => reportApi.fetch(request, annotationEnv(ledger))),
  );

  // Twenty-one kilobytes against a twenty-thousand-byte cap, announced by
  // nothing: the reader of the body is what has to stop.
  assert.equal(calls.length, 0);
  assert.equal(response.status, 413);
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_REQUEST_TOO_LARGE');
  assert.deepEqual(ledger.actions, []);
});

/* NaN, the primary provider since 2026-10-06. */

const NAN = { AI_PROVIDER: 'nan', NAN_API_KEY: 'sk-test-key' };

/** Stands in for NaN: an OpenAI chat completion whose answer is `text`. */
function nanSaid(text: string) {
  return () => new Response(JSON.stringify({
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: text, reasoning_content: null },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('with NaN as the provider the passage goes to NaN, reasoning off', async () => {
  const ledger = recordingLedger();
  const { result: response, calls } = await withModel(
    nanSaid('**It means** the length stops being one number.'),
    () => withCachedIdentity(() => reportApi.fetch(annotationRequest(), annotationEnv(ledger, NAN))),
  );

  assert.equal(response.status, 200);
  const payload = await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>();
  // The same cleaning as Gemini's answers: no markdown in a margin.
  assert.equal(payload.note, 'It means the length stops being one number.');
  assert.equal(payload.model, 'deepseek-v4-flash');
  assert.deepEqual(ledger.actions, ['reserve']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.nan.builders/v1/chat/completions');
  assert.equal(calls[0].body.model, 'deepseek-v4-flash');
  // The reader is waiting mid-sentence: no reasoning phase at all.
  assert.deepEqual(calls[0].body.chat_template_kwargs, { thinking: false, enable_thinking: false });
  assert.match(calls[0].body.messages[0].content, /that quantity stops being a number/);
});

test('a busy NaN hands the use back', async () => {
  const ledger = recordingLedger();
  const { result: response } = await withModel(
    () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 }),
    () => withCachedIdentity(() => reportApi.fetch(annotationRequest(), annotationEnv(ledger, NAN))),
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_BUSY');
  assert.deepEqual(ledger.actions, ['reserve', 'release']);
});

test('NaN chosen without a NaN key is not configured, and costs nothing', async () => {
  const ledger = recordingLedger();
  const response = await withCachedIdentity(() => reportApi.fetch(
    annotationRequest(),
    annotationEnv(ledger, { ...NAN, NAN_API_KEY: '' }),
  ));

  assert.equal(response.status, 503);
  assert.equal((await response.json<{ code: string; remainingUses: number; dailyLimit: number; note: string; language: string; model: string; unlimited: boolean }>()).code, 'AI_NOT_CONFIGURED');
  assert.deepEqual(ledger.actions, []);
});
