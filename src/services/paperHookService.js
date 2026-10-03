import { trustedWorkerUrl } from './workerApiClient.js';

/**
 * The feed card's "why it matters" line, asked of the Worker ahead of time.
 *
 * A card decides what it shows when it mounts and does not change its mind
 * afterwards (AGENTS.md, invariant 7): a sentence that dropped in above the
 * abstract a second after the card arrived would shove the text the reader had
 * started on. So the feed asks for the next few cards while the reader is still
 * on the current one, and a card only reads what is already here, through
 * `peekPaperHook`. A card whose line has not arrived yet keeps its abstract.
 *
 * `null` and `''` are different answers, as with figures: `''` is a paper the
 * Worker has already declined (no usable abstract, allowance spent), and must
 * not be asked about again this session.
 */

const hookCache = new Map();
/** id -> the in-flight batch that will answer it. */
const pending = new Map();
const listeners = new Set();
const BATCH_SIZE = 6;
const REQUEST_TIMEOUT_MS = 15_000;
/** Mirrors `MIN_HOOK_ABSTRACT_CHARS` in `worker/ai-hooks.js`: shorter ones are never answered. */
export const MIN_HOOK_ABSTRACT_CHARS = 200;

export function paperHookId(paper) {
  return String(paper?.id || paper?.doi || paper?.arxivId || '').trim();
}

export function canHaveHook(paper) {
  return Boolean(paperHookId(paper) && paper?.title && String(paper?.abstract || '').trim().length >= MIN_HOOK_ABSTRACT_CHARS);
}

/** What is already known for this paper: the sentence, `''` for none, `null` for not asked yet. */
export function peekPaperHook(paper) {
  const id = paperHookId(paper);
  if (!id || !hookCache.has(id)) return null;
  return hookCache.get(id);
}

async function requestBatch(url, papers, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        papers: papers.map(paper => ({
          id: paperHookId(paper),
          title: String(paper.title).slice(0, 400),
          abstract: String(paper.abstract).slice(0, 4_000),
        })),
      }),
    });
    if (!response.ok) return;
    const payload = await response.json();
    const hooks = payload?.hooks && typeof payload.hooks === 'object' ? payload.hooks : {};
    // Only a real answer is remembered, and it covers every paper that was
    // asked about: the ones the Worker left out were declined, not lost.
    for (const paper of papers) {
      const text = hooks[paperHookId(paper)];
      hookCache.set(paperHookId(paper), typeof text === 'string' ? text.trim() : '');
    }
    listeners.forEach(listener => listener());
  } catch {
    // A network failure leaves them unasked, so a later prefetch tries again.
  } finally {
    clearTimeout(timeout);
    for (const paper of papers) pending.delete(paperHookId(paper));
  }
}

/**
 * Asks for the lines of the papers that could have one and have not been asked
 * about. Resolves when every one of them is answered — including the ones
 * another call already had in flight — and never rejects.
 */
export function prefetchPaperHooks(papers = [], {
  // Test seams. In the app the endpoint is the configured Worker, checked by
  // `trustedWorkerUrl` like every other Worker call.
  endpoint,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(import.meta.env?.VITE_PAPER_API_BASE_URL || '').replace(/\/$/, '');
  const url = endpoint || (base ? trustedWorkerUrl(`${base}/ai/hooks`) : null);
  if (!url) return Promise.resolve();

  const wanted = [];
  const inFlight = new Set();
  const seen = new Set();
  for (const paper of papers) {
    const id = paperHookId(paper);
    if (!canHaveHook(paper) || seen.has(id) || hookCache.has(id)) continue;
    seen.add(id);
    if (pending.has(id)) inFlight.add(pending.get(id));
    else wanted.push(paper);
  }

  const batches = [...inFlight];
  for (let index = 0; index < wanted.length; index += BATCH_SIZE) {
    const batch = wanted.slice(index, index + BATCH_SIZE);
    const request = requestBatch(url, batch, fetchImpl);
    batch.forEach(paper => pending.set(paperHookId(paper), request));
    batches.push(request);
  }
  return Promise.all(batches).then(() => undefined);
}

/**
 * Called whenever answers arrive. For cards that are mounted but not yet on
 * screen: they may still take a line that arrived late, and stop listening the
 * moment they become the card being read.
 */
export function subscribePaperHooks(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget everything. */
export function resetPaperHookCache() {
  hookCache.clear();
  pending.clear();
}
