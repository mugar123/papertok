export class WorkerAuthError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'WorkerAuthError';
    this.code = code;
    this.status = status;
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The deadline is short on purpose and covers the body as well as the headers:
 * `AbortSignal.timeout` has no timer to clear, so it stays armed until the answer
 * has been read in full. A verifier that sends its headers and then stalls is as
 * unreachable as one that never answered, and both have to fail as *unreachable*
 * rather than degrade into "invalid token" -- which is what an unparsed empty
 * body would have done here.
 */
const IDENTITY_TOOLKIT_TIMEOUT_MS = 4000;

async function lookupIdentity(token, env) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(IDENTITY_TOOLKIT_TIMEOUT_MS),
    },
  );
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    // An answer that is not JSON is still an answer, and an answer without a user
    // in it is a refusal.
    payload = {};
  }
  return { ok: response.ok, payload };
}

/**
 * `allowCache` exists for the write endpoints. Reads tolerate a 60 s window in
 * which a just-revoked token still passes; a route that publishes a document to
 * the open web does not, so those routes ask Identity Toolkit every time.
 */
export async function verifyFirebaseIdentity(request, env, { allowCache = true } = {}) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
  if (!token || token.length > 8_192) throw new WorkerAuthError('AUTH_REQUIRED', 401);
  if (!env.FIREBASE_WEB_API_KEY) throw new WorkerAuthError('AUTH_NOT_CONFIGURED', 503);

  const cacheKey = new Request(`https://papertok.internal/auth/${await sha256(token)}`);
  if (allowCache) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached.json();
  }

  let lookup;
  try {
    lookup = await lookupIdentity(token, env);
  } catch {
    // Reaching Identity Toolkit failed. That is a statement about Google, not
    // about the token, and the difference matters: this verifier sits in front of
    // every protected route on each miss of the 60 s identity cache, so reporting
    // an outage as 401 would tell a whole session's worth of users that they had
    // been signed out. 503 says retry.
    throw new WorkerAuthError('AUTH_UNAVAILABLE', 503);
  }
  const user = lookup.payload?.users?.[0];
  const identity = user?.localId ? { uid: user.localId } : null;
  if (!lookup.ok || !identity) throw new WorkerAuthError('AUTH_REQUIRED', 401);

  if (allowCache) {
    await caches.default.put(cacheKey, new Response(JSON.stringify(identity), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60',
      },
    }));
  }
  return identity;
}
