import type { WorkerEnv } from './env.ts';

export interface VerifiedIdentity {
  uid: string;
  email: string;
  displayName?: string;
  /** Firebase's own flag, set only by sign-ins through a provider that verifies the address itself. */
  emailVerified: boolean;
  /** `emailVerified`, or a Google or GitHub identity carrying the same address (`accountOwnsEmail`). */
  ownsEmail: boolean;
  authTime: number | null;
}

interface LookupUser {
  localId?: string;
  email?: unknown;
  displayName?: unknown;
  emailVerified?: unknown;
  providerUserInfo?: Array<{ providerId?: unknown; email?: unknown }>;
}

interface IdentityLookup {
  users?: LookupUser[];
}

const TRUSTED_EMAIL_PROVIDERS = new Set(['google.com', 'github.com']);

/**
 * Whether the account has proven the address it carries.
 *
 * FIREBASE_WEB_API_KEY is public, so the Worker cannot assume the console only
 * offers Google and GitHub: any sign-up method that hands over an unverified
 * address would otherwise pass for its owner. And Firebase sets `emailVerified`
 * only when the provider verifies the address itself, which Google does and
 * GitHub does not, so a GitHub sign-in arrives with the flag off and nothing in
 * the app to turn it on (#267). An identity provider that vouched for the same
 * address is the proof of possession in that case.
 */
export function accountOwnsEmail(account: Pick<LookupUser, 'email' | 'emailVerified' | 'providerUserInfo'> | null | undefined) {
  if (account?.emailVerified === true) return true;
  const email = String(account?.email || '').trim().toLowerCase();
  return email !== '' && (account?.providerUserInfo || []).some(provider => (
    TRUSTED_EMAIL_PROVIDERS.has(String(provider?.providerId || '').trim().toLowerCase())
    && String(provider?.email || '').trim().toLowerCase() === email
  ));
}

export class WorkerAuthError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'WorkerAuthError';
    this.code = code;
    this.status = status;
  }
}

async function sha256(value: string) {
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

/** A token this close to expiry is still worth asking Google about. */
const CLOCK_SKEW_SECONDS = 60;

/** The width of a name in a subscription and in the delivery ledger's recipient. */
const MAX_DISPLAY_NAME_LENGTH = 160;

function decodeSegment(segment: string): { exp?: unknown; aud?: unknown; auth_time?: unknown } | null {
  const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * A local, signature-free look at the token before Google is asked about it.
 *
 * Delegating verification to `accounts:lookup` is the right design and is not
 * being revisited. What was wrong is that ANY non-blank string up to 8 KB paid
 * for a round trip to Identity Toolkit, so an anonymous caller could spend the
 * upstream allowance one junk request at a time. Three base64url segments, a
 * payload that parses, an `exp` that has not passed and an `aud` naming this
 * project cost nothing to check here, and a token failing any of them cannot
 * have been issued by Firebase.
 *
 * `alg`, `iss` and `sub` are deliberately not read: unverified, they are
 * attacker-controlled, so they would buy no security while risking a false
 * negative the day Firebase changes one of them. And `aud` is only checked when
 * the project id is configured — a Worker that does not know its own project
 * must not answer 401 to everybody.
 *
 * Returns the claims, still unverified, or null when the token fails a check.
 */
function screenIdToken(token: string, env: WorkerEnv, nowSeconds: number) {
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some(segment => !segment)) return null;
  let claims;
  try {
    decodeSegment(segments[0]);
    claims = decodeSegment(segments[1]);
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (!Number.isFinite(claims.exp) || (claims.exp as number) + CLOCK_SKEW_SECONDS < nowSeconds) return null;
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  return !projectId || claims.aud === projectId ? claims : null;
}

async function lookupIdentity(token: string, env: WorkerEnv) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY!)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(IDENTITY_TOOLKIT_TIMEOUT_MS),
    },
  );
  const body = await response.text();
  let payload: IdentityLookup | null;
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
export async function verifyFirebaseIdentity(request: Request, env: WorkerEnv, options?: { allowCache?: boolean }) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
  return verifyIdToken(token, env, options);
}

/**
 * The same verification for a token that did not arrive as the request's own
 * credential: the institution link sends a second account's ID token in its
 * body, and that token has to be checked exactly like the first one, including
 * the local screen that keeps junk strings away from Identity Toolkit.
 */
export async function verifyIdToken(token: string, env: WorkerEnv, { allowCache = true } = {}): Promise<VerifiedIdentity> {
  if (!token || token.length > 8_192) throw new WorkerAuthError('AUTH_REQUIRED', 401);
  if (!env.FIREBASE_WEB_API_KEY) throw new WorkerAuthError('AUTH_NOT_CONFIGURED', 503);

  const cacheKey = new Request(`https://papertok.internal/auth/${await sha256(token)}`);
  if (allowCache) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached.json<VerifiedIdentity>();
  }

  // After the cache, not before it: only a verified identity is ever cached, so
  // a token that fails this filter could not have produced a hit anyway, and
  // the warm path keeps costing what it costs today.
  const claims = screenIdToken(token, env, Math.floor(Date.now() / 1000));
  if (!claims) throw new WorkerAuthError('AUTH_REQUIRED', 401);

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
  // The email travels with the identity so a caller can recognise a specific
  // account without a second lookup, and `emailVerified` travels with it because
  // an unverified address is a claim rather than an identity — anything that
  // grants on the strength of an email has to see both. `ownsEmail` is for the
  // routes that only need a proven owner, since the flag alone shuts out every
  // GitHub account (`accountOwnsEmail`).
  //
  // `authTime` is when the user last signed in for this session, in seconds.
  // The claim can be trusted only because Identity Toolkit accepted the token
  // that carries it; a token it refuses never gets this far.
  //
  // `displayName` is here for the email routes, which store it with the
  // subscription. Like the email, it sits in the 60 s cache entry below, so it
  // is collapsed and capped here, where the provider's string enters, to the
  // width the subscription keeps. Only the notification writes read it today,
  // and they skip the cache.
  const identity = user?.localId
    ? {
      uid: user.localId,
      email: String(user.email || '').trim().toLowerCase(),
      ...(typeof user.displayName === 'string'
        ? { displayName: user.displayName.replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME_LENGTH) }
        : {}),
      emailVerified: user.emailVerified === true,
      ownsEmail: accountOwnsEmail(user),
      authTime: typeof claims.auth_time === 'number' && Number.isFinite(claims.auth_time) ? claims.auth_time : null,
    }
    : null;
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
