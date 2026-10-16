/**
 * Rebuilding the Firestore listen stream when it has died under a live client.
 *
 * The SDK routes every `getDoc` and `getDocs` over one long-lived WebChannel
 * stream, and it keeps that stream open for as long as anything listens —
 * which in this app is always (FollowingContext). A stream that dies silently
 * — a laptop back from sleep, a network that changed under the tab, a proxy
 * that dropped the connection without closing it — is not an error the SDK
 * sees: nothing rejects, nothing reconnects. Measured against production
 * (2026-09-06) with the SDK's requests held at the network: a document read
 * and a query issued against that stream had not settled after 96 seconds,
 * and did not settle when the network came back either. Every screen that
 * reads through the SDK then sits on its skeleton until its budget says
 * "stalled", and the only thing that ever cured it was a reload.
 *
 * `disableNetwork()` followed by `enableNetwork()` is that reload without the
 * reload: the SDK tears the stream down and opens a new one. Measured at 6 ms.
 * The hostages settle at once — a document already in the cache with its
 * data, one that is not as `unavailable`, a query as an empty cache answer —
 * and the read issued next answered from the server in 130 ms. Which is why
 * the kick lives behind `patientRead` (boundedRead.js): the flushed answers
 * are exactly the "not now" it already knows how to wait out, and its retry
 * is the read that meets the rebuilt stream.
 *
 * The SDK is injected so this stays a plain module under `node --test`.
 */

/**
 * How long one kick is trusted before a still-stalled read may ask for
 * another. The retry behind a flushed hostage waits 800 ms, and a healthy
 * read answers under half a second: a second kick inside that window would
 * flush the very read that was about to answer.
 */
export const MIN_STREAM_RECOVERY_INTERVAL_MS = 8000;

/**
 * @returns {() => Promise<boolean>} true when the stream was rebuilt; false
 *   when it was left alone — no network to rebuild it on, a kick still fresh,
 *   or the SDK refusing (logged, never thrown into the screen that asked).
 */
export function createStreamRecovery({
  disable,
  enable,
  now = Date.now,
  isOffline = () => false,
  minIntervalMs = MIN_STREAM_RECOVERY_INTERVAL_MS,
  warn = (...args) => console.warn(...args),
}) {
  let lastKickAt = -Infinity;
  let inFlight = null;

  return async function recoverStream() {
    if (isOffline()) return false;
    if (inFlight) return inFlight;
    if (now() - lastKickAt < minIntervalMs) return false;
    lastKickAt = now();
    inFlight = (async () => {
      try {
        await disable();
        await enable();
        return true;
      } catch (error) {
        warn('Could not rebuild the Firestore stream:', error?.message || error);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
