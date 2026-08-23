import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_REQUEST_BUDGETS,
  AI_EXPLANATION_LEVELS,
  AIExplanationError,
  buildPaperExplanationPrompt,
  classifyGeminiError,
  classifyKimiError,
  createRequestDeadline,
  explanationCacheKey,
  getDailyQuotaReset,
  getProviderRetry,
  normalizePaperForExplanation,
  parseExplanationText,
  shouldRefundAIQuota,
  shouldRetryGeminiWithFallback,
  stageBudgetMs,
  shouldFallbackToKimi,
} from '../../worker/ai-explanation.js';

test('supports the three explanation depths', () => {
  assert.deepEqual(AI_EXPLANATION_LEVELS, ['beginner', 'university', 'researcher']);
});

test('builds a source-aware prompt without silently claiming full-text access', () => {
  const paper = normalizePaperForExplanation({ title: 'A test', abstract: 'Known facts.' });
  const prompt = buildPaperExplanationPrompt(paper, 'university', 'abstract');
  assert.match(prompt, /Solo dispones del abstract/);
  assert.match(prompt, /Known facts/);
  assert.match(prompt, /LaTeX/);
  assert.match(prompt, /\$\.\.\.\$/);
  assert.match(prompt, /nunca escribas ω_b/);
  assert.match(prompt, /keyPoints/);
});

test('builds English-only explanations when the interface language is English', () => {
  const paper = normalizePaperForExplanation({ title: 'A test', abstract: 'Known facts.' });
  const prompt = buildPaperExplanationPrompt(paper, 'university', 'abstract', 'en');
  assert.match(prompt, /faithfully explain a scientific paper in English/);
  assert.match(prompt, /Every explanatory field.*written in English/);
  assert.match(prompt, /You only have the abstract and metadata/);
  assert.match(prompt, /Known facts/);
  assert.doesNotMatch(prompt, /explicar fielmente un paper científico en español/);
  assert.match(prompt, /below 1000 words/);
});

test('repairs raw LaTeX backslashes without corrupting valid JSON escapes', () => {
  const explanation = parseExplanationText(String.raw`{
    "overview": "Uses $X_\theta = \omega_b$ and \mathrm{Re}(A).",
    "methodology": "Line one\nLine two",
    "takeaway": "Done"
  }`);

  assert.equal(explanation.overview, String.raw`Uses $X_\theta = \omega_b$ and \mathrm{Re}(A).`);
  assert.equal(explanation.methodology, 'Line one\nLine two');
});

test('keeps the complete cold-request budget below the browser timeout', () => {
  const worstGeminiPath = AI_REQUEST_BUDGETS.pdfOnlySourceMs
    + AI_REQUEST_BUDGETS.geminiPrimaryMs
    + AI_REQUEST_BUDGETS.geminiFallbackMs;

  assert.ok(worstGeminiPath + AI_REQUEST_BUDGETS.responseMarginMs < AI_REQUEST_BUDGETS.browserMs);
  assert.equal(worstGeminiPath, 53_000);

  // Adding the paid fallback does not fit — 105 s of stages against 70 s of
  // patience — and that is precisely why they share a shrinking deadline
  // instead of each trusting its own budget.
  assert.ok(worstGeminiPath + AI_REQUEST_BUDGETS.kimiMs > AI_REQUEST_BUDGETS.browserMs);
});

test('caps every stage by what is left of the request, not by its own budget', () => {
  let clock = 1_000;
  const deadline = createRequestDeadline(() => clock);

  assert.equal(stageBudgetMs(deadline, AI_REQUEST_BUDGETS.geminiPrimaryMs), 12_000);
  clock += 60_000;
  // 8 s left of the 68 s the worker allows itself: the lighter model still gets
  // a shot, Kimi does not, because it would charge its reservation to lose.
  assert.equal(stageBudgetMs(deadline, AI_REQUEST_BUDGETS.geminiFallbackMs), 8_000);
  assert.ok(stageBudgetMs(deadline, AI_REQUEST_BUDGETS.kimiMs) < AI_REQUEST_BUDGETS.minKimiMs);
  clock += 10_000;
  assert.equal(stageBudgetMs(deadline, AI_REQUEST_BUDGETS.geminiPrimaryMs), 0);
  // A direct call with no deadline keeps the stage's own budget.
  assert.equal(stageBudgetMs(undefined, AI_REQUEST_BUDGETS.kimiMs), AI_REQUEST_BUDGETS.kimiMs);
});

test('gives the daily use back only when the provider did no work', () => {
  const refunds = code => shouldRefundAIQuota(new AIExplanationError(code, 502));

  assert.equal(refunds('AI_BUSY'), true);
  assert.equal(refunds('AI_UNAVAILABLE'), true);
  assert.equal(refunds('AI_SOURCE_UNAVAILABLE'), true);
  assert.equal(refunds('AI_FALLBACK_BUDGET_EXHAUSTED'), true);
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

test('keeps English and Spanish explanations in separate worker caches', async () => {
  const paper = normalizePaperForExplanation({ title: 'A test', abstract: 'Known facts.' });
  const spanishKey = await explanationCacheKey(paper, 'university', 'es', 'gemini', 'test-model');
  const englishKey = await explanationCacheKey(paper, 'university', 'en', 'gemini', 'test-model');

  assert.notEqual(spanishKey.url, englishKey.url);
  assert.match(spanishKey.url, /\/es\/university\//);
  assert.match(englishKey.url, /\/en\/university\//);
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

test('only routes to Kimi after Gemini confirms provider quota exhaustion', () => {
  assert.equal(shouldFallbackToKimi(new AIExplanationError(
    'AI_QUOTA_EXHAUSTED',
    429,
    'AI_QUOTA_EXHAUSTED',
    { scope: 'provider' },
  )), true);
  assert.equal(shouldFallbackToKimi(new AIExplanationError(
    'AI_QUOTA_EXHAUSTED',
    429,
    'AI_QUOTA_EXHAUSTED',
    { scope: 'user' },
  )), false);
  assert.equal(shouldFallbackToKimi(new AIExplanationError('AI_BUSY', 429)), false);
});

test('retries Gemini with its lighter model for malformed structured output', () => {
  assert.equal(shouldRetryGeminiWithFallback(new AIExplanationError('AI_INVALID_RESPONSE', 502)), true);
  assert.equal(shouldRetryGeminiWithFallback(new AIExplanationError('AI_UNAVAILABLE', 502)), true);
  assert.equal(shouldRetryGeminiWithFallback(new AIExplanationError('AI_QUOTA_EXHAUSTED', 429)), false);
  // Repeating a request the model already rejected only spends the budget.
  assert.equal(shouldRetryGeminiWithFallback(new AIExplanationError('AI_INVALID_REQUEST_UPSTREAM', 502)), false);
});

test('distinguishes Kimi budget failures from transient rate limits', () => {
  assert.equal(classifyKimiError(402, { error: { message: 'Insufficient balance' } }), 'AI_FALLBACK_BUDGET_EXHAUSTED');
  assert.equal(classifyKimiError(429, { error: { message: 'Requests per minute exceeded' } }), 'AI_BUSY');
  assert.equal(classifyKimiError(401, { error: { message: 'Invalid proxy token' } }), 'AI_NOT_CONFIGURED');
  // The sniffing used to run for every status over the whole body: a 500 saying
  // «load ba-lanc-er» matched `balance` and locked the fallback until the first
  // of next month.
  assert.equal(
    classifyKimiError(500, { error: { message: 'upstream connect error: no healthy load balancer' } }),
    'AI_UNAVAILABLE',
  );
  assert.equal(classifyKimiError(503, { error: { message: 'billing service unreachable' } }), 'AI_BUSY');
  // Where money really is the reason, the words still decide.
  assert.equal(
    classifyKimiError(403, { error: { message: 'Insufficient balance for this workspace' } }),
    'AI_FALLBACK_BUDGET_EXHAUSTED',
  );
  assert.equal(classifyKimiError(403, { error: { message: 'Invalid proxy token' } }), 'AI_NOT_CONFIGURED');
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
