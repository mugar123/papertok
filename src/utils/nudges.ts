type NudgeStorage = Pick<Storage, 'getItem' | 'setItem'>;
/**
 * The small panels that ask for something once and then never again, such as
 * a heads-up that email is down. Everything here is the part that can be
 * decided without a browser — which of them may be shown, which one is shown
 * and what "already answered" means — so the component that renders them is
 * left with rendering.
 *
 * Two rules run through all of it. A nudge is asked once per device and then
 * remembered forever, so the cost of being wrong is not a stray pixel but a
 * person being asked again something they already declined. And a nudge may
 * only claim what somebody has actually confirmed: silence from a health
 * endpoint is not a fault, it is silence.
 */

export const NUDGE_DISMISSED_KEY = 'papertok_nudges_dismissed';

/** A minute of reading before anything asks for attention. */
export const NUDGE_DWELL_MS = 60_000;

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage: NudgeStorage | null | undefined) {
  return storage === undefined ? browserStorage() : storage;
}

/** The ids this device has already answered. Anything else reads as none. */
export function readDismissedNudges(storage?: NudgeStorage | null) {
  try {
    const raw = resolveStorage(storage)?.getItem(NUDGE_DISMISSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Marks one answered, and hands back the list that holds from here on. It
 * returns that list even when the write failed — a private window still gets
 * the panel out of the way for the rest of the visit, which is the part the
 * person asked for.
 */
export function rememberNudgeDismissal<T>(id: T, storage?: NudgeStorage | null) {
  const next: (string | T)[] = readDismissedNudges(storage);
  if (!next.includes(id)) next.push(id);
  try {
    resolveStorage(storage)?.setItem(NUDGE_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // The visit's own state is the fallback; nothing else to do here.
  }
  return next;
}

/** One of the pending ones, at random, or nothing at all. */
export function pickNudge({ eligible = [], dismissed = [], random = Math.random }: { eligible?: string[]; dismissed?: string[]; random?: () => number } = {}) {
  const pending = eligible.filter(id => !dismissed.includes(id));
  if (pending.length === 0) return null;
  const index = Math.min(pending.length - 1, Math.floor(random() * pending.length));
  return pending[index];
}

/**
 * What, if anything, is wrong with email — as reported by the service itself.
 *
 * `code` is the discriminant, not `configured`: the context's initial state is
 * `{ configured: false, available: false, code: null }`, which is what "we have
 * not heard back" looks like. Reading that as a fault would announce an outage
 * to everyone on every cold load, including when the health request never
 * lands. And a service that says it is available is believed, whatever else it
 * reports. `HEALTH_PROBE_LIMITED` means the Worker refused to run the check, so
 * the status is unknown rather than a fault.
 */
export function emailNudgeProblem({ loading = false, health = {} }: { loading?: boolean; health?: { code?: string | null; available?: boolean; configured?: boolean } | null } = {}) {
  if (loading || !health?.code || health.available === true || health.code === 'HEALTH_PROBE_LIMITED') return null;
  return health.code === 'EMAIL_NOT_CONFIGURED' ? 'not-configured' : 'unavailable';
}
