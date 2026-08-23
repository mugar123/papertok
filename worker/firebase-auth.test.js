import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFirebaseIdentity } from './firebase-auth.js';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.js';

const UID = 'alice-uid';
const PROJECT_ID = 'papertok-168df';
const ENV = { FIREBASE_WEB_API_KEY: 'web-key', FIREBASE_PROJECT_ID: PROJECT_ID };

let lookups = 0;

/** Identity Toolkit, and nothing else, is reachable. */
function stubUpstream({ ok = true } = {}) {
  lookups = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('identitytoolkit')) throw new Error(`unexpected fetch: ${url}`);
    lookups += 1;
    return new Response(JSON.stringify(ok ? { users: [{ localId: UID }] } : {}), {
      status: ok ? 200 : 400,
    });
  };
}

function bearing(token) {
  return new Request('https://worker.test/lists/publish', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

const verify = (token, env = ENV) => verifyFirebaseIdentity(bearing(token), env, { allowCache: false });

// ---------------------------------------------------------------------------
// The local pre-filter: what Google never has to be asked about.
// ---------------------------------------------------------------------------

test('a string that is not shaped like an ID token never costs a call to Google', async () => {
  stubUpstream();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const wellFormed = fakeIdToken({ aud: PROJECT_ID });
  const refused = {
    'no segments at all': 'id-token',
    // Header and payload alone, with the signature simply left off: valid JSON
    // in both halves, so only the segment count refuses it.
    'a token with no signature segment': wellFormed.split('.').slice(0, 2).join('.'),
    'a token with a fourth segment': `${wellFormed}.extra`,
    'a segment that is not base64url': 'a.b.c',
    'segments that are not JSON': 'ab.cd.ef',
    'an empty middle segment': `${fakeIdToken().split('.')[0]}..sig`,
    // Three segments, but the signature is blank — the only check that sees
    // this one is the emptiness test, since the signature is never decoded.
    'an empty signature segment': `${wellFormed.split('.').slice(0, 2).join('.')}.`,
    'no expiry': fakeIdToken({ aud: PROJECT_ID, exp: undefined }),
    'an expiry that has passed': fakeIdToken({ aud: PROJECT_ID, exp: nowSeconds - 120 }),
    'another project audience': fakeIdToken({ aud: 'someone-elses-project' }),
    'no audience': fakeIdToken(),
  };
  for (const [why, token] of Object.entries(refused)) {
    await assert.rejects(
      () => verify(token),
      error => error.code === 'AUTH_REQUIRED' && error.status === 401,
      `must refuse ${why}`,
    );
  }
  assert.equal(lookups, 0, 'every one of these was answerable without leaving the isolate');
});

test('an expiry inside the skew window is still Google question to answer', async () => {
  stubUpstream();
  // Google decides whether a token that has just lapsed is dead; a clock that
  // disagrees by a few seconds must not sign anybody out on its own authority.
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.deepEqual(await verify(fakeIdToken({ aud: PROJECT_ID, exp: nowSeconds - 30 })), { uid: UID });
  assert.equal(lookups, 1);
});

test('a well-formed token is verified upstream, as it always was', async () => {
  stubUpstream();
  assert.deepEqual(await verify(fakeIdToken({ aud: PROJECT_ID })), { uid: UID });
  assert.equal(lookups, 1, 'the filter decides who to ask about, never who is signed in');
});

test('an unsigned token is still refused: the signature is Google job, not ours', async () => {
  stubUpstream({ ok: false });
  await assert.rejects(
    () => verify(fakeIdToken({ aud: PROJECT_ID })),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );
  assert.equal(lookups, 1);
});

test('without a configured project id the audience is not checked at all', async () => {
  stubUpstream();
  // Failing open on THIS check is the only safe direction: a deployment that
  // has not been told its own project must not answer 401 to every user.
  const env = { FIREBASE_WEB_API_KEY: 'web-key' };
  assert.deepEqual(await verify(fakeIdToken({ aud: 'anything-at-all' }), env), { uid: UID });
  assert.equal(lookups, 1);
});

test('the length and Bearer checks still come first', async () => {
  stubUpstream();
  for (const token of ['', 'x'.repeat(8_193)]) {
    await assert.rejects(
      () => verify(token),
      error => error.code === 'AUTH_REQUIRED' && error.status === 401,
      `must refuse a token of ${token.length} characters`,
    );
  }
  assert.equal(lookups, 0);
});
