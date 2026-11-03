export interface DigestShutoffState {
  /** The saved subscription is on. */
  enabled: boolean;
  /** The follows in hand are the server's own answer: not cached, not failed, no write in flight. */
  followsConfirmed: boolean;
  /** At least one follow the digest covers is left. */
  hasDigestFollows: boolean;
  /** This account's shutoff was already sent and has not been undone by a new follow. */
  attempted: boolean;
}

/**
 * Whether the weekly digest has to be turned off now: it is on, nothing it
 * covers is followed any more, and that absence is confirmed. The app stops
 * syncing an empty follow list and the Worker refuses one, so without this the
 * stored subscription keeps emailing the follows last synced (ENG-163). A
 * failed or cached read of the follows must never unsubscribe anyone.
 */
export function digestShutoffDue({ enabled, followsConfirmed, hasDigestFollows, attempted }: DigestShutoffState) {
  return enabled && followsConfirmed && !hasDigestFollows && !attempted;
}
