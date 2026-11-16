import type { WorkerEnv } from './env.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import reportApi from './index.ts';
import { audioKey } from './read-aloud-tts.ts';

const ROUTE = 'https://papertok-report-api.example/tts/paragraph';
const ORIGIN = 'https://papertok.app';
const TEXT = 'The authors measure how well each probe separates injected prompts from benign ones.';

function recordingLedger({ accepted = true, scope = '' } = {}) {
  const calls: Array<{ action: string; amount: number; subjectLimit: number }> = [];
  return {
    calls,
    idFromName: () => 'quota-id',
    get: () => ({
      fetch: async (_url: RequestInfo | URL, options?: RequestInit) => {
        calls.push(JSON.parse(options!.body as string));
        return new Response(JSON.stringify({ accepted, remaining: 100, ...(scope ? { scope } : {}) }));
      },
    }),
  };
}

function memoryBucket(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map(Object.entries(initial));
  return {
    objects,
    get: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
    },
    put: async (key: string, value: ArrayBuffer) => {
      objects.set(key, new Uint8Array(value));
    },
  };
}

function env(ledger: ReturnType<typeof recordingLedger>, bucket: ReturnType<typeof memoryBucket>) {
  return {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    CARTESIA_API_KEY: 'cartesia-test-key',
    TTS_DAILY_USER_CHARS: '150000',
    TTS_DAILY_GLOBAL_CHARS: '258000',
    REQUEST_QUOTA_LEDGER: ledger,
    TTS_AUDIO: bucket,
  } as unknown as WorkerEnv;
}

function paragraphRequest(body: unknown = { text: TEXT }, authorization: string | null = 'Bearer test-token') {
  return new Request(ROUTE, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
}

async function signedIn<Result>(callback: () => Promise<Result>) {
  const original = (globalThis as TestGlobals).caches;
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request: RequestInfo | URL) => (String(request instanceof Request ? request.url : request).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : null),
      put: async () => undefined,
    },
  };
  try {
    return await callback();
  } finally {
    if (original === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = original;
  }
}

async function withCartesia<Result>(reply: () => Response, callback: () => Promise<Result>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options?.headers), body: JSON.parse(options!.body as string) });
    return reply();
  };
  try {
    return { response: await callback(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44]);

test('a paragraph nobody has heard is synthesized once, charged by its length and stored', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const { response, calls } = await withCartesia(
    () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }),
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket))),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MP3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cartesia.ai/tts/bytes');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer cartesia-test-key');
  assert.equal(calls[0].body.transcript, TEXT);
  assert.deepEqual(ledger.calls.map(call => [call.action, call.amount, call.subjectLimit]), [['reserve', TEXT.length, 150_000]]);
  assert.deepEqual(bucket.objects.get(await audioKey(TEXT)), MP3);
});

test('a stored paragraph is served without calling Cartesia or spending the allowance', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket({ [await audioKey(TEXT)]: MP3 });
  const { response, calls } = await withCartesia(
    () => new Response('unexpected', { status: 500 }),
    () => signedIn(() => reportApi.fetch(paragraphRequest({ text: `  ${TEXT}\n` }), env(ledger, bucket))),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MP3);
  assert.equal(calls.length, 0);
  assert.equal(ledger.calls.length, 0);
});

test('a reader past the daily allowance is refused before Cartesia is called', async () => {
  const ledger = recordingLedger({ accepted: false, scope: 'user' });
  const { response, calls } = await withCartesia(
    () => new Response(MP3),
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );

  assert.equal(response.status, 429);
  const payload = await response.json<{ code: string; quota: { scope: string } }>();
  assert.equal(payload.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(payload.quota.scope, 'user');
  assert.equal(calls.length, 0);
});

test('Cartesia running out of credits gives the characters back and says whose limit it was', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const { response } = await withCartesia(
    () => new Response(JSON.stringify({ error_code: 'quota_exceeded', title: 'Quota exceeded' }), { status: 402 }),
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket))),
  );

  assert.equal(response.status, 429);
  const payload = await response.json<{ code: string; quota: { scope: string } }>();
  assert.equal(payload.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(payload.quota.scope, 'provider');
  assert.deepEqual(ledger.calls.map(call => [call.action, call.amount]), [['reserve', TEXT.length], ['release', TEXT.length]]);
  assert.equal(bucket.objects.size, 0);
});

test('without a session, or with an empty or oversized paragraph, nothing is spent', async () => {
  const ledger = recordingLedger();
  const { calls } = await withCartesia(() => new Response(MP3), async () => {
    const anonymous = await reportApi.fetch(paragraphRequest(undefined, null), env(ledger, memoryBucket()));
    assert.equal(anonymous.status, 401);
    const empty = await signedIn(() => reportApi.fetch(paragraphRequest({ text: '   ' }), env(ledger, memoryBucket())));
    assert.equal(empty.status, 400);
    const long = await signedIn(() => reportApi.fetch(paragraphRequest({ text: 'a'.repeat(3_001) }), env(ledger, memoryBucket())));
    assert.equal(long.status, 413);
  });
  assert.equal(calls.length, 0);
  assert.equal(ledger.calls.length, 0);
});

test('asked for stored audio only, a paragraph nobody has made is refused without spending anything', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket({ [await audioKey(TEXT)]: MP3 });
  const { calls } = await withCartesia(() => new Response(MP3), async () => {
    const stored = await signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, storedOnly: true }), env(ledger, bucket)));
    assert.equal(stored.status, 200);
    assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), MP3);
    const missing = await signedIn(() => reportApi.fetch(paragraphRequest({ text: 'A paragraph that was never read aloud.', storedOnly: true }), env(ledger, bucket)));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json<{ code: string }>()).code, 'AI_AUDIO_NOT_STORED');
  });
  assert.equal(calls.length, 0);
  assert.equal(ledger.calls.length, 0);
});
