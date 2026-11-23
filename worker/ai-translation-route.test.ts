import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import worker from './index.ts';
import type { WorkerEnv } from './env.ts';
import type { TestGlobals, TestNamespace } from './test-types.ts';

const TRANSLATION_URL = 'https://api.papertok.app/ai/translate';
const TOKEN = 'worker-test-token';
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
  const calls: Array<{ model: string; max_tokens: number; output_config: { effort: string }; system: string; messages: Array<{ content: string }> }> = [];
  const quotas: Array<{ action: string; subjectLimit: number; globalLimit: number; globalAmount?: number }> = [];
  const days: string[] = [];
  const providerUrls: string[] = [];
  const namespace: TestNamespace = {
    idFromName: day => { days.push(day); return 'ledger'; },
    get: () => ({
      fetch: async (_url: RequestInfo | URL, init: RequestInit) => {
        quotas.push(JSON.parse(String(init.body)));
        return Response.json(ledgerReply);
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
  globals.caches = {
    default: {
      match: async key => {
        if (!(key instanceof Request)) return null;
        if (key.url === cachedIdentityUrl) return Response.json({ uid: 'reader-1' });
        const url = new URL(key.url);
        if (url.pathname === '/cache/arxiv' && url.searchParams.get('id_list') === INPUT.arxivId) {
          return new Response(ARXIV_ATOM, { headers: { 'content-type': 'application/atom+xml' } });
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
  const provider = {
    reply: () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(ANSWER) }] }),
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit) => {
    providerUrls.push(String(input));
    calls.push(JSON.parse(String(init.body)));
    return provider.reply();
  });
  return { env, calls, quotas, days, provider, providerUrls };
}

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
  assert.equal(calls[0].max_tokens, 4_000);
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
});

test('a refusal, truncated response or malformed answer cannot become a translation', async t => {
  const { env, provider, quotas } = setUp(t);
  for (const [stop_reason, text, code] of [
    ['refusal', JSON.stringify(ANSWER), 'AI_EMPTY_RESPONSE'],
    ['max_tokens', JSON.stringify(ANSWER), 'AI_INVALID_RESPONSE'],
    ['end_turn', '{"title":"Missing abstract"}', 'AI_INVALID_RESPONSE'],
  ]) {
    provider.reply = () => Response.json({ stop_reason, content: [{ type: 'text', text }] });
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code });
  }
  assert.deepEqual(quotas.map(({ action }) => action), ['reserve', 'reserve', 'reserve']);
});
