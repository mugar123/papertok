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
  const write = body.indexOf('await setDoc(');
  assert.ok(write > -1, 'the live branch writes the document');
  assert.ok(flips[0] < demoReturn, 'the demo branch still flips before it returns');
  assert.ok(flips[1] > write, 'the live branch flips after the write, never before');
  assert.ok(body.indexOf('saveStoredOnboarding(userId') > write, 'and the local memory is written after it too');
});
