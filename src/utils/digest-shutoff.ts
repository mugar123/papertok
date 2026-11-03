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
 * cached one (ENG-163).
 */
export function digestSyncAllowed({ hasFollows, followsConfirmed }: { hasFollows: boolean; followsConfirmed: boolean }) {
  return hasFollows || followsConfirmed;
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
