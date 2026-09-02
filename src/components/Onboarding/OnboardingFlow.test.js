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
  // createUserProfile succeeded, completeOnboarding failed, the reader taps
  // again: the second createUserProfile hits its own reservation, the rules
  // refuse it, and the error reads "that handle is taken" — by them.
  assert.match(source, /const profileCreated = useRef\(false\);/);
  assert.match(
    source,
    /if \(!existingProfile && !profileCreated\.current && visibilityDraft === PROFILE_VISIBILITY\.public\)/,
  );
  assert.match(source, /await createUserProfile\(\{[\s\S]*?\}\);\s*profileCreated\.current = true;/);
});
