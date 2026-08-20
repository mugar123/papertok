import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FirestoreAdminError,
  buildAssertion,
  clearFieldsWrite,
  createFirestoreAdmin,
  createWrite,
  decodeFields,
  deleteWrite,
  documentName,
  encodeFields,
  getAccessToken,
  isServiceAccountConfigured,
  mergeWrite,
  normalizePrivateKey,
  readServiceAccount,
  resetAccessTokenCache,
} from './firestore-admin.js';

// ---------------------------------------------------------------------------
// A real RSA key pair, so the signature is genuinely verified rather than
// merely shaped like a signature.
// ---------------------------------------------------------------------------

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const PEM = [
  '-----BEGIN PRIVATE KEY-----',
  ...(btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g) || []),
  '-----END PRIVATE KEY-----',
].join('\n');

const ENV = {
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'papertok-worker@papertok-168df.iam.gserviceaccount.com',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM,
  FIREBASE_PROJECT_ID: 'papertok-168df',
};

function decodeSegment(segment) {
  return JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/')));
}

// ---------------------------------------------------------------------------
// Credentials.
// ---------------------------------------------------------------------------

test('the private key is accepted with real newlines or with escaped ones', () => {
  const escaped = PEM.replace(/\n/g, '\\n');
  assert.equal(normalizePrivateKey(escaped), PEM);
  assert.equal(normalizePrivateKey(PEM), PEM);
  assert.equal(normalizePrivateKey(undefined), '');
});

test('a missing secret is a configuration error, not a crash at publish time', () => {
  assert.equal(isServiceAccountConfigured(ENV), true);
  for (const missing of Object.keys(ENV)) {
    const partial = { ...ENV, [missing]: '' };
    assert.equal(isServiceAccountConfigured(partial), false, `${missing} must be required`);
    assert.throws(() => readServiceAccount(partial), (error) => (
      error instanceof FirestoreAdminError
        && error.code === 'SERVICE_ACCOUNT_NOT_CONFIGURED'
        && error.status === 503
    ));
  }
});

test('a malformed key is refused rather than signing garbage', async () => {
  await assert.rejects(
    () => buildAssertion({ email: 'a@b.test', privateKey: '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----' }, 0),
    error => error instanceof FirestoreAdminError && error.code === 'SERVICE_ACCOUNT_KEY_INVALID',
  );
});

// ---------------------------------------------------------------------------
// The grant.
// ---------------------------------------------------------------------------

test('the assertion is a real RS256 JWT that verifies against the public key', async () => {
  const account = readServiceAccount(ENV);
  const assertion = await buildAssertion(account, 1_700_000_000);
  const [header, claims, signature] = assertion.split('.');
  assert.equal(assertion.split('.').length, 3);

  assert.deepEqual(decodeSegment(header), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodeSegment(claims), {
    iss: ENV.FIREBASE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });

  const raw = signature.replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    pair.publicKey,
    bytes,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.equal(verified, true, 'the signature must verify with the matching public key');
});

test('the scope asks for datastore and nothing else', async () => {
  const assertion = await buildAssertion(readServiceAccount(ENV), 1);
  const { scope } = decodeSegment(assertion.split('.')[1]);
  assert.equal(scope, 'https://www.googleapis.com/auth/datastore');
});

test('the access token is minted once and reused until it nears expiry', async () => {
  resetAccessTokenCache();
  let mints = 0;
  const fetchImpl = async () => {
    mints += 1;
    return new Response(JSON.stringify({ access_token: `token-${mints}`, expires_in: 3600 }), { status: 200 });
  };
  let clock = 1_700_000_000_000;
  const now = () => clock;

  assert.equal(await getAccessToken(ENV, { fetchImpl, now }), 'token-1');
  assert.equal(await getAccessToken(ENV, { fetchImpl, now }), 'token-1');
  assert.equal(mints, 1, 'a warm isolate must not re-sign on every request');

  // Inside the refresh margin: a new token, before the old one can lapse
  // mid-flight.
  clock += 3_400_000;
  assert.equal(await getAccessToken(ENV, { fetchImpl, now }), 'token-2');
  assert.equal(mints, 2);
});

test('a refused grant surfaces as SERVICE_TOKEN_REFUSED, not as a bad write', async () => {
  resetAccessTokenCache();
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: 'invalid_grant' }),
    { status: 400 },
  );
  await assert.rejects(
    () => getAccessToken(ENV, { fetchImpl, now: () => 0 }),
    error => error instanceof FirestoreAdminError
      && error.code === 'SERVICE_TOKEN_REFUSED'
      && error.status === 502,
  );
});

// ---------------------------------------------------------------------------
// The codec.
// ---------------------------------------------------------------------------

test('values survive a round trip through the REST encoding', () => {
  const document = {
    title: 'Una lista',
    paperCount: 3,
    ratio: 0.5,
    published: true,
    missing: null,
    papers: [
      { id: 'doi:10.1/a', title: 'A', authors: ['Ada', 'Grace'], year: 2026 },
      { id: 'arxiv:2608.1', title: 'B', authors: [] },
    ],
  };
  assert.deepEqual(decodeFields(encodeFields(document)), document);
});

test('integers cross the wire as strings, which is what Firestore requires', () => {
  const fields = encodeFields({ year: 2026, ratio: 1.5 });
  assert.deepEqual(fields.year, { integerValue: '2026' });
  assert.deepEqual(fields.ratio, { doubleValue: 1.5 });
});

test('timestamps encode as RFC 3339 and decode back to a Date', () => {
  const when = new Date('2026-08-20T10:00:00.000Z');
  const fields = encodeFields({ createdAt: when });
  assert.deepEqual(fields.createdAt, { timestampValue: '2026-08-20T10:00:00.000Z' });
  assert.equal(decodeFields(fields).createdAt.getTime(), when.getTime());
});

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

test('a path segment cannot smuggle a slash and reach another collection', () => {
  assert.equal(
    documentName('p', ['users', 'alice', 'lists', 'l1']),
    'projects/p/databases/(default)/documents/users/alice/lists/l1',
  );
  for (const hostile of ['../../admin', 'a/b', '', null, 42]) {
    assert.throws(
      () => documentName('p', ['users', hostile]),
      error => error instanceof FirestoreAdminError && error.code === 'INVALID_DOCUMENT_PATH',
      `must refuse ${JSON.stringify(hostile)}`,
    );
  }
});

test('path segments are percent-encoded', () => {
  assert.match(documentName('p', ['users', 'a b']), /users\/a%20b$/);
});

// ---------------------------------------------------------------------------
// Write builders.
// ---------------------------------------------------------------------------

test('createWrite refuses to overwrite, replaceWrite refuses to create', () => {
  assert.deepEqual(createWrite('n', { a: 1 }).currentDocument, { exists: false });
  assert.deepEqual(mergeWrite('n', { a: 1 }).currentDocument, { exists: true });
  assert.deepEqual(mergeWrite('n', { a: 1 }, { mustExist: false }).currentDocument, undefined);
});

test('a merge names its fields, so createdAt is untouched without reading it', () => {
  const write = mergeWrite('n', { title: 'x', updatedAt: new Date(0) });
  assert.deepEqual(write.updateMask, { fieldPaths: ['title', 'updatedAt'] });
  assert.ok(!('createdAt' in write.update.fields));
});

test('a merge pinned to a version trades the exists check for that version', () => {
  // One precondition or the other, never both: a version match already
  // implies existence, and Firestore rejects a currentDocument with two keys.
  const write = mergeWrite('n', { a: 1 }, { updateTime: '2026-08-20T19:00:00.123456Z' });
  assert.deepEqual(write.currentDocument, { updateTime: '2026-08-20T19:00:00.123456Z' });
  assert.deepEqual(write.updateMask, { fieldPaths: ['a'] });
});

test('clearing a field sends the mask and no value', () => {
  const write = clearFieldsWrite('n', ['publicShareId']);
  assert.deepEqual(write.updateMask, { fieldPaths: ['publicShareId'] });
  assert.deepEqual(write.update.fields, {});
});

test('deleteWrite is just the name', () => {
  assert.deepEqual(deleteWrite('n'), { delete: 'n' });
});

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

function adminWith(responder) {
  resetAccessTokenCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    calls.push({ url, init });
    return responder(url, init);
  };
  return { calls, admin: createFirestoreAdmin(ENV, { fetchImpl, now: () => 0 }) };
}

test('a missing document reads as null rather than throwing', async () => {
  const { admin } = adminWith(async () => new Response('{}', { status: 404 }));
  assert.equal(await admin.getDocument(['publicLists', 'abc']), null);
});

test('a document reads back decoded, with the bearer token attached', async () => {
  const { admin, calls } = adminWith(async () => new Response(
    JSON.stringify({ fields: { ownerId: { stringValue: 'alice' } } }),
    { status: 200 },
  ));
  assert.deepEqual(await admin.getDocument(['publicListOwners', 'abc']), { ownerId: 'alice' });
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
});

test('withMeta pairs the data with the version a precondition needs', async () => {
  const { admin } = adminWith(async () => new Response(
    JSON.stringify({
      fields: { handle: { stringValue: 'alice' } },
      updateTime: '2026-08-20T19:00:00.123456Z',
    }),
    { status: 200 },
  ));
  assert.deepEqual(await admin.getDocument(['userProfiles', 'u1'], { withMeta: true }), {
    data: { handle: 'alice' },
    updateTime: '2026-08-20T19:00:00.123456Z',
  });
  // Absence stays null in both shapes — no `{ data: null }` to trip over.
  const missing = adminWith(async () => new Response('{}', { status: 404 }));
  assert.equal(await missing.admin.getDocument(['userProfiles', 'u1'], { withMeta: true }), null);
});

test('a failed precondition is a 409 for the caller, not a 502 outage', async () => {
  const { admin } = adminWith(async () => new Response(
    JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }),
    { status: 400 },
  ));
  await assert.rejects(
    () => admin.commit([createWrite('n', {})]),
    error => error.code === 'FIRESTORE_PRECONDITION_FAILED' && error.status === 409,
  );
});

test('an upstream failure stays a 502', async () => {
  const { admin } = adminWith(async () => new Response(
    JSON.stringify({ error: { status: 'INTERNAL' } }),
    { status: 500 },
  ));
  await assert.rejects(
    () => admin.commit([createWrite('n', {})]),
    error => error.code === 'FIRESTORE_WRITE_FAILED' && error.status === 502,
  );
});

test('commit sends every write in one request, so a publish is atomic', async () => {
  const { admin, calls } = adminWith(async () => new Response('{}', { status: 200 }));
  await admin.commit([createWrite('a', { x: 1 }), deleteWrite('b')]);
  assert.equal(calls.length, 1, 'one commit, not one request per document');
  assert.match(calls[0].url, /:commit$/);
  assert.equal(JSON.parse(calls[0].init.body).writes.length, 2);
});
