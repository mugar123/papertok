import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import worker from './index.ts';
import type { WorkerEnv } from './env.ts';
import type { TestGlobals, TestNamespace } from './test-types.ts';
import type { LedgerTransaction } from './ledger-storage.ts';
import { RequestQuotaLedger } from './request-quota-ledger.ts';

import { PAPER_TRANSLATION_DEADLINE_MS } from '../src/utils/full-paper-translation-contract.ts';

const FULL_ABSTRACT = 'We study sequence models. '.padEnd(5_995, 'a');
const FULL_ARTICLE = `<html><body><article class="ltx_document"><div class="ltx_abstract"><p>${FULL_ABSTRACT}</p></div>`
  + '<section id="s1"><h2 class="ltx_title">Results</h2><p class="ltx_p">Accuracy increased &amp; held.</p></section>'
  + '</article></body></html>';

const tokenFor = (uid: string) => `e30.${Buffer.from(JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString('base64url')}.fixture`;
const TOKEN = tokenFor('reader-1');
const OTHER_TOKEN = tokenFor('reader-2');
const cachedIdentityUrl = `https://papertok.internal/auth/${createHash('sha256').update(TOKEN).digest('hex')}`;

function setUp(t: TestContext, ledgerReply = { accepted: true, remaining: 4 }) {
  const calls: Array<{
    model: string;
    max_tokens: number;
    thinking?: { type: string };
    output_config: { effort: string };
    system: string;
    messages: Array<{ content: string }>;
  }> = [];
  const quotas: Array<{ action: string; subjectLimit: number; globalLimit: number; globalAmount?: number }> = [];
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
    FIREBASE_WEB_API_KEY: 'test-firebase-key',
    REQUEST_QUOTA_LEDGER: namespace as WorkerEnv['REQUEST_QUOTA_LEDGER'],
  };
  const globals = globalThis as TestGlobals;
  const caches = globals.caches;
  const arxivRequests: string[] = [];
  const source = { url: 'https://arxiv.org/html/1706.03762', renderer: 'arxiv', document: FULL_ARTICLE, malformed: false };
  globals.caches = {
    default: {
      match: async key => {
        if (!(key instanceof Request)) return null;
        if (key.url === cachedIdentityUrl) return Response.json({ uid: 'reader-1' });
        const url = new URL(key.url);
        if (url.pathname === '/cache/resources/full-text') {
          arxivRequests.push(url.search);
          if (source.malformed) return new Response('{');
          return Response.json({
            source: source.renderer, format: 'latexml', url: source.url, document: source.document,
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
    reply: () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ segments: [] }) }] }),
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
  return { env, calls, quotas, days, provider, providerUrls, identity, ledger, source, arxivRequests };
}

function useTestQuotaLedger(env: WorkerEnv) {
  const ledgers = new Map<unknown, RequestQuotaLedger>();
  const namespace: TestNamespace = {
    idFromName: day => day,
    get: id => {
      let ledger = ledgers.get(id);
      if (!ledger) {
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
        ledger = new RequestQuotaLedger({ storage });
        ledgers.set(id, ledger);
      }
      const current = ledger;
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => current.fetch(new Request(input, init)) };
    },
  };
  env.REQUEST_QUOTA_LEDGER = namespace as WorkerEnv['REQUEST_QUOTA_LEDGER'];
}

const FULL_INPUT = {
  query: 'arxiv_id=1706.03762',
  language: 'es',
  fingerprint: createHash('sha256').update(JSON.stringify([
    [FULL_ABSTRACT], ['Results', 'Accuracy increased & held.'],
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
    assert.deepEqual(quotas.map(({ action, subjectLimit, globalAmount }) => [action, subjectLimit, globalAmount]), [
      ['reserve', 2, 0], ['peek', 5, undefined], ['reserve', 5, undefined],
    ]);
    assert.equal(quotas[2].globalLimit, 25);
    return translatedSegments(calls.length === 1 ? ['Estudiamos modelos de secuencias.'] : ['Resultados', 'La precisión aumentó.']);
  };
  const response = await worker.fetch(fullRequest({ ...FULL_INPUT, query: FULL_INPUT.query + '&doi=10.1000/test&fulltext_id=PMC123' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual((await response.text()).trim().split('\n').map(line => JSON.parse(line)), [
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias'] },
    { type: 'chunk', index: 1, segments: ['Resultados', 'La precisión aumentó.'] },
    { type: 'done', count: 2 },
  ]);
  assert.match(days[1], /^translate-paper:\d{4}-\d{2}-\d{2}$/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.deepEqual(calls.map(call => call.messages), [
    [{ role: 'user', content: JSON.stringify([FULL_ABSTRACT]) }],
    [{ role: 'user', content: '["Results","Accuracy increased & held."]' }],
  ]);
  assert.equal(calls[0].max_tokens, 6_000);
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.deepEqual(arxivRequests, ['?arxiv_id=1706.03762']);
});

test('accepts a Japanese result above the original byte limit within one reservation', async t => {
  const { env, calls, quotas, provider } = setUp(t);
  enableFullPaper(env);
  const long = '研究結果を検証'.repeat(2_000);
  provider.reply = () => translatedSegments(calls.length === 1 ? [long] : ['結果', '正確性が上がった。']);
  const result = await worker.fetch(fullRequest({ ...FULL_INPUT, language: 'ja' }), env);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.text()).trim().split('\n').map(line => JSON.parse(line)), [
    { type: 'chunk', index: 0, segments: [long] },
    { type: 'chunk', index: 1, segments: ['結果', '正確性が上がった.'] },
    { type: 'done', count: 2 },
  ]);
  assert.deepEqual(calls.map(call => call.max_tokens), [14_000, 14_000]);
  assert.equal(quotas.filter(quota => quota.action === 'reserve' && quota.subjectLimit === 5).length, 1);
});

test('an off flag, altered text, revoked identity, and exhausted quotas spend nothing', async t => {
  const { env, calls, quotas, ledger, identity, arxivRequests } = setUp(t);
  env.FULL_PAPER_TRANSLATION_ENABLED = 'false';
  const disabled = await worker.fetch(fullRequest(), env);
  assert.equal(disabled.status, 404);
  assert.deepEqual(await disabled.json(), { code: 'AI_NOT_CONFIGURED' });
  const anonymous = new Request('https://api.papertok.app/ai/translate-paper', { method: 'POST' });
  assert.equal((await worker.fetch(anonymous, env)).status, 404);
  assert.equal(identity.lookups, 0);
  assert.deepEqual(arxivRequests, []);
  assert.deepEqual(quotas, []);
  assert.deepEqual(calls, []);
  enableFullPaper(env);
  assert.equal((await worker.fetch(fullRequest({ ...FULL_INPUT, fingerprint: 'a'.repeat(64) }), env)).status, 400);
  assert.equal((await worker.fetch(fullRequest({ ...FULL_INPUT, query: 'x'.repeat(1_025) }), env)).status, 413);
  identity.revoked = true;
  assert.equal((await worker.fetch(fullRequest(), env)).status, 401);
  assert.deepEqual(quotas.map(({ action }) => action), ['reserve', 'peek']);
  identity.revoked = false;
  ledger.reply = () => Response.json({ accepted: false, scope: 'user' });
  assert.equal((await worker.fetch(fullRequest(), env)).status, 429);
  for (const scope of ['user', 'global']) {
    ledger.reply = action => Response.json({
      accepted: true,
      ...(action === 'peek' && (scope === 'user' ? { subjectUsage: 5 } : { globalUsage: 25 })),
    });
    const response = await worker.fetch(fullRequest(), env);
    assert.equal(response.status, 429);
    assert.equal((await response.json<{ quota: { scope: string } }>()).quota.scope, scope);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(arxivRequests, ['?arxiv_id=1706.03762']);
});

test('a bad later chunk leaves the first chunk and spends no retry or refund', async t => {
  const { env, calls, quotas, provider } = setUp(t);
  enableFullPaper(env);
  provider.reply = () => translatedSegments(calls.length === 1 ? ['Estudiamos modelos de secuencias.'] : ['Missing a segment']);
  const response = await worker.fetch(fullRequest(), env);
  assert.deepEqual((await response.text()).trim().split('\n').map(line => JSON.parse(line)), [
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias'] },
    { type: 'error', code: 'AI_INVALID_RESPONSE' },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(quotas.map(({ action }) => action), ['reserve', 'peek', 'reserve']);
});

test('cancelling after one chunk prevents a later provider call', async t => {
  const { env, calls, provider } = setUp(t);
  enableFullPaper(env);
  provider.reply = () => translatedSegments(['Estudiamos modelos de secuencias.']);
  const response = await worker.fetch(fullRequest(), env);
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read()).value)),
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias'] });
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
  assert.deepEqual(quotas.map(({ action }) => action), ['reserve', 'peek']);
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
    { type: 'chunk', index: 0, segments: ['Estudiamos modelos de secuencias'] });
  assert.deepEqual(arxivRequests, Array(2).fill('?arxiv_id=1706.03762'));
});

test('full-paper capabilities do not call the provider and submission requires an allowed Origin', async t => {
  const { env, providerUrls, identity, quotas } = setUp(t);
  const capabilities = () => worker.fetch(new Request('https://api.papertok.app/health/ai?capabilities=1'), env);
  assert.deepEqual(await (await capabilities()).json(), { capabilities: { fullPaperTranslation: false } });
  enableFullPaper(env);
  assert.deepEqual(await (await capabilities()).json(), { capabilities: { fullPaperTranslation: true } });
  for (const origin of ['', 'https://example.net']) {
    const request = fullRequest();
    if (origin) request.headers.set('origin', origin);
    else request.headers.delete('origin');
    assert.equal((await worker.fetch(request, env)).status, 403);
  }
  assert.deepEqual(providerUrls, []);
  assert.deepEqual(quotas, []);
  assert.equal(identity.lookups, 0);
});

test('enabling full-paper translation does not restore the retired abstract route', async t => {
  const { env, calls, quotas, identity } = setUp(t);
  enableFullPaper(env);
  const response = await worker.fetch(new Request('https://api.papertok.app/ai/translate', {
    method: 'POST',
    headers: { origin: 'https://papertok.app', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ arxivId: '1706.03762', language: 'es' }),
  }), env);
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: 'Method not allowed' });
  assert.equal(identity.lookups, 0);
  assert.deepEqual(quotas, []);
  assert.deepEqual(calls, []);
});

test('the real ledger limits cached source checks per account before any paid job', async t => {
  const { env, arxivRequests, calls } = setUp(t);
  enableFullPaper(env);
  useTestQuotaLedger(env);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const mismatched = { ...FULL_INPUT, fingerprint: 'a'.repeat(64) };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await worker.fetch(fullRequest(mismatched), env)).status, 400);
  }
  const limited = await worker.fetch(fullRequest(mismatched), env);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { code: 'AI_BUSY' });
  assert.equal(arxivRequests.length, 2);
  assert.equal((await worker.fetch(fullRequest(mismatched, OTHER_TOKEN), env)).status, 400);
  assert.equal(arxivRequests.length, 3);
  assert.equal(calls.length, 0);
});

test('rejects malformed relay JSON, oversized HTML and a seventeenth packed chunk before charging', async t => {
  const { env, calls, quotas, source } = setUp(t);
  enableFullPaper(env);

  source.malformed = true;
  const malformed = await worker.fetch(fullRequest(), env);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { code: 'AI_INVALID_PAPER' });

  source.malformed = false;
  source.document = '<article class="ltx_document">' + 'a'.repeat(2 * 1024 * 1024) + '</article>';
  const oversized = await worker.fetch(fullRequest(), env);
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { code: 'AI_INVALID_PAPER' });

  const paragraphs = Array.from({ length: 17 }, () => ['A'.repeat(5_990)]);
  source.document = '<article class="ltx_document">'
    + paragraphs.map(([paragraph]) => `<p class="ltx_p">${paragraph}</p>`).join('') + '</article>';
  const fingerprint = createHash('sha256').update(JSON.stringify(paragraphs)).digest('hex');
  const tooMany = await worker.fetch(fullRequest({ ...FULL_INPUT, fingerprint }), env);
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), { code: 'AI_INVALID_PAPER' });
  assert.deepEqual(quotas.filter(quota => quota.subjectLimit === 5).map(quota => quota.action), ['peek', 'peek', 'peek']);
  assert.equal(calls.length, 0);
});

test('a total deadline after the first translated chunk retains the partial result and the daily charge', { timeout: 10_000 }, async t => {
  const { env, calls, quotas, provider } = setUp(t);
  enableFullPaper(env);
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === PAPER_TRANSLATION_DEADLINE_MS ? deadline.signal : originalTimeout(ms));
  const second = Promise.withResolvers<void>();
  provider.reply = signal => {
    if (calls.length === 1) return translatedSegments(['Primer fragmento']);
    second.resolve();
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const response = await worker.fetch(fullRequest(), env);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decode = (value: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(value));
  assert.deepEqual(decode((await reader.read()).value), { type: 'chunk', index: 0, segments: ['Primer fragmento'] });
  const next = reader.read();
  await second.promise;
  deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
  assert.deepEqual(decode((await next).value), { type: 'error', code: 'AI_TIMEOUT' });
  assert.equal((await reader.read()).done, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(quotas.filter(quota => quota.subjectLimit === 5).map(quota => quota.action), ['peek', 'reserve']);
});
