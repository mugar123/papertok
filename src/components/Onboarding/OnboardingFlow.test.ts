import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SOURCE: first-run onboarding asks for topics and the university only without a guest answer', async () => {
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /onboardingComplete/);
  // The onboarding writes the account's preferences and nothing public: no
  // profile, handle or photo.
  assert.doesNotMatch(code, /userProfileService|createUserProfile|updateProfilePhoto|userHandle/);
  // One screen per question, in this order, only without a guest answer.
  const list = code.match(/function onboardingSteps\(\{ asksTopics \}: \{ asksTopics: boolean \}\) \{[\s\S]*?\n\}/);
  assert.ok(list, 'the step list is gone or reshaped');
  assert.match(
    list[0],
    /return asksTopics \? \['topics', 'subtopics', 'university'\] : \['finish'\];/,
  );
  // The lists that come out of it, stated independently.
  const onboardingSteps = new Function(`${stripTypeScriptTypes(list[0])}; return onboardingSteps;`)();
  assert.deepEqual(onboardingSteps({ asksTopics: true }), ['topics', 'subtopics', 'university']);
  assert.deepEqual(onboardingSteps({ asksTopics: false }), ['finish']);
  assert.doesNotMatch(code, /'welcome'|ScriptTitle|welcomeTitlePaths/, 'no greeting screen');
  assert.match(code, /const asksTopics = !guestSeed;/, 'a guest answer never sees the pickers, not even through Back');
  assert.match(code, /const steps = onboardingSteps\(\{ asksTopics \}\);/);
  assert.match(code, /const \[stepIndex, setStep\] = useState(?:<[^;\n]+>)?\(0\);/);
  // The dots are the list the reader will see.
  assert.match(code, /dots=\{\{ count: steps\.length, index: stepIndex,/);
  // The last screen of either list is the one that finishes.
  assert.match(code, /const isLast = stepIndex === steps\.length - 1;/);
  assert.match(code, /if \(isLast\) void handleFinish\(\);\s*else goTo\(stepIndex \+ 1\);/);
  assert.match(code, /university: \{[\s\S]*?cta: 'Start exploring',/);
});

test('SOURCE: the onboarding is drawn in the welcome\'s shell, with the welcome\'s pickers', async () => {
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /import \{ AreaPicker, SubtopicsPicker, WelcomeCopy, WelcomeShell \} from '\.\.\/Public\/WelcomeShell\.tsx';/);
  assert.equal((code.match(/<WelcomeShell\b/g) || []).length, 1);
  assert.match(code, /<AreaPicker\b/);
  assert.match(code, /<SubtopicsPicker\b/);
  // No cards, heading or landmark of its own: the shell draws those.
  assert.doesNotMatch(code, /<Toggle\b|<h1\b|<main\b|area-card|subcat-chip|InterestsReceipt/);
});

test('SOURCE: there is no sign-in page; a guest off a protected route gets the onboarding with the door open', async () => {
  const guard = (await readFile(new URL('../Auth/ProtectedRoute.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  // The state is one object per destination (a literal re-issued the redirect
  // on every render), and it still carries the full requested path.
  assert.match(guard, /const requestedPath = `\$\{location\.pathname\}\$\{location\.search\}`;/);
  assert.match(guard, /const signInState = useMemo(?:<[^;\n]+>)?\(\(\) => \(\{ authRequired: true, returnTo: requestedPath \}\), \[requestedPath\]\);/);
  assert.match(guard, /<Navigate to="\/onboarding" replace state=\{location\.pathname === '\/feed' \? undefined : signInState\} \/>/);
  assert.doesNotMatch(guard, /to="\/login"/);
  const app = await readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /LoginPage/);
  assert.match(app, /<Route path="\/login" element=\{<LoginRedirect \/>\} \/>/, 'old /login links still land somewhere');
  assert.match(app, /if \(!user\) setAuthPromptOpen\(true\)/, 'the sign-in dialog opens for the bounced guest');
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
test('SOURCE: the onboarding is seeded from the guest answer', async () => {
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  // Read once, in one place.
  assert.match(code, /const \[guestAnswer\] = useState(?:<[^;\n]+>)?\(\(\) => readGuestInterests\(\)\);/);
  assert.equal((code.match(/readGuestInterests\(/g) || []).length, 1);
  assert.match(code, /new Set\(guestSeed \?\? \[\]\)/, 'the areas are pre-selected');
  assert.match(code, /new Set\(guestAnswer\?\.topics \?\? \[\]\)/, 'and so are the topics');
  // One rule for both flows: an area narrowed to topics stands for those, an
  // area left whole for its first few (bounded, so the feed has siblings
  // left to explore).
  assert.match(
    code,
    /guestSeedCategoriesForAreas\(Array\.from\(selectedAreas\), GUEST_SEED_PER_AREA, Array\.from\(selectedTopics\)\)/,
    'the preferences are the welcome\'s rule applied to what is ticked',
  );
  assert.match(code, /await completeOnboarding\(preferences\);/, 'and that is what is written');
  assert.doesNotMatch(code, /saveGuestInterests|clearGuestInterests/, 'the onboarding reads the answer; AuthContext owns its end');
});

test('SOURCE: the university screen asks for the address itself, in a field that starts empty', async () => {
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /const \[institutionEmail, setInstitutionEmail\] = useState(?:<[^;\n]+>)?\(''\);/);
  assert.match(
    code,
    /\{step === 'university' && \([\s\S]*?<InstitutionLink\s+idPrefix="onboarding-institution"\s+formId=\{UNIVERSITY_FORM_ID\}\s+showSubmit=\{false\}\s+email=\{institutionEmail\}\s+onEmailChange=\{setInstitutionEmail\}\s+onBusyChange=\{setLinkBusy\}\s+linkedNote=\{COPY\.university\.linkedNote\}\s*\/>/,
    'the link is the university screen\'s, with no button of its own',
  );
  assert.match(code, /linkedNote: 'You can unlink any time in Settings\.',/);
  // The way round the link is there until one is made, whatever is typed.
  assert.match(code, /skip=\{step === 'university' && !institution && !linkBusy\s*\? \{ onClick: \(\) => \{ if \(!saving\) void handleFinish\(\); \}, label: COPY\.university\.skip \}/);
  assert.equal((code.match(/<InstitutionLink\b/g) || []).length, 1);
});

test('SOURCE: the guest answer is cleared where the profile takes over', async () => {
  const source = await readFile(new URL('../../context/AuthContext.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const complete = code.match(/const completeOnboarding = useCallback(?:<[^;\n]+>)?\(async \(preferences: string\[\]\) => \{[\s\S]*?\n {2}\}, \[readingPreferences, user\?\.uid\]\);/);
  assert.ok(complete, 'completeOnboarding is gone or reshaped');
  assert.match(
    complete[0],
    /await settleWithin\(\s*setDoc\(doc\(db, 'users', userId\), \{\s*onboardingComplete: true,\s*\.\.\.\(guestReading \? \{ readingPreferences: guestReading \} : \{\}\),\s*preferences\s*\}, \{ merge: true \}\),\s*PROFILE_NETWORK_TIMEOUT_MS,\s*\);[\s\S]*?clearGuestInterests\(\);/,
    'the answer is cleared after the preferences write has settled, never before',
  );
  // The email opt-in rides in a write of its own that the onboarding does not
  // wait for: rules that have not been deployed yet must not block an account.
  assert.doesNotMatch(complete[0], /onboardingComplete: true,[\s\S]{0,160}emailDigestOptIn/);
  assert.match(
    complete[0],
    /if \(guestEmailDigest\) \{\s*void settleWithin\(\s*setDoc\(doc\(db, 'users', userId\), \{ emailDigestOptIn: true \}, \{ merge: true \}\),/,
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
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const handleFinish = code.match(/const handleFinish = async \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(handleFinish, 'handleFinish is gone or reshaped');
  const catchBlock = handleFinish[0].match(/\} catch \(err\) \{[\s\S]*?\n {4}\}/);
  assert.ok(catchBlock, 'handleFinish lost its catch block');
  assert.match(
    catchBlock[0],
    /if \(\(err as \{ code\?: string \} \| null\)\?\.code === 'ONBOARDING_WRITE_TIMEOUT'\) \{[\s\S]*?\}/,
    'a write timeout is branched on its stable code, not on a message string',
  );
  assert.match(catchBlock[0], /Still saving\. Check your connection and try again\./);
  // The generic branch is still the fallback for everything else.
  assert.match(catchBlock[0], /\} else \{\s*console\.error\('Error saving preferences:', err\);/);
});

test('SOURCE: on the university screen a typed address makes the primary the link\'s submit', async () => {
  const code = (await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /const linksOnPress = step === 'university' && !institution && institutionEmail\.trim\(\) !== '';/);
  const primary = code.match(/primary=\{linksOnPress && !saving\s*\? \{[\s\S]*?\}\s*: \{[\s\S]*?\n {8}\}\}/);
  assert.ok(primary, 'the primary no longer depends on the typed address');
  // Bound to the form: no click handler of its own, so the press is the
  // form's submit and starts email verification.
  const bound = primary[0].match(/\? \{([\s\S]*?)\}\s*:/)![1];
  assert.match(bound, /form: UNIVERSITY_FORM_ID,/);
  assert.match(bound, /label: linkBusy \? COPY\.university\.verifying : COPY\.university\.link,/);
  assert.match(bound, /busy: linkBusy,/, 'busy keeps it focusable during verification');
  assert.doesNotMatch(bound, /onClick/);
  assert.match(code, /link: 'Continue',\s*verifying: 'Verifying…',/);
  // With no address, or once linked, it is the screen's own: Start exploring.
  assert.match(primary[0], /label: saving \? COPY\.saving : stepCopy\.cta,/);
  assert.match(code, /<LibraryPreview still=\{still\} stamp=\{<PetriStamp \/>\} \/>/);
  assert.match(code, /import \{ LibraryPreview \} from '\.\.\/Public\/GuestWelcomePreferences\.tsx';/);

  const shell = (await readFile(new URL('../Public/WelcomeShell.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(shell, /type=\{primary\.form \? 'submit' : 'button'\}\s*form=\{primary\.form\}\s*onClick=\{primary\.form \? undefined : primary\.onClick\}/);
});

const screenBlock = (code: string, screen: string) => code.match(new RegExp(`\\{step === '${screen}' && \\([\\s\\S]*?\\n {6}\\)\\}`))?.[0];

test('SOURCE: the onboarding CSS draws on white ground, with no tint behind its content', async () => {
  const css = (await readFile(new URL('./OnboardingFlow.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /color-mix/);
  assert.doesNotMatch(css, /--area-accent/);
  assert.doesNotMatch(css, /--shadow-/, 'the props keep the welcome\'s own elevation');
  assert.doesNotMatch(css, /border-radius:\s*\d/, 'radius tokens only');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'tokens only');
  const code = (await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(code, /--area-accent|onboarding-stage|onboarding-plate|PagePreview/);
});

test('SOURCE: the university screen keeps the welcome\'s layout, and its platforms stagger only with motion allowed', async () => {
  const code = (await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const block = screenBlock(code, 'university');
  assert.ok(block, 'the university screen is gone or reshaped');
  assert.match(block, /className="gw-preferences gw-university onboarding-university"/);
  assert.match(block, /onboarding-university">\s*<InstitutionLink/);
  assert.match(code, /\{step === 'university' && <LibraryPreview still=\{still\} stamp=\{<PetriStamp \/>\} \/>\}\s*<WelcomeCopy/);
  assert.match(block, /showSubmit=\{false\}/);
  const css = (await readFile(new URL('./OnboardingFlow.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.onboarding-university \.institution-services-list > li:nth-child\(2\) \{ animation-delay: 50ms; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.onboarding-university \.institution-services-list > li[\s\S]*animation: none;/);
});

