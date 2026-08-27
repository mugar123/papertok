import { authenticatedWorkerFetch } from './workerApiClient.js';

/**
 * Asks the model what one passage means.
 *
 * The thin sibling of `paperRewriteService`: one request, one short answer, no
 * stream. It is asked mid-read, with the reader's finger still on the sentence,
 * so everything here is sized for a wait measured in seconds rather than in
 * minutes — a plain POST, a client deadline well inside the Worker's own, and
 * an error vocabulary shared with the rewrite so the reader only ever learns
 * one set of words for "the AI could not".
 */

/**
 * The Worker gives the model 14s and needs a moment either side to reserve the
 * quota and serialise. Past this the answer is not coming, and a spinner that
 * outlives its request is the thing that makes a feature feel broken.
 */
const ANNOTATION_TIMEOUT_MS = 20_000;

/** Below this a selection does not identify a passage; the anchor agrees. */
export const MIN_ANNOTATABLE_CHARS = 8;

export class PaperAnnotationError extends Error {
  constructor(code, quota = null) {
    super(code);
    this.name = 'PaperAnnotationError';
    this.code = code;
    this.quota = quota;
  }
}

export function canAnnotatePassage(quote) {
  return String(quote || '').trim().length >= MIN_ANNOTATABLE_CHARS;
}

/**
 * @returns {Promise<{note: string, model: string, remainingUses: number|null}>}
 */
export async function annotatePassage(paper, {
  quote,
  context = '',
  level = 'university',
  language = 'es',
  signal,
} = {}) {
  if (!canAnnotatePassage(quote)) throw new PaperAnnotationError('AI_INVALID_REQUEST');
  // A signal that already fired will never fire again, so the listener below
  // would never run and the POST would spend one of the day's uses on an answer
  // nobody is waiting for. Everything up to the request is synchronous, so this
  // is the only place an early abort can still be caught.
  if (signal?.aborted) throw new PaperAnnotationError('AI_CANCELLED');

  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) throw new PaperAnnotationError('AI_NOT_CONFIGURED');

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const deadline = setTimeout(() => controller.abort(), ANNOTATION_TIMEOUT_MS);

  try {
    const response = await authenticatedWorkerFetch(`${apiBase}/ai/annotate`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paper: { title: String(paper?.title || '').slice(0, 1_000) },
        quote: String(quote).slice(0, 600),
        // The paragraph the passage came from. Without it the model is asked to
        // explain a fragment whose subject is in the sentence before it.
        context: String(context || '').slice(0, 4_000),
        level,
        language: language === 'en' ? 'en' : 'es',
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new PaperAnnotationError(payload.code || 'AI_UNAVAILABLE', payload.quota || null);
    }
    const payload = await response.json().catch(() => null);
    const note = String(payload?.note || '').trim();
    if (!note) throw new PaperAnnotationError('AI_EMPTY_RESPONSE');
    return {
      note,
      model: String(payload?.model || ''),
      remainingUses: typeof payload?.remainingUses === 'number' ? payload.remainingUses : null,
    };
  } catch (error) {
    if (error instanceof PaperAnnotationError) throw error;
    if (error?.name === 'AbortError') {
      throw new PaperAnnotationError(signal?.aborted ? 'AI_CANCELLED' : 'AI_TIMEOUT');
    }
    if (error?.name === 'WorkerApiAuthError') throw new PaperAnnotationError('AI_AUTH_REQUIRED');
    throw new PaperAnnotationError('AI_UNAVAILABLE');
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
