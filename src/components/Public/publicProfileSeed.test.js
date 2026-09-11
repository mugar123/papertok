import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Convention of ce139ce: comments first, so the explanation of the guard can
// never stand in for the guard.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* The visitor page seeds its first paint from `ownProfileCache`, which the
   signed-in owner's own warm-up fills. On `/@handle` that seed is somebody
   else's document, so it may only be used when it is public — or when the
   reader is the owner. */
test('a visitor page never seeds from a cached profile that is not public', async () => {
  const src = stripComments(await readFile(new URL('./PublicProfilePage.jsx', import.meta.url), 'utf8'));
  const seed = src.match(/const seededProfile = [\s\S]{0,400}?;/);
  assert.ok(seed, 'the seededProfile initialiser was not found');
  assert.match(seed[0], /selfMode \|\| profileIsPublic\(/);
  // And the guard has to sit on the cached entry, not on some other value.
  assert.match(seed[0], /selfMode \|\| profileIsPublic\(cachedProfile[.?]/);
});
