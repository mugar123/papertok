import type { CallerMinute } from './caller-quota.ts';
import type { WorkerEnv } from './env.ts';

import { readBoundedBytes } from './bounded-body.ts';
import { reserveAccountMinute, reserveCallerMinute } from './caller-quota.ts';
import { verifyFirebaseIdentity, WorkerAuthError } from './firebase-auth.ts';

/**
 * The credential an AI agent presents to the MCP server (`mcp-server.ts`) on
 * behalf of a signed-in reader. The app asks `POST /mcp/token` for one with
 * the reader's Firebase ID token and hands the agent this token instead: it
 * names the account and the scopes it may use, lasts thirty minutes, and no
 * other route accepts it.
 *
 * `ptka1.<payload>.<signature>`, both parts base64url. The signature is an
 * HMAC-SHA-256, keyed with `MCP_AGENT_TOKEN_SECRET`, of a message that names
 * this use and the payload as it travels, so nothing is stored and a
 * signature made with the same secret for another purpose does not verify.
 */
export const AGENT_TOKEN_PATH = '/mcp/token';

// Every scope a token can carry. A token lists the ones it was minted with,
// and one that lists any other is refused.
const AGENT_SCOPES = ['account:read', 'lists:write', 'feeds:write'] as const;
export type AgentScope = typeof AGENT_SCOPES[number];
// What a request that names no scope is given. A scope that lets an agent
// write is given only to a request that asks for it by name.
const DEFAULT_SCOPES: readonly AgentScope[] = ['account:read'];
export interface AgentIdentity { uid: string; scopes: AgentScope[] }

const TOKEN_PREFIX = 'ptka1';
const SIGNED_PREFIX = 'papertok-agent-token:v1:';
const TOKEN_LIFETIME_SECONDS = 30 * 60;
const MAX_TOKEN_LENGTH = 2_048;
const MIN_SECRET_LENGTH = 32;
// Firebase's own bound on a user ID.
const MAX_UID_LENGTH = 128;
const MAX_BODY_BYTES = 1_024;
// Tokens one account may ask for in a UTC minute.
const MINT_MINUTE = Object.freeze({ namespace: 'mcp-token', limit: 20 });
// Requests one address may make for a token in a UTC minute, signed in or not:
// several accounts can share an address.
const ADDRESS_MINT_LIMIT = 60;

export class AgentTokenError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter?: string;

  constructor(code: string, status: number, retryAfter?: string) {
    super(code);
    this.name = 'AgentTokenError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Null unless the segment is the one spelling of its bytes: `atob` skips
// whitespace and ignores a final character's spare bits, so several strings
// decode to one signature.
function fromBase64Url(segment: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const bytes = Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    return toBase64Url(bytes) === segment ? bytes : null;
  } catch {
    return null;
  }
}

function knownScopes(value: unknown): AgentScope[] | null {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) return null;
  return value.every(scope => (AGENT_SCOPES as readonly unknown[]).includes(scope)) ? value as AgentScope[] : null;
}

async function signingKey(env: WorkerEnv) {
  const secret = env.MCP_AGENT_TOKEN_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new WorkerAuthError('AGENT_TOKEN_NOT_CONFIGURED', 503);
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const signedMessage = (payload: string) => new TextEncoder().encode(`${SIGNED_PREFIX}${payload}`);

/** A token for `uid` with `scopes`, and the second it expires at. */
export async function mintAgentToken(env: WorkerEnv, uid: string, scopes: AgentScope[], now = Date.now()) {
  if (!uid || uid.length > MAX_UID_LENGTH) throw new WorkerAuthError('AUTH_REQUIRED', 401);
  if (!knownScopes(scopes)) throw new AgentTokenError('INVALID_SCOPE', 400);
  const key = await signingKey(env);
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + TOKEN_LIFETIME_SECONDS;
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ uid, scopes, iat: issuedAt, exp: expiresAt })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedMessage(payload)));
  return { token: `${TOKEN_PREFIX}.${payload}.${toBase64Url(signature)}`, expiresAt };
}

/**
 * The account and scopes a token names. Anything but a token this Worker
 * minted and that has not expired is `AUTH_REQUIRED` (401); a missing or
 * short secret is `AGENT_TOKEN_NOT_CONFIGURED` (503).
 */
export async function verifyAgentToken(token: string, env: WorkerEnv, now = Date.now()): Promise<AgentIdentity> {
  const refused = () => new WorkerAuthError('AUTH_REQUIRED', 401);
  const segments = token.split('.');
  if (!token || token.length > MAX_TOKEN_LENGTH || segments.length !== 3 || segments[0] !== TOKEN_PREFIX) throw refused();
  const key = await signingKey(env);
  const signature = fromBase64Url(segments[2]);
  // `verify` compares in constant time.
  if (!signature || !await crypto.subtle.verify('HMAC', key, signature, signedMessage(segments[1]))) throw refused();
  const encoded = fromBase64Url(segments[1]);
  if (!encoded) throw refused();
  let payload: { uid?: unknown; scopes?: unknown; iat?: unknown; exp?: unknown } | null;
  try {
    payload = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw refused();
  }
  const scopes = knownScopes(payload?.scopes);
  if (!payload || !scopes || typeof payload.uid !== 'string' || !payload.uid || payload.uid.length > MAX_UID_LENGTH
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || (payload.exp as number) <= Math.floor(now / 1000)) {
    throw refused();
  }
  return { uid: payload.uid, scopes };
}

// The scopes a request asks for; an empty body asks for the default.
async function requestedScopes(request: Request) {
  const bytes = await readBoundedBytes(request, MAX_BODY_BYTES);
  if (!bytes) throw new AgentTokenError('PAYLOAD_TOO_LARGE', 413);
  if (bytes.byteLength === 0) return [...DEFAULT_SCOPES];
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AgentTokenError('INVALID_BODY', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentTokenError('INVALID_BODY', 400);
  const asked = (body as { scopes?: unknown }).scopes;
  if (asked === undefined) return [...DEFAULT_SCOPES];
  const scopes = knownScopes(asked);
  if (!scopes) throw new AgentTokenError('INVALID_SCOPE', 400);
  return scopes;
}

// Throws unless the unit was reserved: a missing secret, address or binding is
// configuration, and a ledger that did not answer an outage to retry after.
function spend(minute: CallerMinute) {
  if (minute.reading.code === 'CALLER_IDENTITY_NOT_CONFIGURED' || minute.reading.code === 'QUOTA_LEDGER_NOT_CONFIGURED') {
    throw new AgentTokenError('AGENT_TOKEN_QUOTA_NOT_CONFIGURED', 503);
  }
  if (minute.reading.code) throw new AgentTokenError('QUOTA_LEDGER_UNAVAILABLE', 503, minute.retryAfter);
  if (!minute.reading.accepted) throw new AgentTokenError('AGENT_TOKEN_RATE_LIMITED', 429, minute.retryAfter);
}

/**
 * `POST /mcp/token`: a token for the account whose Firebase ID token the
 * request carries. The identity is never read from the 60-second cache: a
 * token outlives it, so a sign-in revoked a moment ago must not mint one.
 */
export async function handleAgentTokenRequest(request: Request, env: WorkerEnv) {
  // Before Identity Toolkit is asked: a Worker without the secret mints nothing.
  await signingKey(env);
  // Read first, so a body that is refused spends nothing.
  const scopes = await requestedScopes(request);
  // The identity is looked up uncached, so the address is counted before the
  // lookup: requests past the account's limit would each still cost one.
  spend(await reserveCallerMinute(request, env, MINT_MINUTE.namespace, ADDRESS_MINT_LIMIT));
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  spend(await reserveAccountMinute(identity.uid, env, MINT_MINUTE.namespace, MINT_MINUTE.limit));
  const { token, expiresAt } = await mintAgentToken(env, identity.uid, scopes);
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString(), scopes };
}
