/**
 * A well-formed Firebase ID token with nothing behind it.
 *
 * The Worker looks at a token locally before it asks Identity Toolkit about it
 * (three base64url segments, an `exp` that has not passed, an `aud` that names
 * the project), so a test that wants to reach the verifier has to send
 * something shaped like a real token rather than the string `'id-token'`.
 *
 * Nothing here is signed, and nothing here needs to be: the tests that use it
 * stub Identity Toolkit's answer, which is where verification actually lives.
 * The file is deliberately not named `*.test.js` so the runner does not try to
 * execute it as a suite.
 */

function base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * `claims` overrides the payload — pass `{ aud }` when the environment under
 * test configures `FIREBASE_PROJECT_ID`, and `{ exp }` to build an expired one.
 * The default expiry is relative to now, so the fixture cannot rot.
 */
export function fakeIdToken(claims = {}) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }));
  const payload = base64Url(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'test-uid',
    ...claims,
  }));
  return `${header}.${payload}.${base64Url('unsigned')}`;
}
