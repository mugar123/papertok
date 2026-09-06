import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientReadError } from './boundedRead.js';
import {
  FIRESTORE_REST_BASE,
  FirestoreRestError,
  createFirestoreRest,
  decodeFields,
} from './firestoreRest.js';

const PROJECT = 'demo-project';
const ROOT = 'projects/demo-project/databases/(default)/documents';

/** Records every request and answers with whatever the test decided. */
function fakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return responder(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** The answer runQuery really gives: matching rows, then a row with only a readTime. */
const EDGE_ROWS = [
  {
    document: {
      name: `${ROOT}/follows/alice_bob`,
      fields: {
        followerUid: { stringValue: 'alice' },
        targetUid: { stringValue: 'bob' },
        createdAt: { timestampValue: '2026-08-20T22:00:36.679Z' },
      },
      createTime: '2026-08-20T22:00:36.679000Z',
      updateTime: '2026-08-20T22:00:36.679000Z',
    },
    readTime: '2026-09-06T15:31:59.331574Z',
  },
  { readTime: '2026-09-06T15:31:59.331574Z' },
];

test('runQuery posts the structured query to the database root and hands back decoded rows', async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, EDGE_ROWS));
  const rest = createFirestoreRest({ projectId: PROJECT, fetchImpl });
  const structuredQuery = { from: [{ collectionId: 'follows' }], limit: 30 };

  const rows = await rest.runQuery(structuredQuery);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${FIRESTORE_REST_BASE}/${ROOT}:runQuery`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body, { structuredQuery });
  // A CORS "simple request": Firestore accepts a JSON body under text/plain,
  // and a JSON content type would cost a preflight round trip per query.
  assert.equal(calls[0].init.headers['content-type'], 'text/plain');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(rows.length, 1, 'the readTime-only trailer is not a row');
  assert.equal(rows[0].id, 'alice_bob');
  assert.equal(rows[0].name, `${ROOT}/follows/alice_bob`);
  assert.deepEqual(rows[0].fields, EDGE_ROWS[0].document.fields, 'the raw fields travel with the row, for cursors');
  assert.deepEqual(rows[0].data, {
    followerUid: 'alice',
    targetUid: 'bob',
    createdAt: new Date('2026-08-20T22:00:36.679Z'),
  });
});

test('getDocument fetches one document by path and reports a 404 as a confirmed absence', async () => {
  const profile = {
    name: `${ROOT}/userProfiles/u1`,
    fields: { handle: { stringValue: 'mugar' }, displayName: { stringValue: 'Mugar' } },
  };
  const { calls, fetchImpl } = fakeFetch((url) => (url.endsWith('/userProfiles/u1')
    ? jsonResponse(200, profile)
    : jsonResponse(404, { error: { code: 404, message: 'Document not found', status: 'NOT_FOUND' } })));
  const rest = createFirestoreRest({ projectId: PROJECT, fetchImpl });

  const found = await rest.getDocument('userProfiles/u1');
  assert.equal(calls[0].url, `${FIRESTORE_REST_BASE}/${ROOT}/userProfiles/u1`);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(found, { exists: true, id: 'u1', data: { handle: 'mugar', displayName: 'Mugar' } });

  const missing = await rest.getDocument('userProfiles/nobody');
  assert.deepEqual(missing, { exists: false, id: 'nobody', data: null });
});

test('an HTTP failure becomes a FirestoreRestError carrying the SDK code for that status', async () => {
  const cases = [
    [400, 'invalid-argument'],
    [401, 'unauthenticated'],
    [403, 'permission-denied'],
    [429, 'resource-exhausted'],
    [500, 'internal'],
    [503, 'unavailable'],
    [504, 'deadline-exceeded'],
  ];
  for (const [status, code] of cases) {
    const { fetchImpl } = fakeFetch(() => jsonResponse(status, { error: { code: status, message: `HTTP ${status}`, status: 'X' } }));
    const rest = createFirestoreRest({ projectId: PROJECT, fetchImpl });
    await assert.rejects(() => rest.getDocument('userProfiles/u1'), (error) => {
      assert.ok(error instanceof FirestoreRestError, `${status} should be a FirestoreRestError`);
      assert.equal(error.code, code, `HTTP ${status}`);
      assert.equal(error.status, status);
      assert.equal(error.message, `HTTP ${status}`);
      return true;
    });
  }
});

test('a request the network drops is "unavailable" — the one code patientRead keeps retrying', async () => {
  const { fetchImpl } = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  const rest = createFirestoreRest({ projectId: PROJECT, fetchImpl });

  await assert.rejects(() => rest.runQuery({ from: [{ collectionId: 'follows' }], limit: 1 }), (error) => {
    assert.equal(error.code, 'unavailable');
    assert.ok(isTransientReadError(error));
    return true;
  });
});

test('an aborted request is "cancelled", not a network failure to retry', async () => {
  const { fetchImpl } = fakeFetch(() => {
    const error = new Error('The user aborted a request.');
    error.name = 'AbortError';
    throw error;
  });
  const rest = createFirestoreRest({ projectId: PROJECT, fetchImpl });

  await assert.rejects(() => rest.getDocument('userProfiles/u1'), (error) => {
    assert.equal(error.code, 'cancelled');
    return true;
  });
});

test('the signal reaches fetch, so closing the screen ends the request', async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, []));
  const rest = createFirestoreRest({ projectId: PROJECT, fetchImpl });
  const controller = new AbortController();

  await rest.runQuery({ from: [{ collectionId: 'follows' }], limit: 1 }, { signal: controller.signal });

  assert.equal(calls[0].init.signal, controller.signal);
});

test('a session token travels as a bearer header; without one the request stays anonymous', async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, []));

  await createFirestoreRest({ projectId: PROJECT, fetchImpl, getToken: async () => 'id-token' })
    .runQuery({ from: [{ collectionId: 'follows' }], limit: 1 });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer id-token');

  await createFirestoreRest({ projectId: PROJECT, fetchImpl }).runQuery({ from: [{ collectionId: 'follows' }], limit: 1 });
  assert.equal(calls[1].init.headers.Authorization, undefined);

  await createFirestoreRest({ projectId: PROJECT, fetchImpl, getToken: async () => null })
    .runQuery({ from: [{ collectionId: 'follows' }], limit: 1 });
  assert.equal(calls[2].init.headers.Authorization, undefined);
});

test('a token provider that fails does not fail the read: public data still goes anonymously', async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, []));
  const rest = createFirestoreRest({
    projectId: PROJECT,
    fetchImpl,
    getToken: async () => { throw new Error('auth/network-request-failed'); },
  });

  const rows = await rest.runQuery({ from: [{ collectionId: 'follows' }], limit: 1 });

  assert.deepEqual(rows, []);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('decodeFields turns every REST value the app stores back into a plain value', () => {
  const decoded = decodeFields({
    n: { integerValue: '42' },
    d: { doubleValue: 1.5 },
    s: { stringValue: 'x' },
    b: { booleanValue: true },
    z: { nullValue: null },
    t: { timestampValue: '2026-08-20T22:00:36.679Z' },
    a: { arrayValue: { values: [{ stringValue: 'p' }, { integerValue: '2' }] } },
    m: { mapValue: { fields: { inner: { stringValue: 'y' } } } },
    e: { arrayValue: {} },
  });

  assert.deepEqual(decoded, {
    n: 42, d: 1.5, s: 'x', b: true, z: null,
    t: new Date('2026-08-20T22:00:36.679Z'),
    a: ['p', 2], m: { inner: 'y' }, e: [],
  });
  assert.deepEqual(decodeFields(undefined), {});
});
