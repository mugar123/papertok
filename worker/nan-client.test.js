import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NAN_MODEL,
  NAN_REASONING_OFF,
  buildNanChatBody,
  chatCompletionText,
  classifyNanError,
  isNanConfigured,
  isNanPrimary,
  nanHeaders,
  nanModel,
  nanPdfPart,
} from './nan-client.js';

test('NaN answers the AI routes only when AI_PROVIDER says so', () => {
  assert.equal(isNanPrimary({ AI_PROVIDER: 'nan' }), true);
  assert.equal(isNanPrimary({ AI_PROVIDER: ' NaN ' }), true);
  assert.equal(isNanPrimary({ AI_PROVIDER: 'gemini' }), false);
  // Unset keeps the Worker on Gemini, which is what every older env assumed.
  assert.equal(isNanPrimary({}), false);
});

test('only a personal sk- key counts as configured', () => {
  assert.equal(isNanConfigured({ NAN_API_KEY: 'sk-abc123' }), true);
  assert.equal(isNanConfigured({ NAN_API_KEY: '  sk-abc123  ' }), true);
  // A secret pasted into the wrong slot fails closed instead of being sent.
  assert.equal(isNanConfigured({ NAN_API_KEY: 'nvapi-abc123' }), false);
  assert.equal(isNanConfigured({ NAN_API_KEY: '' }), false);
  assert.equal(isNanConfigured({}), false);
});

test('the default model is the DeepSeek NaN actually serves', () => {
  assert.equal(DEFAULT_NAN_MODEL, 'deepseek-v4-flash');
  assert.equal(nanModel({}), 'deepseek-v4-flash');
  assert.equal(nanModel({ NAN_MODEL: 'qwen3.6' }), 'qwen3.6');
});

test('the key travels as a bearer token', () => {
  assert.equal(nanHeaders({ NAN_API_KEY: 'sk-abc' }).authorization, 'Bearer sk-abc');
});

test('every body switches reasoning off, under both template names', () => {
  const body = buildNanChatBody({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Hi' }],
    maxTokens: 600,
    temperature: 0.2,
  });
  // With reasoning on, a rewrite spent its whole output budget thinking.
  assert.deepEqual(body.chat_template_kwargs, { thinking: false, enable_thinking: false });
  assert.equal(body.chat_template_kwargs, NAN_REASONING_OFF);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 600);
  assert.equal('response_format' in body, false);
});

test('JSON mode is json_object, the only structured mode DeepSeek takes here', () => {
  const body = buildNanChatBody({ model: 'm', messages: [], maxTokens: 1, temperature: 0, json: true, stream: true });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.stream, true);
});

test('a PDF travels as a data URL in a file part', () => {
  assert.deepEqual(nanPdfPart('JVBERi0='), {
    type: 'file',
    file: { filename: 'paper.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
  });
});

test('NaN statuses map onto the codes the routes already speak', () => {
  // The monthly allowance: nothing to retry until the month turns.
  assert.equal(classifyNanError(402), 'AI_QUOTA_EXHAUSTED');
  // Rate and concurrency ceilings clear in seconds.
  assert.equal(classifyNanError(429), 'AI_BUSY');
  assert.equal(classifyNanError(503), 'AI_BUSY');
  // A key, tier or model name no retry will fix.
  assert.equal(classifyNanError(401), 'AI_NOT_CONFIGURED');
  assert.equal(classifyNanError(403), 'AI_NOT_CONFIGURED');
  assert.equal(classifyNanError(404), 'AI_NOT_CONFIGURED');
  assert.equal(classifyNanError(400), 'AI_INVALID_REQUEST_UPSTREAM');
  assert.equal(classifyNanError(500), 'AI_UNAVAILABLE');
  assert.equal(classifyNanError(524), 'AI_UNAVAILABLE');
});

test('the answer is the content, never the reasoning beside it', () => {
  assert.equal(chatCompletionText({
    choices: [{ message: { content: 'The answer.', reasoning_content: 'Let me think…' } }],
  }), 'The answer.');
  assert.equal(chatCompletionText({
    choices: [{ message: { content: [{ type: 'text', text: 'Two ' }, 'parts.'] } }],
  }), 'Two parts.');
  assert.equal(chatCompletionText({}), '');
  assert.equal(chatCompletionText({ choices: [{ message: { content: null } }] }), '');
});
