import { DIGEST_CONSENT_FROM_SIGNUP, DIGEST_CONSENT_SPENT, type DigestConsent } from './digest-consent.ts';
import { getAllLeafCategories } from '../data/category-taxonomy.ts';

const LEAF_IDS = new Set(getAllLeafCategories().map(leaf => leaf.id));

/**
 * The chosen categories a profile snapshot gives the digest: its leaf ids,
 * once each and sorted, read the way the account profile reads them. They are
 * confirmed only when the snapshot is the server's copy, never the device's
 * cache and never one that still holds a write the server has not acknowledged
 * (Firestore's `fromCache` and `hasPendingWrites`); a server copy with no
 * categories, or no profile, is a confirmed none.
 */
export function digestProfileInterests(profile: { preferences?: unknown; selectedCategories?: unknown } | undefined, snapshot: { fromCache: boolean; hasPendingWrites: boolean }) {
  const chosen = profile?.preferences || profile?.selectedCategories;
  const interests = Array.isArray(chosen)
    ? [...new Set(chosen.filter((id): id is string => typeof id === 'string' && LEAF_IDS.has(id)))].sort()
    : [];
  return { interests, confirmed: !snapshot.fromCache && !snapshot.hasPendingWrites };
}

export interface DigestShutoffState {
  /** The saved subscription is on. */
  enabled: boolean;
  /** The follows in hand are the server's own answer: not cached, not failed, no write in flight. */
  followsConfirmed: boolean;
  /** The chosen categories in hand come from the server's copy of the profile, not the device's cache, and no profile read failed. */
  interestsConfirmed: boolean;
  /** The digest has something to cover: a follow it lists, or else the reader's chosen categories. */
  digestCovered: boolean;
  /** This account's shutoff was already sent and has not been undone by a follow or an interest. */
  attempted: boolean;
}

/**
 * Whether the weekly digest has to be turned off now: it is on, the reader
 * follows nothing it covers and chose no categories to fill it with instead,
 * and that absence is confirmed. The Worker refuses an empty subscription and
 * the app stops syncing one, so without this the stored subscription keeps
 * emailing what was last synced (ENG-163). A failed or cached read must never
 * unsubscribe anyone: a cached profile with no categories, read before the
 * server's copy arrives, would end a subscription the sync cannot restore.
 */
export function digestShutoffDue({ enabled, followsConfirmed, interestsConfirmed, digestCovered, attempted }: DigestShutoffState) {
  return enabled && followsConfirmed && interestsConfirmed && !digestCovered && !attempted;
}

/**
 * Whether the digest sync, a save that turns the digest on, or a test may send
 * what is in hand. With no follow it covers, each of them switches the stored
 * subscription to the chosen categories and drops the follows the Worker
 * holds, so that empty follow list has to be the server's answer, never a
 * cached one (ENG-163). Without follows the digest rests on the chosen
 * categories, so the profile read has to be confirmed too: otherwise nothing is
 * sent to cover it and the Worker refuses with EMAIL_FOLLOWS_REQUIRED.
 */
export function digestSyncAllowed({ hasFollows, followsConfirmed, interestsConfirmed }: {
  hasFollows: boolean;
  followsConfirmed: boolean;
  interestsConfirmed: boolean;
}) {
  return hasFollows || (followsConfirmed && interestsConfirmed);
}

/**
 * The chosen categories a save, test or sync may send: only the server's copy
 * of the profile. A cached copy may predate a change made elsewhere and would
 * replace the categories the Worker stores, so it sends none and the Worker
 * keeps what it has (ENG-163).
 */
export function digestInterestsToSend({ interests, interestsConfirmed }: { interests: readonly string[]; interestsConfirmed: boolean }) {
  return interestsConfirmed ? interests : undefined;
}

/**
 * Whether the "email updates turned off" notice shows: this account's digest
 * was shut off by the app, and it is still off with nothing to cover. Keyed by
 * account so another sign-in on the same device never sees it.
 */
export function digestShutoffNoticeShown({ turnedOffFor, userId, enabled, digestCovered }: {
  turnedOffFor: string | null;
  userId: string | null;
  enabled: boolean;
  digestCovered: boolean;
}) {
  return userId !== null && turnedOffFor === userId && !enabled && !digestCovered;
}

/**
 * Whether a pending yes to the email still waits for the reader's first
 * follow. Only a yes given under the welcome text that promised the email from
 * sign-up (`DIGEST_CONSENT_FROM_SIGNUP`) starts on the chosen topics alone, and
 * only while something covers the digest. Any other yes, a yes whose version is
 * unknown included, keeps the promise it was given under. A spent yes waits
 * for nothing.
 */
export function digestOptInWaitsForFollow({ pending, consent, covered = true }: {
  pending: boolean;
  consent: DigestConsent;
  covered?: boolean;
}) {
  if (!pending) return false;
  return consent !== DIGEST_CONSENT_SPENT && (consent !== DIGEST_CONSENT_FROM_SIGNUP || !covered);
}

/**
 * What a pending yes to the email does next, once the subscription and the
 * follows are known: `settle` when the flag only has to be deleted (the digest
 * is already on, or the yes is `spent`), `subscribe` when the subscription can
 * start now, `wait` otherwise. An older yes starts with the first follow; a yes
 * given under the from-sign-up text starts on whatever covers the digest, the
 * chosen topics included, once the profile read is the server's own
 * (`digestSendReady`). Nothing is attempted twice in a session; a failed
 * attempt leaves the flag in place, so the next session is the retry. A
 * subscription starts only while the live profile confirms the flag
 * (`flagLive === true`): `false` means another tab or device already settled
 * it, and `null` means this tab has no confirmed answer (not heard yet, cached,
 * a write in flight or a failed listener), so its pending yes may be stale (the
 * reader may have started and ended the subscription elsewhere since). The yes
 * then waits for the next session.
 */
export function digestOptInStep({ consent, attempted, flagLive, enabled, serviceDown, hasFollows, digestCovered, digestSendReady }: {
  consent: DigestConsent;
  attempted: boolean;
  flagLive: boolean | null;
  enabled: boolean;
  serviceDown: boolean;
  hasFollows: boolean;
  digestCovered: boolean;
  digestSendReady: boolean;
}): 'settle' | 'subscribe' | 'wait' {
  if (attempted || flagLive === false) return 'wait';
  if (enabled || consent === DIGEST_CONSENT_SPENT) return 'settle';
  if (serviceDown) return 'wait';
  const ready = consent === DIGEST_CONSENT_FROM_SIGNUP ? digestCovered && digestSendReady : hasFollows;
  return ready && flagLive === true ? 'subscribe' : 'wait';
}

/**
 * Whether an answer still belongs to the account shown and signed in. React
 * learns of an account change after Firebase does, and analytics identifies the
 * new account in between: a response for the previous account must be dropped
 * against both, or it could be reported under the next account's identity.
 */
export function requestAccountCurrent({ requestUid, shownUid, signedInUid }: {
  requestUid: string | null;
  shownUid: string | null;
  signedInUid: string | null | undefined;
}) {
  return requestUid !== null && requestUid === shownUid && requestUid === signedInUid;
}
