/**
 * One deadline for a whole fetch — the headers **and** the body.
 *
 * The shape this replaces looked bounded and was not:
 *
 *     const controller = new AbortController();
 *     const timeout = setTimeout(() => controller.abort(), ms);
 *     try {
 *       const response = await fetch(url, { signal: controller.signal });
 *       return response.json();
 *     } finally {
 *       clearTimeout(timeout);
 *     }
 *
 * `fetch` resolves when the **headers** arrive, so the `finally` disarms the
 * timer before a single byte of the body has been read. An upstream that answers
 * its headers and then dribbles hangs exactly as it would have with no deadline
 * at all — measured against a server that does precisely that, the shape above
 * was still waiting long after its one-second deadline had passed.
 *
 * `AbortSignal.timeout` has no timer to clear. It stays armed until the response
 * has been read in full, so the body read is covered by the same mark. The
 * failure it raises is named `TimeoutError`, not `AbortError`.
 *
 * A caller that brings its own signal keeps it: the AI explanation is allowed to
 * spend seventy seconds and must not be cut down to somebody else's default.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function requestDeadline(options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return options.signal ?? AbortSignal.timeout(timeoutMs);
}

export function withRequestDeadline(options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return { ...options, signal: requestDeadline(options, timeoutMs) };
}

/**
 * The same deadline, for callers whose signal means something else.
 *
 * `withRequestDeadline` lets an incoming signal *replace* the deadline, because
 * there the signal carries a **budget**: `workerApiClient` is handed one by a
 * caller that already knows how long it is allowed to take, and a fifteen-second
 * default has no business shortening it.
 *
 * The institution and project searches are the other case. Their signal carries
 * a **cancellation** — `SearchPage` aborts the in-flight request on the next
 * keystroke — and a cancellation says nothing about how long the request may
 * run. Letting it replace the deadline would leave the typeahead, the busiest
 * path either service has, with no deadline at all: exactly the unbounded wait
 * this module exists to remove.
 *
 * So here the two are additive. `AbortSignal.any` keeps whichever fired first as
 * the reason, which is what lets callers still tell the cases apart: a user who
 * navigates away still raises `AbortError`, and only a real timeout raises
 * `TimeoutError`.
 */
export function withEnforcedDeadline(options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  };
}
