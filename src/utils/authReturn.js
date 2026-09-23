/**
 * Where a guest bounced off a protected route goes once they sign in.
 *
 * It lives here, at module scope, and not in `AppContent` state, because the
 * sign-in itself destroys `AppContent`: `App.jsx` keys the account-scoped tree
 * on `accountScopeKey`, and signed-out → an account advances that generation
 * (`accountScope.js`), which is the isolation it exists for. Held in state
 * below the key, the destination was erased at the one moment it was needed,
 * so every search link, /lists or /following a guest opened ended on the feed
 * (or the onboarding, asked to return to the feed). A reload still forgets it,
 * as it did: the arrival is cleared from the history entry so a reload does
 * not reopen the dialog, and a destination without its dialog would carry off
 * whatever sign-in came next.
 */

let pending = null;

// Only an in-app absolute path is honoured as a destination: `//evil.com` is
// a protocol-relative URL the browser would follow off-site, and bouncing
// back to /login or /onboarding would loop.
export function isInAppPath(path) {
  return typeof path === 'string'
    && path.startsWith('/')
    && !path.startsWith('//')
    && !['/login', '/onboarding'].includes(path.split('?')[0]);
}

/** A guest arrived with a destination; the latest arrival wins. */
export function offerAuthReturn(path) {
  pending = isInAppPath(path) ? path : null;
}

/**
 * The destination without using it up. A new account's first stop is the
 * onboarding, and it has to carry the destination there: several redirects to
 * it fire in the same commit (one per route that mounts at the sign-in, twice
 * each under StrictMode), and whichever lands last decides where the
 * onboarding sends the reader, so each of them has to name the same place.
 */
export function peekAuthReturn() {
  return pending;
}

/** The destination, once: the trip ends where it began and not twice. */
export function takeAuthReturn() {
  const destination = pending;
  pending = null;
  return destination;
}

/** A new door (Save, Like, Sign in) means "stay here", not the old trip. */
export function clearAuthReturn() {
  pending = null;
}
