import { emailServiceState } from './email-health.ts';

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

const PRIVACY_NOTICE_KEY = 'papertok_privacyNotice';

// Unlike the nudges above, kept per reader: each account that signs in on this
// device has to be told separately. It is not swept at sign-out, so signing in
// again does not repeat a notice already dismissed.
function privacyNoticeKey(uid: string) {
  return `${PRIVACY_NOTICE_KEY}:${encodeURIComponent(uid)}`;
}

/** The policy version this reader last dismissed on this device, if any. */
export function readPrivacyNoticeAck(uid: string, storage?: NudgeStorage | null) {
  try {
    return resolveStorage(storage)?.getItem(privacyNoticeKey(uid)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Orders policy versions ('2026-10-25', '2026-10-25.2'): by date, then by the
 * numeric suffix, so '.10' follows '.2'. A value that is not a version covers
 * nothing, so it reads as older than every version.
 */
function policyVersionRank(version: string | null) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/.exec(version ?? '');
  return match ? { day: match[1], suffix: Number(match[2] ?? 0) } : null;
}

function policyVersionCovers(acknowledged: string | null, version: string) {
  const had = policyVersionRank(acknowledged);
  const owed = policyVersionRank(version);
  if (!had || !owed) return acknowledged === version;
  return had.day !== owed.day ? had.day > owed.day : had.suffix >= owed.suffix;
}

/**
 * Keeps the newest version dismissed: another tab still running an older
 * bundle must not write its version over a newer one this reader dismissed.
 */
export function rememberPrivacyNotice(uid: string, version: string, storage?: NudgeStorage | null) {
  try {
    const target = resolveStorage(storage);
    if (policyVersionCovers(readPrivacyNoticeAck(uid, target), version)) return;
    target?.setItem(privacyNoticeKey(uid), version);
  } catch {
    // The host still closes the notice for this visit; it returns next time.
  }
}

/**
 * Whether a reader still has to hear about policy `version`; dismissing it or a
 * later version settles that. Only signed-in
 * accounts are told: a guest has no creation date, so a first-time visitor
 * could not be told apart from someone who read the old policy. An account
 * created at or after `effectiveAt` (an ISO instant: when the change went
 * live) started under the policy as it is and has nothing to be told; one whose
 * creation time is unknown is told.
 */
export function privacyNoticeOwed({ version, effectiveAt, acknowledged, accountCreated, signedIn }: { version: string; effectiveAt: string; acknowledged: string | null; accountCreated?: string | null; signedIn: boolean }) {
  if (!signedIn || policyVersionCovers(acknowledged, version)) return false;
  const created = accountCreated ? new Date(accountCreated) : null;
  if (!created || Number.isNaN(created.getTime())) return true;
  return created.getTime() < new Date(effectiveAt).getTime();
}

/** One of the pending ones, at random, or nothing at all. */
export function pickNudge({ eligible = [], dismissed = [], random = Math.random }: { eligible?: string[]; dismissed?: string[]; random?: () => number } = {}) {
  const pending = eligible.filter(id => !dismissed.includes(id));
  if (pending.length === 0) return null;
  const index = Math.min(pending.length - 1, Math.floor(random() * pending.length));
  return pending[index];
}

export const PRIVACY_NOTICE_ID = 'privacy-change';

/**
 * What the visit shows: the privacy change when it is owed, which takes the
 * turn before any nudge, otherwise one of the pending nudges, or nothing.
 */
export function pickVisitNotice({ privacyOwed, eligible = [], dismissed = [], random }: { privacyOwed: boolean; eligible?: string[]; dismissed?: string[]; random?: () => number }) {
  return privacyOwed ? PRIVACY_NOTICE_ID : pickNudge({ eligible, dismissed, random });
}

const OTHER_ESCAPE_OWNERS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"]';

/**
 * Whether an Escape pressed on `target` belongs to something else: another
 * dialog, menu or list closing itself, or a text field being cleared. Only an
 * Escape on the page underneath puts the privacy notice away.
 */
export function escapeBelongsToOther(target: unknown) {
  const element = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;
  if (!element || typeof element !== 'object') return false;
  if (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName ?? '')) return true;
  return typeof element.closest === 'function' && Boolean(element.closest(OTHER_ESCAPE_OWNERS));
}

/**
 * What, if anything, is wrong with email — as reported by the service itself.
 *
 * `code` is the discriminant, not `configured`: the context's initial state is
 * `{ configured: false, available: false, code: null }`, which is what "we have
 * not heard back" looks like. Reading that as a fault would announce an outage
 * to everyone on every cold load, including when the health request never
 * lands. And a service that says it is available is believed, whatever else it
 * reports. A check the Worker did not run leaves the status unknown
 * (`emailServiceState`), which is not a fault either.
 */
export function emailNudgeProblem({ loading = false, health = {} }: { loading?: boolean; health?: { code?: string | null; available?: boolean; configured?: boolean } | null } = {}) {
  if (loading || !health?.code || emailServiceState(health) !== 'down') return null;
  return health.code === 'EMAIL_NOT_CONFIGURED' ? 'not-configured' : 'unavailable';
}
