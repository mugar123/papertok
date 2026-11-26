import type { WorkerEnv } from './env.ts';
import type { LedgerTransaction } from './ledger-storage.ts';
import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import reportApi from './index.ts';
import { audioKey } from './read-aloud-tts.ts';
import { RequestQuotaLedger } from './request-quota-ledger.ts';

const ROUTE = 'https://papertok-report-api.example/tts/paragraph';
const ORIGIN = 'https://papertok.app';
const TEXT = 'The authors measure how well each probe separates injected prompts from benign ones.';


/** The ledger's own object over a map, with no alarm. */
function ledgerObject() {
  const values = new Map<string, unknown>();
  return new RequestQuotaLedger({
    storage: {
      transaction: <T>(fn: (txn: LedgerTransaction) => Promise<T>) => fn({
        get: <V>(key: string) => values.get(key) as V | undefined,
        put: (key, value) => values.set(key, value),
        delete: key => values.delete(key),
      }),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      deleteAll: async () => values.clear(),
    },
  });
}

/**
 * Accepts every reservation of characters, except those of a period named in `refused`, which are
 * refused with its scope, and records them in `calls`. A paragraph's turn (`tts:making:`) and the
 * count of an account's papers (`tts:paper…`) are answered by the ledger's own objects, one per
 * period, and recorded in `turns`.
 */
function recordingLedger({ accepted = true, scope = '', refused = {} }: { accepted?: boolean; scope?: string; refused?: Record<string, string> } = {}) {
  const calls: Array<{ period: string; action: string; amount: number; subjectLimit: number; globalLimit: number }> = [];
  const turns: Array<{ period: string; action: string }> = [];
  const making = new Map<string, RequestQuotaLedger>();
  return {
    calls,
    turns,
    idFromName: (period: string) => period,
    get: (period: string) => ({
      fetch: async (url: RequestInfo | URL, options?: RequestInit) => {
        const call = { period, ...JSON.parse(options!.body as string) };
        if (period.startsWith('tts:making:') || period.startsWith('tts:paper')) {
          if (period.startsWith('tts:making:')) turns.push(call);
          if (!making.has(period)) making.set(period, ledgerObject());
          return making.get(period)!.fetch(new Request(url, options));
        }
        calls.push(call);
        const refusal = Object.entries(refused).find(([name]) => period.startsWith(name))?.[1];
        const answer = refusal ? { accepted: false, scope: refusal } : { accepted, ...(scope ? { scope } : {}) };
        return new Response(JSON.stringify({ remaining: 100, ...answer }));
      },
    }),
  };
}

function memoryBucket(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map(Object.entries(initial));
  const gets: string[] = [];
  const heads: string[] = [];
  return {
    objects,
    gets,
    heads,
    get: async (key: string) => {
      gets.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const response = new Response(bytes);
      return {
        body: response.body,
        size: bytes.byteLength,
        arrayBuffer: () => {
          assert.ok(!key.endsWith('.mp3'), 'stored MP3 must be streamed');
          return response.arrayBuffer();
        },
      };
    },
    head: async (key: string) => {
      heads.push(key);
      return objects.has(key) ? { key } : null;
    },
    put: async (key: string, value: ArrayBuffer | string, options?: { onlyIf?: Headers }) => {
      if (options?.onlyIf?.get('if-none-match') === '*' && objects.has(key)) return null;
      objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
      return { key };
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

function paragraphRequest(body: unknown = { text: TEXT, paperId: 'paper-1' }, authorization: string | null = 'Bearer test-token', route = ROUTE) {
  return new Request(route, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
}

function memoryCache() {
  const entries = new Map<string, { bytes: ArrayBuffer | null; headers: Headers }>();
  const urlOf = (request: RequestInfo | URL) => String(request instanceof Request ? request.url : request);
  return {
    entries,
    match: async (request: RequestInfo | URL) => {
      const entry = entries.get(urlOf(request));
      return entry ? new Response(entry.bytes, { headers: entry.headers }) : null;
    },
    put: async (request: RequestInfo | URL, response: Response) => {
      entries.set(urlOf(request), {
        bytes: response.body ? await response.arrayBuffer() : null,
        headers: response.headers,
      });
    },
  };
}

async function signedIn<Result>(callback: () => Promise<Result>, cache = memoryCache()) {
  const original = (globalThis as TestGlobals).caches;
  const fixedLength = Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream');
  class TestFixedLengthStream extends TransformStream {
    constructor() { super(); }
  }
  Object.defineProperty(globalThis, 'FixedLengthStream', { configurable: true, value: TestFixedLengthStream });
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (request: RequestInfo | URL) => (String(request instanceof Request ? request.url : request).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : cache.match(request)),
      put: cache.put,
    },
  };
  try {
    return await callback();
  } finally {
    if (fixedLength) Object.defineProperty(globalThis, 'FixedLengthStream', fixedLength);
    else Reflect.deleteProperty(globalThis, 'FixedLengthStream');
    if (original === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = original;
  }
}

type Reply = () => Response | Promise<Response>;
type Replies = { elevenlabs?: Reply; cartesia?: Reply };

/** Answers each provider's request with its reply, and an unexpected call with a 500. */
async function withProviders<Result>(replies: Replies, callback: () => Promise<Result>) {
  const original = globalThis.fetch;
  const calls: Array<{ provider: 'elevenlabs' | 'cartesia'; url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, options) => {
    const provider = String(url).startsWith('https://api.elevenlabs.io/') ? 'elevenlabs' : 'cartesia';
    calls.push({ provider, url: String(url), headers: new Headers(options?.headers), body: JSON.parse(options!.body as string) });
    return await replies[provider]?.() ?? new Response('unexpected', { status: 500 });
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
const cartesiaOutOfCredits = () => Response.json({ error_code: 'quota_exceeded' }, { status: 402 });
/** A provider that takes a moment, so a second request arrives while the first is being answered. */
const later = (reply: () => Response): Reply => () => new Promise(resolve => { setTimeout(() => resolve(reply()), 50); });

test('a paragraph nobody has heard is read by Cartesia once, charged by its length and stored', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const outlives: Array<Promise<unknown>> = [];
  const { response, calls } = await withProviders(
    { cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket), { waitUntil: work => { outlives.push(work); } })),
  );
  // The making of the paragraph is handed to the runtime, so it ends even when its reader has left.
  assert.equal(outlives.length, 2);
  await Promise.all(outlives);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cartesia.ai/tts/bytes');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer cartesia-test-key');
  assert.equal(calls[0].body.transcript, TEXT);
  assert.deepEqual(ledger.calls.map(call => [call.action, call.amount, call.subjectLimit, call.globalLimit]), [['reserve', TEXT.length, 44_000, 258_000]]);
  assert.deepEqual(ledger.turns.map(turn => turn.action), ['reserve', 'release']);
  const key = await audioKey('cartesia', TEXT);
  assert.deepEqual(bucket.objects.get(`${key}.mp3`), CARTESIA_MP3);
  assert.equal(bucket.objects.has(`${key}.json`), false);
});

test('when Cartesia is out of credits, ElevenLabs reads the paragraph and its audio is stored with its timings', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const { response, calls } = await withProviders(
    { cartesia: cartesiaOutOfCredits, elevenlabs: elevenLabsAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket))),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MP3);
  assert.deepEqual(calls.map(call => call.provider), ['cartesia', 'elevenlabs']);
  assert.equal(calls[1].url, 'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/with-timestamps?output_format=mp3_44100_64');
  assert.equal(calls[1].headers.get('xi-api-key'), 'elevenlabs-test-key');
  assert.equal(calls[1].body.text, TEXT);
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(ledger.calls.map(call => [call.period, call.action, call.globalLimit]), [
    [`tts:cartesia:${day}`, 'reserve', 258_000],
    [`tts:cartesia:${day}`, 'release', 258_000],
    [`tts:elevenlabs:${day}`, 'reserve', 88_000],
  ]);
  const key = await audioKey('elevenlabs', TEXT);
  assert.deepEqual(bucket.objects.get(`${key}.mp3`), MP3);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bucket.objects.get(`${key}.json`))), ALIGNMENT);
});

test('each provider reads alone when the other has no key, and its failure is the one reported', async () => {
  const alone = (key: string, replies: Replies) => withProviders(
    replies,
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(recordingLedger(), memoryBucket(), { [key]: undefined }))),
  );
  const noCartesia = await alone('CARTESIA_API_KEY', { elevenlabs: elevenLabsAudio });
  assert.equal(noCartesia.response.status, 200);
  assert.deepEqual(noCartesia.calls.map(call => call.provider), ['elevenlabs']);

  const noElevenLabs = await alone('ELEVENLABS_API_KEY', { cartesia: cartesiaAudio });
  assert.equal(noElevenLabs.response.status, 200);
  assert.deepEqual(new Uint8Array(await noElevenLabs.response.arrayBuffer()), CARTESIA_MP3);
  assert.deepEqual(noElevenLabs.calls.map(call => call.provider), ['cartesia']);

  const down = await alone('ELEVENLABS_API_KEY', { cartesia: () => new Response('', { status: 500 }) });
  assert.equal(down.response.status, 502);
  assert.equal((await down.response.json<{ code: string }>()).code, 'AI_UNAVAILABLE');
  assert.deepEqual(down.calls.map(call => call.provider), ['cartesia']);
});

test('ElevenLabs is asked when Cartesia\'s day of characters is spent', async () => {
  const ledger = recordingLedger({ accepted: false, scope: 'global' });
  const spent = await withProviders(
    { elevenlabs: elevenLabsAudio, cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );
  assert.equal(spent.response.status, 429);
  assert.equal((await spent.response.json<{ quota: { scope: string } }>()).quota.scope, 'global');
  assert.equal(spent.calls.length, 0);
  assert.deepEqual(ledger.calls.map(call => call.globalLimit), [258_000, 88_000]);
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
    assert.equal(ledger.calls.length + ledger.turns.length, 0);
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
    [{ cartesia: cartesiaOutOfCredits, elevenlabs: elevenLabsOutOfCharacters }, 429, 'AI_QUOTA_EXHAUSTED'],
    [{ cartesia: () => new Response('', { status: 401 }), elevenlabs: () => Response.json({ detail: { status: 'too_many_concurrent_requests' } }, { status: 429 }) }, 429, 'AI_BUSY'],
    [{ cartesia: () => new Response('', { status: 429 }), elevenlabs: () => Response.json({ detail: { status: 'invalid_api_key' } }, { status: 401 }) }, 503, 'AI_NOT_CONFIGURED'],
  ];
  for (const [replies, status, code] of cases) {
    const ledger = recordingLedger();
    const bucket = memoryBucket();
    const outlives: Array<Promise<unknown>> = [];
    const { response, calls } = await withProviders(replies, () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket), { waitUntil: work => { outlives.push(work); } })));
    // What the runtime is handed ends without an error of its own, with the turn given back.
    await assert.doesNotReject(Promise.all(outlives));
    assert.equal(outlives.length, 1);
    assert.equal(response.status, status);
    assert.equal((await response.json<{ code: string }>()).code, code);
    assert.deepEqual(calls.map(call => call.provider), ['cartesia', 'elevenlabs']);
    assert.deepEqual(ledger.calls.map(call => call.action), ['reserve', 'release', 'reserve', 'release']);
    assert.deepEqual(ledger.turns.map(turn => turn.action), ['reserve', 'release']);
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
  assert.equal(ledger.calls.length + ledger.turns.length, 0);
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
  assert.equal(ledger.calls.length + ledger.turns.length, 0);
});

test('audio Cartesia stored before ElevenLabs was added keeps its name', async () => {
  const old = createHash('sha256').update(`sonic-3.6-2026-08-27\nf786b574-daa5-4673-aa0c-cbe3e8534c02\n64000\n${TEXT}`).digest('hex');
  assert.equal(`${await audioKey('cartesia', TEXT)}.mp3`, `tts/${old}.mp3`);
});

test('with Cartesia\'s day spent, ElevenLabs\' answer is the one reported, audio or failure', async () => {
  const ledger = recordingLedger({ refused: { 'tts:cartesia:': 'global' } });
  const read = await withProviders(
    { elevenlabs: elevenLabsAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );
  assert.equal(read.response.status, 200);
  assert.deepEqual(new Uint8Array(await read.response.arrayBuffer()), MP3);

  const down = recordingLedger({ refused: { 'tts:cartesia:': 'global' } });
  const failed = await withProviders(
    { elevenlabs: () => new Response('', { status: 500 }) },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(down, memoryBucket()))),
  );
  assert.equal(failed.response.status, 502);
  assert.equal((await failed.response.json<{ code: string }>()).code, 'AI_UNAVAILABLE');
  assert.deepEqual(down.calls.filter(call => call.period.startsWith('tts:elevenlabs:')).map(call => call.action), ['reserve', 'release']);
});

test('a busy Cartesia is reported as busy when ElevenLabs\' day is spent, so the viewer retries', async () => {
  const ledger = recordingLedger({ refused: { 'tts:elevenlabs:': 'global' } });
  const { response, calls } = await withProviders(
    { cartesia: () => new Response('', { status: 429 }) },
    () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, memoryBucket()))),
  );
  assert.equal(response.status, 429);
  assert.equal((await response.json<{ code: string }>()).code, 'AI_BUSY');
  assert.deepEqual(calls.map(call => call.provider), ['cartesia']);
});

test('asked for timings, a paragraph returns ElevenLabs\' stored timings only when its audio is the one served, without calling a provider', async () => {
  const ledger = recordingLedger();
  const elevenLabsKey = await audioKey('elevenlabs', TEXT);
  const cartesiaKey = await audioKey('cartesia', TEXT);
  const timings = new TextEncoder().encode(JSON.stringify(ALIGNMENT));
  const timingsOf = (bucket: ReturnType<typeof memoryBucket>) => withProviders(
    {},
    () => signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, timings: true }), env(ledger, bucket))),
  );

  const { response, calls } = await timingsOf(memoryBucket({ [`${elevenLabsKey}.mp3`]: MP3, [`${elevenLabsKey}.json`]: timings }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), ALIGNMENT);

  // Cartesia's audio is served: alone, or ahead of ElevenLabs' audio of the same paragraph.
  const cartesiaOnly = await timingsOf(memoryBucket({ [`${cartesiaKey}.mp3`]: CARTESIA_MP3, [`${elevenLabsKey}.json`]: timings }));
  const both = await timingsOf(memoryBucket({ [`${cartesiaKey}.mp3`]: CARTESIA_MP3, [`${elevenLabsKey}.mp3`]: MP3, [`${elevenLabsKey}.json`]: timings }));
  for (const missing of [cartesiaOnly, both]) {
    assert.equal(missing.response.status, 404);
    assert.equal((await missing.response.json<{ code?: string }>()).code, 'AI_TIMINGS_NOT_STORED');
  }
  assert.equal(calls.length + cartesiaOnly.calls.length + both.calls.length, 0);
  assert.equal(ledger.calls.length + ledger.turns.length, 0);
});

test('stored audio streams in provider order and warms the edge cache', async () => {
  const cartesiaKey = await audioKey('cartesia', TEXT);
  const elevenLabsKey = await audioKey('elevenlabs', TEXT);
  const bucket = memoryBucket({
    [`${elevenLabsKey}.mp3`]: MP3,
    [`${elevenLabsKey}.json`]: new TextEncoder().encode(JSON.stringify(ALIGNMENT)),
  });
  const worker = env(recordingLedger(), bucket);
  const edge = memoryCache();
  const background: Promise<unknown>[] = [];
  const request = () => reportApi.fetch(paragraphRequest({ text: TEXT, storedOnly: true }), worker, {
    waitUntil: work => { background.push(work); },
  });
  const timings = () => reportApi.fetch(paragraphRequest({ text: TEXT, timings: true }), worker);

  await signedIn(async () => {
    const fallback = await request();
    assert.equal(fallback.headers.get('x-tts-audio'), elevenLabsKey);
    assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), MP3);
    assert.deepEqual(bucket.gets.splice(0), [`${cartesiaKey}.mp3`, `${elevenLabsKey}.mp3`]);
    await Promise.all(background);
    assert.deepEqual(await (await timings()).json(), ALIGNMENT);

    bucket.gets.length = 0;
    bucket.objects.set(`${cartesiaKey}.mp3`, CARTESIA_MP3);
    const primary = await request();
    assert.equal(primary.headers.get('x-tts-audio'), cartesiaKey);
    assert.equal(primary.headers.get('content-length'), String(CARTESIA_MP3.byteLength));
    assert.equal(primary.headers.get('cache-control'), 'private, no-store');
    assert.equal(primary.headers.get('access-control-expose-headers'), 'retry-after, x-tts-audio');
    assert.deepEqual(new Uint8Array(await primary.arrayBuffer()), CARTESIA_MP3);
    assert.deepEqual(bucket.gets.splice(0), [`${cartesiaKey}.mp3`]);
    await Promise.all(background);
    assert.deepEqual([...edge.entries.values()].map(entry => entry.headers.get('cache-control')), [
      'public, max-age=31536000, immutable', 'public, max-age=31536000, immutable',
    ]);

    bucket.heads.length = 0;
    const cached = await request();
    assert.equal(cached.headers.get('x-tts-audio'), cartesiaKey);
    assert.equal(cached.headers.get('content-length'), String(CARTESIA_MP3.byteLength));
    assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), CARTESIA_MP3);
    assert.deepEqual(bucket.gets, []);
    assert.deepEqual(bucket.heads, []);
    const absent = await timings();
    assert.equal(absent.status, 404);
    assert.equal((await absent.json<{ code: string }>()).code, 'AI_TIMINGS_NOT_STORED');
  }, edge);
});

test('fresh audio is cached after it is stored', async () => {
  const bucket = memoryBucket();
  const worker = env(recordingLedger(), bucket);
  const background: Promise<unknown>[] = [];
  const { calls } = await withProviders({ cartesia: cartesiaAudio }, () => signedIn(async () => {
    const response = await reportApi.fetch(paragraphRequest(), worker, { waitUntil: work => { background.push(work); } });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3);
    await Promise.all(background);
    bucket.gets.length = 0;
    const cached = await reportApi.fetch(paragraphRequest({ text: TEXT, storedOnly: true }), worker);
    assert.equal(cached.headers.get('x-tts-audio'), response.headers.get('x-tts-audio'));
    assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), CARTESIA_MP3);
    assert.deepEqual(bucket.gets, []);
  }));
  assert.equal(calls.length, 1);
});

test('a late synthesis serves the first stored bytes and leaves their timings intact', async () => {
  const key = await audioKey('elevenlabs', TEXT);
  const winningTimings = { ...ALIGNMENT, character_end_times_seconds: [0.06, 0.11, 0.16] };
  const bucket = memoryBucket();
  const worker = env(recordingLedger(), bucket, { CARTESIA_API_KEY: undefined });
  const { calls } = await withProviders({ elevenlabs: () => {
    bucket.objects.set(`${key}.mp3`, CARTESIA_MP3);
    bucket.objects.set(`${key}.json`, new TextEncoder().encode(JSON.stringify(winningTimings)));
    return elevenLabsAudio();
  } }, () => signedIn(async () => {
    const response = await reportApi.fetch(paragraphRequest(), worker);
    assert.equal(response.headers.get('x-tts-audio'), key);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3);
    const timings = await reportApi.fetch(paragraphRequest({ text: TEXT, timings: true }), worker);
    assert.deepEqual(await timings.json(), winningTimings);
  }));
  assert.equal(calls.length, 1);
});

for (const [behaviour, conditionalPut] of [
  ['rejects', async () => { throw new Error('onlyIf not supported'); }],
  ['answers null for a new object', async () => null],
] as const) {
  test(`when R2 ${behaviour} on the create-only write, the paid clip is still stored and not paid for again`, async () => {
    const key = await audioKey('cartesia', TEXT);
    const bucket = memoryBucket();
    const put = bucket.put;
    bucket.put = async (name: string, value: ArrayBuffer | string, options?: { onlyIf?: Headers }) => (options?.onlyIf
      ? conditionalPut()
      : put(name, value, options));
    const worker = env(recordingLedger(), bucket);
    const { calls } = await withProviders({ cartesia: cartesiaAudio }, () => signedIn(async () => {
      const response = await reportApi.fetch(paragraphRequest(), worker);
      assert.equal(response.headers.get('x-tts-audio'), key);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3);
      assert.deepEqual(bucket.objects.get(`${key}.mp3`), CARTESIA_MP3);
      const again = await reportApi.fetch(paragraphRequest({ text: TEXT, storedOnly: true }), worker);
      assert.equal(again.status, 200);
      assert.deepEqual(new Uint8Array(await again.arrayBuffer()), CARTESIA_MP3);
    }));
    assert.equal(calls.length, 1);
  });
}

test('a clip stored while waiting for the turn is served without a provider or the paper being counted', async () => {
  const key = await audioKey('cartesia', TEXT);
  const bucket = memoryBucket();
  const ledger = recordingLedger();
  const turnFor = ledger.get;
  ledger.get = (period: string) => {
    const stub = turnFor(period);
    return {
      fetch: async (url: RequestInfo | URL, options?: RequestInit) => {
        // Another request finishes the paragraph just as this one takes the turn.
        if (period.startsWith('tts:making:') && JSON.parse(options!.body as string).action === 'reserve') bucket.objects.set(`${key}.mp3`, CARTESIA_MP3);
        return stub.fetch(url, options);
      },
    };
  };
  const { response, calls } = await withProviders({ cartesia: cartesiaAudio }, () => signedIn(() => reportApi.fetch(paragraphRequest(), env(ledger, bucket))));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-tts-audio'), key);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3);
  assert.equal(calls.length, 0);
  assert.deepEqual(ledger.calls, []);
});

test('a clip the bucket reports but cannot read is answered as unavailable, without a provider', async () => {
  const key = await audioKey('cartesia', TEXT);
  const bucket = memoryBucket();
  bucket.head = async (name: string) => { bucket.heads.push(name); return name === `${key}.mp3` ? { key: name } : null; };
  const { response, calls } = await withProviders({ cartesia: cartesiaAudio }, () => signedIn(() => reportApi.fetch(paragraphRequest(), env(recordingLedger(), bucket))));
  assert.equal(response.status, 502);
  assert.equal(calls.length, 0);
});

test('a cached clip without a usable length is skipped for the copy in R2', async () => {
  const key = await audioKey('cartesia', TEXT);
  const bucket = memoryBucket();
  bucket.objects.set(`${key}.mp3`, CARTESIA_MP3);
  const worker = env(recordingLedger(), bucket);
  for (const length of ['', 'abc', '0']) {
    const edge = memoryCache();
    edge.entries.set(`https://papertok.internal/cache/read-aloud/${key}`, { bytes: new Uint8Array([1, 2]).buffer, headers: new Headers({ 'content-length': length }) });
    const response = await signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, storedOnly: true }), worker), edge);
    assert.equal(response.status, 200, length);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3, length);
  }
});

test('two requests for the same new paragraph call the provider once, and both get its audio', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const worker = env(ledger, bucket);
  const { response: responses, calls } = await withProviders(
    { cartesia: later(cartesiaAudio) },
    () => signedIn(() => Promise.all([reportApi.fetch(paragraphRequest(), worker), reportApi.fetch(paragraphRequest(), worker)])),
  );

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), CARTESIA_MP3);
  }
  assert.equal(calls.length, 1);
  // Only the request making the paragraph checks with HEADs, once; the waiting one polls with GETs.
  assert.deepEqual(bucket.heads, [`${await audioKey('cartesia', TEXT)}.mp3`, `${await audioKey('elevenlabs', TEXT)}.mp3`]);
  assert.deepEqual(ledger.calls.map(call => [call.action, call.amount]), [['reserve', TEXT.length]]);
});

test('when the request making a paragraph fails, a request waiting for it makes it', async () => {
  const ledger = recordingLedger();
  const bucket = memoryBucket();
  const worker = env(ledger, bucket, { ELEVENLABS_API_KEY: undefined });
  const replies = [later(() => new Response('', { status: 500 })), cartesiaAudio];
  const { response: responses, calls } = await withProviders(
    { cartesia: () => replies.shift()!() },
    () => signedIn(() => Promise.all([reportApi.fetch(paragraphRequest(), worker), reportApi.fetch(paragraphRequest(), worker)])),
  );

  assert.deepEqual(responses.map(response => response.status).sort(), [200, 502]);
  assert.equal(calls.length, 2);
  const keys = [`${await audioKey('cartesia', TEXT)}.mp3`, `${await audioKey('elevenlabs', TEXT)}.mp3`];
  // Each request that took the turn checked once with HEADs; waiting never does.
  assert.deepEqual(bucket.heads, [...keys, ...keys]);
  assert.ok(bucket.gets.length > 0 && bucket.gets.every(key => keys.includes(key)));
  assert.deepEqual(ledger.calls.map(call => call.action), ['reserve', 'release', 'reserve']);
});

const PAPERS_ROUTE = 'https://papertok-report-api.example/tts/papers';
const papersRequest = (body: unknown, authorization: string | null = 'Bearer test-token') => paragraphRequest(body, authorization, PAPERS_ROUTE);

test('paper marks cache misses and hits, and writing a mark supersedes a cached miss', async () => {
  const key = await audioKey('cartesia', TEXT);
  const bucket = memoryBucket({ [`${key}.mp3`]: CARTESIA_MP3 });
  const worker = env(recordingLedger(), bucket);
  const edge = memoryCache();
  const ask = async (body: unknown) => (await reportApi.fetch(papersRequest(body), worker)).json();
  await signedIn(async () => {
    assert.deepEqual(await ask({ papers: ['paper-a'] }), { voiced: [] });
    assert.equal(bucket.heads.length, 1);
    assert.deepEqual(await ask({ papers: ['paper-a'] }), { voiced: [] });
    assert.deepEqual(await ask({ usage: true, paperId: 'paper-a' }), { papersLeft: 2, dailyPapers: 2, paperOpen: false });
    assert.equal(bucket.heads.length, 1);
    assert.equal([...edge.entries.values()][0]?.headers.get('cache-control'), 'public, max-age=300');

    assert.deepEqual(await ask({ paperId: 'paper-a', voiced: true, audio: [key] }), { voiced: true });
    bucket.heads.length = 0;
    assert.deepEqual(await ask({ papers: ['paper-a'] }), { voiced: ['paper-a'] });
    assert.deepEqual(await ask({ usage: true, paperId: 'paper-a' }), { papersLeft: 2, dailyPapers: 2, paperOpen: true });
    assert.deepEqual(bucket.heads, []);
    assert.equal([...edge.entries.values()][1]?.headers.get('cache-control'), 'public, max-age=86400');
  }, edge);
});

test('an account\'s new papers are counted once each, a third is refused, and stored audio stays free', async () => {
  const environment = env(recordingLedger(), memoryBucket(), { TTS_DAILY_USER_PAPERS: '2' });
  const ask = (text: string, paperId: string) => withProviders(
    { cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest({ text, paperId }), environment)),
  );
  const usage = async () => (await signedIn(() => reportApi.fetch(papersRequest({ usage: true }), environment))).json<{ papersLeft: number; dailyPapers: number }>();

  assert.deepEqual(await usage(), { papersLeft: 2, dailyPapers: 2 });
  assert.equal((await ask(`${TEXT} One.`, 'paper-a')).response.status, 200);
  assert.equal((await ask(`${TEXT} Two.`, 'paper-a')).response.status, 200, 'a second paragraph of the same paper is not a second paper');
  assert.equal((await usage()).papersLeft, 1);
  assert.equal((await ask(`${TEXT} Three.`, 'paper-b')).response.status, 200);

  const refused = await ask(`${TEXT} Four.`, 'paper-c');
  assert.equal(refused.response.status, 429);
  assert.equal(refused.calls.length, 0, 'no provider is called for a paper past the day\'s');
  const body = await refused.response.json<{ code: string; quota: { scope: string } }>();
  assert.equal(body.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(body.quota.scope, 'user');
  assert.equal((await usage()).papersLeft, 0);

  const stored = await ask(`${TEXT} One.`, 'paper-c');
  assert.equal(stored.response.status, 200, 'audio already made is served to a paper past the day\'s');
  assert.equal(stored.calls.length, 0);
  assert.equal((await ask(`${TEXT} Five.`, 'paper-a')).response.status, 200, 'a paper counted today keeps its new audio');

  const usageFor = async (paperId: string) => (await signedIn(() => reportApi.fetch(papersRequest({ usage: true, paperId }), environment))).json<{ papersLeft: number; paperOpen: boolean }>();
  assert.deepEqual(await usageFor('paper-a'), { papersLeft: 0, dailyPapers: 2, paperOpen: true }, 'a paper counted today stays open');
  assert.equal((await usageFor('paper-c')).paperOpen, false, 'a paper not counted today and not voiced is closed past the day\'s');
});

test('a paper whose first new paragraph fails at both providers is given back', async () => {
  const environment = env(recordingLedger(), memoryBucket(), { TTS_DAILY_USER_PAPERS: '1' });
  const failed = await withProviders(
    { cartesia: () => new Response('down', { status: 503 }), elevenlabs: () => new Response('down', { status: 503 }) },
    () => signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, paperId: 'paper-a' }), environment)),
  );
  assert.equal(failed.response.status, 502);
  const usage = await signedIn(() => reportApi.fetch(papersRequest({ usage: true }), environment));
  assert.equal((await usage.json<{ papersLeft: number }>()).papersLeft, 1, 'nothing was spent');
  const retried = await withProviders(
    { cartesia: cartesiaAudio },
    () => signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT, paperId: 'paper-b' }), environment)),
  );
  assert.equal(retried.response.status, 200, 'the day\'s paper is still there for another');
});

test('new audio needs the paper it is for, and an account with unlimited AI is not counted', async () => {
  const environment = env(recordingLedger(), memoryBucket(), { TTS_DAILY_USER_PAPERS: '1' });
  const without = await withProviders({ cartesia: cartesiaAudio }, () => signedIn(() => reportApi.fetch(paragraphRequest({ text: TEXT }), environment)));
  assert.equal(without.response.status, 400);
  assert.equal(without.calls.length, 0);

  const unlimited = env(recordingLedger(), memoryBucket(), { TTS_DAILY_USER_PAPERS: '1', AI_UNLIMITED_EMAILS: 'reader@example.com' });
  const asUnlimited = <Result>(callback: () => Promise<Result>) => {
    const original = (globalThis as TestGlobals).caches;
    (globalThis as TestGlobals).caches = {
      default: {
        match: async () => new Response(JSON.stringify({ uid: 'user-2', email: 'reader@example.com', emailVerified: true }), { headers: { 'content-type': 'application/json' } }),
        put: async () => undefined,
      },
    };
    return callback().finally(() => { (globalThis as TestGlobals).caches = original; });
  };
  for (const paperId of ['paper-a', 'paper-b']) {
    const made = await withProviders({ cartesia: cartesiaAudio }, () => asUnlimited(() => reportApi.fetch(paragraphRequest({ text: `${TEXT} ${paperId}`, paperId }), unlimited)));
    assert.equal(made.response.status, 200, `${paperId} is read`);
  }
  assert.deepEqual(await (await asUnlimited(() => reportApi.fetch(papersRequest({ usage: true }), unlimited))).json(), { unlimited: true });
});

test('a paper is marked voiced only when every audio the viewer names is stored, and a feed learns which are', async () => {
  const bucket = memoryBucket();
  const environment = env(recordingLedger(), bucket);
  const ask = async (body: unknown) => (await signedIn(() => reportApi.fetch(papersRequest(body), environment))).json<{ voiced: unknown }>();
  const { response } = await withProviders({ cartesia: cartesiaAudio }, () => signedIn(() => reportApi.fetch(paragraphRequest(), environment)));
  const key = response.headers.get('x-tts-audio')!;
  assert.match(key, /^tts\/[0-9a-f]{64}$/);
  assert.match(response.headers.get('access-control-expose-headers')!, /x-tts-audio/);
  const missing = await audioKey('cartesia', 'A paragraph nobody made.');

  assert.deepEqual(await ask({ paperId: 'paper-a', voiced: true, audio: [key, missing] }), { voiced: false }, 'one paragraph without audio');
  assert.deepEqual(await ask({ papers: ['paper-a'] }), { voiced: [] });
  assert.deepEqual(await ask({ paperId: 'paper-a', voiced: true, audio: [key] }), { voiced: true });
  assert.deepEqual(await ask({ papers: ['paper-a', 'paper-b', 7, 'paper-a'] }), { voiced: ['paper-a'] });
  const invalid = await signedIn(() => reportApi.fetch(papersRequest({ paperId: 'paper-b', voiced: true, audio: ['../secret'] }), environment));
  assert.equal(invalid.status, 400);
  const unsigned = await reportApi.fetch(papersRequest({ papers: ['paper-a'] }, null), environment);
  assert.equal(unsigned.status, 401);
});
