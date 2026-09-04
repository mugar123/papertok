import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SOURCE: first-run onboarding asks for a public handle after interests', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  assert.match(source, /createUserProfile/);
  assert.match(source, /VisibilityChoice/);
  assert.match(source, /PROFILE_VISIBILITY\.public/);
  assert.match(source, /PROFILE_VISIBILITY\.private/);
  assert.match(source, /onboardingComplete/);
  assert.match(source, /¿Quieres un perfil público\?/);
  assert.doesNotMatch(source, /if \(existingProfile && step > 3\) setStep\(3\)/);
});

test('SOURCE: login does not send a failed profile load through onboarding', async () => {
  const source = await readFile(new URL('../Auth/LoginPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /if \(profileLoadError\) return/);
  assert.match(source, /navigate\('\/onboarding'/);
});

test('SOURCE: a retry after a failed completeOnboarding does not claim the handle twice', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  // Comments are prose, not code: a decoy comment reproducing the guard
  // condition must never make this test see a guard that is not really
  // there. Strip them first, the same way analyticsPageviews.test.js does.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  assert.match(code, /const profileCreated = useRef\(false\);/);

  // createUserProfile succeeded, completeOnboarding failed, the reader taps
  // again: the second createUserProfile hits its own reservation, the rules
  // refuse it, and the error reads "that handle is taken" — by them. Tying
  // the guard, the call it protects, and the flag-set into one contiguous,
  // bounded match means a regression that drops any one of the three — the
  // guard's own check, the call, or setting the flag only once the call has
  // actually succeeded — fails here, instead of passing on a comment that
  // merely describes the intended behaviour.
  const guarded = code.match(
    /if \(!existingProfile && !profileCreated\.current && visibilityDraft === PROFILE_VISIBILITY\.public\) \{[\s\S]*?\n {6}\}/,
  );
  assert.ok(guarded, 'the profileCreated guard around createUserProfile is gone');
  // The real guarded block is well under twenty lines. A much longer capture
  // means the regex ran past it into unrelated code below.
  const guardedLines = guarded[0].split('\n');
  assert.ok(guardedLines.length <= 20, `guard capture spans ${guardedLines.length} lines, past the create block`);
  assert.match(
    guarded[0],
    /await createUserProfile\(\{[\s\S]*?\}\);\s*profileCreated\.current = true;\s*\}$/,
    'profileCreated.current must be set only once createUserProfile has actually succeeded',
  );
  // The capture above is bounded to the guarded block on purpose, so it can
  // never see a SECOND call sitting just outside it -- a sibling block,
  // reachable without the profileCreated guard, would double-claim the
  // handle and this test would still pass. Count every call in the whole
  // file instead, the same way saveModalMotion.test.js's scriptedCloses does.
  const profileCreateCalls = code.match(/createUserProfile\(/g) ?? [];
  assert.equal(profileCreateCalls.length, 1, 'createUserProfile must be called from exactly the guarded block above');
});
