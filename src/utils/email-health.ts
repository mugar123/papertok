/**
 * What a `/health/email` answer says about the email service. Once the
 * window's live probes are spent, the Worker answers `HEALTH_PROBE_LIMITED`
 * without asking Resend, so the service is unknown rather than down. Unknown
 * blocks nothing: saving preferences does not call Resend, and a test send
 * reports its own failure.
 */
export function emailServiceState(health: { available?: boolean; code?: string | null } | null): 'available' | 'unknown' | 'down' {
  if (health?.available) return 'available';
  if (health?.code === 'HEALTH_PROBE_LIMITED') return 'unknown';
  return 'down';
}
