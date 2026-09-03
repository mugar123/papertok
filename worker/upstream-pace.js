import { reserveRequestQuota } from './request-quota-ledger.js';

// Semantic Scholar admits one request per second per key and refuses the rest
// of that second at once (measured 2026-09-03: five in parallel, one 200; the
// next single request a second later, 200). The per-minute ceiling is the same
// average and no protection at all against that: sixty reservations fit in one
// second, each one spent, one answered.
//
// This is the beat the ceiling lacks. A second is a *subject* in one long-lived
// ledger object (`<namespace>:pace`) with a limit of one, so the reservation is
// the slot: the first caller to take second N sends in second N, the next one
// takes N+1 and waits for it, and a caller that finds nothing free within
// `maxWaitMs` is refused here rather than upstream -- same 429, no provider
// call spent. The minute reservation is a different story: this gate runs
// after it on purpose, so that unit is already spent by the time a caller
// reaches here, and refusing the second does not give it back. The retention
// alarm of the ledger clears the used seconds every three days; at one a
// second that is under 260k entries, well inside the object's global counter.
export const DEFAULT_MAX_WAIT_MS = 2_500;
// What a caller refused here is told to wait, in whole seconds, derived from the
// window above rather than written next to it: the beat gave up because no
// second was free inside that window, so "come back" means "after it". Not the
// same number as the router's fallback for a *provider* refusal, which speaks
// for Semantic Scholar's own one-second window.
export const PACE_RETRY_AFTER_SECONDS = String(Math.ceil(DEFAULT_MAX_WAIT_MS / 1000));
// Sits exactly on `request-quota-ledger.js`'s own `MAX_LIMIT`. One increment
// past this and that module's `positiveInteger` returns 0 for any
// `globalLimit`, which turns every reservation `INVALID_REQUEST` -> 400 ->
// `QUOTA_LEDGER_UNAVAILABLE` here -> a 503 on every Semantic Scholar request.
// Raise the two together, or not at all.
const PACE_GLOBAL_LIMIT = 1_000_000;

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function awaitUpstreamSlot(ledger, {
  namespace,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  const started = now();
  // The bound stays expressed in `second` against `started`, never against a
  // fresh `now()` read, so it terminates in a handful of steps no matter what
  // the clock does inside the loop: each iteration below only ever moves
  // `second` forward, so a clock that jumps ahead can only make this exit
  // sooner, never later, and one that stalls or runs backward leaves it exactly
  // as bounded as a plain per-second counter always was.
  let second = Math.floor(started / 1000);
  while (second * 1000 - started <= maxWaitMs) {
    const reservation = await reserveRequestQuota(ledger, {
      periodKey: `${namespace}:pace`,
      subject: `${namespace}:second:${second}`,
      subjectLimit: 1,
      globalLimit: PACE_GLOBAL_LIMIT,
    });
    if (!reservation.accepted && reservation.code) return { accepted: false, code: reservation.code };
    // The reservation round trip just spent is exactly what can burn the
    // clock, so whether `second` is still current has to be read fresh here,
    // after the await -- not assumed from the value the loop already held
    // going in. A slot confirmed once the second it names has already ended
    // is no more usable than one the ledger refused outright: honoring it
    // anyway is how a caller used to send inside a second somebody else holds,
    // because the wait below clamps to zero for any `now()` at or past
    // `second`, past its own end included. (A check on `second` before the
    // reservation call would not catch this -- it is the call's own latency
    // that does the damage, and it hasn't happened yet at that point.)
    if (reservation.accepted && Math.floor(now() / 1000) <= second) {
      const waitMs = Math.max(0, second * 1000 - now());
      if (waitMs > 0) await sleep(waitMs);
      return { accepted: true, second, waitedMs: waitMs };
    }
    // Next candidate is whichever is later: the next second in sequence, or
    // the second the clock has actually reached. Plain `second + 1` is what
    // let a stale accept slip through above -- without the `now()` term here
    // too, a slow enough ledger keeps proposing seconds that have already
    // closed by the time each reservation lands, one at a time, rather than
    // catching up to the present in a single jump.
    second = Math.max(second + 1, Math.floor(now() / 1000));
  }
  return { accepted: false };
}
