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
const COMMAND_JSX = new URL('./components/ui/command.jsx', import.meta.url);
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
  const openingTagAt = navbar.lastIndexOf('<NavLink', forYouAt);
  assert.notEqual(
    openingTagAt,
    -1,
    'the "For you" label is no longer inside a <NavLink>. It was a <button> that called '
    + 'navigate("/") and wrote its own aria-current until 2026-09-05; as a NavLink — like '
    + 'the other two tabs — React Router sets aria-current="page" on the active one '
    + 'itself (verified in react-router 7.18: NavLink defaults `"aria-current": '
    + 'ariaCurrentProp = "page"`). Turned back into a <button> or a plain <a>, nothing '
    + 'announces which feed you are on and the current tab is communicated by appearance '
    + 'alone (WCAG 1.3.1).',
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

// ── The focus ring, across every CSS stylesheet ─────────────────────────────

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
  [
    "input:not([type='checkbox']):not([type='radio']):not([type='range']):focus-visible, "
    + "textarea:focus-visible, [contenteditable='true']:focus-visible",
    'the same rule that removes the outline draws the replacement in the next two '
    + 'declarations: border to ink plus an inset ink hairline, visible on every '
    + 'surface. Text fields match :focus-visible even on a mouse click (typing is '
    + 'assumed to follow), so the ring boxed every clicked search field; the ink '
    + 'border is the same indicator for keyboard and mouse (2026-08-29)',
  ],
]);

test('no .css stylesheet switches the focus ring off without a replacement', async () => {
  // Scope, stated plainly: this only reads files under src/ whose name ends
  // in `.css` (see `stylesheets()` above). It cannot see an `outline-none`
  // written as a Tailwind utility class inside a JSX `className`/`cn(...)`
  // call — that string never touches a stylesheet. One exists today, on the
  // search palette's field in `src/components/ui/command.jsx`, and it was
  // measured in the browser rather than reasoned about: it costs the user no
  // ring. (The palette's rows carried a second one until the selected-row ring
  // went in; see that test above for why it could not stay.) Whether the field
  // keeping its ring is luck or design is the subject of the two tests at the
  // bottom of this file, and the answer is short enough to repeat here — the
  // global `:focus-visible` is unlayered, so it outranks anything Tailwind
  // puts in `@layer utilities`.
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

// ── The palette's selected row: a state shown in colour alone ───────────────

/**
 * The selected-row mark. It tells a keyboard user where they are in the
 * palette, and it has had three shapes: a tint alone (measured at 1.04:1 on
 * ink and 1.07:1 on paper — invisible against the 3:1 WCAG 1.4.11 asks of
 * state indicators), then a 2px ring of `var(--focus-ring)`, and now a 3px
 * inset bar down the row's left edge in the same token. The ring went because
 * the search field draws its own focus box directly above the list, and two
 * boxes at once read as noise, not as "you are here" (user feedback,
 * 2026-08-29). The bar is the app's ruled-row vocabulary, drawn as an inset
 * shadow so the row's box never changes size; the token stays `--focus-ring`
 * because it is the one whose job is this mark and whose value holds 3:1 on
 * every surface in both themes (contrast.test.js measures it).
 *
 * The tint stays. It is not the indicator, but it is what makes the row read
 * as a single object rather than as a barred gap.
 */

test('the palette marks its selected row with the inset bar, not only a tint', async () => {
  const command = await readSource(COMMAND_JSX);

  const item = command.match(/function CommandItem\(\{[\s\S]*?\n\}/);
  assert.ok(
    item,
    'components/ui/command.jsx no longer defines CommandItem. It is the only place '
    + 'the search palette styles a result row, so whatever replaced it now owns the '
    + 'selected-row indicator this test is about.',
  );

  // Cut at the string-literal boundaries too: these utilities live inside
  // quoted arguments to `cn(...)`, so a bare `\S+` swallows the closing
  // quote and comma of whichever one ends its line.
  const utilities = (item[0].match(/data-\[selected=true\]:[^\s'"\x60,]+/g) ?? []).join(' ');

  assert.match(
    utilities,
    /data-\[selected=true\]:shadow-\[inset_3px_0_0_var\(--focus-ring\)\]/,
    'the selected row no longer draws its inset `var(--focus-ring)` bar. Whatever is '
    + 'left is a background change on its own, and the two backgrounds involved '
    + '(--bg-secondary over --bg-card) are 1.04:1 apart on ink and 1.07:1 on paper: '
    + 'the row the arrows are on becomes indistinguishable from the rows they are '
    + 'not on (WCAG 1.4.11). --focus-ring is the token to use because it is the one '
    + 'whose job is "you are here" and whose value clears 3:1 on both themes.',
  );
  assert.match(
    utilities,
    /data-\[selected=true\]:bg-secondary/,
    'the selected row lost its tint. The bar alone marks the edge, but the tint is '
    + 'what makes the whole row read as one selected object instead of a stray rule '
    + 'floating in the list.',
  );
});

// ── The one rule that makes every `outline-none` in the tree harmless ───────

/**
 * The scan above reads stylesheets, and a review pointed out what it therefore
 * cannot see: `components/ui/command.jsx` carries a Tailwind `outline-none` on
 * the search palette's field, and no `.css` file mentions it. The palette is
 * real and reachable — `App.jsx` mounts `SearchCommand` for every signed-in
 * user and `/` opens it.
 *
 * Measured in the browser, signed in, with the palette open (originally with
 * the ring; since 2026-08-29 the field's indicator is the text-field rule in
 * global.css — border to ink plus an inset hairline — same unlayered scope,
 * higher specificity than the bare `:focus-visible`):
 *
 *   - the field, `outline-none` and all, matches `:focus-visible` and shows a
 *     visible indicator either way: while the bare ring rule was the only one
 *     it computed `outline: solid 2px` in the ring token, and under the
 *     text-field rule it shows the ink border instead. The `outline-none`
 *     utility stays harmless in both worlds for the same layering reason.
 *   - the rows never take DOM focus at all. cmdk gives them `role="option"`
 *     and `tabIndex -1` and keeps `document.activeElement` on the field,
 *     moving `aria-activedescendant` as the arrows walk the list. That is why
 *     the `outline-none` they used to carry hid nothing — and why the mark
 *     that now identifies the selected row is hung off `[data-selected=true]`
 *     rather than off focus.
 *
 * The field keeps its ring for one reason only: `.outline-none` is generated
 * into `@layer utilities`, the global `:focus-visible` is not in any layer at
 * all, and unlayered CSS outranks every layer regardless of specificity. That
 * is a property of ONE rule's position in ONE file, and moving it back inside
 * `@layer base` — where it used to live — would silently switch the ring off
 * again on every Tailwind primitive at once, with every assertion above still
 * green.
 *
 * So this holds the position, not the occurrences. An inventory of bare
 * `outline-none` classes would be the wrong net: while the rule below stays
 * unlayered none of them can do harm, and the next shadcn primitive to arrive
 * with one in its class list would fail the build for nothing.
 */

const GLOBAL_CSS = new URL('./styles/global.css', import.meta.url);

/** The block selectors and at-rule preludes open at `index`, outermost first. */
function enclosingBlocks(css, index) {
  const stack = [];
  for (let i = 0; i < index; i += 1) {
    if (css[i] === '{') {
      const before = css.slice(0, i);
      const start = Math.max(before.lastIndexOf('{'), before.lastIndexOf('}')) + 1;
      stack.push(before.slice(start).trim().replace(/\s+/g, ' '));
    } else if (css[i] === '}') {
      stack.pop();
    }
  }
  return stack;
}

test('the global focus ring stays outside every cascade layer', async () => {
  const css = stripComments(await readFile(GLOBAL_CSS, 'utf8'));

  const rule = css.match(/^:focus-visible\s*\{[^}]*\}/m);
  assert.ok(
    rule,
    'global.css no longer has a top-level `:focus-visible` rule. It is the only '
    + 'thing drawing a focus ring on the shadcn/ui primitives, none of which have a '
    + 'stylesheet of their own.',
  );
  assert.match(
    rule[0],
    /outline:\s*2px\s+solid\s+var\(--focus-ring\)/,
    'the global `:focus-visible` no longer paints `2px solid var(--focus-ring)`.',
  );

  const layers = enclosingBlocks(css, css.indexOf(rule[0])).filter(b => b.startsWith('@layer'));
  assert.deepEqual(
    layers,
    [],
    'the global `:focus-visible` rule has been moved back inside a cascade layer. '
    + 'Tailwind generates `.outline-none` into `@layer utilities`, and a layered rule '
    + 'loses to a later layer however specific it is — so from inside `@layer base` '
    + 'this rule stops drawing a ring on every element carrying `outline-none`, which '
    + 'today includes the search palette\'s field (`components/ui/command.jsx`). '
    + 'Nothing about that failure is visible in a stylesheet: the class list, the '
    + 'rule and its colour all still read correctly (WCAG 2.4.7).',
  );
});

/** Every `.js`/`.jsx` under src/ except the tests, path-relative. */
async function sources() {
  const entries = await readdir(SRC_DIR, { recursive: true });
  return entries.filter(name => /\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name)).sort();
}

/**
 * What a component can still do that the rule above cannot outrank. Both beat
 * unlayered author CSS: `!important` inverts the layer order, which puts the
 * unlayered rule LAST rather than first, and an inline style outranks the whole
 * author stylesheet. These are the two shapes worth failing a build over — and
 * the reason they are searched for in `.js`/`.jsx` is that neither leaves a
 * trace in any `.css` file for the scan above to find.
 */
const RING_KILLERS = [
  {
    what: 'a Tailwind !important outline utility',
    pattern: /(?:[\w-]+:)*(?:!outline-(?:none|hidden|0)|outline-(?:none|hidden|0)!)/g,
  },
  {
    what: 'an inline style that removes the outline',
    pattern: /\boutline(?:Style|Width)?\s*:\s*(['"`]?)(?:none|0(?:px)?)\1\s*[,}]/g,
  },
];

test('no component outranks the global focus ring from JSX', async () => {
  const offenders = [];

  for (const file of await sources()) {
    const source = stripComments(await readFile(new URL(file, SRC_DIR), 'utf8'));
    for (const { what, pattern } of RING_KILLERS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        offenders.push(`${file}: ${what} (${match[0]})`);
      }
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    'a component switches the focus ring off in a way the global `:focus-visible` in '
    + '`styles/global.css` cannot win against. A plain `outline-none` is harmless — it '
    + 'is a normal declaration in `@layer utilities` and the unlayered global rule '
    + 'beats it — but `!important` flips the layer order in its favour and an inline '
    + '`style` sits above the author stylesheet entirely. Either one leaves the control '
    + 'with no visible focus (WCAG 2.4.7) and nothing in any stylesheet to show for it. '
    + 'Draw the replacement ring first, then say here why the suppression is needed.',
  );
});
