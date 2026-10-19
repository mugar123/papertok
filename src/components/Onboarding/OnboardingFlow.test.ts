import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SOURCE: first-run onboarding opens on a greeting, asks for topics only without a guest answer, and the university comes last', async () => {
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /onboardingComplete/);
  // The onboarding writes the account's preferences and nothing public: no
  // profile, handle or photo.
  assert.doesNotMatch(code, /userProfileService|createUserProfile|updateProfilePhoto|userHandle/);
  // One screen per question, in this order. The pickers only without a
  // guest answer; the greeting first, the university last.
  const list = code.match(/function onboardingSteps\(\{ asksTopics \}: \{ asksTopics: boolean \}\) \{[\s\S]*?\n\}/);
  assert.ok(list, 'the step list is gone or reshaped');
  assert.match(
    list[0],
    /return \[\s*'welcome',\s*\.\.\.\(asksTopics \? \['topics', 'subtopics'\] : \[\]\),\s*'university',\s*\];/,
  );
  // The lists that come out of it, stated independently.
  const onboardingSteps = new Function(`${stripTypeScriptTypes(list[0])}; return onboardingSteps;`)();
  assert.deepEqual(onboardingSteps({ asksTopics: true }), ['welcome', 'topics', 'subtopics', 'university']);
  assert.deepEqual(onboardingSteps({ asksTopics: false }), ['welcome', 'university']);
  assert.match(code, /const asksTopics = !guestSeed;/, 'a guest answer never sees the pickers, not even through Back');
  assert.match(code, /const steps = onboardingSteps\(\{ asksTopics \}\);/);
  assert.match(code, /const \[stepIndex, setStep\] = useState(?:<[^;\n]+>)?\(0\);/, 'every account starts on the greeting');
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

test('SOURCE: the greeting writes its title glyph by glyph once, and draws it whole when motion is refused', async () => {
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /kicker: \(firstName: string\) => \(firstName \? `Hello, \$\{firstName\}` : 'Hello'\)/);
  assert.match(code, /title: 'Welcome to PaperTok',/);
  // No step count: the dots under the screen show it.
  assert.match(code, /lede: 'Your feed is ready to be yours\. A few short steps and you are in\.',/);
  assert.doesNotMatch(code, /COUNT_WORDS|lede\(steps\.length/);
  assert.match(code, /cta: 'Let’s go',/);
  // The heading's name is the hidden text; the drawing is hidden from it.
  assert.match(code, /<span className="sr-only">\{COPY\.welcome\.title\}<\/span>\s*<ScriptTitle still=\{still\} \/>/);
  assert.match(code, /const still = Boolean\(useReducedMotion\(\)\);/);
  const title = code.match(/function ScriptTitle\(\{ still \}: \{ still: boolean \}\) \{[\s\S]*?\n\}/);
  assert.ok(title, 'ScriptTitle is gone or reshaped');
  assert.match(title[0], /<span className="onboarding-script" aria-hidden="true">/);
  assert.match(title[0], /<svg className="onboarding-script-svg" viewBox=\{WELCOME_TITLE\.viewBox\}/);
  // No pen, nothing measured at runtime: the timing is baked.
  assert.doesNotMatch(code, /PenNib|onboarding-script-pen|getTotalLength|useLayoutEffect/);
  const css = await readFile(new URL('./OnboardingFlow.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /onboarding-script-pen/);
  // Each glyph is ink under its own mask, one id per glyph; motion refused,
  // there are no masks and the paths are simply filled.
  assert.match(title[0], /\{!still && \(\s*<defs>/);
  assert.match(title[0], /id=\{`welcome-title-mask-\$\{index\}`\}/);
  assert.match(title[0], /fill=\{`url\(#welcome-title-ink-\$\{index\}\)`\}/);
  assert.match(title[0], /<path\s+key=\{index\}\s+d=\{glyph\.d\}\s+fill="currentColor"\s+mask=\{still \? undefined : `url\(#welcome-title-mask-\$\{index\}\)`\}/);
  assert.doesNotMatch(title[0], /stroke/);
  assert.match(title[0], /initial=\{\{ attrX: left - width \}\}\s*animate=\{\{ attrX: left \}\}/);
  assert.match(title[0], /className="onboarding-script-rule"\s*initial=\{still \? false : \{ scaleX: 0 \}\}/);
});

test('the greeting settles inside three seconds under the baked glyph data', async () => {
  const code = (await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const constant = (name: string) => Number(code.match(new RegExp(`const ${name} = ([\\d.]+);`))![1]);
  const { default: data } = await import('./welcomeTitlePaths.ts');
  assert.equal(data.glyphs.length, 17);
  assert.equal(data.slant, 22, 'the lean the sweeps were measured across travels with them');
  assert.match(code, /const SLANT_DEGREES = WELCOME_TITLE\.slant;/, 'the component leans its bands the way the data was measured');
  for (const glyph of data.glyphs) {
    assert.ok(glyph.length > 0, `${glyph.char} has a baked length`);
    assert.ok(glyph.box.length === 2 && glyph.box[0] < glyph.box[1], `${glyph.char} has a baked box`);
    assert.ok(glyph.sweep.length === 2 && glyph.sweep[0] < glyph.sweep[1], `${glyph.char} has a baked sweep`);
  }
  // The schedule stated independently: durations share WRITE_SECONDS by ink
  // (capitals weigh more), each glyph joins the last at JOIN_AT, words pause.
  const weights = data.glyphs.map(glyph => glyph.length * (/[A-Z]/.test(glyph.char) ? constant('CAPITAL_WEIGHT') : 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let start = constant('WRITE_START');
  let end = 0;
  data.glyphs.forEach((glyph, index) => {
    const duration = (weights[index] / total) * constant('WRITE_SECONDS');
    if (index > 0) start += (glyph.afterSpace ? constant('WORD_GAP') : 0);
    end = Math.max(end, start + duration);
    start += duration * constant('JOIN_AT');
  });
  const settled = end + constant('RULE_GAP') + constant('RULE_SECONDS');
  assert.ok(settled <= 3, `the greeting settles at ${settled.toFixed(2)} s`);
});

test('SOURCE: the title is baked outlines from a checked-in generator, and no script face loads at runtime', async () => {
  const code = (await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /^import WELCOME_TITLE from '\.\/welcomeTitlePaths\.ts';$/m);
  assert.doesNotMatch(code, /@fontsource\/pinyon-script/);
  const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['build:welcome-title'], 'node scripts/build-welcome-title.ts');
  assert.ok(pkg.devDependencies['@fontsource/pinyon-script'] && pkg.devDependencies['opentype.js']);
  assert.ok(!pkg.dependencies['@fontsource/pinyon-script'], 'the face is a build input, not a runtime dependency');
  await readFile(new URL('../../../scripts/build-welcome-title.ts', import.meta.url), 'utf8');
  const { default: data } = await import('./welcomeTitlePaths.ts');
  assert.equal(data.text, 'Welcome to PaperTok');
  assert.match(code, /title: 'Welcome to PaperTok',/, 'the hidden text says what the drawing shows');
  // One outline per visible character, in writing order.
  assert.deepEqual(data.glyphs.map(glyph => glyph.char).join(''), 'WelcometoPaperTok');
  assert.equal(data.viewBox.split(' ').length, 4);
  const css = (await readFile(new URL('./OnboardingFlow.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'tokens only');
});

test('SOURCE: there is no sign-in page; a guest off a protected route gets the feed with the door open', async () => {
  const guard = (await readFile(new URL('../Auth/ProtectedRoute.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  // The state is one object per destination (a literal re-issued the redirect
  // on every render), and it still carries the full requested path.
  assert.match(guard, /const requestedPath = `\$\{location\.pathname\}\$\{location\.search\}`;/);
  assert.match(guard, /const signInState = useMemo(?:<[^;\n]+>)?\(\(\) => \(\{ authRequired: true, returnTo: requestedPath \}\), \[requestedPath\]\);/);
  assert.match(guard, /<Navigate to="\/feed" replace state=\{signInState\} \/>/);
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
  assert.doesNotMatch(code, /guestCategoriesForAreas\(/, 'the full union belongs to the guest feed plan, not to the onboarding');
  assert.doesNotMatch(code, /saveGuestInterests|clearGuestInterests/, 'the onboarding reads the answer; AuthContext owns its end');
});

test('SOURCE: the university screen asks for the address itself, in a field that starts empty', async () => {
  const source = await readFile(new URL('./OnboardingFlow.tsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /const \[institutionEmail, setInstitutionEmail\] = useState(?:<[^;\n]+>)?\(''\);/);
  assert.doesNotMatch(code, /guestAnswer\?\.institutionEmail/, 'the welcome no longer carries an address');
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
  // form's submit and Google's window opens from it.
  const bound = primary[0].match(/\? \{([\s\S]*?)\}\s*:/)![1];
  assert.match(bound, /form: UNIVERSITY_FORM_ID,/);
  assert.match(bound, /label: linkBusy \? COPY\.university\.verifying : linkPreparing \? COPY\.university\.preparing : COPY\.university\.link,/);
  assert.match(bound, /busy: linkBusy \|\| linkPreparing,/, 'busy keeps it focusable while Google is open or being prepared');
  assert.doesNotMatch(bound, /onClick/);
  assert.match(code, /link: 'Continue',\s*verifying: 'Verifying…',\s*preparing: 'Preparing sign-in…',/);
  // The window opens on the link's own Auth instance, which has to be ready
  // for it to open inside the press (InstitutionLink ignores the submit until
  // then). An address the account already proves opens no window and does not wait.
  assert.match(code, /const linkPreparing = !usePopupReady\(linksOnPress \? institutionLinkReadiness\(\) : null\)\s*&& needsUniversityProof\(institutionEmail\);/);
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
  // The yellow is the greeting's rule, and nothing else here.
  assert.equal((css.match(/--brand-yellow/g) || []).length, 1);
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
  assert.match(code, /\{step === 'university' && <LibraryPreview still=\{still\} stamp=\{<PetriStamp \/>\} \/>\}\s*\{step === 'welcome' \? \(/);
  assert.match(block, /showSubmit=\{false\}/);
  const css = (await readFile(new URL('./OnboardingFlow.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.onboarding-university \.institution-services-list > li:nth-child\(2\) \{ animation-delay: 50ms; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.onboarding-university \.institution-services-list > li[\s\S]*animation: none;/);
});

