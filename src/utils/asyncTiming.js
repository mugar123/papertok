export async function settleWithin(promise, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason }),
      ),
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve({ status: 'timed_out' }), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function resolveWithin(promise, timeoutMs, fallbackValue) {
  const result = await settleWithin(promise, timeoutMs);
  return result.status === 'fulfilled' ? result.value : fallbackValue;
}

export function fulfilledPaperLists(results) {
  return (Array.isArray(results) ? results : []).flatMap((result) => (
    result?.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
  ));
}

/**
 * How long `all` below may wait for the sources after the first-paint budget
 * has passed. Above the longest client deadline any main source carries (the
 * Worker routes are read under 6–10 s), so a source that is still going to
 * answer is waited for, and a source that never answers cannot hold the feed
 * on its veil for longer than this.
 */
export const DEFAULT_SOURCE_SETTLE_TIMEOUT_MS = 12_000;

/**
 * Same per-source budget as settleWithin for `first`, but the caller can paint
 * as soon as `isReady` is true instead of waiting for the slowest source.
 *
 * `all` used to be `Promise.all` of the SAME budgeted promises, which made the
 * first-paint budget double as a failure deadline: a first paint with nothing
 * in it awaited `all`, got the same four `timed_out`, and the load was declared
 * failed while every request was still in flight and about to answer
 * (measured 2026-09-16: sources answering 300 ms past the budget produced
 * "Error loading papers", and the reader's Try again met a warm edge). `all`
 * now settles each source under its own, longer ceiling, so a first paint that
 * has nothing to show waits for the real answers, and the success path's late
 * pool receives them too.
 */
export function settleSourcesForFirstPaint(promises, timeoutMs, isReady, { allTimeoutMs = DEFAULT_SOURCE_SETTLE_TIMEOUT_MS } = {}) {
  const sources = [...promises];
  const tracked = sources.map((promise) => settleWithin(promise, timeoutMs));
  const results = Array.from({ length: tracked.length }, () => ({ status: 'pending' }));
  let resolved = false;

  const first = new Promise((resolve) => {
    const maybeFinish = () => {
      if (resolved) return;
      const papers = fulfilledPaperLists(results);
      const done = results.every((result) => result.status !== 'pending');
      if (done || (typeof isReady === 'function' && isReady(papers))) {
        resolved = true;
        resolve([...results]);
      }
    };
    if (tracked.length === 0) {
      resolved = true;
      resolve([]);
      return;
    }
    tracked.forEach((settled, index) => {
      settled.then((result) => {
        results[index] = result;
        maybeFinish();
      });
    });
  });

  const all = Promise.all(sources.map((promise) => settleWithin(promise, Math.max(timeoutMs, allTimeoutMs))));
  return { first, all };
}
