type ConsentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ConsentLocks = { request: <R>(name: string, callback: (lock: unknown) => Promise<R>) => Promise<R> };

/**
 * The welcome text the reader accepted when they said yes to the weekly email:
 * "Mondays, when there are new papers in the topics you chose". A yes given
 * under the earlier text ("Starts with your first follow") carries no version,
 * so it keeps that promise whenever the account is created.
 */
export const DIGEST_CONSENT_FROM_SIGNUP = 'topics-from-signup-1';
/** A yes given under the earlier text, "Starts with your first follow. Unsubscribe anytime.", which carries no stamp. */
export const DIGEST_CONSENT_FIRST_FOLLOW = 'first-follow-1';
/** What `POST /notifications/opt-in` accepts. Anything else is refused, never read as the new promise. */
export const DIGEST_OPT_IN_CONSENTS: readonly string[] = [DIGEST_CONSENT_FROM_SIGNUP, DIGEST_CONSENT_FIRST_FOLLOW];

/**
 * What this device remembers about the account's pending yes, besides the
 * `emailDigestOptIn` flag on the profile (which rules allow as a bool only):
 * the consent version it was given under, or `spent` once the subscription
 * started or the reader decided for themselves. `spent` keeps a flag that
 * could not be deleted from starting a subscription the reader has since
 * ended, in Settings or from the email's own unsubscribe link.
 *
 * Not swept at sign-out, like the survey's version key: it holds no reading
 * data, and sweeping it would let that stuck flag act again.
 */
const CONSENT_KEY_PREFIX = 'papertok_digestConsent:';
export const DIGEST_CONSENT_SPENT = 'spent';

export type DigestConsent = typeof DIGEST_CONSENT_FROM_SIGNUP | typeof DIGEST_CONSENT_SPENT | null;

function getStorage(storage?: ConsentStorage | null) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

function browserLocks(): ConsentLocks | null {
  return typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;
}

function consentKey(userId: string) {
  return `${CONSENT_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/** Anything but a known value reads as no record, so an unknown version keeps the old promise. */
export function readDigestConsent(userId: string | null | undefined, storage?: ConsentStorage | null): DigestConsent {
  const target = getStorage(storage);
  if (!userId || !target) return null;
  try {
    const value = target.getItem(consentKey(userId));
    return value === DIGEST_CONSENT_FROM_SIGNUP || value === DIGEST_CONSENT_SPENT ? value : null;
  } catch {
    return null;
  }
}

/** `null` removes the record. A device that cannot store it falls back to the old promise. */
export function writeDigestConsent(userId: string, consent: DigestConsent, storage?: ConsentStorage | null) {
  const target = getStorage(storage);
  if (!target) return;
  try {
    if (consent) target.setItem(consentKey(userId), consent);
    else target.removeItem(consentKey(userId));
  } catch {
    // Storage is best effort; see readDigestConsent.
  }
}

/** For a deleted account: its uid has no business staying in this browser. */
export function forgetDigestConsent(userId: string, storage?: Pick<Storage, 'removeItem'> | null) {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  try {
    target?.removeItem(consentKey(userId));
  } catch {
    // Clearing site data removes it too.
  }
}

/**
 * Runs `task` while no other tab of this browser is starting this account's
 * subscription, and after it if one is. Two tabs that both read the digest as
 * off would each send the activation and report a subscribe; the second tab
 * runs after the first and, re-reading the stored subscription, finds it on. A
 * browser without Web Locks runs the task at once, which still re-reads first.
 */
export async function withDigestOptInLock<T>(userId: string, task: () => Promise<T>, locks: ConsentLocks | null = browserLocks()): Promise<T> {
  if (!locks) return task();
  return locks.request(`papertok-digest-opt-in:${encodeURIComponent(userId)}`, task);
}
