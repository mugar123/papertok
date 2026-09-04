import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('./AuthContext.jsx', import.meta.url);

test('SOURCE: a remembered onboarding never stands in for a profile that failed to load', async () => {
  const source = await readFile(SOURCE, 'utf8');
  // Comments are prose, not code: a decoy comment reproducing this file's own
  // guard text must never make this test see a guard that is not really
  // there, or fail over text that only describes the rule instead of
  // breaking it. Strip them first, the same way analyticsPageviews.test.js
  // does, so only real code is scanned below.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  // The device flag decides the first paint while the read is in flight, and
  // nothing else: a failed read is PROFILE_LOAD_FAILED and a missing document
  // is an account without onboarding, whatever this device remembers. Opening
  // the app on an empty followedAuthors is what turned the next follow into an
  // overwrite of the whole list.
  assert.doesNotMatch(code, /!storedOnboarding\?\.complete/);
  assert.match(
    code,
    /if \(!applyProfile\(remote\.value\)\) \{\s*setOnboardingComplete\(false\);\s*saveStoredOnboarding\(currentUser\.uid, \{ complete: false, preferences: \[\] \}\);/,
  );
  assert.match(code, /\} else if \(!hydratedFromCache\) \{\s*setProfileLoadError\('PROFILE_LOAD_FAILED'\);/);
});

test('SOURCE: a follow toggle writes a field transform, not the list this session happened to load', async () => {
  const source = await readFile(SOURCE, 'utf8');
  // Comments are prose, not code: strip them first, the same way
  // analyticsPageviews.test.js does, so a decoy comment cannot stand in for
  // the real write asserted below.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  assert.match(code, /toggleFollowedAuthor\(followedAuthors, authorName\)/);
  assert.doesNotMatch(code, /followedAuthors: newFollowed/);

  // The two checks above can both pass while the object that actually reaches
  // Firestore is something else entirely -- a renamed variable, or a value
  // rebuilt by hand -- because neither one looks at the write itself. Tie the
  // real setDoc call, inside toggleFollowAuthor's own body, to `patch`: the
  // field transform toggleFollowedAuthor returned.
  const fn = code.match(
    /const toggleFollowAuthor = useCallback\(async \(authorName\) => \{[\s\S]*?\n {2}\}, \[followedAuthors, user\?\.uid\]\);/,
  );
  assert.ok(fn, 'toggleFollowAuthor is gone');
  // The real function is well under twenty lines. A much longer capture means
  // the regex ran past it into unrelated code below.
  const fnLines = fn[0].split('\n');
  assert.ok(fnLines.length <= 18, `toggleFollowAuthor capture spans ${fnLines.length} lines, past a single function`);
  assert.match(
    fn[0],
    /await setDoc\(doc\(db, 'users', userId\), patch, \{ merge: true \}\);/,
    'the write must send patch, the field transform toggleFollowedAuthor returned',
  );
});
