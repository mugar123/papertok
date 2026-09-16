/**
 * The one lane every arXiv request of this tab goes through.
 *
 * arXiv asks for one request every three seconds and one connection, and the
 * Worker now keeps that beat for the whole app (worker/report-api.js: a miss
 * takes a seat, a seat further than four seconds away is refused with 429).
 * This lane is the tab's side of the same bargain:
 *
 * - Requests go out one at a time, `gapMs` apart, and identical URLs in flight
 *   share one run -- the two things `arxivService` always did.
 * - A request that has waited in the lane longer than `maxQueueWaitMs` is
 *   dropped without being sent. Nobody is listening for it any more (the
 *   route's own deadline has passed for every caller), and sending it anyway
 *   would spend an app-wide seat on an answer that is thrown away. Measured
 *   2026-09-16: one cold feed load put five arXiv requests in this lane in
 *   2.5 s, and the last ones were for followed topics whose 3.5 s budget was
 *   long gone by the time they went out.
 * - A 429 -- the Worker's beat refusing, or arXiv itself -- puts the lane on
 *   a cooldown for the `retry-after` it carried (`DEFAULT_COOLDOWN_MS` when it
 *   carried none), during which every request is refused at once. Asking
 *   again inside that window costs a round trip and answers the same thing.
 *
 * `now` and `sleep` are injectable so the lane can be tested without waiting.
 */
export const DEFAULT_GAP_MS = 350;
export const DEFAULT_COOLDOWN_MS = 4_000;

export class ArxivQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArxivQueueError';
    this.code = code;
  }
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createArxivRequestQueue({
  gapMs = DEFAULT_GAP_MS,
  maxQueueWaitMs,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  let chain = Promise.resolve();
  const inFlight = new Map();
  let refusedUntil = 0;

  const runNow = async (enqueuedAt, task) => {
    if (now() < refusedUntil) {
      throw new ArxivQueueError('RATE_LIMITED', 'arXiv is rate limited; not asking again yet');
    }
    if (Number.isFinite(maxQueueWaitMs) && now() - enqueuedAt > maxQueueWaitMs) {
      throw new ArxivQueueError('QUEUE_EXPIRED', 'arXiv request waited longer than anyone waits for it');
    }
    try {
      return await task();
    } catch (error) {
      if (error?.status === 429) {
        const cooldown = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : DEFAULT_COOLDOWN_MS;
        refusedUntil = Math.max(refusedUntil, now() + cooldown);
      }
      throw error;
    }
  };

  const run = (key, task) => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const enqueuedAt = now();
    const attempt = () => runNow(enqueuedAt, task);
    const result = chain.then(attempt, attempt);
    chain = result.then(() => sleep(gapMs), () => sleep(gapMs));
    const tracked = result.finally(() => inFlight.delete(key));
    inFlight.set(key, tracked);
    return tracked;
  };

  return { run };
}
