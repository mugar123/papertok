import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLandingHtml } from './page.js';

/**
 * The landing's structural a11y net — source-level, in the style of
 * `src/accessibilityStructure.test.js`: read what the build actually
 * produces (or the source that produces it) and hold the parts a static
 * read CAN verify. It is not a substitute for the axe run
 * (`scripts/diagnostics/landing-axe.mjs`), the reflow/zoom probe, the
 * keyboard walkthrough or the AX-tree/screen-reader pass — see
 * `docs/ACCESIBILIDAD-EVIDENCIA.md`, "Landing (2026-09)", for what those
 * covered and what none of this does: computed contrast, real focus-ring
 * visibility, and what a screen reader actually announces.
 */

const html = buildLandingHtml();
const doc = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8');
const motionCss = readFileSync(fileURLToPath(new URL('./motion.css', import.meta.url)), 'utf8');
const shared = readFileSync(fileURLToPath(new URL('../legal/static-page.css', import.meta.url)), 'utf8');
const motionJsRaw = readFileSync(fileURLToPath(new URL('./motion.js', import.meta.url)), 'utf8');

/** CSS has no `//` comments; JS/JSX does — accessibilityStructure.test.js's
 * own reason applies here too: a comment that quotes the very markup an
 * assertion looks for would let the code lose what the comment still
 * promises, with the test still reading it out of the prose. */
const stripCssComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJsComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const cssNoComments = stripCssComments(css);
const motionCssNoComments = stripCssComments(motionCss);
const sharedNoComments = stripCssComments(shared);
const motionJs = stripJsComments(motionJsRaw);

// ── Language ─────────────────────────────────────────────────────────────

test('language is declared on the document and on the Spanish name inside it', () => {
  assert.match(
    doc,
    /<html lang="en">/,
    'index.html lost its document-level `lang`. Every word on the page — English by '
    + 'default — would be read by a screen reader in whatever language the user\'s own '
    + 'voice defaults to instead (WCAG 3.1.1).',
  );
  assert.match(
    html,
    /<span lang="es">Universidad de Salamanca<\/span>/,
    'the one Spanish proper name on an otherwise-English page ("Universidad de '
    + 'Salamanca", in the follow section\'s institution row) lost its `lang="es"` span. '
    + 'Without it a screen reader applies English pronunciation rules to Spanish words '
    + '(WCAG 3.1.2).',
  );
});

// ── Every interactive element is named ──────────────────────────────────────

test('every interactive element has an accessible name and no icon-only control goes unnamed', () => {
  const matches = [...html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
  assert.ok(matches.length > 10, 'the <a>/<button> scan found suspiciously few controls — check the regex still matches the built markup.');
  for (const m of matches) {
    const attrs = m[2];
    const inner = m[3].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    assert.ok(
      inner.length > 0 || /aria-label="[^"]+"/.test(attrs),
      `an interactive element has neither visible text nor an aria-label, so it has no `
      + `accessible name at all (WCAG 4.1.2, 2.4.4): ${m[0].slice(0, 100)}`,
    );
  }
});

// ── Every <svg> is decorative or a named image ──────────────────────────────

test('every svg is either decorative (aria-hidden) or an image with a title', () => {
  const svgs = [...html.matchAll(/<svg\b([^>]*)>/g)];
  assert.ok(svgs.length > 5, 'the <svg> scan found suspiciously few elements — check the regex still matches the built markup.');
  for (const m of svgs) {
    assert.ok(
      /aria-hidden="true"/.test(m[1]) || /role="img"/.test(m[1]),
      `an <svg> is neither aria-hidden nor role="img" — a screen reader will try to read `
      + `its raw path data as a generic graphic with no name (WCAG 1.1.1): ${m[0]}`,
    );
  }
});

test('the two citation-map plates are the only image svgs, and each has a matching title', () => {
  // graphMap.js: citationPlate() emits role="img" aria-labelledby="lp-map-title[-compact]"
  // with a <title id="lp-map-title[-compact]"> right inside — the wide plate and the
  // phone-width compact one, never both visible at once (landing.css), but both always
  // in the markup so a screen reader gets whichever one CSS shows.
  const imgSvgs = [...html.matchAll(/<svg\b[^>]*\brole="img"[^>]*>/g)];
  assert.equal(
    imgSvgs.length,
    2,
    'expected exactly two role="img" svgs (the wide and compact citation-map plates). '
    + 'A count drifting from 2 means either a plate lost its role or a new svg needs one.',
  );
  const referencedIds = new Set();
  for (const m of imgSvgs) {
    const idMatch = m[0].match(/aria-labelledby="([^"]+)"/);
    assert.ok(idMatch, `a role="img" svg has no aria-labelledby to name it: ${m[0]}`);
    const titleRe = new RegExp(`<title id="${idMatch[1]}">[^<]+</title>`);
    assert.match(
      html,
      titleRe,
      `the svg's aria-labelledby="${idMatch[1]}" points at a <title id="${idMatch[1]}"> `
      + 'that is missing, empty, or has a mismatched id — role="img" with a broken name '
      + 'reference reads to a screen reader as an unnamed image (WCAG 1.1.1).',
    );
    referencedIds.add(idMatch[1]);
  }
  assert.equal(
    referencedIds.size,
    imgSvgs.length,
    'two plates point at the SAME title id — one of them (almost certainly the compact, '
    + 'phone-width plate) silently inherited the other\'s name instead of describing '
    + 'itself. Each plate is a separately-composed picture (graphMap.js) and needs its '
    + 'own <title>, not a shared one.',
  );
});

// ── Focus ring never suppressed ─────────────────────────────────────────────

/**
 * Selectors allowed to switch the ring off, each with the reason nothing is
 * lost — the same discipline `src/accessibilityStructure.test.js` holds the
 * app's own two exceptions to (`OUTLINE_OFF_ON_PURPOSE`). A new entry here
 * needs a real "what does the user see instead", not a rubber stamp.
 */
const OUTLINE_OFF_ON_PURPOSE = new Map([
  [
    '#main-content.lp-main:focus',
    'not a control and never a tab stop — only the skip link\'s fragment '
    + 'navigation (page.js gives #main-content tabindex="-1") ever focuses it. '
    + 'Measured live: a 2px ring around a box taller than the viewport draws '
    + 'its top edge under the sticky bar and the rest below the fold — '
    + 'invisible, same reasoning as the app\'s own #main-content (App.jsx).',
  ],
]);

test('no focus outline is ever removed without a documented reason, anywhere in the landing\'s own styles or markup', () => {
  const haystack = [cssNoComments, motionCssNoComments, sharedNoComments].join('\n');
  const offenders = [];
  const pattern = /([^{}]+)\{[^}]*outline\s*:\s*(?:none|0)\b[^}]*\}/g;
  let m;
  while ((m = pattern.exec(haystack)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!OUTLINE_OFF_ON_PURPOSE.has(selector)) offenders.push(selector);
  }
  assert.deepEqual(
    offenders,
    [],
    'a landing stylesheet sets `outline: none` or `outline: 0` on a selector this test '
    + 'does not recognize. static-page.css\'s own `:focus-visible { outline: 2px solid '
    + 'var(--focus-ring); ... }` is the ONLY focus indicator every control on this page '
    + 'relies on (WCAG 2.4.7) — there is no second, component-level ring to fall back on '
    + 'the way the app\'s command palette has. If the ring really is drawn somewhere else, '
    + 'add the selector to OUTLINE_OFF_ON_PURPOSE above with the reason.',
  );
  assert.doesNotMatch(
    motionJs,
    /\.style\.outline\s*=|outlineStyle\s*=\s*['"`](?:none|0)/,
    'motion.js sets an inline outline style that could suppress the ring from script '
    + 'rather than CSS, where this scan (and the stylesheet one above) would not see it.',
  );
});

// ── Touch targets ────────────────────────────────────────────────────────

test('touch targets are 44px on phones: Skip, bar links, footer links, the two CTAs, and the reading-level tabs', () => {
  assert.match(sharedNoComments, /\.lp-bar__link \{[^}]*min-height: 44px/, 'the bar\'s "Source" link dropped below the 44px floor.');
  assert.match(sharedNoComments, /\.lp-footer a \{[^}]*min-height: 44px/, 'the footer links dropped below the 44px floor.');
  assert.match(cssNoComments, /\.lp-deck__skip \{[^}]*min-height: 44px/, 'the hero deck\'s Skip button dropped below the 44px floor.');
  assert.match(sharedNoComments, /\.lp-btn--lg \{[^}]*min-height: 52px/, 'the large CTA buttons ("Open the feed" ×2) dropped below their 52px floor.');
  assert.match(
    motionCssNoComments,
    /\.lp-levels__tab \{[^}]*min-height: 44px/,
    'the reading-level tabs (Beginner/University/Expert) dropped below the 44px floor — '
    + 'these are real, always-reachable <button>s (only `disabled`, never removed from '
    + 'the tab order), so WCAG 2.5.8 applies to them like any other control.',
  );
});

// ── Decorative UI figures ────────────────────────────────────────────────

test('the UI figures hide their fake controls from assistive tech and describe themselves in one sentence', () => {
  assert.equal((html.match(/<figure class="lp-figure-ui">/g) || []).length, 2, 'expected exactly two `.lp-figure-ui` figures (Follow, Library).');
  assert.equal((html.match(/<figcaption class="lp-visually-hidden">/g) || []).length, 3, 'expected exactly three visually-hidden figcaptions (Follow, Library, Research).');
  const figures = [...html.matchAll(/<figure class="lp-(?:figure-ui|window)">[\s\S]*?<\/figure>/g)];
  assert.equal(figures.length, 3, 'expected three figures total (two `.lp-figure-ui` plus the Research `.lp-window`).');
  for (const m of figures) {
    // Specifically the element right after the figcaption — not merely "some
    // aria-hidden appears anywhere in the figure", which every decorative
    // icon() svg already satisfies on its own and would let the WRAPPER'S
    // own aria-hidden go missing without this test noticing.
    assert.match(
      m[0],
      /<\/figcaption>\s*<(?:div|svg)\b[^>]*\baria-hidden="true"/,
      `a UI figure's own content wrapper (the element right after its figcaption) lost `
      + `aria-hidden — nothing in it is real, operable UI (no session backs it on this `
      + `page), so a screen reader must not be told it is: ${m[0].slice(0, 60)}…`,
    );
    assert.doesNotMatch(
      m[0],
      /<button|<a /,
      `a UI figure contains a real <button> or <a> that a keyboard could reach and that `
      + `would do nothing when activated — the dead-control rule this whole page holds `
      + `everything else to: ${m[0].slice(0, 60)}…`,
    );
  }
});

// ── Heading order ────────────────────────────────────────────────────────

test('heading levels never skip: h1, then each level increases by at most one', () => {
  // h1..h6, not just h1..h3 — the brief's own list stopped at h3, which would have
  // silently ignored the eleven <h4> briefs inside the Research forme (brief(), page.js)
  // and never noticed if one of them jumped to h5 with nothing in between.
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.ok(levels.length > 10, 'the heading scan found suspiciously few headings — check the regex still matches the built markup.');
  assert.equal(levels[0], 1, `the page must open on an <h1>; found h${levels[0]} first.`);
  let last = 0;
  for (const l of levels) {
    assert.ok(l <= last + 1, `an <h${l}> follows an <h${last}> with nothing in between — a jump a screen reader's heading rotor would present as a gap in the outline (WCAG 1.3.1).`);
    last = l;
  }
});

// ── tabindex and id hygiene ──────────────────────────────────────────────

test('no element carries a positive tabindex', () => {
  const offenders = [...html.matchAll(/tabindex="(\d+)"/g)].filter((m) => Number(m[1]) > 0);
  assert.deepEqual(
    offenders.map((m) => m[0]),
    [],
    'a positive tabindex reorders the whole page\'s tab sequence around one element, '
    + 'independent of where it sits in the DOM or on screen — the tab order stops '
    + 'matching the visual and reading order (WCAG 2.4.3). `tabindex="0"`/`"-1"` are fine; '
    + 'only tabindex="1" and up are banned.',
  );
});

test('no id is rendered twice', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) { if (seen.has(id)) dupes.add(id); else seen.add(id); }
  assert.deepEqual(
    [...dupes],
    [],
    'a duplicate id breaks every aria-labelledby/aria-controls/aria-describedby that '
    + 'points at it — the browser resolves the reference to whichever element happens '
    + 'to come first, silently, which is exactly how the map\'s titles and the reader\'s '
    + 'tabs/panels are wired (WCAG 4.1.2).',
  );
});

// ── Decisions already made, that a "cleanup" could quietly undo ────────────
// The CONTEXT for this task names these explicitly as decisions not to
// reverse without saying so. They cost nothing to hold as structural
// assertions, and they are exactly the kind of thing a well-meaning
// refactor removes without realising it was accessibility-load-bearing.

test('the hero deck ships slide 1 visible and slides 2/3 hidden, aria-hidden and inert before any script runs', () => {
  const slides = [...html.matchAll(/<div class="lp-hero__slide"[^>]*>/g)];
  assert.equal(slides.length, 3, 'expected exactly three hero slides (HERO_PAPERS).');
  assert.doesNotMatch(
    slides[0][0],
    /hidden|aria-hidden|inert/,
    'the first hero slide must render openly with no JavaScript: it is the one paper a '
    + 'no-JS visit reads.',
  );
  for (const slide of slides.slice(1)) {
    assert.match(
      slide[0],
      /\bhidden\b/,
      'a non-first hero slide lost `hidden` — without it a no-JS visit shows a three-tall '
      + 'stack of papers instead of one sheet.',
    );
    assert.match(
      slide[0],
      /aria-hidden="true"/,
      'a non-first hero slide lost `aria-hidden="true"` — even where `hidden` alone would '
      + 'hide it visually, a keyboard/AT user could still reach text no sighted visitor '
      + 'sees (WCAG 1.3.1/4.1.2), until motion.js\'s armDeck() takes over.',
    );
    assert.match(
      slide[0],
      /\binert\b/,
      'a non-first hero slide lost `inert` — its links/buttons would stay in the tab '
      + 'order while invisible.',
    );
  }
});

test('the deck\'s Skip button and its foot ship hidden pre-JS, so a no-JS visit has nothing dead to reach', () => {
  assert.match(
    html,
    /<div class="lp-deck__foot" hidden>/,
    'the deck foot (Skip button + count) lost its pre-JS `hidden`. armDeck() is what '
    + 'wires Skip to actually move the deck; before it runs, a visible Skip button would '
    + 'be a focusable control that does nothing on click or Enter.',
  );
  assert.match(
    html,
    /<button class="lp-deck__skip"[^>]*\bhidden\b[^>]*>/,
    'the Skip button itself lost its pre-JS `hidden` attribute.',
  );
});

test('the sheet carries no tabindex/role/carousel semantics until armDeck() adds them together', () => {
  const sheetTag = html.match(/<div class="lp-sheet" data-deck>/);
  assert.ok(
    sheetTag,
    'the sheet\'s opening tag no longer matches `<div class="lp-sheet" data-deck>` — '
    + 'check whether it now ships tabindex/role in the prerendered markup, which is '
    + 'exactly what this test exists to catch.',
  );
});

test('armDeck() arms the sheet\'s tabindex, role, roledescription and label together with .is-armed', () => {
  // Atomic on purpose (motion.js's own comment on armDeck): none of this may be true a
  // moment before the keydown handler is actually listening, or a keyboard could reach a
  // control announcing itself as an operable carousel with no operation bound yet.
  assert.match(
    motionJs,
    /sheet\.setAttribute\('tabindex', '0'\);\s*\n\s*sheet\.setAttribute\('role', 'group'\);\s*\n\s*sheet\.setAttribute\('aria-roledescription', 'carousel'\);\s*\n\s*sheet\.setAttribute\('aria-label', '[^']+'\);\s*\n\s*sheet\.classList\.add\('is-armed'\);/,
    'armDeck() no longer sets tabindex, role, aria-roledescription, aria-label and '
    + '.is-armed as one contiguous, unconditional block at the end of arming. Splitting '
    + 'them (an early tabindex, a role added later, etc.) reopens the window where a '
    + 'keyboard can tab into a control that either does nothing yet or is announced as an '
    + 'operable carousel before it is one.',
  );
});

test('the three reading-level tabs ship disabled before any script runs', () => {
  const tabs = [...html.matchAll(/<button class="lp-levels__tab"[^>]*>/g)];
  assert.equal(tabs.length, 3, 'expected exactly three reading-level tabs (LEVELS).');
  for (const tab of tabs) {
    assert.match(
      tab[0],
      /\bdisabled\b/,
      'a reading-level tab lost its pre-JS `disabled`. Without a script there is no click '
      + 'or keydown handler behind these buttons yet, and an enabled control that does '
      + 'nothing on press is exactly the dead control this page may not ship.',
    );
  }
});

test('armLevels enables the tabs the moment their handlers actually exist', () => {
  assert.match(
    motionJs,
    /tab\.disabled = false;/,
    'armLevels() no longer clears `disabled` on the tabs once their click/keydown '
    + 'handlers are wired — without this line the pre-JS `disabled` above never comes '
    + 'off and the tabs stay dead forever, even with JavaScript running.',
  );
});

test('the picker wheel is aria-hidden, with a real, complete list of its papers beside it', () => {
  assert.match(
    html,
    /<div class="lp-pile" aria-hidden="true">/,
    'the wheel lost `aria-hidden="true"`. Thirteen slots cycling through twenty-five '
    + 'papers, some mid-turn, is not a list a screen reader could make sense of.',
  );
  assert.match(
    html,
    /<ul class="lp-visually-hidden" id="lp-pile-list">/,
    'the wheel\'s companion list (the actual, static list of every paper, in reading '
    + 'order) is gone — without it aria-hidden on the wheel leaves that content with no '
    + 'accessible equivalent at all.',
  );
  const listMatch = html.match(/<ul class="lp-visually-hidden" id="lp-pile-list">([\s\S]*?)<\/ul>/);
  assert.ok(listMatch, 'could not find the wheel\'s companion list to count its items.');
  const items = [...listMatch[1].matchAll(/<li>/g)];
  assert.ok(items.length >= 20, `expected the wheel's companion list to carry the full paper set (25); found ${items.length}.`);
});

test('reduced motion turns off the deck transition, the rewrite sequence and the map draw-on', () => {
  const reducedBlockMatch = motionCssNoComments.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\n\}/);
  assert.ok(reducedBlockMatch, 'motion.css lost its `@media (prefers-reduced-motion: reduce)` block entirely (WCAG 2.3.3).');
  const reducedBlock = reducedBlockMatch[0];
  assert.match(reducedBlock, /\.lp-deck__reel \{ transition: none !important; \}/, 'reduced motion no longer disables the hero deck\'s slide transition.');
  assert.match(reducedBlock, /\.lp-rewrite,\s*\n\s*\.lp-rewrite \*,\s*\n\s*\.lp-spark \{ animation: none !important; \}/, 'reduced motion no longer disables every animation inside the rewrite sequence.');
  assert.match(reducedBlock, /\.mp-spoke,\s*\n\s*\.mp-node,\s*\n\s*\.mp-label \{ animation: none !important; \}/, 'reduced motion no longer disables the citation map\'s draw-on animation.');
});

// ── Regression tests for defects this task's own testing found ─────────────
// Not axe — axe-core's static DOM read cannot see any of the three below (a
// dynamic focus move, a colour pairing that reads fine structurally, a
// second colour pairing likewise). Found by actually driving Chrome with a
// keyboard and reading document.activeElement — see
// docs/ACCESIBILIDAD-EVIDENCIA.md, "Landing (2026-09)", for the reproduction.

test('the skip link\'s target is actually focusable (defect: skip link changed the URL but never moved focus)', () => {
  assert.match(
    html,
    /<main id="main-content" class="lp-main" tabindex="-1">/,
    'main-content lost its tabindex="-1". Without it, activating the skip link scrolls '
    + 'the page (the URL hash changes) but the browser falls back to focusing <body> — '
    + 'confirmed live: document.activeElement stayed BODY after a real click on the '
    + 'focused skip link. A keyboard user "skips" nothing a screen reader or Tab can act '
    + 'on (WCAG 2.4.1). The app\'s own #main-content (App.jsx) carries the same attribute '
    + 'for the same reason.',
  );
});

test('the avatar initials use a token that actually clears 4.5:1 (defect: axe measured 4.39:1)', () => {
  assert.match(
    cssNoComments,
    /\.lp-avatar \{[^}]*color: var\(--text-secondary\);/,
    'the avatar initials (the small "BA"/"RA"/"TA" badges) no longer use '
    + '--text-secondary. axe-core (landing-axe.mjs) measured the previous '
    + '--text-tertiary-on---tint-neutral-bg pairing at 4.39:1 against the 4.5:1 WCAG '
    + '1.4.3 floor, in all three configurations. These are aria-hidden (decorative, '
    + 'redundant with the real byline text beside them) but 1.4.3 is about what a '
    + 'sighted low-vision reader can perceive, not about screen-reader exposure, so '
    + 'aria-hidden does not exempt them.',
  );
  assert.doesNotMatch(
    cssNoComments,
    /\.lp-avatar \{[^}]*color: var\(--text-tertiary\);/,
    'the avatar initials still also carry the old, insufficient --text-tertiary colour.',
  );
});

test('the rewrite sequence hands focus to the reader instead of dropping it to <body> (defect found live)', () => {
  assert.match(
    html,
    /<p class="lp-rewrite__status" tabindex="-1">/,
    'the reader\'s status line lost tabindex="-1" — armRewrite (motion.js) needs a '
    + 'focusable, ALWAYS-VISIBLE-throughout-the-sequence element to hand focus to; '
    + 'without this attribute .focus() on it is a silent no-op.',
  );
  assert.match(
    motionJs,
    /var loseFocusToBody = open && card\.contains\(document\.activeElement\);/,
    'armRewrite() no longer captures whether focus is inside the card before '
    + 'card.inert flips it. Confirmed live: ~140ms after pressing "Read in plain '
    + 'words" (the idle→source transition), card.inert = true used to blur the '
    + 'button straight to <body> with no visible ring anywhere for the rest of the '
    + '~3.3s sequence, and a keyboard user would have had to Tab from the very top '
    + 'of the page again to reach the reader that just opened in front of them.',
  );
  assert.match(
    motionJs,
    /if \(loseFocusToBody\) \{\s*\n\s*var status = root\.querySelector\('\.lp-rewrite__status'\);\s*\n\s*if \(status\) status\.focus\(\);\s*\n\s*\}/,
    'armRewrite() no longer moves focus to .lp-rewrite__status once the card goes '
    + 'inert. Verified live (real Tab to the button, then activate): '
    + 'document.activeElement lands on the status line with a visible '
    + ':focus-visible ring, and Tab from there reaches the reading-level tabs next.',
  );
});
