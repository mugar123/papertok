import type { Paper, PaperAuthor } from '../models/paper.ts';
import type { AIQuota, RewriteMeta, RewriteSection } from '../models/rewrite.ts';
export type { RewriteSection } from '../models/rewrite.ts';
type RewritePaperInput = Partial<Paper> & { journalRef?: string };
export type ClientRewriteMeta = Pick<RewriteMeta, 'level' | 'language'> & Partial<RewriteMeta> & { cached?: boolean; remainingUses?: number | null };
export interface RewriteResult { meta: ClientRewriteMeta; sections: RewriteSection[]; incomplete?: boolean }
type RewriteEvent = ({ type: 'meta' } & ClientRewriteMeta) | ({ type: 'section' } & RewriteSection)
  | { type: 'error'; code?: string; quota?: AIQuota | null; partial?: boolean; finishReason?: string }
  | { type: 'ping'; stage?: string } | { type: 'done'; sectionCount?: number; truncated?: boolean };
interface RewriteOptions {
  language?: string;
  /**
   * Retry a rewrite that failed: skips the copies kept in memory and in the
   * account, and lets the worker replace a cached one that stopped early.
   */
  force?: boolean;
  /** Write the paper again although a copy exists, replacing the saved one. */
  regenerate?: boolean;
  /** Whose saved summaries to read and add to; a guest has none. */
  uid?: string | null;
  signal?: AbortSignal;
  /** Called once, just before the request that reaches the worker. */
  onRequest?: () => void;
  onMeta?: (meta: ClientRewriteMeta) => void;
  onSection?: (section: RewriteSection, index: number) => void;
  onProgress?: (progress: { stage: string }) => void;
}

import { toRewriteSection } from '../models/rewrite.ts';
import { isAIReadablePdfUrl } from '../utils/ai-explanation-access.ts';
import { isTransientReadError } from '../utils/bounded-read.ts';
import { accessStatusForPaper } from '../utils/paper-status.ts';
import { getSavedSummary, saveSummary } from './saved-summary-service.ts';
import { authenticatedWorkerFetch } from './worker-api-client.ts';

/**
 * Client for the streaming paper rewrite.
 *
 * The worker answers with NDJSON, one line per event, so sections can be shown
 * while the rest of the paper is still being written. Callers get an
 * `onSection` callback rather than a resolved array; the returned promise only
 * settles when the stream ends.
 *
 * Completed rewrites are also kept in memory per (paper, level, language), so
 * flipping between levels a second time is instant, and, for a signed-in
 * reader, in their account (savedSummaryService), so opening the paper again
 * another day neither calls the worker nor spends a use.
 */

const rewriteCache = new Map<string, RewriteResult>();
// Moves on with every change of account, so a rewrite still streaming for the
// previous one cannot land in the memory the next one reads.
let rewriteCacheAccount = 0;

export type AIUses = { remainingUses: number; dailyLimit: number | null; unlimited?: boolean };
const lastAIUses = new Map<string, AIUses>();

/**
 * Forgets the rewrites and uses counts held in memory. They are the signed-in
 * account's, and would otherwise stand in front of the next account's own.
 */
export function clearRewriteCache() {
  rewriteCache.clear();
  lastAIUses.clear();
  rewriteCacheAccount += 1;
}

/**
 * No bytes for this long means the stream is dead, not slow. The worker sends a
 * heartbeat every 8s while the model is still thinking, so real silence this
 * long means the connection is gone rather than the paper being long.
 */
const STALL_TIMEOUT_MS = 45_000;

export const PAPER_REWRITE_LEVELS = Object.freeze([
  { id: 'beginner', label: 'Beginner' },
  { id: 'university', label: 'University' },
  { id: 'researcher', label: 'Researcher' },
]);

export class PaperRewriteError extends Error {
  declare code: string | undefined;
  declare quota: AIQuota | null;
  declare partial: boolean;
  declare finishReason?: string;
  constructor(code: string|undefined, quota: AIQuota | null = null, { partial = false } = {}) {
    super(code);
    this.name = 'PaperRewriteError';
    this.code = code;
    this.quota = quota;
    this.partial = partial;
  }
}

function cleanText(value: unknown, maxLength: number) {
  return String(value || '').trim().slice(0, maxLength);
}

function paperCacheId(paper: RewritePaperInput | null | undefined) {
  return cleanText(paper?.id || paper?.doi || paper?.arxivId || paper?.title, 500).toLowerCase();
}

/**
 * The rewrite needs a PDF the worker is actually allowed to read, which is why
 * an abstract is not enough here — unlike the old explainer.
 */
export function getRewritablePdfUrl(paper: RewritePaperInput | null | undefined) {
  const candidates = [paper?.openAccessPdfUrl];
  if (paper?.arxivId) {
    const arxivId = String(paper.arxivId).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
    candidates.push(`https://arxiv.org/pdf/${arxivId}.pdf`);
  }
  // The access chip's rule (`accessStatusForPaper`). A stored copy keeps its
  // open PDF as `pdfUrl` but no access field, and must not read "Open access"
  // while the rewrite refuses that PDF.
  if (paper?.pdfUrl && accessStatusForPaper(paper) === 'open') candidates.push(paper.pdfUrl);
  // Europe PMC rather than PMC itself: `pmc.ncbi.nlm.nih.gov/articles/<id>/pdf/`
  // answers anything without a browser with a 1.8 KB HTML interstitial, so the
  // worker downloaded a "preparing to download" page and reported every PubMed
  // paper as having no full text. The Europe PMC render of the same article
  // serves `application/pdf` on the first response.
  if (paper?.pmcid) candidates.push(`https://europepmc.org/articles/${encodeURIComponent(paper.pmcid)}?pdf=render`);
  return candidates.find(isAIReadablePdfUrl) || '';
}

/**
 * How many of the day's AI uses are left, without spending one.
 *
 * The rewrite already reports `remainingUses` on the `meta` line, but only once
 * a rewrite is under way — which is to say, only after it has cost a use, and
 * never at all when the answer comes from cache or the request fails. The reader
 * shows the number the moment it opens, so it needs a way to ask.
 *
 * Returns `null` rather than throwing: a reader that cannot show the count is
 * still a working reader, and this must never be the thing that breaks it.
 */
export async function fetchRemainingAIUses({ signal }: { signal?: AbortSignal } = {}) {
  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) return null;
  try {
    const response = await authenticatedWorkerFetch(`${apiBase}/ai/quota`, { method: 'GET', signal });
    if (!response.ok) return null;
    const payload = await response.json() as { remainingUses?: unknown; dailyLimit?: unknown; unlimited?: unknown };
    const remainingUses = Number(payload?.remainingUses);
    const dailyLimit = Number(payload?.dailyLimit);
    if (!Number.isFinite(remainingUses) || !Number.isFinite(dailyLimit)) return null;
    // An exempt account has a ceiling too — the global one — but showing it as
    // "993/1000 today" would be a true sentence nobody reads as "no limit".
    return { remainingUses, dailyLimit, unlimited: payload?.unlimited === true };
  } catch {
    return null;
  }
}


/**
 * The count this tab last heard for the account, so the reader opens with its
 * pill instead of growing it a round trip later. The reader still asks again.
 */
export function lastKnownAIUses(uid: string | null | undefined) {
  return (uid && lastAIUses.get(uid)) || null;
}

export function rememberAIUses(uid: string, uses: AIUses) {
  lastAIUses.set(uid, uses);
}

/**
 * Asks once per account and tab, ahead of the first reader. An answer that
 * lands after the account changed carried whichever token was current, so it
 * is dropped.
 */
export function primeAIUses(uid: string) {
  if (lastKnownAIUses(uid)) return;
  const account = rewriteCacheAccount;
  void fetchRemainingAIUses().then(uses => {
    if (uses && account === rewriteCacheAccount && !lastKnownAIUses(uid)) rememberAIUses(uid, uses);
  });
}

export function canRewritePaper(paper: RewritePaperInput | null | undefined) {
  return Boolean(getRewritablePdfUrl(paper));
}

export function serializePaperForRewrite(paper: RewritePaperInput | null | undefined) {
  return {
    id: cleanText(paper?.id, 400),
    title: cleanText(paper?.title, 1_000),
    abstract: cleanText(paper?.abstract || paper?.summary, 30_000),
    authors: Array.isArray(paper?.authors)
      ? paper.authors.slice(0, 30).map(author => ({ name: cleanText((author as PaperAuthor)?.name || author, 160) }))
      : [],
    year: paper?.year || (paper?.published ? new Date(paper.published).getFullYear() : null),
    doi: cleanText(paper?.doi, 300),
    arxivId: cleanText(paper?.arxivId, 100),
    journal: cleanText(paper?.journal || paper?.journalRef, 300),
    categories: Array.isArray(paper?.categories)
      ? paper.categories.slice(0, 20)
      : [paper?.primaryCategory].filter(Boolean),
    pdfUrl: getRewritablePdfUrl(paper),
  };
}

/**
 * Identifies a rewrite by what actually makes one different from another. The
 * paper half is derived from `id || doi || arxivId || title` rather than from
 * the object, so a caller handed a freshly rebuilt `paper` with the same
 * contents can tell that it is not looking at a new request.
 */
export function rewriteCacheKey(paper: RewritePaperInput | null | undefined, level: string, language: string) {
  return `${paperCacheId(paper)}:${level}:${language}`;
}

export function getCachedRewrite(paper: RewritePaperInput | null | undefined, level: string, language = 'en') {
  return rewriteCache.get(rewriteCacheKey(paper, level, language)) || null;
}

/**
 * Splits an incoming byte stream into complete NDJSON events, holding any
 * partial trailing line until its newline arrives.
 */
export function createNdjsonParser<T = unknown>() {
  let buffer = '';
  const parse = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return null;
    }
  };
  return {
    push(text: string) {
      buffer += text;
      const events = [];
      let newlineAt = buffer.indexOf('\n');
      while (newlineAt !== -1) {
        const event = parse(buffer.slice(0, newlineAt));
        if (event) events.push(event);
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf('\n');
      }
      return events;
    },
    flush() {
      const event = parse(buffer);
      buffer = '';
      return event ? [event] : [];
    },
  };
}

/**
 * What a failure is called by the time the reader sees it.
 *
 * The worker names its own refusals and those arrive as `PaperRewriteError`
 * already; what this is for is the failures that never reach it. An expired or
 * revoked session fails inside `getIdToken`, before a single byte leaves the
 * browser, and collapsing that into `AI_UNAVAILABLE` told the reader that
 * something had broken and to try again — when trying again was the one thing
 * that could not work, and signing in was.
 */
export function toRewriteError(error: unknown, { cancelled = false } = {}) {
  if (error instanceof PaperRewriteError) return error;
  if ((error as { name?: string } | null)?.name === 'AbortError') {
    return new PaperRewriteError(cancelled ? 'AI_CANCELLED' : 'AI_TIMEOUT');
  }
  if ((error as { name?: string } | null)?.name === 'WorkerApiAuthError') return new PaperRewriteError('AI_AUTH_REQUIRED');
  // Firebase reports a revoked, expired or unreachable session through its own
  // `auth/*` codes, which never travel over the wire.
  if (typeof (error as { code?: unknown } | null)?.code === 'string' && (error as { code: string }).code.startsWith('auth/')) {
    return new PaperRewriteError('AI_AUTH_REQUIRED');
  }
  return new PaperRewriteError('AI_UNAVAILABLE');
}

/**
 * What a stream that ended with sections may be kept as. A stream cut short is
 * still worth showing, but must not be cached or saved as if it were the whole
 * paper. Memory keeps it only if the account has not changed since the request,
 * and the account only if its saved copy was read (`keepInAccount`).
 */
export function rewriteKeeping({ failed, done, sectionCount, sameAccount, keepInAccount }: {
  failed: boolean;
  done: { sectionCount?: number; truncated?: boolean } | null;
  sectionCount: number;
  sameAccount: boolean;
  keepInAccount: boolean;
}) {
  const incomplete = failed || !done || done.sectionCount !== sectionCount || done.truncated === true;
  return { incomplete, cache: !incomplete && sameAccount, save: !incomplete && keepInAccount };
}

export async function rewritePaper(paper: RewritePaperInput, level = 'university', {
  force = false,
  regenerate = false,
  uid = null,
  signal,
  onMeta,
  onSection,
  onProgress,
  onRequest,
}: RewriteOptions = {}) {
  if (!PAPER_REWRITE_LEVELS.some(item => item.id === level)) {
    throw new PaperRewriteError('AI_INVALID_LEVEL');
  }
  // A signal that already fired will never fire again, so the listener installed
  // further down would never run: the POST would go out and burn one of the ten
  // daily uses on a stream the caller has already walked away from. Everything
  // between here and that POST is synchronous, so this is the only place where
  // an early abort can still be noticed.
  if (signal?.aborted) throw new PaperRewriteError('AI_CANCELLED');
  const rewriteLanguage = 'en';
  const cacheKey = rewriteCacheKey(paper, level, rewriteLanguage);
  const cacheAccount = rewriteCacheAccount;
  const reuse = !force && !regenerate;
  // A complete rewrite is kept in the account unless its copies could not be
  // read: a copy that was never read must not be written over.
  let keepInAccount = Boolean(uid);

  if (reuse && rewriteCache.has(cacheKey)) {
    const cached = rewriteCache.get(cacheKey)!;
    onMeta?.({ ...cached.meta, cached: true, remainingUses: null });
    cached.sections.forEach((section, index) => onSection?.(section, index));
    return cached;
  }

  if (reuse && uid) {
    onProgress?.({ stage: 'saved' });
    const saved = await getSavedSummary(uid, paper, level, { signal }).catch((error: unknown) => {
      if (signal?.aborted) throw new PaperRewriteError('AI_CANCELLED');
      console.warn('Could not read the saved summary', error);
      // Unknown is not absent. Asking the worker now could spend a use and
      // write a different copy over the saved one, for a reader who only
      // opened it, so the reader is offered this lookup again instead.
      if (isTransientReadError(error)) throw new PaperRewriteError('AI_SAVED_SUMMARY_READ_FAILED');
      // A refusal does not change on a retry, so offering one would leave the
      // reader without any summary: every signed-in reader between a frontend
      // deploy and the rules that allow this read. The worker answers as it
      // did before copies were kept, and this one is not kept either.
      keepInAccount = false;
      return null;
    });
    if (signal?.aborted) throw new PaperRewriteError('AI_CANCELLED');
    if (saved) {
      const meta = { level, language: rewriteLanguage, model: saved.model, sourceBasis: saved.sourceBasis };
      onMeta?.({ ...meta, cached: true, remainingUses: null });
      saved.sections.forEach((section, index) => onSection?.(section, index));
      return { meta, sections: saved.sections, incomplete: false };
    }
  }

  if (!canRewritePaper(paper)) throw new PaperRewriteError('AI_REWRITE_NEEDS_FULL_TEXT');

  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) throw new PaperRewriteError('AI_NOT_CONFIGURED');

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  // A stall timer rather than a total deadline: a long paper is allowed to take
  // its time as long as bytes keep arriving.
  let stallTimer: ReturnType<typeof setTimeout> | null | undefined = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };

  let meta: ClientRewriteMeta | null = null;
  const sections: RewriteSection[] = [];
  let streamError: PaperRewriteError | null = null;
  let completion: Extract<RewriteEvent, { type: 'done' }> | null = null;

  try {
    resetStallTimer();
    onRequest?.();
    const response = await authenticatedWorkerFetch(`${apiBase}/ai/rewrite`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paper: serializePaperForRewrite(paper),
        level,
        language: rewriteLanguage,
        retryIncomplete: force,
        ...(regenerate ? { regenerate: true } : {}),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { code?: string; quota?: AIQuota };
      throw new PaperRewriteError(payload.code || 'AI_UNAVAILABLE', payload.quota || null);
    }
    if (!response.body) throw new PaperRewriteError('AI_UNAVAILABLE');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createNdjsonParser<RewriteEvent>();

    const handleEvent = (event: RewriteEvent) => {
      if (event.type === 'meta') {
        meta = event;
        onMeta?.(event);
        // The first ping is eight seconds out; without this the reader would
        // spend those eight seconds on a generic label.
        onProgress?.({ stage: 'source' });
        return;
      }
      if (event.type === 'section') {
        const section = toRewriteSection(event);
        // A section the reader cannot lay out is not counted, so the `done`
        // count no longer matches and the rewrite reads as incomplete.
        if (!section) return;
        onSection?.(section, sections.length);
        sections.push(section);
        onProgress?.({ stage: 'writing' });
        return;
      }
      if (event.type === 'error') {
        streamError = new PaperRewriteError(
          event.code || 'AI_UNAVAILABLE',
          event.quota || null,
          { partial: Boolean(event.partial) },
        );
        if (event.finishReason) streamError.finishReason = event.finishReason;
        return;
      }
      if (event.type === 'done') {
        completion = event;
        return;
      }
      // A `ping` carries no rewrite, and receiving one is most of the point: it
      // is what keeps the stall timer above from firing while the worker is
      // downloading the paper and the model is reading it. What it does carry is
      // which of those two the wait is currently in, which is the difference
      // between a minute that looks broken and a minute that looks busy.
      if (event.type === 'ping') {
        onProgress?.({ stage: event.stage || 'reading' });
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStallTimer();
      parser.push(decoder.decode(value, { stream: true })).forEach(handleEvent);
    }
    parser.flush().forEach(handleEvent);

    if (streamError && sections.length === 0) throw streamError;
    if (sections.length === 0) throw new PaperRewriteError('AI_INVALID_RESPONSE');

    const result: RewriteResult = { meta: meta || { level, language: rewriteLanguage }, sections };
    const keeping = rewriteKeeping({
      failed: Boolean(streamError),
      done: completion,
      sectionCount: sections.length,
      sameAccount: cacheAccount === rewriteCacheAccount,
      keepInAccount,
    });
    if (keeping.cache) rewriteCache.set(cacheKey, result);
    if (keeping.save) {
      void saveSummary(uid, paper, level, {
        sections,
        model: result.meta.model || '',
        sourceBasis: result.meta.sourceBasis || '',
        promptVersion: result.meta.promptVersion || '',
      }, getRewritablePdfUrl(paper));
    }
    return { ...result, incomplete: keeping.incomplete };
  } catch (error) {
    const failure = toRewriteError(error, { cancelled: Boolean(signal?.aborted) });
    if (sections.length > 0 && failure.code !== 'AI_CANCELLED') {
      return { meta: meta || { level, language: rewriteLanguage }, sections, incomplete: true };
    }
    throw failure;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
