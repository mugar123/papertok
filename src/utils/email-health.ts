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
