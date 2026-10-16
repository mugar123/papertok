/**
 * Whether a failed Worker call failed because there is no session — the
 * browser refusing to send one (`WorkerApiAuthError`, code
 * WORKER_AUTH_REQUIRED) or the Worker answering 401 / AUTH_REQUIRED for an
 * expired one — rather than because a provider is down. The two want
 * different words: "sign in", not "could not be loaded right now".
 */
export function isSignInRequiredError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === 'WORKER_AUTH_REQUIRED'
    || (error as { code?: unknown }).code === 'AUTH_REQUIRED'
    || (error as { status?: unknown }).status === 401;
}
