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
// call spent, no minute reservation wasted on a request the provider would
// have refused anyway. The retention alarm of the ledger clears the used
// seconds every three days; at one a second that is under 260k entries, well
// inside the object's global counter.
const DEFAULT_MAX_WAIT_MS = 2_500;
const PACE_GLOBAL_LIMIT = 1_000_000;

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function awaitUpstreamSlot(ledger, {
  namespace,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  const started = now();
  for (let second = Math.floor(started / 1000); second * 1000 - started <= maxWaitMs; second += 1) {
    const reservation = await reserveRequestQuota(ledger, {
      periodKey: `${namespace}:pace`,
      subject: `${namespace}:second:${second}`,
      subjectLimit: 1,
      globalLimit: PACE_GLOBAL_LIMIT,
    });
    if (!reservation.accepted && reservation.code) return { accepted: false, code: reservation.code };
    if (!reservation.accepted) continue;
    const waitMs = Math.max(0, second * 1000 - now());
    if (waitMs > 0) await sleep(waitMs);
    return { accepted: true, second, waitedMs: waitMs };
  }
  return { accepted: false };
}
