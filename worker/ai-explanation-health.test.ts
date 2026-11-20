import type { WorkerEnv } from './env.ts';
type FetchCall = { url: string; headers: HeadersInit; body: unknown };
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAIProviderHealth } from './ai-explanation.ts';

function stubFetch(handlers: Record<string, (call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String((input as Request)?.url || input);
    const call = {
      url,
      headers: init.headers || {},
      body: (() => {
        try { return JSON.parse(init.body as string); } catch { return null; }
      })(),
    };
    calls.push(call);
    const match = Object.keys(handlers).find(fragment => url.includes(fragment));
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    return handlers[match](call);
  };
  return calls;
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

test('/health/ai checks that NaN serves the configured model, not merely that the key works', async () => {
  stubFetch({
    'api.nan.builders/v1/models': () => json({ object: 'list', data: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.6' }] }),
  });

  const healthy = await checkAIProviderHealth({
    AI_PROVIDER: 'nan',
    NAN_API_KEY: 'sk-test-key',
    AI: { toMarkdown: async (): Promise<import('./paper-text.ts').PaperTextConversion> => ({} as import('./paper-text.ts').PaperTextConversion) },
  });
  assert.equal(healthy.provider, 'nan');
  assert.equal(healthy.model, 'deepseek-v4-flash');
  assert.equal(healthy.available, true);
  assert.equal(healthy.code, null);
  assert.equal(healthy.paperText, true);
  assert.equal('fallback' in healthy, false);

  // A model id NaN does not serve: the key works, every rewrite would 404.
  const misnamed = await checkAIProviderHealth({
    AI_PROVIDER: 'nan',
    NAN_API_KEY: 'sk-test-key',
    NAN_MODEL: 'deepseek-v4.1',
  });
  assert.equal(misnamed.available, false);
  assert.equal(misnamed.code, 'AI_NOT_CONFIGURED');
  assert.equal(misnamed.paperText, false);

  const keyless = await checkAIProviderHealth({ AI_PROVIDER: 'nan' });
  assert.equal(keyless.configured, false);
  assert.equal(keyless.code, 'AI_NOT_CONFIGURED');
});

test('/health/ai reports a NaN outage even while the retired fallback secrets are still set', async () => {
  const calls = stubFetch({
    'api.nan.builders/v1/models': () => json({ error: { message: 'overloaded' } }, 503),
  });

  const health = await checkAIProviderHealth({
    AI_PROVIDER: 'nan',
    NAN_API_KEY: 'sk-test-key',
    NVIDIA_API_KEY: 'nvapi-test-key',
    MODAL_PROXY_TOKEN_ID: 'wk-test-id',
    MODAL_PROXY_TOKEN_SECRET: 'ws-test-secret',
    MODAL_KIMI_BASE_URL: 'https://papertok--kimi.modal.run/v1',
    AI_FALLBACK_PROVIDER: 'nvidia-deepseek,modal-kimi',
  } as WorkerEnv);
  assert.equal(health.provider, 'nan');
  assert.equal(health.available, false);
  assert.equal(health.code, 'AI_BUSY');
  assert.equal('fallback' in health, false);
  assert.equal(calls.length, 1);
});

test('/health/ai checks that the Anthropic key can use the configured model', async () => {
  const calls = stubFetch({
    'api.anthropic.com/v1/models/claude-opus-5-5': () => json({ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }),
    'api.anthropic.com/v1/models/claude-opus-9': () => json({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-opus-9' } }, 404),
  });

  const healthy = await checkAIProviderHealth({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key' });
  assert.deepEqual(healthy, { provider: 'anthropic', model: 'claude-opus-5-5', configured: true, available: true, code: null });
  assert.equal(calls.length, 1);

  // A model name Anthropic does not serve: the key works, every route would fail.
  const misnamed = await checkAIProviderHealth({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_MODEL: 'claude-opus-9' });
  assert.equal(misnamed.available, false);
  assert.equal(misnamed.code, 'AI_NOT_CONFIGURED');

  const keyless = await checkAIProviderHealth({ AI_PROVIDER: 'anthropic' });
  assert.equal(keyless.configured, false);
  assert.equal(keyless.code, 'AI_NOT_CONFIGURED');
  // No key, no request.
  assert.equal(calls.length, 2);
});

test('/health/ai reports an Anthropic outage as busy, not as a missing key', async () => {
  stubFetch({
    'api.anthropic.com/v1/models': () => json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529),
  });

  const health = await checkAIProviderHealth({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key' });
  assert.equal(health.configured, true);
  assert.equal(health.available, false);
  assert.equal(health.code, 'AI_BUSY');
});
