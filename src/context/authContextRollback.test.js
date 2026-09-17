import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Comments are stripped first (convention of ce139ce): the guard is explained
// in a comment right above itself, and a matcher that reads comments would be
// satisfied by the explanation alone.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('optimistic rollbacks only run for the session that started the write', async () => {
  const src = stripComments(await readFile(new URL('./AuthContext.jsx', import.meta.url), 'utf8'));
  const rollbacks = src.match(/catch \(updateError\) \{[^}]*\}/g) || [];
  assert.equal(rollbacks.length, 2);
  const setters = [];
  for (const block of rollbacks) {
    assert.match(block, /auth\.currentUser\?\.uid === userId/);
    // The guard has to gate the setState, not merely sit in the same block.
    const guarded = block.match(/auth\.currentUser\?\.uid === userId\)\s*(set\w+)\(previous\)/);
    assert.ok(guarded, `the rollback is not gated by the uid check: ${block}`);
    setters.push(guarded[1]);
    assert.match(block, /throw updateError/);
  }
  assert.deepEqual(setters.sort(), ['setProfilePhoto', 'setReadingPreferences']);
});

test('completeOnboarding flips the flag only after the document write has landed', async () => {
  // Flipping first sent the onboarding on its way (its effect navigates the
  // moment the flag is true) while the write was in flight: a refused write
  // failed against an unmounted page, left no local memory, and the next
  // reload asked everything again (audit of 2026-09-16, hallazgo 4).
  const src = stripComments(await readFile(new URL('./AuthContext.jsx', import.meta.url), 'utf8'));
  const fn = src.match(/const completeOnboarding = useCallback\(async \(preferences\) => \{[\s\S]*?\n {2}\}, \[user\?\.uid\]\);/);
  assert.ok(fn, 'completeOnboarding is gone or reshaped');
  const body = fn[0];
  const flips = [...body.matchAll(/setOnboardingComplete\(true\)/g)].map(m => m.index);
  assert.equal(flips.length, 2, 'one flip per branch: demo and live');
  const demoReturn = body.indexOf('return;');
  // The write is now bounded (see the test below), so it is no longer a bare
  // `await setDoc(`: `settleWithin` is what actually goes on the wire.
  const write = body.indexOf('await settleWithin(');
  assert.ok(write > -1, 'the live branch writes the document under a bound');
  assert.ok(flips[0] < demoReturn, 'the demo branch still flips before it returns');
  assert.ok(flips[1] > write, 'the live branch flips after the write, never before');
  assert.ok(body.indexOf('saveStoredOnboarding(userId') > write, 'and the local memory is written after it too');
});

test('completeOnboarding bounds the write with settleWithin and never flips on a non-fulfilled result', async () => {
  // Firestore's own promise never times out on its own (memory cache,
  // firebase.js): a flaky or offline connection would otherwise hang the
  // onboarding screen's only button forever. `settleWithin` never throws --
  // a timeout comes back as a settled `{ status: 'timed_out' }`, not a
  // rejection -- so completeOnboarding has to turn a non-fulfilled result
  // into a thrown error itself, before either setter or the local cache
  // write runs. A retry must find the same starting point it found the
  // first time, not a half-applied one.
  const src = stripComments(await readFile(new URL('./AuthContext.jsx', import.meta.url), 'utf8'));
  const fn = src.match(/const completeOnboarding = useCallback\(async \(preferences\) => \{[\s\S]*?\n {2}\}, \[user\?\.uid\]\);/);
  assert.ok(fn, 'completeOnboarding is gone or reshaped');
  const body = fn[0];

  assert.match(
    body,
    /const settled = await settleWithin\(\s*setDoc\(doc\(db, 'users', userId\), \{[\s\S]*?\}, \{ merge: true \}\),\s*PROFILE_NETWORK_TIMEOUT_MS,\s*\);/,
    'the write is not bounded by settleWithin under the named profile-network timeout',
  );

  // Scoped to the live branch only: the demo branch above sets the same two
  // fields unconditionally on every call, and would falsely satisfy a check
  // run over the whole function body.
  const liveStart = body.indexOf('const userId = user?.uid;');
  assert.ok(liveStart > -1, 'the live branch is gone or reshaped');
  const live = body.slice(liveStart);

  const guard = live.match(/if \(settled\.status !== 'fulfilled'\) \{[\s\S]*?\n {6}\}/);
  assert.ok(guard, 'nothing catches a non-fulfilled settle before the setters run');
  assert.match(guard[0], /throw /, 'the guard actually throws, it does not merely log');

  const head = live.slice(0, live.indexOf(guard[0]));
  assert.doesNotMatch(head, /setUserPreferences\(preferences\)/, 'a setter must not run before the write is confirmed fulfilled');
  assert.doesNotMatch(head, /setOnboardingComplete\(true\)/, 'the flag must not flip before the write is confirmed fulfilled');
  assert.doesNotMatch(head, /saveStoredOnboarding\(userId/, 'local memory must not be written before the write is confirmed fulfilled');

  const tail = live.slice(live.indexOf(guard[0]) + guard[0].length);
  assert.match(tail, /saveStoredOnboarding\(userId/, 'local memory is written once the write is confirmed fulfilled');
  assert.match(tail, /setUserPreferences\(preferences\)/, 'the preferences setter runs once the write is confirmed fulfilled');
  assert.match(tail, /setOnboardingComplete\(true\)/, 'the flag flips once the write is confirmed fulfilled');
});

test('completeOnboarding gives a write timeout a stable code, and leaves a rejection as itself', async () => {
  const src = stripComments(await readFile(new URL('./AuthContext.jsx', import.meta.url), 'utf8'));
  const fn = src.match(/const completeOnboarding = useCallback\(async \(preferences\) => \{[\s\S]*?\n {2}\}, \[user\?\.uid\]\);/);
  assert.ok(fn, 'completeOnboarding is gone or reshaped');
  assert.match(
    fn[0],
    /if \(settled\.status === 'timed_out'\) \{[\s\S]*?\.code = 'ONBOARDING_WRITE_TIMEOUT';[\s\S]*?throw /,
    'a timeout must carry a stable code the caller can branch on, not a message to match against',
  );
  assert.match(fn[0], /throw settled\.reason;/, 'a real rejection (a rules refusal, say) is rethrown as itself, not relabelled');
});
