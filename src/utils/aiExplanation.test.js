import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIExplanationError,
  classifyGeminiError,
  getDailyQuotaReset,
  getProviderRetry,
  normalizePaperForExplanation,
  shouldRefundAIQuota,
} from '../../worker/ai-explanation.ts';

test('gives the daily use back only when the provider did no work', () => {
  const refunds = code => shouldRefundAIQuota(new AIExplanationError(code, 502));

  assert.equal(refunds('AI_BUSY'), true);
  assert.equal(refunds('AI_UNAVAILABLE'), true);
  // These two the provider did answer: refunding them would buy unlimited free
  // retries against its quota.
  assert.equal(refunds('AI_INVALID_RESPONSE'), false);
  assert.equal(refunds('AI_INVALID_REQUEST_UPSTREAM'), false);
  // A crash of ours is not the reader's fault either.
  assert.equal(shouldRefundAIQuota(new TypeError('boom')), true);

  const quotaError = scope => new AIExplanationError('AI_QUOTA_EXHAUSTED', 429, 'AI_QUOTA_EXHAUSTED', { scope });
  assert.equal(shouldRefundAIQuota(quotaError('provider')), true);
  assert.equal(shouldRefundAIQuota(quotaError('user')), false);
});

test('rejects an explanation request without usable paper content', () => {
  assert.throws(
    () => normalizePaperForExplanation({ title: 'No content' }),
    error => error instanceof AIExplanationError && error.code === 'AI_INVALID_PAPER',
  );
});

test('rejects placeholder abstracts and unsupported PDF hosts', () => {
  assert.throws(
    () => normalizePaperForExplanation({
      title: 'No usable content',
      abstract: 'No abstract available.',
      pdfUrl: 'https://example.org/paper.pdf',
    }),
    error => error instanceof AIExplanationError && error.code === 'AI_INVALID_PAPER',
  );
});

test('distinguishes Gemini configuration errors from temporary failures', () => {
  assert.equal(classifyGeminiError(403, { error: { message: 'API key not valid' } }), 'AI_NOT_CONFIGURED');
  assert.equal(classifyGeminiError(503, { error: { message: 'Service unavailable' } }), 'AI_BUSY');
  assert.equal(classifyGeminiError(500, {}), 'AI_UNAVAILABLE');
  assert.equal(classifyGeminiError(429, { error: { message: 'Requests per minute exceeded' } }), 'AI_BUSY');
  assert.equal(classifyGeminiError(429, { error: { message: 'Requests per day exceeded' } }), 'AI_QUOTA_EXHAUSTED');
  // A rejected request is deterministic, so it gets its own non-retryable code
  // instead of looking like a temporary outage.
  assert.equal(
    classifyGeminiError(400, { error: { status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } }),
    'AI_INVALID_REQUEST_UPSTREAM',
  );
  assert.equal(classifyGeminiError(400, { error: { message: 'API key not valid' } }), 'AI_NOT_CONFIGURED');
});

test('preserves Gemini retry timing for temporary rate limits', () => {
  assert.deepEqual(getProviderRetry({
    error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.5s' }] },
  }, '', Date.parse('2026-07-22T12:00:00.000Z')), {
    resetAt: '2026-07-22T12:00:13.000Z',
    retryAfterSeconds: 13,
    scope: 'provider-rate',
  });
});

test('reports the next UTC quota reset without relying on browser time', () => {
  assert.deepEqual(getDailyQuotaReset(Date.parse('2026-07-20T22:15:30.000Z')), {
    resetAt: '2026-07-21T00:00:00.000Z',
    retryAfterSeconds: 6_270,
  });
});
