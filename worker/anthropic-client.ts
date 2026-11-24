import Anthropic from '@anthropic-ai/sdk';
import type { WorkerEnv } from './env.ts';

/**
 * Anthropic's Claude models through the official SDK. PaperTok's AI provider
 * since 2026-11-19, when the NaN Builders key had expired and the team's Claude
 * credits took over. `AI_PROVIDER` can switch rewrite and annotation to another
 * provider.
 *
 * Like `nan-client.ts`, only configuration, the request body, error
 * classification and reading an answer live here, so each AI route shares them
 * without importing another route. The routes build their own `AIExplanationError`
 * from the code `anthropicFailure` returns.
 */

/** Pablo or Nico can switch to `claude-sonnet-5-5` or `claude-haiku-5-5` with `ANTHROPIC_MODEL`. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function setting(value: unknown, maxLength: number) {
  return String(value ?? '').trim().slice(0, maxLength);
}

/** Whether Claude, rather than NaN or Gemini, answers the AI routes. */
export function isAnthropicPrimary(env: WorkerEnv) {
  return setting(env?.AI_PROVIDER, 40).toLowerCase() === 'anthropic';
}

/** Anthropic keys start with `sk-ant-`; anything else is a misplaced secret. */
export function isAnthropicConfigured(env: WorkerEnv) {
  return /^sk-ant-/.test(setting(env?.ANTHROPIC_API_KEY, 300));
}

export function anthropicModel(env: WorkerEnv) {
  return setting(env?.ANTHROPIC_MODEL, 100) || DEFAULT_ANTHROPIC_MODEL;
}

/**
 * No SDK retries. A 429 or 529 that the SDK retried on its own would spend the
 * route's whole deadline waiting, and every retry is another paid request; the
 * reader's own retry button is the bounded one.
 */
export function createAnthropicClient(env: WorkerEnv) {
  return new Anthropic({ apiKey: setting(env?.ANTHROPIC_API_KEY, 300), maxRetries: 0 });
}

/**
 * One request body, as every route sends it.
 *
 * `effort` is the only depth control: thinking is always on for Opus 5.5, and
 * `temperature` is rejected by these models. The server-side fallback re-runs a
 * request the safety classifier declined on a substitute model inside the same
 * call; a model without a fallback runs the request alone.
 */
export function buildAnthropicRequest({ model, effort, maxTokens, system, content }: {
  model: string;
  effort: 'low' | 'medium';
  maxTokens: number;
  system?: string;
  content: string | Anthropic.Beta.Messages.BetaContentBlockParam[];
}) {
  return {
    model,
    max_tokens: maxTokens,
    betas: [SERVER_SIDE_FALLBACK_BETA],
    fallbacks: 'default' as const,
    output_config: { effort },
    ...(system ? { system } : {}),
    messages: [{ role: 'user' as const, content }],
  };
}

/** Anthropic reports spent credits as a 400, which no retry will fix until they are topped up. */
const CREDIT_BALANCE = /credit balance|billing/i;

/**
 * The SDK's typed errors, mapped onto PaperTok's codes. `status` is what the
 * route answers with, as for the other providers.
 */
export function anthropicFailure(error: unknown) {
  if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof Anthropic.APIUserAbortError) {
    return { code: 'AI_TIMEOUT', status: 504, retryAfter: null };
  }
  if (!(error instanceof Anthropic.APIError)) return { code: 'AI_UNAVAILABLE', status: 502, retryAfter: null };
  const retryAfter = error.headers?.get('retry-after') ?? null;
  // A key, permission or model name that no retry will fix.
  if (error instanceof Anthropic.AuthenticationError
    || error instanceof Anthropic.PermissionDeniedError
    || error instanceof Anthropic.NotFoundError) {
    return { code: 'AI_NOT_CONFIGURED', status: 503, retryAfter };
  }
  if (error instanceof Anthropic.RateLimitError) return { code: 'AI_BUSY', status: 429, retryAfter };
  // 529 is Anthropic's "overloaded".
  if (error.status === 503 || error.status === 529) return { code: 'AI_BUSY', status: 502, retryAfter };
  if (error.status === 400 && CREDIT_BALANCE.test(error.message)) {
    return { code: 'AI_NOT_CONFIGURED', status: 503, retryAfter };
  }
  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return { code: 'AI_INVALID_REQUEST_UPSTREAM', status: 502, retryAfter };
  }
  return { code: 'AI_UNAVAILABLE', status: 502, retryAfter };
}

/**
 * The answer of a non-streamed message: the text of the model that finished it.
 * A refusal is not an answer: the classifier declined the request (and any
 * fallback did too), so the caller gets the category and no text.
 */
export function anthropicAnswer(message: Anthropic.Beta.Messages.BetaMessage) {
  if (message.stop_reason === 'refusal') {
    return { text: '', refusal: message.stop_details?.category ?? 'unspecified' };
  }
  // A `fallback` block marks where one model's output gives way to the next:
  // what the model that declined wrote before it is not part of the answer.
  const answered = message.content.slice(message.content.findLastIndex(block => block.type === 'fallback') + 1);
  const text = answered
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');
  return { text, refusal: null };
}
