// Codes `/health/email` answers when the Worker did not run the check: the
// window's live probes are spent, or its quota ledger is missing or failing.
// Neither says anything about Resend.
const UNCHECKED_CODES = new Set(['HEALTH_PROBE_LIMITED', 'PROVIDER_QUOTA_NOT_CONFIGURED']);

/**
 * What a `/health/email` answer says about the email service. A check the
 * Worker did not run leaves the service unknown rather than down. Unknown
 * blocks nothing: saving preferences does not call Resend, and a test send
 * reports its own failure.
 */
export function emailServiceState(health: { available?: boolean; code?: string | null } | null): 'available' | 'unknown' | 'down' {
  if (health?.available) return 'available';
  if (health?.code && UNCHECKED_CODES.has(health.code)) return 'unknown';
  return 'down';
}

/** The Worker's code for an email service that has no credential or sender configured yet. */
export const EMAIL_NOT_CONFIGURED_CODE = 'EMAIL_NOT_CONFIGURED';

/**
 * The reason email updates are paused when the service is not configured, as the
 * notice in the feed, Settings and the Email updates dialog all say it, so
 * hiding the notice (it does not fit on a very short window) loses nothing.
 */
export const EMAIL_NOT_CONFIGURED_REASON = 'The email service is not connected yet, so no digest will go out';

/** What Settings shows for a service that is down: not configured is not the same as not responding. */
export function emailDownStatus(health: { code?: string | null } | null) {
  return health?.code === EMAIL_NOT_CONFIGURED_CODE
    ? { label: 'Not connected', description: EMAIL_NOT_CONFIGURED_REASON }
    : { label: 'Unavailable', description: 'The email service is not responding right now' };
}

/** What the Email updates dialog says about a service that is down, by the code the Worker gave. */
export function emailProviderProblemText(code: string | null | undefined) {
  if (code === EMAIL_NOT_CONFIGURED_CODE) return `${EMAIL_NOT_CONFIGURED_REASON}.`;
  if (code === 'EMAIL_PROVIDER_AUTH_FAILED') return 'The email provider did not accept the saved credential.';
  if (code === 'EMAIL_SENDER_NOT_VERIFIED') return 'Resend has not verified the configured sender domain yet.';
  if (code === 'EMAIL_SENDER_STATUS_UNKNOWN') return 'PaperTok cannot confirm the sender domain with the current Resend key.';
  return 'The email provider is not available right now.';
}
