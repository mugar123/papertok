/**
 * Test scaffolding for the F2 deadline regressions. Not imported by the app, so
 * it never reaches a bundle; it lives outside `src/utils` so nothing picks it up
 * by accident, and its name keeps it out of `find src -name '*.test.js'`.
 *
 * The shape under test is an upstream that answers its headers at once and then
 * dribbles. `fetch` resolves on the headers, so a deadline that is disarmed at
 * that point never covers the part that actually stalls.
 */

/**
 * A `fetch` that returns immediately with a body that never finishes.
 *
 * The abort is wired to the stream by hand because `fetch` is stubbed and there
 * is no socket to cut. That is precisely what makes the test meaningful: the
 * stream only errors if the signal handed to `fetch` is *still armed* while the
 * body is being read. A cleared timer leaves it pending for ever.
 */
export function dribblingFetch({ status = 200, headers } = {}) {
  return async (_url, options = {}) => {
    const { signal } = options;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        if (signal?.aborted) controller.error(signal.reason);
        else signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }), { status, headers: headers ?? { 'content-type': 'application/json' } });
  };
}

/**
 * Runs `work` against a watchdog and reports how it settled: the error's `name`,
 * `'resolved'`, or `'still waiting'` if the watchdog won.
 *
 * The watchdog earns its place twice. `node --test` has no per-test timeout, so
 * without it reverting a fix would hang the suite for ever instead of turning it
 * red — which would make the mutation check useless. And its timer is ref'd,
 * so it holds the event loop open; `AbortSignal.timeout` schedules an *unref'd*
 * timer, which under Node 22 lets a test that only awaits an abort get reported
 * as `cancelled` rather than passed.
 */
export async function settleWithin(watchdogMs, work) {
  let watchdog;
  const tooSlow = new Promise(resolve => {
    watchdog = setTimeout(() => resolve('still waiting'), watchdogMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(work).then(() => 'resolved', error => error?.name ?? String(error)),
      tooSlow,
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

/**
 * Swaps in a stubbed `fetch` for the duration of `work` and restores it after,
 * even if the assertion throws.
 */
export async function withStubbedFetch(stub, work) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await work();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
