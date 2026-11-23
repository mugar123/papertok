import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import worker from './index.ts';
import type { WorkerEnv } from './env.ts';
import type { TestGlobals, TestNamespace } from './test-types.ts';
import type { LedgerTransaction } from './ledger-storage.ts';
import { RequestQuotaLedger } from './request-quota-ledger.ts';

const TRANSLATION_URL = 'https://api.papertok.app/ai/translate';
const tokenFor = (uid: string) => `e30.${Buffer.from(JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString('base64url')}.fixture`;
const TOKEN = tokenFor('reader-1');
const OTHER_TOKEN = tokenFor('reader-2');
const cachedIdentityUrl = `https://papertok.internal/auth/${createHash('sha256').update(TOKEN).digest('hex')}`;
const INPUT = {
  arxivId: '2611.00829',
  language: 'ja',
  title: 'An estimate of stellar distances',
  abstract: 'We measure stellar distances using two independent methods.',
};
const ANSWER = { title: '恒星までの距離の推定', abstract: '2つの独立した方法で恒星までの距離を測定する。', sourceLanguage: 'EN' };
const ARXIV_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/abs/${INPUT.arxivId}v1</id>
  <title>${INPUT.title}</title>
  <summary>${INPUT.abstract}</summary>
  <published>2026-11-01T12:00:00Z</published>
  <category term="astro-ph.GA"/>
</entry></feed>`;

function request(body: unknown = INPUT, { method = 'POST', origin = 'https://papertok.app', token = TOKEN } = {}) {
  return new Request(TRANSLATION_URL, {
    method,
    headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

function setUp(t: TestContext, ledgerReply = { accepted: true, remaining: 9 }) {
  const calls: Array<{
    model: string;
    max_tokens: number;
    thinking?: { type: string };
    output_config: { effort: string };
    system: string;
    messages: Array<{ content: string }>;
  }> = [];
  const quotas: Array<{ action: string; subjectLimit: number; globalLimit: number; globalAmount?: number; partKey?: string; partLimit?: number }> = [];
  const days: string[] = [];
  const providerUrls: string[] = [];
  const ledger: { reply(action: string): Response | Promise<Response> } = { reply: () => Response.json(ledgerReply) };
  const namespace: TestNamespace = {
    idFromName: day => { days.push(day); return 'ledger'; },
    get: () => ({
      fetch: async (_url: RequestInfo | URL, init: RequestInit) => {
        const quota = JSON.parse(String(init.body)) as typeof quotas[number];
        quotas.push(quota);
        return ledger.reply(quota.action);
      },
    }),
  };
  const env: WorkerEnv = {
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-test-key',
    ANTHROPIC_TRANSLATION_MODEL: 'claude-haiku-5-5',
    FIREBASE_WEB_API_KEY: 'test-firebase-key',
    REQUEST_QUOTA_LEDGER: namespace as WorkerEnv['REQUEST_QUOTA_LEDGER'],
  };
  const globals = globalThis as TestGlobals;
  const caches = globals.caches;
  const arxiv = { beforeRead: async () => {} };
  const arxivRequests: string[] = [];
  const source = { url: 'https://arxiv.org/html/1706.03762', renderer: 'arxiv' };
  globals.caches = {
    default: {
      match: async key => {
        if (!(key instanceof Request)) return null;
        if (key.url === cachedIdentityUrl) return Response.json({ uid: 'reader-1' });
        const url = new URL(key.url);
        if (url.pathname === '/cache/arxiv' && url.searchParams.get('id_list') === INPUT.arxivId) {
          await arxiv.beforeRead();
          return new Response(ARXIV_ATOM, { headers: { 'content-type': 'application/atom+xml' } });
        }
        if (url.pathname === '/cache/resources/full-text') {
          arxivRequests.push(url.search);
          return Response.json({
            source: source.renderer, format: 'latexml', url: source.url,
            document: '<html><body><article class="ltx_document"><div class="ltx_abstract"><p>We study sequence models.</p></div>'
              + '<section id="s1"><h2 class="ltx_title">Results</h2><p class="ltx_p">Accuracy increased &amp; held.</p></section>'
              + '</article></body></html>',
          });
        }
        return null;
      },
      put: async () => undefined,
    },
  };
  t.after(() => {
    if (caches) globals.caches = caches;
    else delete globals.caches;
  });
  const provider: { reply(signal?: AbortSignal | null): Response | Promise<Response> } = {
    reply: () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(ANSWER) }] }),
  };
  const identity = { revoked: false, lookups: 0 };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit) => {
    if (new URL(String(input)).hostname === 'identitytoolkit.googleapis.com') {
      identity.lookups++;
      const { idToken } = JSON.parse(String(init.body)) as { idToken: string };
      if (idToken === OTHER_TOKEN) return Response.json({ users: [{ localId: 'reader-2' }] });
      if (idToken === TOKEN && !identity.revoked) return Response.json({ users: [{ localId: 'reader-1' }] });
      return Response.json({ error: { message: 'INVALID_ID_TOKEN' } }, { status: 400 });
    }
    providerUrls.push(String(input));
    calls.push(JSON.parse(String(init.body)));
    return provider.reply(init.signal);
  });
  return { env, calls, quotas, days, provider, providerUrls, identity, arxiv, ledger, source, arxivRequests };
}

function translationTimers(t: TestContext) {
  const timers = new Map<number, AbortController>();
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    if (ms !== 20_000 && ms !== 24_000) return original(ms);
    const timer = new AbortController();
    timers.set(ms, timer);
    return timer.signal;
  });
  return timers;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('finishes arXiv verification before the quota and provider timer starts', async t => {
  const { env, calls, quotas, arxiv } = setUp(t);
  const timers = translationTimers(t);
  const reading = deferred<void>();
  const metadata = deferred<void>();
  arxiv.beforeRead = () => {
    reading.resolve();
    return metadata.promise;
  };
  const response = worker.fetch(request(), env);
  await reading.promise;
  assert.deepEqual([...timers.keys()], [24_000]);
  assert.equal(quotas.length, 0);
  metadata.resolve();
  assert.equal((await response).status, 200);
  assert.ok(timers.has(20_000));
  assert.equal(calls.length, 1);
});

test('returns a timeout for a slow arXiv check without charging or calling Claude', async t => {
  const { env, calls, quotas, arxiv } = setUp(t);
  const timers = translationTimers(t);
  const reading = deferred<void>();
  const metadata = deferred<void>();
  arxiv.beforeRead = () => {
    reading.resolve();
    return metadata.promise;
  };
  const response = worker.fetch(request(), env);
  await reading.promise;
  timers.get(24_000)?.abort();
  const timedOut = await response;
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { code: 'AI_TIMEOUT' });
  metadata.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.has(20_000), false);
  assert.equal(quotas.length, 0);
  assert.equal(calls.length, 0);
});

test('returns before the browser deadline and refunds a late reservation without calling Claude', async t => {
  const { env, calls, quotas, ledger } = setUp(t);
  const timers = translationTimers(t);
  const reserving = deferred<void>();
  const reservation = deferred<Response>();
  ledger.reply = action => {
    if (action === 'release') return Response.json({ remaining: 10 });
    reserving.resolve();
    return reservation.promise;
  };
  const pending: Promise<unknown>[] = [];
  const response = worker.fetch(request(), env, { waitUntil: work => { pending.push(work); } });
  await reserving.promise;
  assert.ok(timers.has(20_000));
  timers.get(24_000)?.abort();
  const timedOut = await response;
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { code: 'AI_TIMEOUT' });
  assert.equal(pending.length, 1);
  reservation.resolve(Response.json({ accepted: true, remaining: 9 }));
  await Promise.all(pending);
  assert.equal(calls.length, 0);
  assert.deepEqual(quotas.map(({ action, globalAmount, partLimit }) => [action, globalAmount, partLimit]), [
    ['reserve', undefined, 20], ['release', undefined, 20],
  ]);
});

test('aborts the Claude request on its own deadline and keeps both attempts', async t => {
  const { env, calls, quotas, provider } = setUp(t);
  const timers = translationTimers(t);
  const sending = deferred<AbortSignal | null | undefined>();
  provider.reply = signal => new Promise((_resolve, reject) => {
    sending.resolve(signal);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const pending: Promise<unknown>[] = [];
  const response = worker.fetch(request(), env, { waitUntil: work => { pending.push(work); } });
  const signal = await sending.promise;
  assert.ok(signal);
  timers.get(20_000)?.abort();
  const timedOut = await response;
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { code: 'AI_TIMEOUT' });
  assert.equal(signal.aborted, true);
  assert.equal(timers.get(24_000)?.signal.aborted, false);
  await Promise.all(pending);
  assert.equal(calls.length, 1);
  assert.deepEqual(quotas.map(({ action, globalAmount, partLimit }) => [action, globalAmount, partLimit]), [
    ['reserve', undefined, 20], ['release', 0, undefined],
  ]);
});

test('revoked credentials cannot spend even while the identity cache still has them', async t => {
  const { env, calls, quotas, identity } = setUp(t);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  identity.revoked = true;
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { code: 'AI_AUTH_REQUIRED' });
  assert.equal(identity.lookups, 2);
  assert.equal(calls.length, 1);
  assert.equal(quotas.length, 1);
});

test('translates the title and abstract in one private call with a separate quota', async t => {
  const { env, calls, quotas, days, providerUrls } = setUp(t);
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://papertok.app');
  assert.deepEqual(await response.json(), { ...ANSWER, sourceLanguage: 'en', language: 'ja' });
  assert.match(days[0], /^translate:\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(quotas.map(({ action, subjectLimit, globalLimit }) => ({ action, subjectLimit, globalLimit })), [
    { action: 'reserve', subjectLimit: 10, globalLimit: 100 },
  ]);
  assert.equal(calls.length, 1);
  assert.match(providerUrls[0], /^https:\/\/api\.anthropic\.com\/v1\/messages(?:\?|$)/);
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.equal(calls[0].max_tokens, 10_000);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.equal(calls[0].output_config.effort, 'low');
  assert.match(calls[0].system, /into Japanese/);
  assert.deepEqual(JSON.parse(calls[0].messages[0].content), { title: INPUT.title, abstract: INPUT.abstract });
  assert.equal('fallbacks' in calls[0], false);
});

test('rejects invalid requests and disabled translation before spending', async t => {
  const { env, calls, quotas } = setUp(t);
  for (const [input, status, code] of [
    [request(INPUT, { token: '' }), 401, 'AI_AUTH_REQUIRED'],
    [request(INPUT, { token: 'invalid-token' }), 401, 'AI_AUTH_REQUIRED'],
    [request(INPUT, { origin: 'https://untrusted.example' }), 403, undefined],
    [request(INPUT, { method: 'GET' }), 405, undefined],
    [request({ ...INPUT, language: 'constructor' }), 400, 'AI_INVALID_REQUEST'],
    [request({ ...INPUT, arxivId: 'https://arxiv.org/abs/2611.00829' }), 400, 'AI_INVALID_REQUEST'],
    [request({ ...INPUT, abstract: 'Too short.' }), 400, 'AI_INVALID_REQUEST'],
    [request({ ...INPUT, abstract: 'An abstract attached to this record by another provider.' }), 400, 'AI_INVALID_PAPER'],
    [request({ ...INPUT, title: 'x'.repeat(501) }), 400, 'AI_INVALID_REQUEST'],
    [request({ ...INPUT, padding: 'x'.repeat(10_000) }), 413, 'AI_REQUEST_TOO_LARGE'],
  ] as const) {
    const response = await worker.fetch(input, env);
    assert.equal(response.status, status);
    if (code) assert.equal((await response.json<{ code: string }>()).code, code);
  }
  for (const overrides of [{ AI_PROVIDER: 'gemini' }, { ANTHROPIC_TRANSLATION_MODEL: '' }, { ANTHROPIC_API_KEY: '' }]) {
    const response = await worker.fetch(request(), { ...env, ...overrides });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'AI_NOT_CONFIGURED' });
  }
  assert.equal(calls.length, 0);
  assert.equal(quotas.length, 0);
});

test('quota exhaustion stops the provider call', async t => {
  const { env, calls } = setUp(t, { accepted: false, remaining: 0 });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 429);
  const payload = await response.json<{ code: string; quota: { scope: string } }>();
  assert.equal(payload.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(payload.quota.scope, 'global');
  assert.equal(calls.length, 0);
});

test('accepts the five added languages as both targets and reported sources', async t => {
  const { env, calls, provider } = setUp(t);
  const languages = [
    ['zh-Hant', 'Chinese (Traditional)'],
    ['ca', 'Catalan'],
    ['he', 'Hebrew'],
    ['gl', 'Galician'],
    ['eu', 'Basque'],
  ] as const;
  for (const [index, [language, name]] of languages.entries()) {
    provider.reply = () => Response.json({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ ...ANSWER, sourceLanguage: language.toUpperCase() }) }],
    });
    const response = await worker.fetch(request({ ...INPUT, language }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...ANSWER, sourceLanguage: language, language });
    assert.ok(calls[index].system.includes(`into ${name}.`));
  }
});

test('omits an unknown or unsupported source language without discarding the translation', async t => {
  const { env, provider } = setUp(t);
  for (const sourceLanguage of [null, 'sv', 'constructor']) {
    provider.reply = () => Response.json({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ ...ANSWER, sourceLanguage }) }],
    });
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { title: ANSWER.title, abstract: ANSWER.abstract, language: 'ja' });
  }
});

test('refunds a provider outage to the reader while retaining the global attempt', async t => {
  const { env, provider, quotas } = setUp(t);
  provider.reply = () => Response.json({ error: { type: 'overloaded_error', message: 'busy' } }, { status: 529 });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json<{ code: string }>()).code, 'AI_BUSY');
  assert.deepEqual(quotas.map(({ action, globalAmount }) => [action, globalAmount]), [['reserve', undefined], ['release', 0]]);
  assert.equal(quotas[0].partLimit, 20);
  assert.ok(quotas[0].partKey);
  assert.equal(quotas[1].partKey, undefined);
});

test('one account can spend only its attempt allowance during a provider outage', async t => {
  const { env, provider, calls } = setUp(t);
  const values = new Map<string, unknown>();
  const storage = {
    transaction: <T>(fn: (txn: LedgerTransaction) => Promise<T>) => fn({
      get: <V>(key: string) => values.get(key) as V | undefined,
      put: (key, value) => values.set(key, value),
      delete: key => values.delete(key),
    }),
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAll: async () => values.clear(),
  };
  const ledger = new RequestQuotaLedger({ storage });
  const namespace: TestNamespace = {
    idFromName: day => day,
    get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => ledger.fetch(new Request(input, init)) }),
  };
  env.REQUEST_QUOTA_LEDGER = namespace as WorkerEnv['REQUEST_QUOTA_LEDGER'];
  provider.reply = () => Response.json({ error: { type: 'overloaded_error', message: 'busy' } }, { status: 529 });
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal((await worker.fetch(request(), env)).status, 502);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 429);
    const payload = await response.json<{ code: string; quota: { scope: string } }>();
    assert.equal(payload.code, 'AI_QUOTA_EXHAUSTED');
    assert.equal(payload.quota.scope, 'part');
  }
  assert.equal(calls.length, 20);
  assert.equal((await worker.fetch(request(INPUT, { token: OTHER_TOKEN }), env)).status, 502);
  assert.equal(calls.length, 21);
});

test('a refusal, truncated response or malformed answer cannot become a translation', async t => {
  const { env, provider, quotas } = setUp(t);
  for (const [stop_reason, text, code] of [
    ['refusal', JSON.stringify(ANSWER), 'AI_EMPTY_RESPONSE'],
    ['max_tokens', JSON.stringify(ANSWER), 'AI_INVALID_RESPONSE'],
    ['end_turn', '{"title":"Missing abstract"}', 'AI_INVALID_RESPONSE'],
    ['end_turn', JSON.stringify({ ...ANSWER, title: 'x'.repeat(1_501) }), 'AI_INVALID_RESPONSE'],
    ['end_turn', JSON.stringify({ ...ANSWER, abstract: 'x'.repeat(9_001) }), 'AI_INVALID_RESPONSE'],
  ]) {
    provider.reply = () => Response.json({ stop_reason, content: [{ type: 'text', text }] });
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code });
  }
  assert.deepEqual(quotas.map(({ action }) => action), [
    'reserve', 'release', 'reserve', 'release', 'reserve', 'release', 'reserve', 'release', 'reserve', 'release',
  ]);
  for (const refund of quotas.filter(quota => quota.action === 'release')) {
    assert.equal(refund.globalAmount, 0);
    assert.equal(refund.partKey, undefined);
  }
});

const FULL_INPUT = {
  query: 'arxiv_id=1706.03762',
  language: 'es',
  fingerprint: createHash('sha256').update(JSON.stringify([
    ['We study sequence models.'], ['Results', 'Accuracy increased & held.'],
  ])).digest('hex'),
};

function enableFullPaper(env: WorkerEnv) {
  env.FULL_PAPER_TRANSLATION_ENABLED = 'true';
}

function fullRequest(body: unknown = FULL_INPUT, token = TOKEN) {
  return new Request('https://api.papertok.app/ai/translate-paper', {
    method: 'POST',
    headers: { origin: 'https://papertok.app', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function translatedSegments(segments: string[]) {
  return Response.json({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ segments }) }],
  });
}

test('approved full text spends one atomic slot before sending any approved chunk', async t => {
  const { env, calls, quotas, provider, days, arxivRequests } = setUp(t);
  enableFullPaper(env);
  provider.reply = () => {
    assert.equal(quotas.length, 1);
    assert.deepEqual([quotas[0].subjectLimit, quotas[0].globalLimit], [5, 25]);
    return translatedSegments(calls.length === 1 ? ['Estudiamos modelos de secuencias.'] : ['Resultados', 'La precisión aumentó.']);
  };
  const response = await worker.fetch(fullRequest(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual((await response.text()).trim().split('\n').map(line => JSON.parse(line)), [
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias.'] },
    { type: 'chunk', index: 1, segments: ['Resultados', 'La precisión aumentó.'] },
    { type: 'done', count: 2 },
  ]);
  assert.match(days[0], /^translate-paper:\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(calls.map(call => call.messages), [
    [{ role: 'user', content: '["We study sequence models."]' }],
    [{ role: 'user', content: '["Results","Accuracy increased & held."]' }],
  ]);
  assert.equal(calls[0].max_tokens, 6_000);
  assert.deepEqual(arxivRequests, ['?arxiv_id=1706.03762']);
});

test('an off flag, altered text, revoked identity, and exhausted quotas spend nothing', async t => {
  const { env, calls, quotas, ledger, identity, arxivRequests } = setUp(t);
  env.FULL_PAPER_TRANSLATION_ENABLED = 'false';
  const disabled = await worker.fetch(fullRequest(), env);
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), { code: 'AI_NOT_CONFIGURED' });
  assert.equal(identity.lookups, 0);
  assert.deepEqual(arxivRequests, []);
  assert.deepEqual(quotas, []);
  assert.deepEqual(calls, []);
  enableFullPaper(env);
  assert.equal((await worker.fetch(fullRequest({ ...FULL_INPUT, fingerprint: 'a'.repeat(64) }), env)).status, 400);
  assert.equal((await worker.fetch(fullRequest({ ...FULL_INPUT, query: 'x'.repeat(1_025) }), env)).status, 413);
  identity.revoked = true;
  assert.equal((await worker.fetch(fullRequest(), env)).status, 401);
  assert.equal(quotas.length, 0);
  identity.revoked = false;
  for (const scope of ['user', 'global']) {
    ledger.reply = () => Response.json({ accepted: false, scope });
    const response = await worker.fetch(fullRequest(), env);
    assert.equal(response.status, 429);
    assert.equal((await response.json<{ quota: { scope: string } }>()).quota.scope, scope);
  }
  assert.equal(calls.length, 0);
});

test('a bad later chunk leaves the first chunk and spends no retry or refund', async t => {
  const { env, calls, quotas, provider } = setUp(t);
  enableFullPaper(env);
  provider.reply = () => translatedSegments(calls.length === 1 ? ['Estudiamos modelos de secuencias.'] : ['Missing a segment']);
  const response = await worker.fetch(fullRequest(), env);
  assert.deepEqual((await response.text()).trim().split('\n').map(line => JSON.parse(line)), [
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias.'] },
    { type: 'error', code: 'AI_INVALID_RESPONSE' },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(quotas.map(({ action }) => action), ['reserve']);
});

test('cancelling after one chunk prevents a later provider call', async t => {
  const { env, calls, provider } = setUp(t);
  enableFullPaper(env);
  provider.reply = () => translatedSegments(['Estudiamos modelos de secuencias.']);
  const response = await worker.fetch(fullRequest(), env);
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read()).value)),
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias.'] });
  await reader.cancel();
  assert.equal(calls.length, 1);
});

test('ar5iv is eligible and source redirects must keep the arXiv id', async t => {
  const { env, calls, quotas, source, arxivRequests, provider } = setUp(t);
  enableFullPaper(env);
  source.renderer = 'ar5iv';
  source.url = 'https://ar5iv.org/html/1706.03763';
  const mismatched = await worker.fetch(fullRequest(), env);
  assert.equal(mismatched.status, 400);
  assert.deepEqual(await mismatched.json(), { code: 'AI_INVALID_PAPER' });
  assert.equal(quotas.length, 0);
  assert.equal(calls.length, 0);

  source.url = 'https://ar5iv.org/html/1706.03762v2';
  provider.reply = () => translatedSegments(['Estudiamos modelos de secuencias.']);
  const accepted = await worker.fetch(fullRequest(), env);
  assert.equal(accepted.status, 200);
  assert.ok(accepted.body);
  const reader = accepted.body.getReader();
  const chunk = await reader.read();
  await reader.cancel();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(chunk.value)),
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias.'] });
  assert.deepEqual(arxivRequests, Array(2).fill('?arxiv_id=1706.03762'));
});
