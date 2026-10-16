/**
 * NaN Builders (nan.builders): open models on a shared EU inference cluster,
 * behind an OpenAI-compatible API. PaperTok's primary AI provider since
 * 2026-10-06, when the Gemini allowance ran out; `AI_PROVIDER = "gemini"`
 * switches every route back.
 *
 * Only pure helpers live here — configuration, the request body, error
 * classification, and reading an answer — so each AI route can share them
 * without importing another route. The routes still build their own
 * `AIExplanationError` from the code `classifyNanError` returns.
 */

export const NAN_API_BASE_URL = 'https://api.nan.builders/v1';
export const NAN_CHAT_COMPLETIONS_URL = `${NAN_API_BASE_URL}/chat/completions`;
/** NaN's id for DeepSeek V4 Flash, the only DeepSeek it serves. */
export const DEFAULT_NAN_MODEL = 'deepseek-v4-flash';

/**
 * Reasoning off, on every call.
 *
 * Measured on 2026-10-06 against deepseek-v4-flash: with reasoning on, a
 * university-level rewrite spent all 16,384 output tokens thinking and wrote
 * no section at all, and a 300-word answer took 10.7 s instead of 4.4 s.
 * `reasoning_effort` is accepted and ignored on this model; the chat
 * template's own switch is what turns it off. `thinking` is the DeepSeek
 * template's name for it and `enable_thinking` the Qwen and Gemma one, so a
 * different `NAN_MODEL` is covered as well.
 */
export const NAN_REASONING_OFF = Object.freeze({ thinking: false, enable_thinking: false });

function setting(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

/** Whether NaN, rather than Gemini, answers the AI routes. */
export function isNanPrimary(env) {
  return setting(env?.AI_PROVIDER, 40).toLowerCase() === 'nan';
}

/** NaN keys are personal `sk-…` keys; anything else is a misplaced secret. */
export function isNanConfigured(env) {
  return /^sk-/.test(setting(env?.NAN_API_KEY, 200));
}

export function nanModel(env) {
  return setting(env?.NAN_MODEL, 100) || DEFAULT_NAN_MODEL;
}

export function nanHeaders(env) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${setting(env?.NAN_API_KEY, 200)}`,
  };
}

/**
 * One chat completion body, as every route sends it.
 *
 * `json` asks for `json_object`, which on deepseek-v4-flash guarantees valid
 * JSON but not its shape, and is refused unless the prompt says "JSON": the
 * shape has to be written into the prompt. `json_schema` is rejected on this
 * model outright.
 */
export function buildNanChatBody({ model, messages, maxTokens, temperature, json = false, stream = false }) {
  return {
    model,
    messages,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    max_tokens: maxTokens,
    temperature,
    stream,
    chat_template_kwargs: NAN_REASONING_OFF,
  };
}

/**
 * A PDF attached as a `file` part.
 *
 * Not in NaN's documentation, but it works: the gateway extracts the text
 * itself. It is slow — about 45 s before the first token on a 15-page paper,
 * and three at once ran to 110–125 s with one cut off by a 524 (measured
 * 2026-10-06) — so it is only the fallback for when the Worker could not
 * extract the text first.
 */
export function nanPdfPart(pdfBase64) {
  return {
    type: 'file',
    file: { filename: 'paper.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` },
  };
}

/**
 * NaN's documented statuses, mapped onto PaperTok's codes.
 *
 * 402 is the model's monthly token allowance, which only returns when the
 * calendar month turns. 429 is a per-key rate or per-model concurrency
 * ceiling that clears in seconds. 401, 403 and 404 are a key, tier or model
 * name that no retry will fix, and a 400 is the request itself.
 */
export function classifyNanError(status) {
  if (status === 402) return 'AI_QUOTA_EXHAUSTED';
  if (status === 429 || status === 503 || status === 529) return 'AI_BUSY';
  if (status === 401 || status === 403 || status === 404) return 'AI_NOT_CONFIGURED';
  if (status === 400 || status === 413 || status === 422) return 'AI_INVALID_REQUEST_UPSTREAM';
  return 'AI_UNAVAILABLE';
}

/** The answer of a non-streamed completion. Reasoning is never part of it. */
export function chatCompletionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return typeof content === 'string' ? content : '';
}
