import type { SettledWithin } from '../utils/async-timing.ts';
import { settleWithin } from '../utils/async-timing.ts';

/**
 * What the server's read of the profile decides. The device's remembered
 * onboarding only decided the paint while the read was in flight, so it is
 * no input here: an answer is applied (a missing document included), a
 * failure with nothing hydrated from the cache is PROFILE_LOAD_FAILED, and a
 * failure after the cache painted the profile keeps that paint.
 */
export function profileReadOutcome<T>(remote: SettledWithin<T>, hydratedFromCache: boolean):
  | { kind: 'apply'; snapshot: T }
  | { kind: 'failed'; code: 'PROFILE_LOAD_FAILED' }
  | { kind: 'keep-cached' } {
  if (remote.status === 'fulfilled') return { kind: 'apply', snapshot: remote.value };
  if (!hydratedFromCache) return { kind: 'failed', code: 'PROFILE_LOAD_FAILED' };
  return { kind: 'keep-cached' };
}

/**
 * Waits for the onboarding's profile write, bounded: Firestore's promise
 * never settles on its own against a stalled connection (memory cache,
 * firebase.js), and an unbounded write would hang the onboarding screen's
 * only button forever. Resolves only once the write is fulfilled, so nothing
 * after it (the flag, the preferences, the local memory) runs before. A
 * timeout throws with the stable code ONBOARDING_WRITE_TIMEOUT for the caller
 * to branch on; a rejection (a rules refusal, say) is rethrown as itself.
 */
export async function confirmOnboardingWrite(write: Promise<unknown>, timeoutMs: number) {
  const settled = await settleWithin(write, timeoutMs);
  // A retry is safe — the write merge-sets the same fields — so there is
  // nothing to do here but let the caller know and stop.
  if (settled.status !== 'fulfilled') {
    if (settled.status === 'timed_out') {
      const timeoutError = new Error('completeOnboarding: the write did not settle in time') as Error & { code?: string };
      timeoutError.code = 'ONBOARDING_WRITE_TIMEOUT';
      throw timeoutError;
    }
    throw settled.reason;
  }
}
