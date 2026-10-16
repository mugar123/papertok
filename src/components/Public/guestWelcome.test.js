import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const jsxPromise = read('./GuestWelcome.tsx').then(stripComments);
// The page, its foot and the pickers the welcome draws through.
const shellPromise = read('./WelcomeShell.tsx').then(stripComments);
const cssPromise = read('./GuestWelcome.css').then(stripComments);
const starsPromise = read('./Stars.tsx').then(stripComments);

/**
 * SOURCE test for the shape of the welcome: four screens in order — what
 * PaperTok is, what you do in it, the areas, and the specific topics inside
 * them — a page with its own landmark, and the areas as the one question that
 * has to be answered before the feed.
 */
test('the welcome retains its intro and topics before personalization and optional support', async () => {
  const [jsx, shell] = await Promise.all([jsxPromise, shellPromise]);
  assert.match(jsx, /const STEPS = \['welcome', 'how', 'topics', 'subtopics', 'reading', 'inbox', 'support'\];/);
  assert.match(jsx, /return \(\s*<WelcomeShell\b/, 'the welcome is drawn in the shared page');
  assert.match(shell, /<motion\.main\s+className=\{`gw\$\{/, 'the welcome brings its own <main>, the feed page is not mounted under it');
  assert.doesNotMatch(jsx + shell, /ui\/dialog|<Dialog/, 'a first visit is not a dialog over the feed');
  // The feed is built from the answer, so the last step cannot be passed
  // without one; the first two can be skipped straight to it.
  assert.match(jsx, /const primaryDisabled = isQuestion && selected\.size === 0;/);
  assert.match(jsx, /const finish = \(\) => \{\s*if \(selected\.size === 0 \|\| leaving\) return;/);
  assert.match(jsx, /skip=\{stepIndex < TOPICS_INDEX \? \{ onClick: \(\) => goTo\(TOPICS_INDEX\), label: copy\.skip \} : null\}/, 'the skip goes to the areas step, not past it');
  assert.match(jsx, /const TOPICS_INDEX = STEPS\.indexOf\('topics'\);/);
});

/**
 * The specific topics are a screen of their own, after the areas, drawn with
 * the areas' own cards. Narrowing is optional — an area left whole stands for
 * all of it — so the areas screen says Continue and the topics screen's
 * button is live with nothing picked; and the copy sells narrowing as making
 * the feed yours, not as a fallback.
 */
test('the specific topics are their own screen, in the area cards, and never block the feed', async () => {
  const [jsx, shell] = await Promise.all([jsxPromise, shellPromise]);
  assert.match(jsx, /const primary = \(\) => \{\s*if \(step === 'support'\) finish\(\);\s*else goTo\(stepIndex \+ 1\);/);
  assert.match(jsx, /\{isSubtopics && \(\s*<SubtopicsPicker\b/, 'the topics screen draws the shared picker');
  const subtopics = shell.slice(shell.indexOf('export function SubtopicsPicker'));
  assert.match(subtopics, /className="gw-areas"/, 'the same grid as the areas');
  assert.match(subtopics, /className="gw-area"/, 'the same cards as the areas');
  assert.doesNotMatch(jsx + shell, /gw-chip|gw-refine/, 'the chip row is back');
  assert.match(jsx, /cta: 'Continue',/);
  assert.match(jsx, /lede: 'The more specific, the more personal your feed\.'/);
});

/**
 * Back and skip are bare icons either side of the button. Bare, so each has
 * to carry its name for assistive tech (and a tooltip for the pointer), in
 * both languages; and each keeps its slot when absent, so the button does not
 * move from one screen to the next.
 */
test('back and skip are named icon buttons either side of the way forward', async () => {
  const [jsx, shell] = await Promise.all([jsxPromise, shellPromise]);
  const actions = shell.match(/<div className="gw-actions">[\s\S]*?\n {8}<\/div>/)?.[0] ?? '';
  assert.ok(actions, 'the action row is there');
  const order = ['aria-label={back.label}', 'className="gw-primary"', 'aria-label={skip.label}'].map(needle => actions.indexOf(needle));
  assert.ok(order.every(position => position >= 0), 'back, the button and skip are all in the row');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order: back, button, skip');
  assert.match(actions, /title=\{back\.label\}/);
  assert.match(actions, /title=\{skip\.label\}/);
  // The welcome names back here; the skip's name is pinned with its target above.
  assert.match(jsx, /back=\{stepIndex > 0 \? \{ onClick: \(\) => goTo\(stepIndex - 1\), label: copy\.back \} : null\}/);
  assert.equal((actions.match(/<span className="gw-action-slot">/g) ?? []).length, 2, 'both sides keep a slot');
  const css = await cssPromise;
  assert.match(css, /\.gw-action-slot \{[^}]*flex: 0 0 44px;/);
});

/**
 * The three gestures share one screen, side by side, and arrive one after
 * another: each keeps its box from the first frame, and its illustration
 * mounts — and so plays — when it lands. The last one has to be done inside
 * the five seconds the rest of the welcome keeps to.
 */
test('the three gestures sit in a row and arrive one after another', async () => {
  const jsx = await jsxPromise;
  assert.match(jsx, /const BEAT_STAGGER_MS = (\d+);/);
  const stagger = Number(/const BEAT_STAGGER_MS = (\d+);/.exec(jsx)[1]);
  assert.ok(stagger * 2 + 2500 <= 5000, 'the third gesture still finishes inside five seconds');
  assert.match(jsx, /\{landed \? <Demo still=\{still\} \/> : <div className="gw-demo" aria-hidden="true" \/>\}/);
  assert.match(jsx, /const \[landed, setLanded\] = useState\(still\);/, 'refused motion shows all three at once');
  const css = await cssPromise;
  assert.match(css.match(/\.gw-beats \{[^}]*\}/)?.[0] ?? '', /flex-direction: row;/);
});

/**
 * Moving to a step moves focus to its heading, so a screen reader starts
 * reading the new step. Not on first paint: that is the page loading.
 */
test('each step heading takes focus when the reader moves to it', async () => {
  const [jsx, shell] = await Promise.all([jsxPromise, shellPromise]);
  // One heading, drawn by the template every screen shares, so no screen
  // can ship without it.
  const headings = shell.match(/<h1 className="gw-title" tabIndex=\{-1\}>/g) ?? [];
  assert.equal(headings.length, 1, 'the screens share one focusable h1');
  assert.doesNotMatch(jsx, /<h1\b/, 'the welcome draws its heading through WelcomeCopy');
  // Each new screen's section, as it mounts, focuses its heading; the first
  // section to mount is the first paint and does not steal focus.
  assert.match(shell, /ref=\{focusNewHeading\}/);
  assert.match(shell, /if \(shownSection\.current && shownSection\.current !== section\) \{\s*section\.querySelector\('\.gw-title'\)\?\.focus\(\{ preventScroll: true \}\);/);
  const css = await cssPromise;
  assert.match(css, /\.gw-title:focus-visible \{\s*outline: none;\s*\}/);
});

/**
 * The regression this file was written after: `initial={false}` on the
 * AnimatePresence around the steps is inherited by every motion component
 * inside it, and the welcome's illustrations mounted already finished — the
 * papers never travelled from the sources to the feed.
 */
test('the steps presence does not switch off the illustrations’ entrance', async () => {
  const shell = await shellPromise;
  // The screens' presence (mode="wait"); the progress dots have their own,
  // which skips the first paint on purpose so the dots are simply there.
  const presence = (shell.match(/<AnimatePresence[^>]*>/g) ?? []).filter(tag => tag.includes('mode="wait"'));
  assert.ok(presence.length > 0, 'the steps still cross-fade through AnimatePresence');
  for (const tag of presence) {
    assert.doesNotMatch(tag, /initial=\{false\}/, `${tag} would freeze every illustration on its last frame`);
  }
  // And the leaving step reads the direction of the move happening now.
  assert.match(shell, /exit: \(dir\) => \(\{ opacity: 0, x: dir \* -28/);
  assert.match(shell, /custom=\{direction\}\s+variants=\{stepVariants\}/);
});

/**
 * Refused motion draws every illustration in its final state and draws no
 * stars at all.
 */
test('with motion refused the illustrations are drawn finished and the columns hold still', async () => {
  const jsx = await jsxPromise;
  assert.match(jsx, /const still = Boolean\(prefersReducedMotion\);/);
  assert.match(jsx, /const \[order, setOrder\] = useState\(still \? \['b', 'a', 'c'\] : \['a', 'b', 'c'\]\);/);
  assert.match(jsx, /if \(still\) onComplete\?\.\(/, 'with no leave to wait for, the answer is handed over at once');
  assert.match(jsx, /\{!still && <Stars avoid=\{hero\} \/>\}/, 'no stars when motion is refused');
  // WCAG 2.2.2: with no pause control, the stars stop scheduling themselves too.
  const stars = await starsPromise;
  assert.match(stars, /const until = performance\.now\(\) \+ STARS_LAST_MS;/, 'the stars have a deadline');
  assert.match(stars, /if \(.*< until\) timer = window\.setTimeout\(twinkle\b/, 'no glint is scheduled past it');
  const css = await cssPromise;
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(reduced, /\.gw-area \{\s*animation: none;/);
});


/**
 * The first screen is the landing page: the hero carries its own way forward
 * (the shell's foot is not drawn there), the account button discloses the two
 * providers in place — named as expanded or not, and inert while closed — and
 * the engravings and stars are decoration that assistive tech never meets.
 */
test('the welcome is the landing page, with its own way forward and decorative engravings', async () => {
  const [jsx, css] = await Promise.all([jsxPromise, cssPromise]);
  const welcome = jsx.slice(jsx.indexOf("{step === 'welcome' ? ("), jsx.indexOf(') : copyBlock}'));

  const backdrop = jsx.slice(jsx.indexOf('backdrop={onLanding && ('), jsx.indexOf('barAction={'));
  assert.match(welcome, /<Button variant="engraved" size="lg" className="w-full" onClick=\{primary\}>/, 'Get started moves to the next screen');
  assert.match(welcome, /aria-expanded=\{accountOpen\}\s+aria-controls="gw-providers"/, 'the account button says whether the providers are open');
  assert.match(welcome, /id="gw-providers"[^>]*inert=\{!accountOpen\}/, 'closed, the providers cannot take focus');
  for (const provider of ['github', 'google']) {
    assert.match(welcome, new RegExp(`signIn\\('${provider}'\\)`), `the landing signs in with ${provider}`);
  }
  for (const plate of ['scrolls', 'microscope', 'lab']) {
    assert.match(backdrop, new RegExp(`<span className="gw-plate gw-plate--${plate}" aria-hidden="true" />`));
  }
  assert.match(await starsPromise, /<div ref=\{sky\} className="gw-stars" aria-hidden="true" \/>/);
  assert.match(css, /\.gw--landing \.gw-foot \{\s*display: none;/, 'one way forward on the landing, not two');
});

/**
 * The interface is English-only: the copy has one English block and no
 * Spanish one left behind.
 */
test('the welcome copy is English-only', async () => {
  const source = await read('./GuestWelcome.tsx');
  assert.match(source, /const COPY = \{\n {2}en: \{/);
  assert.doesNotMatch(source, /^\s*es: \{/m, 'a Spanish copy block is back');
  assert.match(source, /const copy = COPY\.en;/);
});

/**
 * One centred column and the way forward centred at the foot, with nothing
 * competing beside it (the landing page carries its own, see above).
 */
test('the welcome is one centred column with the button centred at the foot', async () => {
  const css = await cssPromise;
  const stage = css.match(/(?:^|\n)\.gw-stage \{[^}]*\}/)?.[0] ?? '';
  assert.match(stage, /flex-direction: column;/);
  assert.match(stage, /align-items: center;/);
  const foot = css.match(/(?:^|\n)\.gw-foot \{[^}]*\}/)?.[0] ?? '';
  assert.match(foot, /flex-direction: column;/);
  assert.match(foot, /align-items: center;/);
});

/**
 * A big area (physics has 26 topics) folds to its first few behind "Show
 * more"; a small one shows everything; a topic already picked stays in view
 * when its group is folded; and the control says whether it is open, and
 * which grid it opens, to assistive tech.
 */
test('long topic groups fold behind show more without hiding a pick', async () => {
  const shell = await shellPromise;
  const shownCount = Number(/const SUBTOPICS_SHOWN = (\d+);/.exec(shell)[1]);
  assert.ok(shownCount >= 3 && shownCount <= 9, 'a few, not a wall');
  assert.match(shell, /const SUBTOPICS_FOLD_MIN = SUBTOPICS_SHOWN \+ \d+;/, 'no "show 1 more"');
  assert.match(shell, /entries\.filter\(\(\[id\], index\) => index < SUBTOPICS_SHOWN \|\| selectedTopics\.has\(id\)\)/);
  assert.match(shell, /className="gw-more"\s+aria-expanded=\{expanded\}\s+aria-controls=\{gridId\}/);
  assert.match(shell, /showMore: n => `Show \$\{n\} more`/);
});


test('the welcome ends in the feed, and an existing account can sign in from any screen', async () => {
  const [jsx, shell] = await Promise.all([jsxPromise, shellPromise]);
  const support = jsx.slice(jsx.indexOf('    support: {'), jsx.indexOf('const SHOWCASE') > jsx.indexOf('    support: {') ? jsx.indexOf('const SHOWCASE') : undefined);
  assert.match(support, /cta: 'Start exploring papers'/);
  assert.doesNotMatch(jsx, /cta: 'Sign in'/, 'the last action opens the feed, not a dialog');
  // Someone onboarded on another device must not answer the welcome again to
  // reach their account: the landing's account button opens the providers, and
  // the bar carries Sign in on every screen after it.
  const bar = shell.slice(shell.indexOf('<header className="gw-bar">'), shell.indexOf('</header>'));
  assert.match(bar, /\{barAction\}/, 'the bar draws the action its caller passes');
  const barAction = jsx.slice(jsx.indexOf('barAction={('), jsx.indexOf("{step === 'welcome'", jsx.indexOf('barAction={(')));
  assert.match(barAction, /<PrivacyPopover className="gw-bar-button" \/>/, 'Privacy is on every screen, the landing included');
  assert.match(barAction, /\{!onLanding && \(\s*<button type="button" className="gw-sign-in" onClick=\{onSignIn\}>/);
  assert.match(barAction, /Sign in/);
  // The page leaves, and only then hands its answer over.
  assert.match(shell, /animate=\{leaving && !still \? \{ opacity: 0, y: -16 \} : \{ opacity: 1, y: 0 \}\}/);
  assert.match(shell, /onAnimationComplete=\{\(\) => \{\s*if \(leaving && !still\) onLeaveComplete\?\.\(\);/);
  assert.match(jsx, /onLeaveComplete=\{\(\) => onComplete\?\.\(answer\(\)\)\}/);
});
