/**
 * The small panels that ask for something once and then never again: a star on
 * GitHub, a heads-up that email is down. Everything here is the part that can
 * be decided without a browser — which of them may be shown, which one is
 * shown, what "already answered" means, and how long a star count is worth
 * trusting — so the component that renders them is left with rendering.
 *
 * Two rules run through all of it. A nudge is asked once per device and then
 * remembered forever, so the cost of being wrong is not a stray pixel but a
 * person being asked again something they already declined. And a nudge may
 * only claim what somebody has actually confirmed: silence from a health
 * endpoint is not a fault, it is silence.
 */

export const NUDGE_DISMISSED_KEY = 'papertok_nudges_dismissed';
export const STAR_COUNT_KEY = 'papertok_github_stars';

/** A minute of reading before anything asks for attention. */
export const NUDGE_DWELL_MS = 60_000;
/**
 * How long the panel waits for the star count before showing without it. The
 * count either travels with the panel or is not part of it: a box that fills
 * in late pushes the copy around under someone's eyes.
 */
export const STAR_FETCH_BUDGET_MS = 1500;
/** A star count is a fact about a repository, not about this visit. */
export const STAR_COUNT_TTL_MS = 24 * 60 * 60 * 1000;

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage) {
  return storage === undefined ? browserStorage() : storage;
}

/** The ids this device has already answered. Anything else reads as none. */
export function readDismissedNudges(storage) {
  try {
    const raw = resolveStorage(storage)?.getItem(NUDGE_DISMISSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
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
export function rememberNudgeDismissal(id, storage) {
  const next = readDismissedNudges(storage);
  if (!next.includes(id)) next.push(id);
  try {
    resolveStorage(storage)?.setItem(NUDGE_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // The visit's own state is the fallback; nothing else to do here.
  }
  return next;
}

/** One of the pending ones, at random, or nothing at all. */
export function pickNudge({ eligible = [], dismissed = [], random = Math.random } = {}) {
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
 * reports.
 */
export function emailNudgeProblem({ loading = false, health = {} } = {}) {
  if (loading || !health?.code || health.available === true) return null;
  return health.code === 'EMAIL_NOT_CONFIGURED' ? 'not-configured' : 'unavailable';
}

/** The cached star count, if it is still worth trusting. */
export function readCachedStarCount(storage, now = Date.now()) {
  try {
    const raw = resolveStorage(storage)?.getItem(STAR_COUNT_KEY);
    if (!raw) return null;
    const { count, at } = JSON.parse(raw) || {};
    if (!Number.isInteger(count) || count < 0 || !Number.isFinite(at)) return null;
    const age = now - at;
    return age >= 0 && age < STAR_COUNT_TTL_MS ? count : null;
  } catch {
    return null;
  }
}

/** Keeps a count for a day. Anything that is not a count is not kept. */
export function cacheStarCount(count, storage, now = Date.now()) {
  if (!Number.isInteger(count) || count < 0) return false;
  try {
    resolveStorage(storage)?.setItem(STAR_COUNT_KEY, JSON.stringify({ count, at: now }));
    return true;
  } catch {
    return false;
  }
}
