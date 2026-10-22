import type { WorkerEnv } from './env.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const JWT_LIFETIME_SECONDS = 3600;
/** Mint a new token this long before the old one lapses. */
const TOKEN_REFRESH_MARGIN_SECONDS = 300;

export class FirebaseServiceAccountError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status = 502, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'FirebaseServiceAccountError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Credentials.
// ---------------------------------------------------------------------------

/**
 * The private key arrives as a Wrangler secret, and how it arrives depends on
 * how it was pasted: straight from the JSON key file it carries literal
 * backslash-n, piped from a PEM it carries real newlines. Both are accepted so
 * loading the secret cannot fail in a way that only shows up at the first
 * publish.
 */
export function normalizePrivateKey(value: unknown) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function base64UrlEncode(bytes: string | ArrayBuffer) {
  const binary = typeof bytes === 'string'
    ? bytes
    : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new FirebaseServiceAccountError('SERVICE_ACCOUNT_KEY_INVALID', 503);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function readServiceAccount(env: WorkerEnv) {
  const email = String(env.FIREBASE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = normalizePrivateKey(env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  if (!email || !privateKey || !projectId) {
    throw new FirebaseServiceAccountError('SERVICE_ACCOUNT_NOT_CONFIGURED', 503);
  }
  return { email, privateKey, projectId };
}

export function isServiceAccountConfigured(env: WorkerEnv) {
  try {
    readServiceAccount(env);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token minting, cached per isolate.
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Test seam: drops the cached token so a test can observe a fresh mint. */
export function resetAccessTokenCache() {
  tokenCache.clear();
}

export async function buildAssertion(account: Pick<ReturnType<typeof readServiceAccount>, 'email' | 'privateKey'>, nowSeconds: number, scope = DATASTORE_SCOPE) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: account.email,
    scope,
    aud: TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
  }));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(account.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function getAccessToken(env: WorkerEnv, { fetchImpl = fetch, now = () => Date.now(), scope = DATASTORE_SCOPE } = {}) {
  const account = readServiceAccount(env);
  const nowSeconds = Math.floor(now() / 1000);
  const cached = tokenCache.get(`${account.email}:${scope}`);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS > nowSeconds) return cached.token;

  const assertion = await buildAssertion(account, nowSeconds, scope);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const payload = await response.json<{ access_token?: string; expires_in?: unknown; error?: string }>().catch(() => ({} as { access_token?: string; expires_in?: unknown; error?: string }));
  if (!response.ok || !payload?.access_token) {
    throw new FirebaseServiceAccountError('SERVICE_TOKEN_REFUSED', 502, payload?.error || '');
  }
  tokenCache.set(`${account.email}:${scope}`, {
    token: payload.access_token,
    expiresAt: nowSeconds + (Number(payload.expires_in) || JWT_LIFETIME_SECONDS),
  });
  return payload.access_token;
}

export function invalidateAccessToken(email: string, scope = DATASTORE_SCOPE) {
  tokenCache.delete(`${email}:${scope}`);
}
