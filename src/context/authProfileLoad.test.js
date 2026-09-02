import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('./AuthContext.jsx', import.meta.url);

test('SOURCE: a remembered onboarding never stands in for a profile that failed to load', async () => {
  const source = await readFile(SOURCE, 'utf8');
  // The device flag decides the first paint while the read is in flight, and
  // nothing else: a failed read is PROFILE_LOAD_FAILED and a missing document
  // is an account without onboarding, whatever this device remembers. Opening
  // the app on an empty followedAuthors is what turned the next follow into an
  // overwrite of the whole list.
  assert.doesNotMatch(source, /!storedOnboarding\?\.complete/);
  assert.match(
    source,
    /if \(!applyProfile\(remote\.value\)\) \{\s*setOnboardingComplete\(false\);\s*saveStoredOnboarding\(currentUser\.uid, \{ complete: false, preferences: \[\] \}\);/,
  );
  assert.match(source, /\} else if \(!hydratedFromCache\) \{\s*setProfileLoadError\('PROFILE_LOAD_FAILED'\);/);
});

test('SOURCE: a follow toggle writes a field transform, not the list this session happened to load', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.match(source, /toggleFollowedAuthor\(followedAuthors, authorName\)/);
  assert.doesNotMatch(source, /followedAuthors: newFollowed/);
});
