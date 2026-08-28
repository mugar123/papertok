import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

/**
 * The landmark skeleton, and the two ways it has already been broken.
 *
 * `docs/ACCESIBILIDAD.md` asks for an automated regression test per corrected
 * defect. The contrast tokens and the route titles got theirs
 * (`styles/contrast.test.js`, `utils/routeMetadata.test.js`); the structural
 * fixes of this delivery shipped with none, and they are exactly the kind that
 * rots quietly: a skip link that stops being first in the DOM, a `<nav>` that
 * loses its name in a refactor, an `outline: none` added back to hide a ring
 * somebody found ugly. None of those breaks a build, a lint rule or a render.
 *
 * So they are held here the way this repo already holds stylesheet invariants
 * (`styles/darkTheme.test.js`, `components/Reader/readerMobileStyles.test.js`):
 * read the source, assert the parts of the fix the source can be held to. This
 * is a structural net, not a substitute for the keyboard walkthrough or for a
 * screen reader — see `docs/ACCESIBILIDAD-EVIDENCIA.md` for what is and is not
 * actually verified.
 */

const APP_JSX = new URL('./App.jsx', import.meta.url);
const NAVBAR_JSX = new URL('./components/Layout/Navbar.jsx', import.meta.url);
const FEED_CONTAINER_JSX = new URL('./components/Feed/FeedContainer.jsx', import.meta.url);
const BUTTON_VARIANTS = new URL('./components/ui/button-variants.js', import.meta.url);
const SRC_DIR = new URL('./', import.meta.url);

/**
 * Comments describe the very markup these assertions look for — FeedContainer's
 * header comment names `<main>` and `landmark`, and global.css explains why an
 * `outline: none` used to be fatal. Matching a comment would let the code lose
 * the thing its comment still promises, and every assertion here would keep
 * passing against prose.
 */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const readSource = async url => stripComments(await readFile(url, 'utf8'));

/** Every stylesheet under src/, path-relative for readable failures. */
async function stylesheets() {
  const entries = await readdir(SRC_DIR, { recursive: true });
  return entries.filter(name => name.endsWith('.css')).sort();
}

// ── The page skeleton: App.jsx ──────────────────────────────────────────────

test('App.jsx renders a skip link that targets #main-content', async () => {
  const app = await readSource(APP_JSX);

  const link = app.match(/<a\b[^>]*className="skip-link"[^>]*>/);
  assert.ok(
    link,
    'App.jsx no longer renders `<a className="skip-link">`. That link is the only '
    + 'mechanism this app has for skipping the repeated chrome (WCAG 2.4.1 Bypass '
    + 'Blocks), and it is the first thing every keyboard user meets.',
  );
  assert.match(
    link[0],
    /href="#main-content"/,
    'the skip link no longer points at #main-content. Its href is what moves focus: '
    + 'a link to any other id (or to nothing) leaves the reader at the top of the '
    + 'chrome with no way past it, while still looking correct on screen.',
  );

  const target = app.match(/<div\b[^>]*id="main-content"[^>]*>/);
  assert.ok(
    target,
    'the `<div id="main-content">` the skip link points at is gone. Without the '
    + 'target element the link is a dead fragment: focus stays where it was and '
    + 'nothing visible happens.',
  );
  assert.match(
    target[0],
    /tabIndex=\{-1\}/,
    '#main-content lost `tabIndex={-1}`. A plain div cannot receive focus, so both '
    + 'the skip link and RouteAnnouncer would silently fail to move focus into the '
    + 'content — the URL would change and the keyboard would not.',
  );

  assert.ok(
    app.indexOf(link[0]) < app.indexOf(target[0]),
    'the skip link is no longer rendered before #main-content. It has to be the '
    + 'first tab stop on the page; behind the chrome it skips nothing.',
  );
});

test('the skip link handles its own click instead of letting HashRouter see the fragment', async () => {
  const rawApp = await readFile(APP_JSX, 'utf8');
  const app = stripComments(rawApp);

  const link = app.match(/<a\b[^>]*className="skip-link"[^>]*>/);
  assert.ok(link, 'App.jsx no longer renders `<a className="skip-link">`.');

  const handlerName = link[0].match(/onClick=\{(\w+)\}/);
  assert.ok(
    handlerName,
    'the skip link lost its onClick handler. src/main.jsx mounts <HashRouter>, so the '
    + 'route IS the URL fragment: without an onClick that intercepts the click, '
    + 'following href="#main-content" rewrites the whole hash, react-router reads it '
    + 'as the pathname "/main-content", matches nothing, and the catch-all '
    + '`<Route path="*">` (App.jsx) redirects to "/" — ejecting a keyboard user from '
    + 'whatever route they were on. Verified live from #/login: the hash became '
    + '#main-content, then #/, and the login page was gone.',
  );

  const handlerDeclAt = app.indexOf(`const ${handlerName[1]}`);
  assert.notEqual(
    handlerDeclAt,
    -1,
    `could not find where ${handlerName[1]} is defined in App.jsx to check its body.`,
  );
  const handlerBody = app.slice(handlerDeclAt, handlerDeclAt + 400);

  assert.match(
    handlerBody,
    /preventDefault\(\)/,
    `${handlerName[1]} no longer calls preventDefault(). Without it the browser still `
    + 'follows the href and HashRouter still rewrites the hash and redirects away '
    + '(see above).',
  );
  assert.match(
    handlerBody,
    /getElementById\(['"]main-content['"]\)/,
    `${handlerName[1]} no longer focuses #main-content directly. preventDefault() `
    + 'alone stops the redirect but leaves the skip link with nothing to skip to — '
    + 'focus has to be moved by hand once the browser is prevented from following the '
    + 'href itself.',
  );

  assert.match(
    rawApp,
    /HashRouter/,
    'the comment explaining why the skip link needs its own click handler (naming '
    + 'HashRouter as the router that turns the fragment into a route) is gone from '
    + 'App.jsx. The plain-fragment version of this link looks completely correct to '
    + 'anyone who does not know the router treats the URL fragment as the route.',
  );
});

test('App.jsx mounts RouteAnnouncer', async () => {
  const app = await readSource(APP_JSX);

  assert.match(
    app,
    /import\s+RouteAnnouncer\s+from\s+'\.\/components\/Layout\/RouteAnnouncer'/,
    'App.jsx stopped importing RouteAnnouncer.',
  );
  assert.match(
    app,
    /<RouteAnnouncer\s*\/>/,
    'RouteAnnouncer is no longer mounted. It is what makes a route change perceivable: '
    + 'it sets the tab title (2.4.2), announces the new view through a polite live '
    + 'region (4.1.3) and moves focus to #main-content (2.4.3). Unmounted, SPA '
    + 'navigation goes back to being completely silent.',
  );
});

// ── The navigation landmark: Navbar.jsx ─────────────────────────────────────

test('the navbar exposes a name and marks the active route', async () => {
  const navbar = await readSource(NAVBAR_JSX);

  const nav = navbar.match(/<nav\b[^>]*>/);
  assert.ok(nav, 'Navbar.jsx no longer renders a `<nav>` element.');
  assert.match(
    nav[0],
    /aria-label=/,
    'the `<nav>` lost its aria-label. A screen reader lists landmarks by name; an '
    + 'unnamed navigation region is announced as "navigation" with nothing to tell '
    + 'it apart from any other, which defeats the point of having a landmark.',
  );

  const forYouAt = navbar.search(/'For you'\s*:\s*'Para ti'/);
  assert.notEqual(forYouAt, -1, 'the "For you" / "Para ti" control is gone from Navbar.jsx.');
  const openingTagAt = navbar.lastIndexOf('<button', forYouAt);
  assert.notEqual(openingTagAt, -1, 'the "For you" label is no longer inside a <button>.');
  assert.match(
    navbar.slice(openingTagAt, forYouAt),
    /aria-current=/,
    'the "For you" control no longer carries aria-current. The active tab is styled '
    + 'with a class, so without aria-current the current page is communicated by '
    + 'appearance alone and nothing announces which feed you are on (WCAG 1.3.1).',
  );
});

// ── The feed landmark, and why it is opt-in: FeedContainer.jsx ──────────────

test('FeedContainer renders its landmark as <main> with a visually hidden h1', async () => {
  const feed = await readSource(FEED_CONTAINER_JSX);

  const main = feed.match(/<main\b[^>]*>/);
  assert.ok(
    main,
    'FeedContainer no longer renders a `<main>`. The signed-in feed route is then a '
    + 'page with no main landmark, and the skip link lands on content that nothing '
    + 'identifies as the content.',
  );
  assert.match(
    main[0],
    /aria-label=\{landmark\.label\}/,
    'the feed `<main>` lost `aria-label={landmark.label}`, so the landmark goes back '
    + 'to being unnamed.',
  );
  assert.match(
    feed,
    /<h1 className="visually-hidden">\{landmark\.heading\}<\/h1>/,
    'the visually hidden `<h1>` inside the feed landmark is gone. The feed is a wall '
    + 'of h2 paper titles with no h1 above them, which leaves the heading outline '
    + 'starting at level 2 and gives the page no title in the heading list.',
  );
});

test('the feed landmark stays opt-in, or the guest route nests two <main> elements', async () => {
  const feed = await readSource(FEED_CONTAINER_JSX);

  assert.match(
    feed,
    /function FeedLandmark\(\{ landmark, children \}\) \{\s*if \(!landmark\) \{\s*return <div className="feed-wrapper">\{children\}<\/div>;/,
    'FeedLandmark no longer falls back to a plain `<div className="feed-wrapper">` '
    + 'when no `landmark` prop is passed. This branch is not defensive coding: '
    + 'GuestFeedPage renders its own `<main className="guest-feed-page">` around this '
    + 'component, so an unconditional `<main>` here puts one landmark inside the '
    + 'other on the public route — invalid HTML and two "main" regions. '
    + 'FollowingFeedPage has no landmark of its own yet and must not inherit the '
    + '"For you" heading, which is why the prop is opt-in rather than defaulted on.',
  );
  assert.match(
    feed,
    /export default function FeedContainer\([^)]*landmark = null[^)]*\)/,
    'the `landmark` prop lost its `null` default. Defaulting it to anything else '
    + 'turns the landmark on for every consumer, including the guest route that '
    + 'already has one.',
  );
});

// ── The focus ring, across every stylesheet ─────────────────────────────────

/**
 * The rules that switch the ring off on purpose, and what draws it instead.
 *
 * Two, not one — the inventory was checked rather than assumed. A new entry
 * here needs a real answer to "what does the user see instead", written down;
 * otherwise this list becomes the hole the test was built to close.
 */
const OUTLINE_OFF_ON_PURPOSE = new Map([
  [
    '.save-modal-tag-input:focus',
    'the input sits inside .save-modal-tag-editor, which draws a real 2px --focus-ring '
    + 'on :focus-within; keeping both painted two rings around one field',
  ],
  [
    '#main-content:focus',
    'not a control and never a tab stop — the skip link and RouteAnnouncer move focus '
    + 'here programmatically, and a ring drawn around the whole page region reads as a '
    + 'rendering bug rather than as focus',
  ],
]);

test('no stylesheet switches the focus ring off without a replacement', async () => {
  const offenders = [];

  for (const file of await stylesheets()) {
    const css = stripComments(await readFile(new URL(file, SRC_DIR), 'utf8'));
    const pattern = /outline\s*:\s*(?:none|0(?:px)?)\s*(?:!important)?\s*[;}]/gi;
    let match;
    while ((match = pattern.exec(css)) !== null) {
      const before = css.slice(0, match.index);
      const open = before.lastIndexOf('{');
      const previous = Math.max(before.lastIndexOf('}'), before.lastIndexOf('{', open - 1));
      const selector = before.slice(previous + 1, open).trim().replace(/\s+/g, ' ');
      if (OUTLINE_OFF_ON_PURPOSE.has(selector)) continue;
      offenders.push(`${file}: ${selector}`);
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    'a stylesheet turns the focus ring off on a control with nothing drawn in its '
    + 'place. This is the defect the whole focus-ring work of this delivery existed to '
    + 'close: component stylesheets are unlayered, so any `outline: none` in one of '
    + 'them beats the global `:focus-visible` rule in `styles/global.css` and the '
    + 'control simply stops showing focus (WCAG 2.4.7). If the ring really is drawn '
    + 'somewhere else, add the selector to OUTLINE_OFF_ON_PURPOSE above with the rule '
    + 'that draws it — the list is a record of decisions, not a mute button.',
  );
});

test('the focus ring is never painted in the brand orange again', async () => {
  const offenders = [];
  const outlineDeclaration = /outline(?:-color)?\s*:[^;}]*var\(\s*--brand-orange\s*\)/gi;

  for (const file of await stylesheets()) {
    const css = stripComments(await readFile(new URL(file, SRC_DIR), 'utf8'));
    if (outlineDeclaration.test(css)) offenders.push(file);
    outlineDeclaration.lastIndex = 0;
  }

  // The shared Button writes its ring as a Tailwind utility rather than a
  // declaration, so the same mistake hides in a different syntax here.
  const variants = await readSource(BUTTON_VARIANTS);
  if (/outline-\[var\(--brand-orange\)\]/.test(variants)) {
    offenders.push('components/ui/button-variants.js');
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    '--brand-orange is being used as a focus ring colour again. It is #ff9d00 in both '
    + 'themes, which is 2.08:1 against a white page — under half the 3:1 that WCAG '
    + '1.4.11 asks of a focus indicator. The ring is `var(--focus-ring)`, which is the '
    + 'one token that deliberately flips with the theme (#b45309 on paper, #ff9d00 on '
    + 'ink) so it clears 3:1 on both. --brand-orange stays the brand mark and is still '
    + 'legitimately a `color:` in ScientificReport.css and a `hover:border` on the '
    + 'shared Button — this only forbids it as an outline.',
  );
});
