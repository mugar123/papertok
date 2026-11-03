export interface DigestShutoffState {
  /** The saved subscription is on. */
  enabled: boolean;
  /** The follows and interests in hand are the server's own answer: not cached, not failed, no write in flight. */
  confirmed: boolean;
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
 * unsubscribe anyone.
 */
export function digestShutoffDue({ enabled, confirmed, digestCovered, attempted }: DigestShutoffState) {
  return enabled && confirmed && !digestCovered && !attempted;
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
