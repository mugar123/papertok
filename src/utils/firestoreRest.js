/**
 * Firestore over its REST API, for the reads that must not depend on the
 * SDK's listen stream.
 *
 * Every `getDoc` and `getDocs` in the web SDK is a one-shot *listen*: it
 * travels over the single WebChannel stream the client keeps open, and it
 * inherits that stream's state. Measured on the follow sheet (2026-09-06):
 * against a stream that has died under a live client, the edge query says
 * nothing for ten seconds and then resolves **empty from the in-memory
 * cache**, which painted "No followers yet" for an account with followers —
 * and once the client has latched itself offline, every retry gets the same
 * cached answer in under a millisecond, until the page is reloaded. The
 * counters on the same screen never suffered this: `getCountFromServer` is a
 * plain XHR with its own timeout, and a fresh request each time.
 *
 * This helper gives a read those same properties: one HTTP request, a
 * `signal` that really ends it, no cache to answer from, and a network
 * failure that surfaces as `unavailable` — the code `patientRead` keeps
 * retrying — instead of as a lie. Rules are enforced by the server exactly as
 * for the SDK; a signed-in reader sends the same ID token the SDK would.
 *
 * Deliberately small: it reads single documents with `getDocument`, which is
 * all the app and the Worker's share pages need. `batchGet` is not here
 * because it is all-or-nothing: one
 * missing or private document in the batch fails the whole request with 403
 * (measured), so one deleted document would hide every other result.
 */

export const FIRESTORE_REST_BASE = 'https://firestore.googleapis.com/v1';

/** HTTP status → the SDK's error code, so callers keep one vocabulary. */
const STATUS_CODES = Object.freeze({
  400: 'invalid-argument',
  401: 'unauthenticated',
  403: 'permission-denied',
  404: 'not-found',
  409: 'aborted',
  429: 'resource-exhausted',
  499: 'cancelled',
  500: 'internal',
  501: 'unimplemented',
  503: 'unavailable',
  504: 'deadline-exceeded',
});

export function restErrorCode(status) {
  return STATUS_CODES[status] || 'unknown';
}

export class FirestoreRestError extends Error {
  constructor(message, { code = 'unknown', status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FirestoreRestError';
    this.code = code;
    this.status = status;
  }
}

export function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue?.fields);
  // referenceValue, geoPointValue and bytesValue never appear in this app's
  // documents; surfacing them as null beats pretending they decoded.
  return null;
}

export function decodeFields(fields) {
  return Object.fromEntries(
    Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)]),
  );
}

export function documentRoot(projectId) {
  return `projects/${projectId}/databases/(default)/documents`;
}

function lastSegment(path) {
  return String(path || '').split('/').pop();
}

/**
 * `getToken` is optional and best-effort: the data this helper reads is
 * public under the rules, so a token that cannot be minted (an auth network
 * hiccup) must not turn a public read into a failure. Know the price before
 * passing one: an `Authorization` header makes every request a CORS
 * preflight (one per URL), so a token doubles the round trips of a read.
 */
export function createFirestoreRest({ projectId, fetchImpl = globalThis.fetch, getToken } = {}) {
  if (!projectId) throw new TypeError('A Firestore project id is required.');
  const base = `${FIRESTORE_REST_BASE}/${documentRoot(projectId)}`;

  async function authorization() {
    if (!getToken) return {};
    try {
      const token = await getToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
  }

  async function request(url, init) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new FirestoreRestError('The request was cancelled.', { code: 'cancelled', cause: error });
      }
      throw new FirestoreRestError('Firestore could not be reached.', { code: 'unavailable', cause: error });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail = body?.error;
      throw new FirestoreRestError(detail?.message || `HTTP ${response.status}`, {
        code: restErrorCode(response.status),
        status: response.status,
      });
    }
    return body;
  }

  return {
    /** One document by path. A 404 is a confirmed absence; a 403 is not (it stays an error). */
    async getDocument(path, { signal } = {}) {
      const id = lastSegment(path);
      let body;
      try {
        body = await request(`${base}/${path}`, { method: 'GET', headers: await authorization(), signal });
      } catch (error) {
        if (error?.status === 404) return { exists: false, id, data: null };
        throw error;
      }
      return { exists: true, id, data: decodeFields(body?.fields) };
    },
  };
}
