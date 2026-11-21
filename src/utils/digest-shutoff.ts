import { getAllLeafCategories } from '../data/category-taxonomy.ts';

const LEAF_IDS = new Set(getAllLeafCategories().map(leaf => leaf.id));

/**
 * The chosen categories a profile snapshot gives the digest: its leaf ids,
 * once each and sorted, read the way the account profile reads them. They are
 * confirmed only when the snapshot is the server's copy, never the device's
 * cache; a server copy with no categories, or no profile, is a confirmed none.
 */
export function digestProfileInterests(profile: { preferences?: unknown; selectedCategories?: unknown } | undefined, fromCache: boolean) {
  const chosen = profile?.preferences || profile?.selectedCategories;
  const interests = Array.isArray(chosen)
    ? [...new Set(chosen.filter((id): id is string => typeof id === 'string' && LEAF_IDS.has(id)))].sort()
    : [];
  return { interests, confirmed: !fromCache };
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
 * When the welcome stopped saying the email waits for the first follow and
 * began promising it from sign-up. A yes saved by an account created before it
 * was given under the old promise and keeps it; an account created at or after
 * it is subscribed on its chosen topics alone. Creation time is Firebase's own
 * record, so no profile field or rule is needed to tell the two apart.
 */
export const DIGEST_FROM_SIGNUP_EFFECTIVE_AT = '2026-11-25T00:00:00Z';

/**
 * Whether a saved yes to the email still waits for the reader's first follow:
 * it is pending and either its account is older than `effectiveAt` or nothing
 * (no topic, follow or citation source) covers the digest yet. An account
 * whose creation time is unknown keeps the old promise rather than being
 * subscribed on a guess.
 */
export function digestOptInWaitsForFollow({ pending, accountCreated, covered = true, effectiveAt = DIGEST_FROM_SIGNUP_EFFECTIVE_AT }: {
  pending: boolean;
  accountCreated: string | null | undefined;
  covered?: boolean;
  effectiveAt?: string;
}) {
  if (!pending) return false;
  if (!covered) return true;
  const created = accountCreated ? new Date(accountCreated).getTime() : Number.NaN;
  return Number.isNaN(created) || created < new Date(effectiveAt).getTime();
}

/**
 * What a pending yes to the email does next, once the subscription and the
 * follows are known: `settle` when the digest is already on (the flag is
 * spent), `subscribe` when it can start now, `wait` otherwise. An older yes
 * starts with the first follow; a yes from an account created after
 * `effectiveAt` starts on whatever covers the digest, the chosen topics
 * included, once the profile read is the server's own (`digestSendReady`).
 * Nothing is attempted twice in a session; a failed attempt leaves the flag in
 * place, so the next session is the retry.
 */
export function digestOptInStep({ waitsForFollow, attempted, enabled, serviceDown, hasFollows, digestCovered, digestSendReady }: {
  waitsForFollow: boolean;
  attempted: boolean;
  enabled: boolean;
  serviceDown: boolean;
  hasFollows: boolean;
  digestCovered: boolean;
  digestSendReady: boolean;
}): 'settle' | 'subscribe' | 'wait' {
  if (attempted) return 'wait';
  if (enabled) return 'settle';
  if (serviceDown) return 'wait';
  const ready = waitsForFollow ? hasFollows : digestCovered && digestSendReady;
  return ready ? 'subscribe' : 'wait';
}
