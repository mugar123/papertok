import type { WorkerEnv } from './env.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import reportApi from './index.ts';
import { audioKey } from './read-aloud-tts.ts';

const ROUTE = 'https://papertok-report-api.example/tts/paragraph';
const ORIGIN = 'https://papertok.app';
const TEXT = 'The authors measure how well each probe separates injected prompts from benign ones.';

/** Accepts every reservation, except those of a period named in `refused`, which are refused with its scope. */
function recordingLedger({ accepted = true, scope = '', refused = {} }: { accepted?: boolean; scope?: string; refused?: Record<string, string> } = {}) {
  const calls: Array<{ period: string; action: string; amount: number; subjectLimit: number; globalLimit: number }> = [];
  return {
    calls,
    idFromName: (period: string) => period,
    get: (period: string) => ({
      fetch: async (_url: RequestInfo | URL, options?: RequestInit) => {
        calls.push({ period, ...JSON.parse(options!.body as string) });
        const refusal = Object.entries(refused).find(([name]) => period.startsWith(name))?.[1];
        const answer = refusal ? { accepted: false, scope: refusal } : { accepted, ...(scope ? { scope } : {}) };
        return new Response(JSON.stringify({ remaining: 100, ...answer }));
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
    head: async (key: string) => (objects.has(key) ? { key } : null),
    put: async (key: string, value: ArrayBuffer | string) => {
      objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    },
  };
}

function env(ledger: ReturnType<typeof recordingLedger>, bucket: ReturnType<typeof memoryBucket>, overrides: Record<string, unknown> = {}) {
  return {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    ELEVENLABS_API_KEY: 'elevenlabs-test-key',
    CARTESIA_API_KEY: 'cartesia-test-key',
    TTS_DAILY_USER_CHARS: '44000',
    TTS_DAILY_ELEVENLABS_CHARS: '88000',
    TTS_DAILY_CARTESIA_CHARS: '258000',
    REQUEST_QUOTA_LEDGER: ledger,
    TTS_AUDIO: bucket,
    ...overrides,
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

type Replies = { elevenlabs?: () => Response; cartesia?: () => Response };

/** Answers each provider's request with its reply, and an unexpected call with a 500. */
async function withProviders<Result>(replies: Replies, callback: () => Promise<Result>) {
  const original = globalThis.fetch;
  const calls: Array<{ provider: 'elevenlabs' | 'cartesia'; url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, options) => {
    const provider = String(url).startsWith('https://api.elevenlabs.io/') ? 'elevenlabs' : 'cartesia';
    calls.push({ provider, url: String(url), headers: new Headers(options?.headers), body: JSON.parse(options!.body as string) });
    return replies[provider]?.() ?? new Response('unexpected', { status: 500 });
  };
  try {
    return { response: await callback(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44]);
const CARTESIA_MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
const ALIGNMENT = { characters: ['T', 'h', 'e'], character_start_times_seconds: [0, 0.05, 0.1], character_end_times_seconds: [0.05, 0.1, 0.15] };
const elevenLabsAudio = () => Response.json({ audio_base64: btoa(String.fromCharCode(...MP3)), alignment: ALIGNMENT, normalized_alignment: ALIGNMENT });
const cartesiaAudio = () => new Response(CARTESIA_MP3, { headers: { 'content-type': 'audio/mpeg' } });
const elevenLabsOutOfCharacters = () => Response.json({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } }, { status: 401 });

test('a paragraph nobody has heard is read by ElevenLabs once, charged by its length and stored with its timings', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const { response, calls } = await withProviders(
    { elevenlabs: elevenLabsAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket))),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MP3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/with-timestamps?output_format=mp3_44100_64');
  assert.equal(calls[0].headers.get('xi-api-key'), 'elevenlabs-test-key');
  assert.equal(calls[0].body.text, TEXT);
  assert.deepEqual(ledger.calls.map(call => [call.action, call.amount, call.subjectLimit, call.globalLimit]), [['reserve', TEXT.length, 44_000, 88_000]]);
  const key = await audioKey('elevenlabs', TEXT);
  assert.deepEqual(bucket.objects.get(`${key}.mp3`), MP3);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bucket.objects.get(`${key}.json`))), ALIGNMENT);
});

test('when ElevenLabs is out of characters, Cartesia reads the paragraph and its audio is stored', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const { response, calls } = await withProviders(
    { elevenlabs: elevenLabsOutOfCharacters, cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket))),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3);
  assert.deepEqual(calls.map(call => call.provider), ['elevenlabs', 'cartesia']);
  assert.equal(calls[1].url, 'https://api.cartesia.ai/tts/bytes');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer cartesia-test-key');
  assert.equal(calls[1].body.transcript, TEXT);
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(ledger.calls.map(call => [call.period, call.action, call.globalLimit]), [
    [`tts:elevenlabs:${day}`, 'reserve', 88_000],
    [`tts:elevenlabs:${day}`, 'release', 88_000],
    [`tts:cartesia:${day}`, 'reserve', 258_000],
  ]);
  const key = await audioKey('cartesia', TEXT);
  assert.deepEqual(bucket.objects.get(`${key}.mp3`), CARTESIA_MP3);
  assert.equal(bucket.objects.has(`${key}.json`), false);
});

test('Cartesia also reads when ElevenLabs has no key, and is asked when ElevenLabs\' day of characters is spent', async () => {
  const noKey = await withProviders(
    { cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(recordingLedger(), memoryBucket(), { ELEVENLABS_API_KEY: undefined }))),
  );
  assert.equal(noKey.response.status, 200);
  assert.deepEqual(noKey.calls.map(call => call.provider), ['cartesia']);

  const ledger = recordingLedger({ accepted: false, scope: 'global' });
  const spent = await withProviders(
    { elevenlabs: elevenLabsAudio, cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );
  assert.equal(spent.response.status, 429);
  assert.equal((await spent.response.json<{ quota: { scope: string } }>()).quota.scope, 'global');
  assert.equal(spent.calls.length, 0);
  assert.deepEqual(ledger.calls.map(call => call.globalLimit), [88_000, 258_000]);
});

test('a paragraph stored by either provider is served without calling one or spending the allowance', async () => {
  for (const provider of ['elevenlabs', 'cartesia'] as const) {
    const ledger = recordingLedger();
    const bucket = memoryBucket({ [`${await audioKey(provider, TEXT)}.mp3`]: MP3 });
    const { response, calls } = await withProviders(
      {},
      () => signedIn(() => reportApi.fetch(paragraphRequest({ text: `  ${TEXT}\n` }), env(ledger, bucket))),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MP3);
    assert.equal(calls.length, 0);
    assert.equal(ledger.calls.length, 0);
  }
});

test('a reader past their daily allowance is refused before either provider is called', async () => {
  const ledger = recordingLedger({ accepted: false, scope: 'user' });
  const { response, calls } = await withProviders(
    { elevenlabs: elevenLabsAudio, cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );

  assert.equal(response.status, 429);
  const payload = await response.json<{ code: string; quota: { scope: string } }>();
  assert.equal(payload.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(payload.quota.scope, 'user');
  assert.equal(calls.length, 0);
  assert.equal(ledger.calls.length, 1);
});

test('when both providers fail, both give the characters back and the last refusal is reported', async () => {
  const cases: Array<[Replies, number, string]> = [
    [{ elevenlabs: elevenLabsOutOfCharacters, cartesia: () => Response.json({ error_code: 'quota_exceeded' }, { status: 402 }) }, 429, 'AI_QUOTA_EXHAUSTED'],
    [{ elevenlabs: () => Response.json({ detail: { status: 'invalid_api_key' } }, { status: 401 }), cartesia: () => new Response('', { status: 429 }) }, 429, 'AI_BUSY'],
    [{ elevenlabs: () => Response.json({ detail: { status: 'too_many_concurrent_requests' } }, { status: 429 }), cartesia: () => new Response('', { status: 401 }) }, 503, 'AI_NOT_CONFIGURED'],
  ];
  for (const [replies, status, code] of cases) {
    const ledger = recordingLedger();
    const bucket = memoryBucket();
    const { response, calls } = await withProviders(replies, () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket))));
    assert.equal(response.status, status);
    assert.equal((await response.json<{ code: string }>()).code, code);
    assert.deepEqual(calls.map(call => call.provider), ['elevenlabs', 'cartesia']);
    assert.deepEqual(ledger.calls.map(call => call.action), ['reserve', 'release', 'reserve', 'release']);
    assert.equal(bucket.objects.size, 0);
  }
});

test('without a session, or with an empty or oversized paragraph, nothing is spent', async () => {
  const ledger = recordingLedger();
  const { calls } = await withProviders({ elevenlabs: elevenLabsAudio, cartesia: cartesiaAudio }, async () => {
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
  const bucket = memoryBucket({ [`${await audioKey('cartesia', TEXT)}.mp3`]: CARTESIA_MP3 });
  const { calls } = await withProviders({ elevenlabs: elevenLabsAudio, cartesia: cartesiaAudio }, async () => {
    const stored = await signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, storedOnly: true }), env(ledger, bucket)));
    assert.equal(stored.status, 200);
    assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), CARTESIA_MP3);
    const missing = await signedIn(() => reportApi.fetch(paragraphRequest({ text: 'A paragraph that was never read aloud.', storedOnly: true }), env(ledger, bucket)));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json<{ code: string }>()).code, 'AI_AUDIO_NOT_STORED');
  });
  assert.equal(calls.length, 0);
  assert.equal(ledger.calls.length, 0);
});

test('audio Cartesia stored before ElevenLabs was added keeps its name', async () => {
  const old = createHash('sha256').update(`sonic-3.6-2026-08-27\nf786b574-daa5-4673-aa0c-cbe3e8534c02\n64000\n${TEXT}`).digest('hex');
  assert.equal(`${await audioKey('cartesia', TEXT)}.mp3`, `tts/${old}.mp3`);
});

test('with ElevenLabs\' day spent, Cartesia\'s answer is the one reported, audio or failure', async () => {
  const ledger = recordingLedger({ refused: { 'tts:elevenlabs:': 'global' } });
  const read = await withProviders(
    { cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );
  assert.equal(read.response.status, 200);
  assert.deepEqual(new Uint8Array(await read.response.arrayBuffer()), CARTESIA_MP3);

  const down = recordingLedger({ refused: { 'tts:elevenlabs:': 'global' } });
  const failed = await withProviders(
    { cartesia: () => new Response('', { status: 500 }) },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(down, memoryBucket()))),
  );
  assert.equal(failed.response.status, 502);
  assert.equal((await failed.response.json<{ code: string }>()).code, 'AI_UNAVAILABLE');
  assert.deepEqual(down.calls.filter(call => call.period.startsWith('tts:cartesia:')).map(call => call.action), ['reserve', 'release']);
});

test('a busy ElevenLabs is reported as busy when Cartesia\'s day is spent, so the viewer retries', async () => {
  const ledger = recordingLedger({ refused: { 'tts:cartesia:': 'global' } });
  const { response, calls } = await withProviders(
    { elevenlabs: () => Response.json({ detail: { status: 'too_many_concurrent_requests' } }, { status: 429 }) },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );
  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'AI_BUSY');
  assert.deepEqual(calls.map(call => call.provider), ['elevenlabs']);
});

test('asked for timings, a paragraph returns ElevenLabs\' stored timings with its audio, never for Cartesia\'s, without calling a provider', async () => {
  const ledger = recordingLedger();
  const elevenLabsKey = await audioKey('elevenlabs', TEXT);
  const bucket = memoryBucket({
    [`${elevenLabsKey}.mp3`]: MP3,
    [`${elevenLabsKey}.json`]: new TextEncoder().encode(JSON.stringify(ALIGNMENT)),
  });
  const { response, calls } = await withProviders(
    {},
    () => signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, timings: true }), env(ledger, bucket))),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), ALIGNMENT);

  // Cartesia's audio, with ElevenLabs timings whose own audio never got stored.
  const cartesiaOnly = memoryBucket({
    [`${await audioKey('cartesia', TEXT)}.mp3`]: CARTESIA_MP3,
    [`${elevenLabsKey}.json`]: new TextEncoder().encode(JSON.stringify(ALIGNMENT)),
  });
  const missing = await withProviders(
    {},
    () => signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, timings: true }), env(ledger, cartesiaOnly))),
  );
  assert.equal(missing.response.status, 404);
  assert.equal((await missing.response.json<{ code?: string }>()).code, 'AI_TIMINGS_NOT_STORED');
  assert.equal(calls.length + missing.calls.length, 0);
  assert.equal(ledger.calls.length, 0);
});
