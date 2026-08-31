/**
 * Firestore with the Worker's own service identity (P18/P10).
 *
 * Everything the app writes goes through `firestore.rules` from the browser,
 * which is right for user-owned documents. Public list documents are the
 * exception: validating them needs more expressions than the rules engine will
 * evaluate in one request (1000), so `publicLists` is closed to clients and
 * written here instead, after validation in real code.
 *
 * The access token is an OAuth2 token minted from the service account key by
 * signing a JWT with RS256 — there is no Google SDK in a Worker, so the grant
 * is built by hand with WebCrypto. Tokens last an hour and are cached in the
 * isolate, so a cold start pays one signature and one token exchange and every
 * request after that pays neither.
 *
 * Scope is `datastore` only, and the service account is expected to hold
 * `roles/datastore.user`: it reads and writes documents and can do nothing
 * else — not IAM, not Auth, not the rules themselves.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const JWT_LIFETIME_SECONDS = 3600;
/** Mint a new token this long before the old one lapses. */
const TOKEN_REFRESH_MARGIN_SECONDS = 300;

export class FirestoreAdminError extends Error {
  constructor(code, status = 502, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'FirestoreAdminError';
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
export function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function base64UrlEncode(bytes) {
  const binary = typeof bytes === 'string'
    ? bytes
    : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new FirestoreAdminError('SERVICE_ACCOUNT_KEY_INVALID', 503);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function readServiceAccount(env) {
  const email = String(env.FIREBASE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = normalizePrivateKey(env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  if (!email || !privateKey || !projectId) {
    throw new FirestoreAdminError('SERVICE_ACCOUNT_NOT_CONFIGURED', 503);
  }
  return { email, privateKey, projectId };
}

export function isServiceAccountConfigured(env) {
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

const tokenCache = new Map();

/** Test seam: drops the cached token so a test can observe a fresh mint. */
export function resetAccessTokenCache() {
  tokenCache.clear();
}

export async function buildAssertion(account, nowSeconds) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: account.email,
    scope: SCOPE,
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

export async function getAccessToken(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const account = readServiceAccount(env);
  const nowSeconds = Math.floor(now() / 1000);
  const cached = tokenCache.get(account.email);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS > nowSeconds) return cached.token;

  const assertion = await buildAssertion(account, nowSeconds);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new FirestoreAdminError('SERVICE_TOKEN_REFUSED', 502, payload?.error || '');
  }
  tokenCache.set(account.email, {
    token: payload.access_token,
    expiresAt: nowSeconds + (Number(payload.expires_in) || JWT_LIFETIME_SECONDS),
  });
  return payload.access_token;
}

// ---------------------------------------------------------------------------
// The value codec. Firestore REST speaks tagged values, JavaScript does not.
// ---------------------------------------------------------------------------

export function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value) } };
  }
  throw new FirestoreAdminError('UNENCODABLE_VALUE', 500, typeof value);
}

export function encodeFields(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, encodeValue(value)]),
  );
}

export function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  // referenceValue, geoPointValue and bytesValue never appear in this app's
  // documents; surfacing them as null beats pretending they decoded.
  return null;
}

export function decodeFields(fields) {
  return Object.fromEntries(
    Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)]),
  );
}

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

function documentRoot(projectId) {
  return `projects/${projectId}/databases/(default)/documents`;
}

/**
 * `['users', uid, 'lists', listId]` -> a fully qualified document name.
 *
 * A segment that is `.` or `..` survives `encodeURIComponent` and is then
 * resolved away by the URL parser, which would silently address a document one
 * level up from the one the caller asked about. This is not only belt and
 * braces for the route validators: `listId` also arrives here straight out of
 * `publicListOwners/{shareId}`, recorded by a publish that ran before those
 * validators existed, so it is never re-checked upstream.
 */
export function documentName(projectId, segments) {
  for (const segment of segments) {
    if (typeof segment !== 'string' || !segment || segment.includes('/')
      || segment === '.' || segment === '..') {
      throw new FirestoreAdminError('INVALID_DOCUMENT_PATH', 400);
    }
  }
  return `${documentRoot(projectId)}/${segments.map(encodeURIComponent).join('/')}`;
}

export function createFirestoreAdmin(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const { email, projectId } = readServiceAccount(env);

  /**
   * One retry, and only for a 401.
   *
   * The access token is cached for the life of the isolate, so a token Google
   * has stopped honouring goes on being presented for up to fifty-five minutes,
   * and every request inside that window comes back 401 and leaves as a 502.
   * Dropping the cached token costs one signature and recovers on the spot.
   *
   * Repeating a commit is safe even though these writes are not idempotent: a
   * 401 is refused at the authentication layer, before the transaction runs, so
   * the second attempt is the first execution.
   *
   * 403 is deliberately NOT retried. A revoked key fails at the token exchange
   * (SERVICE_TOKEN_REFUSED) and never gets this far; every remaining 403 is
   * PERMISSION_DENIED about an identity that authenticated perfectly well, so a
   * fresh token changes nothing and re-minting would add a JWT signature and a
   * token exchange to every single request for as long as the misconfiguration
   * lasted.
   */
  async function authorizedFetch(url, init) {
    const send = async () => {
      const token = await getAccessToken(env, { fetchImpl, now });
      return fetchImpl(url, {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${token}` },
      });
    };
    const response = await send();
    if (response.status !== 401) return response;
    tokenCache.delete(email);
    return send();
  }

  return {
    projectId,
    name: segments => documentName(projectId, segments),

    /**
     * Returns the decoded document, or null when it does not exist.
     *
     * With `withMeta` it returns `{ data, updateTime }` instead, `updateTime`
     * being the RFC3339 string the REST API reports — the value a
     * `currentDocument.updateTime` precondition needs, so a read-modify-write
     * can refuse to clobber a document that moved under it.
     */
    async getDocument(segments, { withMeta = false } = {}) {
      const url = `https://firestore.googleapis.com/v1/${documentName(projectId, segments)}`;
      const response = await authorizedFetch(url, { method: 'GET' });
      if (response.status === 404) return null;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new FirestoreAdminError('FIRESTORE_READ_FAILED', 502, payload?.error?.status || '');
      }
      const data = decodeFields(payload.fields);
      return withMeta ? { data, updateTime: payload.updateTime } : data;
    },

    /**
     * Several documents in one round trip. Missing names come back as `null`
     * rather than throwing, matching `getDocument`. Order follows `docs`.
     */
    async batchGet(docs) {
      const names = (Array.isArray(docs) ? docs : []).map(segments => documentName(projectId, segments));
      if (names.length === 0) return [];
      const url = `https://firestore.googleapis.com/v1/${documentRoot(projectId)}:batchGet`;
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents: names }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new FirestoreAdminError(
          'FIRESTORE_READ_FAILED',
          502,
          payload?.error?.status || '',
        );
      }
      const rows = Array.isArray(payload) ? payload : [];
      const byName = new Map();
      for (const row of rows) {
        if (row?.found?.name) {
          byName.set(row.found.name, decodeFields(row.found.fields));
        } else if (typeof row?.missing === 'string') {
          byName.set(row.missing, null);
        }
      }
      return names.map(name => (byName.has(name) ? byName.get(name) : null));
    },

    /**
     * A structured query scoped to a parent document (or the database root
     * when `parentSegments` is empty). Each hit is `{ id, data }`.
     */
    async runQuery({ parentSegments = [], collectionId, orderByField, orderDirection = 'ASCENDING', limit: pageSize } = {}) {
      if (typeof collectionId !== 'string' || !collectionId || collectionId.includes('/')) {
        throw new FirestoreAdminError('INVALID_DOCUMENT_PATH', 400);
      }
      const parent = parentSegments.length
        ? documentName(projectId, parentSegments)
        : documentRoot(projectId);
      const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;
      const structuredQuery = {
        from: [{ collectionId }],
        ...(orderByField ? {
          orderBy: [{
            field: { fieldPath: orderByField },
            direction: orderDirection === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
          }],
        } : {}),
        ...(Number.isInteger(pageSize) && pageSize > 0 ? { limit: pageSize } : {}),
      };
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ structuredQuery }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new FirestoreAdminError(
          'FIRESTORE_READ_FAILED',
          502,
          payload?.error?.status || '',
        );
      }
      const rows = Array.isArray(payload) ? payload : [];
      return rows.flatMap((row) => {
        const name = row?.document?.name;
        if (typeof name !== 'string' || !name) return [];
        const id = name.slice(name.lastIndexOf('/') + 1);
        return [{ id, data: decodeFields(row.document.fields) }];
      });
    },

    /**
     * A capped `count()` aggregation. Same parent/collection shape as
     * `runQuery`. Returns an integer; a missing alias is zero.
     */
    async countQuery({ parentSegments = [], collectionId, limit: cap } = {}) {
      if (typeof collectionId !== 'string' || !collectionId || collectionId.includes('/')) {
        throw new FirestoreAdminError('INVALID_DOCUMENT_PATH', 400);
      }
      const parent = parentSegments.length
        ? documentName(projectId, parentSegments)
        : documentRoot(projectId);
      const url = `https://firestore.googleapis.com/v1/${parent}:runAggregationQuery`;
      const structuredQuery = {
        from: [{ collectionId }],
        ...(Number.isInteger(cap) && cap > 0 ? { limit: cap } : {}),
      };
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          structuredQuery,
          aggregations: [{ alias: 'count', count: {} }],
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new FirestoreAdminError(
          'FIRESTORE_READ_FAILED',
          502,
          payload?.error?.status || '',
        );
      }
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const row of rows) {
        const raw = row?.result?.aggregateFields?.count?.integerValue
          ?? row?.result?.aggregateFields?.count?.doubleValue;
        const count = Number(raw);
        if (Number.isFinite(count)) return Math.max(0, Math.trunc(count));
      }
      return 0;
    },

    /**
     * One atomic commit. `writes` are the REST shapes built by the helpers
     * below, so a publish either lands whole or not at all — which is the
     * property the client-side batch had and must not lose.
     */
    async commit(writes) {
      const url = `https://firestore.googleapis.com/v1/${documentRoot(projectId)}:commit`;
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ writes }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = payload?.error?.status || '';
        // A failed precondition is the caller's problem (already published,
        // or gone), not an outage.
        if (status === 'FAILED_PRECONDITION' || status === 'NOT_FOUND') {
          throw new FirestoreAdminError('FIRESTORE_PRECONDITION_FAILED', 409, status);
        }
        throw new FirestoreAdminError('FIRESTORE_WRITE_FAILED', 502, status);
      }
      return payload;
    },
  };
}

// ---------------------------------------------------------------------------
// Write builders.
// ---------------------------------------------------------------------------

/** Creates a document and fails if it already exists. */
export function createWrite(name, data) {
  return {
    update: { name, fields: encodeFields(data) },
    currentDocument: { exists: false },
  };
}

/** Overwrites a document wholesale and fails if it is not already there. */
export function replaceWrite(name, data) {
  return {
    update: { name, fields: encodeFields(data) },
    currentDocument: { exists: true },
  };
}

/**
 * Touches only the named fields. The mask is what keeps `createdAt` out of an
 * update: the field is never sent, so it cannot be moved, and no read is
 * needed to carry its old value forward.
 *
 * `updateTime` narrows the precondition from "the document exists" to "the
 * document has not moved since this exact version" — the commit then fails
 * with FAILED_PRECONDITION (409 here) instead of overwriting a concurrent
 * write. Firestore accepts one precondition, so it replaces `mustExist`
 * rather than joining it; a version match implies existence anyway.
 */
export function mergeWrite(name, data, { mustExist = true, updateTime = null } = {}) {
  return {
    update: { name, fields: encodeFields(data) },
    updateMask: { fieldPaths: Object.keys(data) },
    ...(updateTime
      ? { currentDocument: { updateTime } }
      : mustExist ? { currentDocument: { exists: true } } : {}),
  };
}

/** Clears named fields without touching the rest of the document. */
export function clearFieldsWrite(name, fieldPaths) {
  return {
    update: { name, fields: {} },
    updateMask: { fieldPaths },
    currentDocument: { exists: true },
  };
}

export function deleteWrite(name) {
  return { delete: name };
}
