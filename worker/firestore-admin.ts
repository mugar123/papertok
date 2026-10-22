import { getAccessToken, readServiceAccount, invalidateAccessToken } from './firebase-service-account.ts';
import type { WorkerEnv } from './env.ts';

import type { FirestoreValue, FirestoreDataValue, FirestoreData } from '../src/models/Firestore.ts';
export type { FirestoreValue, FirestoreDataValue, FirestoreData } from '../src/models/Firestore.ts';

interface FirestoreFailure { error?: { status?: string } }
interface FirestoreDocument extends FirestoreFailure {
  name: string;
  fields?: Record<string, FirestoreValue>;
  updateTime?: string;
}
interface FirestoreRow {
  found?: FirestoreDocument;
  missing?: string;
  document?: FirestoreDocument;
  result?: { aggregateFields?: { count?: { integerValue?: string; doubleValue?: number } } };
}
export interface QueryOptions {
  parentSegments?: string[];
  collectionId?: string;
  orderByField?: string;
  orderDirection?: string;
  limit?: number;
  where?: { field: string; op?: string; value: unknown };
  allDescendants?: boolean;
}
export interface FirestoreWrite {
  update?: { name: string; fields: Record<string, FirestoreValue> };
  delete?: string;
  updateMask?: { fieldPaths: string[] };
  currentDocument?: { exists?: boolean; updateTime?: string };
}
type DocumentResult<T, Meta extends boolean> = Meta extends true ? { data: T; updateTime?: string } : T;
export type FirestoreAdmin = ReturnType<typeof createFirestoreAdmin>;

export class FirestoreAdminError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status = 502, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'FirestoreAdminError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// The value codec. Firestore REST speaks tagged values, JavaScript does not.
// ---------------------------------------------------------------------------

export function encodeValue(value: unknown): FirestoreValue {
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

export function encodeFields(data: object): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, encodeValue(value)]),
  );
}

export function decodeValue(value: FirestoreValue | null | undefined): FirestoreDataValue {
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

export function decodeFields<T extends object = FirestoreData>(fields: Record<string, FirestoreValue> | null | undefined): T {
  return Object.fromEntries(
    Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)]),
  ) as T;
}

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

function documentRoot(projectId: string) {
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
export function documentName(projectId: string, segments: unknown[]) {
  for (const segment of segments) {
    if (typeof segment !== 'string' || !segment || segment.includes('/')
      || segment === '.' || segment === '..') {
      throw new FirestoreAdminError('INVALID_DOCUMENT_PATH', 400);
    }
  }
  return `${documentRoot(projectId)}/${(segments as string[]).map(encodeURIComponent).join('/')}`;
}

export function createFirestoreAdmin(env: WorkerEnv, { fetchImpl = fetch, now = () => Date.now() } = {}) {
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
  async function authorizedFetch(url: string, init: RequestInit) {
    const send = async () => {
      const token = await getAccessToken(env, { fetchImpl, now });
      return fetchImpl(url, {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${token}` },
      });
    };
    const response = await send();
    if (response.status !== 401) return response;
    invalidateAccessToken(email);
    return send();
  }

  return {
    projectId,
    name: (segments: string[]) => documentName(projectId, segments),

    /**
     * Returns the decoded document, or null when it does not exist.
     *
     * With `withMeta` it returns `{ data, updateTime }` instead, `updateTime`
     * being the RFC3339 string the REST API reports — the value a
     * `currentDocument.updateTime` precondition needs, so a read-modify-write
     * can refuse to clobber a document that moved under it.
     */
    async getDocument<T extends object = FirestoreData, Meta extends boolean = false>(segments: string[], { withMeta = false as Meta }: { withMeta?: Meta } = {}): Promise<DocumentResult<T, Meta> | null> {
      const url = `https://firestore.googleapis.com/v1/${documentName(projectId, segments)}`;
      const response = await authorizedFetch(url, { method: 'GET' });
      if (response.status === 404) return null;
      const payload = await response.json<Partial<FirestoreDocument>>().catch(() => ({} as Partial<FirestoreDocument>));
      if (!response.ok) {
        throw new FirestoreAdminError('FIRESTORE_READ_FAILED', 502, payload?.error?.status || '');
      }
      const data = decodeFields<T>(payload.fields);
      return (withMeta ? { data, updateTime: payload.updateTime } : data) as DocumentResult<T, Meta>;
    },

    /**
     * Several documents in one round trip. Missing names come back as `null`
     * rather than throwing, matching `getDocument`. Order follows `docs`.
     */
    async batchGet<T extends object = FirestoreData>(docs: string[][]): Promise<Array<T | null>> {
      const names = (Array.isArray(docs) ? docs : []).map(segments => documentName(projectId, segments));
      if (names.length === 0) return [];
      const url = `https://firestore.googleapis.com/v1/${documentRoot(projectId)}:batchGet`;
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents: names }),
      });
      const payload = await response.json<FirestoreRow[] | FirestoreFailure>().catch(() => null);
      if (!response.ok) {
        throw new FirestoreAdminError(
          'FIRESTORE_READ_FAILED',
          502,
          (payload as FirestoreFailure | null)?.error?.status || '',
        );
      }
      const rows = Array.isArray(payload) ? payload : [];
      const byName = new Map<string, T | null>();
      for (const row of rows) {
        if (row?.found?.name) {
          byName.set(row.found.name, decodeFields<T>(row.found.fields));
        } else if (typeof row?.missing === 'string') {
          byName.set(row.missing, null);
        }
      }
      return names.map(name => (byName.has(name) ? byName.get(name)! : null));
    },

    /**
     * A structured query scoped to a parent document (or the database root
     * when `parentSegments` is empty). Each hit is `{ id, data, path }`.
     *
     * `path` is the document segments after `/documents/`, so a collection
     * group hit can be addressed again without reconstructing the parent from
     * the id. `where` is a single field filter (`EQUAL` and friends).
     * `allDescendants: true` is a collection-group query.
     */
    async runQuery<T extends object = FirestoreData>({
      parentSegments = [],
      collectionId,
      orderByField,
      orderDirection = 'ASCENDING',
      limit: pageSize,
      where: whereFilter,
      allDescendants = false,
    }: QueryOptions = {}) {
      if (typeof collectionId !== 'string' || !collectionId || collectionId.includes('/')) {
        throw new FirestoreAdminError('INVALID_DOCUMENT_PATH', 400);
      }
      const parent = parentSegments.length
        ? documentName(projectId, parentSegments)
        : documentRoot(projectId);
      const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;
      const structuredQuery = {
        from: [{ collectionId, allDescendants: allDescendants === true }],
        ...(whereFilter?.field ? {
          where: {
            fieldFilter: {
              field: { fieldPath: String(whereFilter.field) },
              op: whereFilter.op || 'EQUAL',
              value: encodeValue(whereFilter.value),
            },
          },
        } : {}),
        ...(orderByField ? {
          orderBy: [{
            field: { fieldPath: orderByField },
            direction: orderDirection === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
          }],
        } : {}),
        ...(Number.isInteger(pageSize) && pageSize! > 0 ? { limit: pageSize } : {}),
      };
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ structuredQuery }),
      });
      const payload = await response.json<FirestoreRow[] | FirestoreFailure>().catch(() => null);
      if (!response.ok) {
        throw new FirestoreAdminError(
          'FIRESTORE_READ_FAILED',
          502,
          (payload as FirestoreFailure | null)?.error?.status || '',
        );
      }
      const rows = Array.isArray(payload) ? payload : [];
      return rows.flatMap((row) => {
        const name = row?.document?.name;
        if (typeof name !== 'string' || !name) return [];
        const marker = '/documents/';
        const index = name.indexOf(marker);
        const rest = index >= 0 ? name.slice(index + marker.length) : '';
        const path = rest
          ? rest.split('/').map(segment => decodeURIComponent(segment))
          : [name.slice(name.lastIndexOf('/') + 1)];
        const id = path[path.length - 1];
        return [{ id, data: decodeFields<T>(row.document!.fields), path }];
      });
    },

    /**
     * A capped `count()` aggregation. Same parent/collection shape as
     * `runQuery`. Returns an integer; a missing alias is zero.
     */
    async countQuery({ parentSegments = [], collectionId, limit: cap }: Pick<QueryOptions, 'parentSegments' | 'collectionId' | 'limit'> = {}) {
      if (typeof collectionId !== 'string' || !collectionId || collectionId.includes('/')) {
        throw new FirestoreAdminError('INVALID_DOCUMENT_PATH', 400);
      }
      const parent = parentSegments.length
        ? documentName(projectId, parentSegments)
        : documentRoot(projectId);
      const url = `https://firestore.googleapis.com/v1/${parent}:runAggregationQuery`;
      const structuredQuery = {
        from: [{ collectionId }],
        ...(Number.isInteger(cap) && cap! > 0 ? { limit: cap } : {}),
      };
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          structuredQuery,
          aggregations: [{ alias: 'count', count: {} }],
        }),
      });
      const payload = await response.json<FirestoreRow[] | (FirestoreRow & FirestoreFailure)>().catch(() => null);
      if (!response.ok) {
        throw new FirestoreAdminError(
          'FIRESTORE_READ_FAILED',
          502,
          (payload as FirestoreFailure | null)?.error?.status || '',
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
    async commit(writes: FirestoreWrite[]) {
      const url = `https://firestore.googleapis.com/v1/${documentRoot(projectId)}:commit`;
      const response = await authorizedFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ writes }),
      });
      const payload = await response.json<FirestoreFailure & { commitTime?: string; writeResults?: unknown[] }>().catch(() => ({} as FirestoreFailure));
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
export function createWrite(name: string, data: object): FirestoreWrite {
  return {
    update: { name, fields: encodeFields(data) },
    currentDocument: { exists: false },
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
export function mergeWrite(name: string, data: object, { mustExist = true, updateTime = null }: { mustExist?: boolean; updateTime?: string | null } = {}): FirestoreWrite {
  return {
    update: { name, fields: encodeFields(data) },
    updateMask: { fieldPaths: Object.keys(data) },
    ...(updateTime
      ? { currentDocument: { updateTime } }
      : mustExist ? { currentDocument: { exists: true } } : {}),
  };
}

/** Clears named fields without touching the rest of the document. */
export function clearFieldsWrite(name: string, fieldPaths: string[]): FirestoreWrite {
  return {
    update: { name, fields: {} },
    updateMask: { fieldPaths },
    currentDocument: { exists: true },
  };
}

export function deleteWrite(name: string): FirestoreWrite {
  return { delete: name };
}
