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
