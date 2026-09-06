import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: a profile that lands after the feed budget still applies, the same way as one in time', async () => {
  const code = stripComments(await readFile(new URL('./FeedContext.jsx', import.meta.url), 'utf8'));

  // One applier for both arrivals: the sets, the affinities, the generation
  // bump and the semantic overlay all live in it.
  const applier = code.match(/const applyInteractionProfile = \(result\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(applier, 'applyInteractionProfile is gone');
  for (const call of ['setLikedPaperIds(liked)', 'setSavedPaperIds(saved)', 'setReadPaperIds(read)', 'setInteractionProfileGeneration(generation => generation + 1)']) {
    assert.ok(applier[0].includes(call), `${call} is not inside the applier`);
  }

  // The budget still decides when the feed may start...
  assert.match(code, /const settled = await settleWithin\(profileLoad, INTERACTIONS_NETWORK_TIMEOUT_MS\);/);
  assert.match(code, /finally \{\s*if \(!cancelled\) setRecommendationProfileUserId\(userId\);/);
  // ...and a late answer is applied, not dropped.
  assert.match(code, /if \(settled\.status === 'timed_out'\) \{\s*profileLoad\.then\(\(lateResult\) => \{\s*if \(cancelled \|\| !hasInteractionProfile\(lateResult\)\) return;[\s\S]*?applyInteractionProfile\(lateResult\);/);
  // The in-time path goes through the very same function.
  assert.match(code, /\n {8}applyInteractionProfile\(result\);\n/);
});

test('SOURCE: the account profile read is patient, refuses a cache-served absence, and heals its own error late', async () => {
  const code = stripComments(await readFile(new URL('./AuthContext.jsx', import.meta.url), 'utf8'));
  const call = code.match(/patientRead\(\(\) => getDoc\(userRef\), \{[\s\S]*?\}\),\s*PROFILE_NETWORK_TIMEOUT_MS,\s*\);/);
  assert.ok(call, 'the profile read is not a patientRead any more');
  assert.match(call[0], /isAnswer: documentIsAuthoritative/);
  assert.match(call[0], /onLateResult: \(snapshot\) => \{\s*if \(!isCurrent\(\)\) return;\s*setProfileLoadError\(null\);\s*applyRemote\(snapshot\);\s*setLoading\(false\);/);
  // The bare read under a guillotine is gone.
  assert.doesNotMatch(code, /settleWithin\(getDoc\(userRef\)/);
  // A timeout is still the error screen when nothing else painted...
  assert.match(code, /\} else if \(!hydratedFromCache\) \{\s*setProfileLoadError\('PROFILE_LOAD_FAILED'\);/);
  // ...but it is logged as the wait it is, not as a failure of the server.
  assert.match(code, /if \(remote\.status === 'rejected' && !isReadTimeout\(remote\.reason\)\) \{\s*console\.error\('Error fetching user data'/);
});
