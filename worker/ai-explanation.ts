import type { WorkerEnv } from './env.ts';
import type { Paper } from '../src/models/Paper.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { QuotaRequest } from './request-quota-ledger.ts';

import type { AIQuota } from '../src/models/Rewrite.ts';
export type { AIQuota } from '../src/models/Rewrite.ts';

export interface AIProviderPayload {
  error?: { details?: Array<{ retryDelay?: unknown; [key: string]: unknown }>; [key: string]: unknown };
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: boolean }> }; finishReason?: string }>;
}

type PdfResult = { bytes: Uint8Array<ArrayBuffer>; reason: '' }
  | { bytes: null; reason: 'unreachable' | 'not_pdf' | 'too_large' };

import { hasUsableAIAbstract, isAIReadablePdfUrl } from '../src/utils/aiExplanationAccess.ts';
import { getMonthlyBudgetReset } from './kimi-budget-ledger.ts';
import { readBoundedBytes } from './bounded-body.ts';
import { peekRequestQuota, releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.ts';
import { verifyFirebaseIdentity, WorkerAuthError } from './firebase-auth.ts';
import {
  NAN_API_BASE_URL,
  classifyNanError,
  isNanConfigured,
  nanHeaders,
  nanModel,
} from './nan-client.ts';

const DEFAULT_MODEL = 'gemini-3.5-flash';
const DEFAULT_USER_DAILY_LIMIT = 5;
const DEFAULT_GLOBAL_DAILY_LIMIT = 100;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const LATEX_JSON_COMMANDS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
  'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi',
  'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi',
  'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi',
  'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega', 'ell', 'frac', 'dfrac',
  'tfrac', 'sqrt', 'text', 'textrm', 'textit', 'mathrm', 'mathbf', 'mathit',
  'mathcal', 'operatorname', 'left', 'right', 'begin', 'end', 'sum', 'prod',
  'int', 'iint', 'iiint', 'oint', 'partial', 'nabla', 'infty', 'approx',
  'sim', 'simeq', 'cong', 'equiv', 'neq', 'leq', 'geq', 'll', 'gg', 'times',
  'cdot', 'pm', 'mp', 'to', 'mapsto', 'rightarrow', 'leftarrow', 'Rightarrow',
  'Leftarrow', 'overline', 'underline', 'hat', 'bar', 'vec', 'dot', 'ddot',
  'boldsymbol', 'sin', 'cos', 'tan', 'log', 'ln', 'exp', 'max', 'min', 'sup',
  'inf', 'det', 'gcd', 'lim',
]);

/**
 * PaperTok is English-only. Any incoming `language` — including a legacy 'es'
 * from an old client or a cached request — is accepted and ignored. The value
 * is still returned (and kept in cache keys) so the key format stays stable.
 */
export function normalizeExplanationLanguage(language?: unknown): 'en';
export function normalizeExplanationLanguage() {
  return 'en';
}

export class AIExplanationError extends Error {
  declare code: string;
  declare status: number;
  declare quota: AIQuota | null;
  declare detail?: string;

  constructor(code: string, status = 500, message = code, quota: AIQuota | null = null) {
    super(message);
    this.name = 'AIExplanationError';
    this.code = code;
    this.status = status;
    this.quota = quota;
  }
}

export function cleanText(value: unknown, maxLength: number) {
  return String(value || '').replace(/\0/g, '').trim().slice(0, maxLength);
}

function normalizeDoi(value: unknown) {
  return cleanText(value, 300).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
}

function normalizeUrl(value: unknown) {
  const text = cleanText(value, 2_000);
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizePaperForExplanation(input: Partial<Record<keyof Paper, unknown>> = {}) {
  const authors = Array.isArray(input.authors)
    ? input.authors.map(author => cleanText(author?.name || author, 160)).filter(Boolean).slice(0, 30)
    : [];
  const concepts = Array.isArray(input.concepts)
    ? input.concepts.map(concept => cleanText(concept?.display_name || concept?.name || concept, 120)).filter(Boolean).slice(0, 20)
    : [];
  const categories = Array.isArray(input.categories)
    ? input.categories.map(category => cleanText(category, 100)).filter(Boolean).slice(0, 20)
    : [];

  const abstract = cleanText(input.abstract, 30_000);
  const pdfUrl = normalizeUrl(input.pdfUrl);
  const paper = {
    id: cleanText(input.id, 400),
    title: cleanText(input.title, 1_000),
    abstract: hasUsableAIAbstract(abstract) ? abstract : '',
    authors,
    year: Number.isFinite(Number(input.year)) ? Number(input.year) : null,
    doi: normalizeDoi(input.doi),
    arxivId: cleanText(input.arxivId, 100),
    journal: cleanText(input.journal, 300),
    categories,
    concepts,
    pdfUrl: isAIReadablePdfUrl(pdfUrl) ? pdfUrl : '',
  };

  if (!paper.title || (!paper.abstract && !paper.pdfUrl)) {
    throw new AIExplanationError('AI_INVALID_PAPER', 400);
  }
  return paper;
}

function safeInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(value as string, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * The paper's PDF as bytes, or why there is none.
 *
 * The reason travels because "the download produced nothing" covered three
 * different failures that need three different answers: a mirror that never
 * replied is worth retrying, a server that answered with an HTML interstitial
 * instead of the file is a source that has to be swapped, and a PDF over the cap
 * is a paper this endpoint will never read. They were indistinguishable in the
 * logs, which is how PMC's interstitial hid behind arXiv's timeouts.
 */
export async function fetchPaperPdfBytes(pdfUrl: string, timeoutMs: number): Promise<PdfResult> {
  const failed = (reason: 'unreachable' | 'not_pdf' | 'too_large'): PdfResult => ({ bytes: null, reason });
  if (!isAIReadablePdfUrl(pdfUrl)) return failed('unreachable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = pdfUrl;
    let response;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { accept: 'application/pdf' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirectCount === 3) return failed('unreachable');
      const nextUrl = new URL(location, currentUrl).toString();
      if (!isAIReadablePdfUrl(nextUrl)) return failed('unreachable');
      currentUrl = nextUrl;
    }
    if (!response?.ok || !isAIReadablePdfUrl(response.url || currentUrl)) return failed('unreachable');
    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (!contentType.toLowerCase().includes('pdf')) return failed('not_pdf');
    if (contentLength > MAX_PDF_BYTES) return failed('too_large');
    // `content-length` is the server's word for it, and a chunked response gives
    // none: the cap has to hold against the bytes themselves.
    const bytes = await readBoundedBytes(response, MAX_PDF_BYTES);
    if (!bytes) return failed('too_large');
    if (!bytes.length) return failed('unreachable');
    return { bytes, reason: '' };
  } catch {
    return failed('unreachable');
  } finally {
    clearTimeout(timeout);
  }
}

function hasOddEscapingBackslash(text: string, index: number) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) count += 1;
  return count % 2 === 1;
}

export function escapeLatexBackslashesInJson(value: unknown, { broad = false } = {}) {
  const text = String(value || '');
  let output = '';
  let mathDelimiter = '';
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] === '$' && !hasOddEscapingBackslash(text, cursor)) {
      const delimiter = text.startsWith('$$', cursor) ? '$$' : '$';
      if (!mathDelimiter) mathDelimiter = delimiter;
      else if (mathDelimiter === delimiter) mathDelimiter = '';
      output += delimiter;
      cursor += delimiter.length;
      continue;
    }
    if (text[cursor] !== '\\') {
      output += text[cursor];
      cursor += 1;
      continue;
    }

    let runEnd = cursor;
    while (text[runEnd] === '\\') runEnd += 1;
    const slashCount = runEnd - cursor;
    output += '\\'.repeat(slashCount);
    if (slashCount % 2 === 1) {
      const tail = text.slice(runEnd);
      const next = tail[0] || '';
      const command = tail.match(/^([A-Za-z]+)/)?.[1] || '';
      const validUnicodeEscape = next === 'u' && /^[0-9a-fA-F]{4}/.test(tail.slice(1, 5));
      const validJsonEscape = /["\\/bfnrt]/.test(next) || validUnicodeEscape;
      const latexSpecial = /[()[\]{}%_,;:!$]/.test(next);
      const knownLatexCommand = LATEX_JSON_COMMANDS.has(command);
      const broadCommand = broad && command.length > 1;
      if (mathDelimiter || latexSpecial || knownLatexCommand || broadCommand || !validJsonEscape) {
        output += '\\';
      }
    }
    cursor = runEnd;
  }
  return output;
}

function providerQuotaCode(payload: unknown) {
  const detail = JSON.stringify(payload || {}).toLowerCase();
  return /per.?day|requests.?per.?day|rpd|generatedrequestsperday/.test(detail)
    ? 'AI_QUOTA_EXHAUSTED'
    : 'AI_BUSY';
}

function parseRetryDelay(value: unknown) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)s$/i);
  return match ? Math.max(1, Math.ceil(Number(match[1]))) : 0;
}

export function getProviderRetry(payload: AIProviderPayload | null, retryAfterHeader: string | null = '', now = Date.now()) {
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
  const detailDelay = details
    .map(detail => parseRetryDelay(detail?.retryDelay))
    .find(Boolean);
  const headerSeconds = Number.parseInt(retryAfterHeader!, 10);
  const retryAfterSeconds = detailDelay || (Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : 60);
  return {
    resetAt: new Date(now + retryAfterSeconds * 1_000).toISOString(),
    retryAfterSeconds,
    scope: 'provider-rate',
  };
}

export function classifyGeminiError(status: number, payload: unknown) {
  if (status === 429) return providerQuotaCode(payload);
  const detail = JSON.stringify(payload || {}).toLowerCase();
  if ([400, 401, 403, 404].includes(status) && /api.?key|permission|model.+not found|not found.+model|unsupported model/.test(detail)) {
    return 'AI_NOT_CONFIGURED';
  }
  if (status === 503 || status === 529) return 'AI_BUSY';
  // A rejected request is deterministic: the lighter model will reject the very
  // same body, so this must not look retryable.
  if (status === 400) return 'AI_INVALID_REQUEST_UPSTREAM';
  return 'AI_UNAVAILABLE';
}

/**
 * A refusal from NaN as the error every AI route throws. Its spent allowance
 * is monthly, not daily like Gemini's, so the reset the reader is shown is
 * the first of next month (UTC).
 */
export function nanProviderError(response: Response, payload: AIProviderPayload | null) {
  const code = classifyNanError(response.status);
  const status = code === 'AI_NOT_CONFIGURED' ? 503 : code === 'AI_QUOTA_EXHAUSTED' || response.status === 429 ? 429 : 502;
  const quota = code === 'AI_QUOTA_EXHAUSTED'
    ? { ...getMonthlyBudgetReset(), scope: 'provider' }
    : code === 'AI_BUSY'
      ? getProviderRetry(payload, response.headers.get('retry-after'))
      : null;
  return new AIExplanationError(code, status, code, quota);
}

async function checkGeminiHealth(env: WorkerEnv) {
  const provider = 'gemini';
  const model = cleanText(env.AI_MODEL || DEFAULT_MODEL, 100) || DEFAULT_MODEL;
  if (!env.GEMINI_API_KEY) {
    return { provider, model, configured: false, available: false, code: 'AI_NOT_CONFIGURED' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      signal: controller.signal,
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
    });
    const payload = response.ok ? null : await response.json().catch(() => ({}));
    return {
      provider,
      model,
      configured: true,
      available: response.ok,
      code: response.ok ? null : classifyGeminiError(response.status, payload),
    };
  } catch {
    return { provider, model, configured: true, available: false, code: 'AI_UNAVAILABLE' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * A key that works and a model name NaN does not serve would otherwise only
 * show up as the first reader's failed rewrite, so the configured model has to
 * be on the list, not merely the list reachable. `paperText` says whether the
 * Workers AI binding that turns PDFs into text is there: without it every
 * rewrite falls back to NaN reading the PDF itself, which works but is slow.
 */
async function checkNanHealth(env: WorkerEnv) {
  const provider = 'nan';
  const model = nanModel(env);
  const paperText = typeof env.AI?.toMarkdown === 'function';
  if (!isNanConfigured(env)) {
    return { provider, model, paperText, configured: false, available: false, code: 'AI_NOT_CONFIGURED' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${NAN_API_BASE_URL}/models`, {
      signal: controller.signal,
      headers: nanHeaders(env),
    });
    if (!response.ok) {
      return { provider, model, paperText, configured: true, available: false, code: classifyNanError(response.status) };
    }
    const payload = await response.json<{ data?: Array<{ id?: unknown }> }>().catch((): { data?: Array<{ id?: unknown }> } => ({}));
    const served = Array.isArray(payload?.data) && payload.data.some(entry => entry?.id === model);
    return {
      provider,
      model,
      paperText,
      configured: true,
      available: served,
      code: served ? null : 'AI_NOT_CONFIGURED',
    };
  } catch {
    return { provider, model, paperText, configured: true, available: false, code: 'AI_UNAVAILABLE' };
  } finally {
    clearTimeout(timeout);
  }
}

const HEALTH_CHECKS: Partial<Record<string, typeof checkGeminiHealth | typeof checkNanHealth>> = {
  gemini: checkGeminiHealth,
  nan: checkNanHealth,
};

export async function checkAIProviderHealth(env: WorkerEnv): Promise<{ provider: string; model: string; configured: boolean; available: boolean; code: string | null; paperText?: boolean }> {
  const provider = cleanText(env.AI_PROVIDER || 'gemini', 40).toLowerCase();
  return HEALTH_CHECKS[provider]
    ? HEALTH_CHECKS[provider](env)
    : { provider, model: '', configured: false, available: false, code: 'AI_NOT_CONFIGURED' };
}

/**
 * Accounts the per-user daily allowance does not apply to.
 *
 * A wrangler secret rather than a `[vars]` entry in `wrangler.toml`: the repo
 * already carries an admin uid with the note that a uid is not a secret, and an
 * email is not the same thing. Matched against the *verified* address only —
 * an unverified email is a claim, and this is the one place in the Worker where
 * a claim would buy something.
 *
 * The global daily ceiling still applies. That one is not a product limit, it is
 * the cost ceiling on the provider key, and an exemption from it is how a
 * runaway loop becomes a bill.
 */
export function hasUnlimitedAI(env: WorkerEnv, identity: Partial<VerifiedIdentity> | null | undefined) {
  if (!identity?.emailVerified || !identity.email) return false;
  const allowed = String(env.AI_UNLIMITED_EMAILS || '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(identity.email);
}

/**
 * The verified identity, plus whether the daily allowance applies to it.
 *
 * Replaced a `verifyFirebaseUser` that returned a bare uid: every AI route now
 * has to know *which* account is asking, not merely that some account is, and a
 * second lookup to find out would have doubled the Identity Toolkit traffic in
 * front of every protected route.
 */
export async function verifyFirebaseAccount(request: Request, env: WorkerEnv) {
  try {
    const identity = await verifyFirebaseIdentity(request, env);
    return { ...identity, unlimitedAI: hasUnlimitedAI(env, identity) };
  } catch (error) {
    if (error instanceof WorkerAuthError) {
      // Both of the verifier's 503s used to arrive as `AI_NOT_CONFIGURED`, and
      // the reader's copy for that code says the feature is not switched on
      // here — no retry offered. Only a missing key is actually that; Identity
      // Toolkit being briefly unreachable is an outage, and this verifier sits
      // in front of every AI route, so the whole feature read as "never coming"
      // for as long as Google was down.
      const code = error.status !== 503
        ? 'AI_AUTH_REQUIRED'
        : error.code === 'AUTH_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE';
      throw new AIExplanationError(code, error.status);
    }
    throw error;
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyQuotaReset(now = Date.now()) {
  const current = new Date(now);
  const resetAt = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() + 1,
  );
  return {
    resetAt: new Date(resetAt).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - current.getTime()) / 1_000)),
  };
}

/**
 * Failures that are not the user's doing give the daily use back. What is left
 * out matters as much: `AI_INVALID_RESPONSE` and `AI_INVALID_REQUEST_UPSTREAM`
 * mean the provider did process the request, and refunding those would hand out
 * unlimited free retries against its quota.
 */
const REFUNDABLE_AI_CODES = new Set([
  'AI_BUSY',
  'AI_UNAVAILABLE',
  'AI_NOT_CONFIGURED',
  // Only `/ai/rewrite` raises this one, and it raises it twice for two different
  // reasons: a paper with no PDF at all, refused before anything is reserved,
  // and a PDF that would not download, discovered after. This predicate is
  // consulted only past the reservation, so the case it sees here is always the
  // second — the source being unreachable.
  'AI_REWRITE_NEEDS_FULL_TEXT',
  // `AI_CLIENT_GONE` is deliberately absent. A reader that closes the tab
  // mid-rewrite got the answer it asked for and the provider billed for it;
  // refunding would make hanging up the cheapest way to retry for free.
]);

export function shouldRefundAIQuota(error: unknown) {
  // A crash of ours is never the user's fault either.
  if (!(error instanceof AIExplanationError)) return true;
  // Past the reservation this can only be the provider's daily wall, never the
  // user's own — that one is refused before anything is counted.
  if (error.code === 'AI_QUOTA_EXHAUSTED') return error.quota?.scope !== 'user';
  return REFUNDABLE_AI_CODES.has(error.code);
}

/**
 * The daily allowance as it stands, without touching it.
 *
 * Split out from `reserveAIQuota` rather than derived from it because the reader
 * needs the number *before* it decides to spend one: the rewrite shows how many
 * uses are left, and reserving to find out would cost a use per look. The limit
 * travels with the answer so the client does not have to hardcode a ten it does
 * not own.
 */
export async function peekAIQuota(env: WorkerEnv, uid: string, { unlimited = false } = {}) {
  const globalLimit = safeInteger(env.AI_DAILY_GLOBAL_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT, 1, 100_000);
  // An exempt account is not given a separate code path: its per-user ceiling is
  // simply raised to the global one, so the ledger still counts what it spends
  // and the only thing that can refuse it is the cost ceiling.
  const subjectLimit = unlimited
    ? globalLimit
    : safeInteger(env.AI_DAILY_USER_LIMIT, DEFAULT_USER_DAILY_LIMIT, 1, 100);
  const reading = await peekRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `ai:${todayKey()}`,
    subject: `ai:${uid}`,
    subjectLimit,
    globalLimit,
  });
  if (reading.code) {
    throw reading.code === 'QUOTA_LEDGER_NOT_CONFIGURED'
      ? new AIExplanationError('AI_NOT_CONFIGURED', 503)
      : new AIExplanationError('AI_UNAVAILABLE', 503);
  }
  return {
    remainingUses: Math.max(0, Number(reading.remaining) || 0),
    dailyLimit: subjectLimit,
    // Said plainly rather than left for the client to infer from a suspiciously
    // round number: a reader showing "1000/1000 today" is telling the truth in a
    // way nobody reads as "no limit".
    ...(unlimited ? { unlimited: true } : {}),
    ...getDailyQuotaReset(),
  };
}

export async function reserveAIQuota(env: WorkerEnv, uid: string, { unlimited = false } = {}) {
  const globalLimit = safeInteger(env.AI_DAILY_GLOBAL_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT, 1, 100_000);
  // The day is fixed once and travels with the reservation: recomputing it at
  // release time would refund against tomorrow's ledger for a request that
  // straddles UTC midnight.
  const ledgerRequest = {
    periodKey: `ai:${todayKey()}`,
    subject: `ai:${uid}`,
    subjectLimit: unlimited
      ? globalLimit
      : safeInteger(env.AI_DAILY_USER_LIMIT, DEFAULT_USER_DAILY_LIMIT, 1, 100),
    globalLimit,
  };
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, ledgerRequest);
  if (!reservation.accepted && reservation.code) {
    // A ledger that is merely unreachable is a transient outage worth retrying;
    // only a missing binding means the feature is not configured.
    throw reservation.code === 'QUOTA_LEDGER_NOT_CONFIGURED'
      ? new AIExplanationError('AI_NOT_CONFIGURED', 503)
      : new AIExplanationError('AI_UNAVAILABLE', 503);
  }
  if (!reservation.accepted) {
    throw new AIExplanationError('AI_QUOTA_EXHAUSTED', 429, 'AI_QUOTA_EXHAUSTED', {
      ...getDailyQuotaReset(),
      scope: reservation.scope || 'global',
      ...(reservation.scope === 'user' ? { remainingUses: 0 } : {}),
    });
  }
  return { remainingUses: reservation.remaining, ledgerRequest };
}

/**
 * Gives back exactly what `reserveAIQuota` took. `quota` has to be the handle it
 * returned rather than a freshly built one: the ledger request inside it carries
 * the day the use was charged to, so a request that started before UTC midnight
 * and failed after it still credits yesterday.
 *
 * Exported because `/ai/rewrite` and `/ai/annotate` reserve against the same
 * daily ledger.
 */
export async function releaseAIQuota(env: WorkerEnv, quota: { ledgerRequest: QuotaRequest }) {
  try {
    await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, quota.ledgerRequest);
  } catch {
    // A refund that cannot be delivered must not replace the real error.
  }
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
