import { isAIReadablePdfUrl } from '../utils/aiExplanationAccess.js';
import { authenticatedWorkerFetch } from './workerApiClient.js';

/**
 * Client for the streaming paper rewrite.
 *
 * The worker answers with NDJSON, one line per event, so sections can be shown
 * while the rest of the paper is still being written. Callers get an
 * `onSection` callback rather than a resolved array; the returned promise only
 * settles when the stream ends.
 *
 * Completed rewrites are also kept in memory per (paper, level, language), so
 * flipping between levels a second time is instant.
 */

const rewriteCache = new Map();

/**
 * No bytes for this long means the stream is dead, not slow. The worker sends a
 * heartbeat every 8s while the model is still thinking, so real silence this
 * long means the connection is gone rather than the paper being long.
 */
const STALL_TIMEOUT_MS = 45_000;

export const PAPER_REWRITE_LEVELS = Object.freeze([
  { id: 'beginner', label: 'Principiante', labelEn: 'Beginner' },
  { id: 'university', label: 'Universitario', labelEn: 'University' },
  { id: 'researcher', label: 'Investigador', labelEn: 'Researcher' },
]);

export class PaperRewriteError extends Error {
  constructor(code, quota = null, { partial = false } = {}) {
    super(code);
    this.name = 'PaperRewriteError';
    this.code = code;
    this.quota = quota;
    this.partial = partial;
  }
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function paperCacheId(paper) {
  return cleanText(paper?.id || paper?.doi || paper?.arxivId || paper?.title, 500).toLowerCase();
}

/**
 * The rewrite needs a PDF the worker is actually allowed to read, which is why
 * an abstract is not enough here — unlike the old explainer.
 */
export function getRewritablePdfUrl(paper) {
  const candidates = [paper?.openAccessPdfUrl];
  if (paper?.arxivId) {
    const arxivId = String(paper.arxivId).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
    candidates.push(`https://arxiv.org/pdf/${arxivId}.pdf`);
  }
  if (paper?.openAccess && paper?.pdfUrl) candidates.push(paper.pdfUrl);
  if (paper?.pmcid) candidates.push(`https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(paper.pmcid)}/pdf/`);
  return candidates.find(isAIReadablePdfUrl) || '';
}

export function canRewritePaper(paper) {
  return Boolean(getRewritablePdfUrl(paper));
}

export function serializePaperForRewrite(paper) {
  return {
    id: cleanText(paper?.id, 400),
    title: cleanText(paper?.title, 1_000),
    abstract: cleanText(paper?.abstract || paper?.summary, 30_000),
    authors: Array.isArray(paper?.authors)
      ? paper.authors.slice(0, 30).map(author => ({ name: cleanText(author?.name || author, 160) }))
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

export function rewriteCacheKey(paper, level, language) {
  return `${paperCacheId(paper)}:${level}:${language}`;
}

export function getCachedRewrite(paper, level, language = 'es') {
  return rewriteCache.get(rewriteCacheKey(paper, level, language)) || null;
}

/**
 * Splits an incoming byte stream into complete NDJSON events, holding any
 * partial trailing line until its newline arrives.
 */
export function createNdjsonParser() {
  let buffer = '';
  const parse = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  };
  return {
    push(text) {
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

export async function rewritePaper(paper, level = 'university', {
  language = 'es',
  force = false,
  signal,
  onMeta,
  onSection,
} = {}) {
  if (!PAPER_REWRITE_LEVELS.some(item => item.id === level)) {
    throw new PaperRewriteError('AI_INVALID_LEVEL');
  }
  const rewriteLanguage = language === 'en' ? 'en' : 'es';
  const cacheKey = rewriteCacheKey(paper, level, rewriteLanguage);

  if (!force && rewriteCache.has(cacheKey)) {
    const cached = rewriteCache.get(cacheKey);
    onMeta?.({ ...cached.meta, cached: true, remainingUses: null });
    cached.sections.forEach((section, index) => onSection?.(section, index));
    return cached;
  }

  if (!canRewritePaper(paper)) throw new PaperRewriteError('AI_REWRITE_NEEDS_FULL_TEXT');

  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) throw new PaperRewriteError('AI_NOT_CONFIGURED');

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  // A stall timer rather than a total deadline: a long paper is allowed to take
  // its time as long as bytes keep arriving.
  let stallTimer = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };

  let meta = null;
  const sections = [];
  let streamError = null;

  try {
    resetStallTimer();
    const response = await authenticatedWorkerFetch(`${apiBase}/ai/rewrite`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paper: serializePaperForRewrite(paper),
        level,
        language: rewriteLanguage,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new PaperRewriteError(payload.code || 'AI_UNAVAILABLE', payload.quota || null);
    }
    if (!response.body) throw new PaperRewriteError('AI_UNAVAILABLE');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createNdjsonParser();

    const handleEvent = (event) => {
      if (event.type === 'meta') {
        meta = event;
        onMeta?.(event);
        return;
      }
      if (event.type === 'section') {
        const section = {
          id: event.id,
          kind: event.kind,
          heading: event.heading,
          originalHeading: event.originalHeading,
          paragraphs: Array.isArray(event.paragraphs) ? event.paragraphs : [],
          highlights: Array.isArray(event.highlights) ? event.highlights : [],
        };
        onSection?.(section, sections.length);
        sections.push(section);
        return;
      }
      if (event.type === 'error') {
        streamError = new PaperRewriteError(
          event.code || 'AI_UNAVAILABLE',
          event.quota || null,
          { partial: Boolean(event.partial) },
        );
        if (event.finishReason) streamError.finishReason = event.finishReason;
      }
      // `ping` frames carry no content; receiving one is the point.
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

    const result = { meta: meta || { level, language: rewriteLanguage }, sections };
    // A stream cut short is still worth showing, but must not be cached as if
    // it were the whole paper.
    if (!streamError) rewriteCache.set(cacheKey, result);
    return { ...result, incomplete: Boolean(streamError) };
  } catch (error) {
    if (error instanceof PaperRewriteError) throw error;
    if (error?.name === 'AbortError') {
      throw new PaperRewriteError(signal?.aborted ? 'AI_CANCELLED' : 'AI_TIMEOUT');
    }
    if (error?.name === 'WorkerApiAuthError') throw new PaperRewriteError('AI_AUTH_REQUIRED');
    throw new PaperRewriteError('AI_UNAVAILABLE');
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
