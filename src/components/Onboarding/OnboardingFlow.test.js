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

test('SOURCE: there is no sign-in page; a guest off a protected route gets the feed with the door open', async () => {
  const guard = (await readFile(new URL('../Auth/ProtectedRoute.jsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  // The state is one object per destination (a literal re-issued the redirect
  // on every render), and it still carries the full requested path.
  assert.match(guard, /const requestedPath = `\$\{location\.pathname\}\$\{location\.search\}`;/);
  assert.match(guard, /const signInState = useMemo\(\(\) => \(\{ authRequired: true, returnTo: requestedPath \}\), \[requestedPath\]\);/);
  assert.match(guard, /<Navigate to="\/feed" replace state=\{signInState\} \/>/);
  assert.doesNotMatch(guard, /to="\/login"/);
  const app = await readFile(new URL('../../App.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /LoginPage/);
  assert.match(app, /<Route path="\/login" element=\{<LoginRedirect \/>\} \/>/, 'old /login links still land somewhere');
  assert.match(app, /if \(!user\) setAuthPromptOpen\(true\)/, 'the sign-in dialog opens for the bounced guest');
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
test('SOURCE: the onboarding opens on the profile step, seeded from the guest answer, with the receipt in view', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /readGuestInterests\(\)/);
  // The guest already answered the interests question; the only step left
  // for them is the profile. Back still reaches the receipt and the pickers.
  assert.match(code, /useState\(guestSeed \? 4 : 1\)/, 'a guest with an answer skips straight to the profile step');
  assert.match(code, /new Set\(guestSeed \?\? \[\]\)/, 'the areas are pre-selected');
  // A bounded seed per area, not every category of the area: the feed's
  // window is five wide and its exploration needs siblings left over.
  // An area the welcome narrowed seeds exactly those topics instead.
  assert.match(code, /new Set\(guestSeedCategoriesForAreas\(guestSeed \?\? \[\], GUEST_SEED_PER_AREA, guestSeedTopics\)\)/, 'the seed is the bounded per-area pick, topics included');
  assert.match(code, /const \[guestSeedTopics\] = useState\(\(\) => readGuestInterests\(\)\?\.topics \?\? \[\]\);/);
  assert.doesNotMatch(code, /guestCategoriesForAreas\(/, 'the full union belongs to the guest feed plan, not to the onboarding');
  // The profile step shows what came along and names the way to change it.
  assert.doesNotMatch(code, /onboarding-seed-note/, 'the one-line note is gone');
  assert.match(code, /guestSeed && \(\s*<section className="onboarding-seed-receipt"[\s\S]*?<InterestsReceipt/, 'the profile step shows the receipt of the seeded interests');
  assert.match(code, /const adjustInterests = \(\) => \{\s*setSeedAdjusted\(true\);\s*setStep\(2\);\s*\};/, 'Adjust interests opens the categories step with the areas kept');
  assert.match(code, /onClick=\{adjustInterests\}/, 'and the button is wired to it');
  // One receipt, drawn twice: the confirm step and the profile step render
  // the same component, so what the profile gets is what both show.
  assert.equal((code.match(/<InterestsReceipt/g) || []).length, 2, 'both steps use the shared receipt');
  assert.doesNotMatch(code, /className="onboarding-receipt-row"[\s\S]*className="onboarding-receipt-row"/, 'the rows are rendered in one place only');
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
    /await settleWithin\(\s*setDoc\(doc\(db, 'users', userId\), \{\s*onboardingComplete: true,\s*preferences\s*\}, \{ merge: true \}\),\s*PROFILE_NETWORK_TIMEOUT_MS,\s*\);[\s\S]*?clearGuestInterests\(\);/,
    'the answer is cleared after the preferences write has settled, never before',
  );
  assert.match(
    code,
    /if \(onboarded\) \{[\s\S]*?clearGuestInterests\(\);[\s\S]*?\}\s*return true;/,
    'a profile that already chose its interests discards a waiting guest answer',
  );
});

/**
 * The pessimistic write in `completeOnboarding` is now bounded
 * (`settleWithin` + `PROFILE_NETWORK_TIMEOUT_MS`); a timeout throws an error
 * with a stable `ONBOARDING_WRITE_TIMEOUT` code so handleFinish's catch can
 * tell it apart from a rules refusal or any other failure, and say so rather
 * than leaving "Start exploring" spinning with no message.
 */
test('SOURCE: handleFinish tells a write timeout apart from a generic save failure', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const handleFinish = code.match(/const handleFinish = async \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(handleFinish, 'handleFinish is gone or reshaped');
  const catchBlock = handleFinish[0].match(/\} catch \(err\) \{[\s\S]*?\n {4}\}/);
  assert.ok(catchBlock, 'handleFinish lost its catch block');
  assert.match(
    catchBlock[0],
    /else if \(err\?\.code === 'ONBOARDING_WRITE_TIMEOUT'\) \{[\s\S]*?\}/,
    'a write timeout is branched on its stable code, not on a message string',
  );
  assert.match(catchBlock[0], /Still saving\. Check your connection and try again\./);
  assert.match(catchBlock[0], /Sigue guardando\. Comprueba tu conexión e inténtalo de nuevo\./);
  // The generic branch is still the fallback for everything else.
  assert.match(catchBlock[0], /\} else \{\s*console\.error\('Error saving preferences:', err\);/);
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
