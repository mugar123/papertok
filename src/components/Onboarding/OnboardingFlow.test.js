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

/**
 * The interests a guest picked before signing up reach their profile.
 *
 * Three pieces, in three files, and any one missing breaks the promise the
 * prompt makes ("if you create an account, they are saved to your profile"):
 * the onboarding must pre-select from the stored answer, the answer must be
 * cleared only once `completeOnboarding` has written the preferences, and an
 * account that was already onboarded must discard a stray answer rather than
 * leave it waiting for the next new account on the same device.
 */
test('SOURCE: the onboarding opens on the receipt, pre-filled from the guest answer', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /readGuestInterests\(\)/);
  assert.match(code, /useState\(guestSeed \? 3 : 1\)/, 'a guest with an answer starts on the receipt');
  assert.match(code, /new Set\(guestSeed \?\? \[\]\)/, 'the areas are pre-selected');
  assert.match(code, /new Set\(guestCategoriesForAreas\(guestSeed \?\? \[\]\)\)/, 'every category of those areas is pre-selected');
  // The receipt is still a receipt: `completeOnboarding` is the only write,
  // so what it shows is what the profile gets.
  assert.doesNotMatch(code, /saveGuestInterests|clearGuestInterests/, 'the onboarding reads the answer; AuthContext owns its end');
});

test('SOURCE: the guest answer is cleared where the profile takes over', async () => {
  const source = await readFile(new URL('../../context/AuthContext.jsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const complete = code.match(/const completeOnboarding = useCallback\(async \(preferences\) => \{[\s\S]*?\n {2}\}, \[user\?\.uid\]\);/);
  assert.ok(complete, 'completeOnboarding is gone or reshaped');
  assert.match(
    complete[0],
    /await setDoc\(doc\(db, 'users', userId\), \{\s*onboardingComplete: true,\s*preferences\s*\}, \{ merge: true \}\);[\s\S]*?clearGuestInterests\(\);/,
    'the answer is cleared after the preferences are written, never before',
  );
  assert.match(
    code,
    /if \(onboarded\) \{[\s\S]*?clearGuestInterests\(\);[\s\S]*?\}\s*return true;/,
    'a profile that already chose its interests discards a waiting guest answer',
  );
});

test('SOURCE: the profile fields are the shared Input under a Label, with their associations intact', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /import \{ Input \} from '\.\.\/ui\/input\.jsx'/);
  assert.match(code, /import \{ Label \} from '\.\.\/ui\/label\.jsx'/);
  assert.doesNotMatch(code, /<input\b/, 'a bare <input> came back');
  assert.match(code, /<Label htmlFor="onboarding-handle">/);
  assert.match(code, /<Input\s+id="onboarding-handle"[\s\S]*?aria-invalid=\{Boolean\(handleDraft\) && Boolean\(handleError\)\}\s*aria-describedby="onboarding-handle-hint"/);
  assert.match(code, /<Label htmlFor="onboarding-display-name">/);
  assert.match(code, /<Input\s+id="onboarding-display-name"/);
});

test('SOURCE: the area cards and category chips are the shared Toggle, styled off data-pressed', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /import \{ Toggle \} from '\.\.\/ui\/toggle\.jsx'/);
  // Base UI writes `aria-pressed` and `data-pressed` on the native button it
  // renders, so no class mirrors the state by hand any more.
  assert.match(code, /<Toggle\s[\s\S]*?className="area-card"\s+pressed=\{isSelected\}\s+onPressedChange=\{\(\) => toggleArea\(key\)\}/);
  assert.match(code, /<Toggle\s[\s\S]*?className="subcat-chip"\s+pressed=\{isSelected\}\s+onPressedChange=\{\(\) => toggleSubcategory\(catId\)\}/);
  assert.doesNotMatch(code, /aria-pressed=|is-selected/);
  // "Select all" per area is an action, not a state: it stays a plain button.
  assert.match(code, /<button\s+type="button"\s+className=\{`subcat-select-all \$\{allSelected \? 'is-active' : ''\}`\}/);
  const css = (await readFile(new URL('./OnboardingFlow.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.area-card\[data-pressed\]\s*\{/);
  assert.match(css, /\.subcat-chip\[data-pressed\]\s*\{/);
  assert.doesNotMatch(css, /\.is-selected/);
});
