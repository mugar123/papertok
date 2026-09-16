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
// call spent. The minute reservation is a different story: this gate still
// runs after it on purpose, so that unit is already spent by the time a
// caller reaches here -- but refusing the second gives it back now, the same
// unit, not a recomputed one. The retention alarm of the ledger clears the
// used seconds every three days; at one a second that is under 260k entries,
// well inside the object's global counter.
export const DEFAULT_MAX_WAIT_MS = 2_500;
// What a caller refused here is told to wait, in whole seconds, derived from the
// window it was refused within rather than written next to it: the beat gave up
// because no slot was free inside that window, so "come back" means "after it".
// Not the same number as the router's fallback for a *provider* refusal, which
// speaks for the provider's own window.
export function paceRetryAfterSeconds(maxWaitMs) {
  return String(Math.ceil(maxWaitMs / 1000));
}
export const PACE_RETRY_AFTER_SECONDS = paceRetryAfterSeconds(DEFAULT_MAX_WAIT_MS);
// Sits exactly on `request-quota-ledger.js`'s own `MAX_LIMIT`. One increment
// past this and that module's `positiveInteger` returns 0 for any
// `globalLimit`, which turns every reservation `INVALID_REQUEST` -> 400 ->
// `QUOTA_LEDGER_UNAVAILABLE` here -> a 503 on every paced request.
// Raise the two together, or not at all.
const PACE_GLOBAL_LIMIT = 1_000_000;

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// `periodMs` is the beat's period: one slot per period, app-wide. Semantic
// Scholar takes the default second; arXiv asks for one request every three
// seconds (its published policy), so it passes 3 000. The slot index is the
// period the clock is in, `floor(t / periodMs)`, which for a one-second beat is
// the second itself -- the arithmetic below is unchanged, only the unit.
export async function awaitUpstreamSlot(ledger, {
  namespace,
  periodMs = 1000,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  const started = now();
  // The bound stays expressed in `slot` against `started`, never against a
  // fresh `now()` read, so it terminates in a handful of steps no matter what
  // the clock does inside the loop: each iteration below only ever moves
  // `slot` forward, so a clock that jumps ahead can only make this exit
  // sooner, never later, and one that stalls or runs backward leaves it exactly
  // as bounded as a plain per-period counter always was.
  let slot = Math.floor(started / periodMs);
  while (slot * periodMs - started <= maxWaitMs) {
    const reservation = await reserveRequestQuota(ledger, {
      periodKey: `${namespace}:pace`,
      subject: `${namespace}:slot:${slot}`,
      subjectLimit: 1,
      globalLimit: PACE_GLOBAL_LIMIT,
    });
    if (!reservation.accepted && reservation.code) return { accepted: false, code: reservation.code };
    // The reservation round trip just spent is exactly what can burn the
    // clock, so whether `slot` is still current has to be read fresh here,
    // after the await -- not assumed from the value the loop already held
    // going in. A slot confirmed once the period it names has already ended
    // is no more usable than one the ledger refused outright: honoring it
    // anyway is how a caller used to send inside a period somebody else holds,
    // because the wait below clamps to zero for any `now()` at or past
    // `slot`, past its own end included. (A check on `slot` before the
    // reservation call would not catch this -- it is the call's own latency
    // that does the damage, and it hasn't happened yet at that point.)
    if (reservation.accepted && Math.floor(now() / periodMs) <= slot) {
      const waitMs = Math.max(0, slot * periodMs - now());
      if (waitMs > 0) await sleep(waitMs);
      return { accepted: true, slot, waitedMs: waitMs };
    }
    // Next candidate is whichever is later: the next period in sequence, or
    // the period the clock has actually reached. Plain `slot + 1` is what
    // let a stale accept slip through above -- without the `now()` term here
    // too, a slow enough ledger keeps proposing periods that have already
    // closed by the time each reservation lands, one at a time, rather than
    // catching up to the present in a single jump.
    slot = Math.max(slot + 1, Math.floor(now() / periodMs));
  }
  return { accepted: false };
}
