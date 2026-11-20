import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ANTHROPIC_MODEL,
  anthropicAnswer,
  anthropicFailure,
  anthropicModel,
  buildAnthropicRequest,
  isAnthropicConfigured,
  isAnthropicPrimary,
} from './anthropic-client.ts';

test('Claude answers the AI routes only when AI_PROVIDER says so', () => {
  assert.equal(isAnthropicPrimary({ AI_PROVIDER: 'anthropic' }), true);
  assert.equal(isAnthropicPrimary({ AI_PROVIDER: ' Anthropic ' }), true);
  assert.equal(isAnthropicPrimary({ AI_PROVIDER: 'nan' }), false);
  assert.equal(isAnthropicPrimary({}), false);
});

test('only an sk-ant- key counts as configured', () => {
  assert.equal(isAnthropicConfigured({ ANTHROPIC_API_KEY: 'sk-ant-api03-abc' }), true);
  // A key pasted into the wrong slot fails closed instead of being sent.
  assert.equal(isAnthropicConfigured({ ANTHROPIC_API_KEY: 'sk-abc123' }), false);
  assert.equal(isAnthropicConfigured({ ANTHROPIC_API_KEY: '' }), false);
  assert.equal(isAnthropicConfigured({}), false);
});

test('the model is Opus 5.5 unless ANTHROPIC_MODEL says otherwise', () => {
  assert.equal(DEFAULT_ANTHROPIC_MODEL, 'claude-opus-5-5');
  assert.equal(anthropicModel({}), 'claude-opus-5-5');
  assert.equal(anthropicModel({ ANTHROPIC_MODEL: ' claude-haiku-5-5 ' }), 'claude-haiku-5-5');
});

test('a request carries effort and the server-side fallback, and no sampling parameters', () => {
  const body = buildAnthropicRequest({ model: 'claude-opus-5-5', effort: 'low', maxTokens: 2_000, content: 'Hi' });
  assert.deepEqual(body, {
    model: 'claude-opus-5-5',
    max_tokens: 2_000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(buildAnthropicRequest({ model: 'm', effort: 'medium', maxTokens: 1, system: 'Be brief.', content: 'Hi' }).system, 'Be brief.');
});

test('the SDK\'s typed errors map onto the codes the routes already speak', () => {
  const failure = (status: number, message = 'x', headers?: Headers) => anthropicFailure(
    Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message } }, message, headers ?? new Headers()),
  );
  // A key, permission or model name no retry will fix.
  assert.deepEqual(failure(401), { code: 'AI_NOT_CONFIGURED', status: 503, retryAfter: null });
  assert.equal(failure(403).code, 'AI_NOT_CONFIGURED');
  assert.equal(failure(404).code, 'AI_NOT_CONFIGURED');
  // Spent credits are a 400 that only a top-up fixes.
  assert.equal(failure(400, 'Your credit balance is too low to access the Anthropic API.').code, 'AI_NOT_CONFIGURED');
  assert.equal(failure(400, 'max_tokens: must be positive').code, 'AI_INVALID_REQUEST_UPSTREAM');
  assert.equal(failure(413).code, 'AI_INVALID_REQUEST_UPSTREAM');
  // Rate limits and overload clear on their own.
  assert.deepEqual(failure(429, 'x', new Headers({ 'retry-after': '9' })), { code: 'AI_BUSY', status: 429, retryAfter: '9' });
  assert.deepEqual(failure(529), { code: 'AI_BUSY', status: 502, retryAfter: null });
  assert.equal(failure(500).code, 'AI_UNAVAILABLE');
});

test('a timeout, an abort and a dropped connection are told apart', () => {
  assert.deepEqual(anthropicFailure(new Anthropic.APIConnectionTimeoutError()), { code: 'AI_TIMEOUT', status: 504, retryAfter: null });
  assert.equal(anthropicFailure(new Anthropic.APIUserAbortError()).code, 'AI_TIMEOUT');
  assert.equal(anthropicFailure(new Anthropic.APIConnectionError({ message: 'reset' })).code, 'AI_UNAVAILABLE');
  // A crash of ours is not the provider's verdict.
  assert.equal(anthropicFailure(new TypeError('boom')).code, 'AI_UNAVAILABLE');
});

test('the answer is the text of the model that finished it, and a refusal is not an answer', () => {
  const message = (fields: Record<string, unknown>) => ({ content: [], stop_reason: 'end_turn', stop_details: null, ...fields }) as unknown as Anthropic.Beta.Messages.BetaMessage;
  assert.deepEqual(anthropicAnswer(message({
    content: [{ type: 'text', text: 'What the first model wrote. ' }, { type: 'fallback' }, { type: 'text', text: 'Second.' }, { type: 'text', text: ' Third.' }],
  })), { text: 'Second. Third.', refusal: null });
  assert.deepEqual(anthropicAnswer(message({ content: [{ type: 'text', text: 'No fallback.' }] })), { text: 'No fallback.', refusal: null });
  assert.deepEqual(anthropicAnswer(message({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'bio', explanation: null },
  })), { text: '', refusal: 'bio' });
  assert.deepEqual(anthropicAnswer(message({ stop_reason: 'refusal' })), { text: '', refusal: 'unspecified' });
});
