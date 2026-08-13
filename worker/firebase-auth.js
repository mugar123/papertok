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

export async function verifyFirebaseIdentity(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
  if (!token || token.length > 8_192) throw new WorkerAuthError('AUTH_REQUIRED', 401);
  if (!env.FIREBASE_WEB_API_KEY) throw new WorkerAuthError('AUTH_NOT_CONFIGURED', 503);

  const cacheKey = new Request(`https://papertok.internal/auth/${await sha256(token)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached.json();

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  const user = payload?.users?.[0];
  const identity = user?.localId ? { uid: user.localId } : null;
  if (!response.ok || !identity) throw new WorkerAuthError('AUTH_REQUIRED', 401);

  await caches.default.put(cacheKey, new Response(JSON.stringify(identity), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  }));
  return identity;
}
