import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLandingHtml } from './page.js';
import { PILE } from './papers.js';

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

// ── Every interactive element is named, and the name doesn't fight the label ─

/** Case/whitespace-insensitive, matching how axe-core's own
 * label-content-name-mismatch rule and a speech-input engine both normalize
 * before comparing — this is deliberately looser than a raw string compare,
 * or "Read in plain words." (trailing period, a hypothetical) would fail a
 * containment check it should pass. */
const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

test('every interactive element has an accessible name, and an aria-label never fights the visible text (WCAG 4.1.2, 2.4.4, 2.5.3)', () => {
  const matches = [...html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
  assert.ok(matches.length > 10, 'the <a>/<button> scan found suspiciously few controls — check the regex still matches the built markup.');
  for (const m of matches) {
    const attrs = m[2];
    const inner = m[3].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    const ariaLabel = attrs.match(/aria-label="([^"]+)"/);
    assert.ok(
      inner.length > 0 || ariaLabel,
      `an interactive element has neither visible text nor an aria-label, so it has no `
      + `accessible name at all (WCAG 4.1.2, 2.4.4): ${m[0].slice(0, 100)}`,
    );
    // WCAG 2.5.3 Label in Name: when a control has BOTH visible text and an
    // aria-label, the aria-label (the accessible name) must CONTAIN the
    // visible text — not merely exist. A speech-input user says the visible
    // label out loud ("click Read in plain words"); if the accessible name
    // is a different string that happens not to contain it as a substring,
    // that command has nothing to match against. This does not fire for an
    // icon-only control (no visible text at all) — 2.5.3 has nothing to
    // compare an aria-label against there, and that case is legitimate.
    if (inner.length > 0 && ariaLabel) {
      assert.ok(
        normalize(ariaLabel[1]).includes(normalize(inner)),
        `WCAG 2.5.3 Label in Name: the accessible name (aria-label="${ariaLabel[1]}") does not `
        + `contain the visible text ("${inner}") as a substring — someone using speech input `
        + `who says the visible label cannot activate this control: ${m[0].slice(0, 100)}`,
      );
    }
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
  // Every shape that suppresses the ring, not just the bare `outline: none`
  // form — `outline: 0`/`0px`, `outline-style: none`, `outline-width: 0`,
  // and `outline-color: transparent` (a fully transparent ring is exactly as
  // invisible as no ring) all switch it off just as effectively, and none of
  // them mention "none" for a `/outline\s*:\s*(?:none|0)\b/`-shaped pattern
  // to catch. `outline-offset` is deliberately NOT matched: offset 0 does
  // not hide anything.
  const pattern = /([^{}]+)\{[^}]*\b(?:outline(?:-style)?\s*:\s*(?:none|0(?:px)?)\b|outline-width\s*:\s*0(?:px)?\b|outline-color\s*:\s*transparent\b)[^}]*\}/g;
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

/** The full body of a named function, brace-balanced — not "the rest of the
 * file", which a single-`}` search would grab and which would make a call
 * ANYWHERE after the function's own closing brace look like it were still
 * inside it. */
function functionBody(source, signature) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, `could not find "${signature}" in motion.js — has init() been renamed or restructured?`);
  const open = source.indexOf('{', at);
  assert.notEqual(open, -1, `found "${signature}" but no opening brace after it.`);
  let depth = 0;
  let i = open;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  assert.ok(depth === 0 && i < source.length, `"${signature}"'s opening brace never closes — unbalanced braces in motion.js?`);
  return source.slice(open + 1, i);
}

test('init() arms the tabs and the deck BEFORE the data-motion gate, not merely somewhere in the file', () => {
  // The previous version of this file only checked that `tab.disabled =
  // false;` existed SOMEWHERE in motion.js — true even if armLevels(rewrite)
  // were moved below the `data-motion` gate below, which would leave every
  // reading-level tab `disabled` forever on a phone or under reduced motion
  // (the gate never opens there) while this assertion stayed green. Same
  // hole for the unconditional armDeck() call, which is what un-hides the
  // deck's Skip button — the phone's only control over the hero deck. This
  // reads init()'s own body and asserts the two calls sit BEFORE the gate
  // line in source order, which is also execution order here: nothing
  // between the top of the function and the gate can return early on its
  // own (no other conditional wraps either call).
  const body = functionBody(motionJs, 'export function init() {');
  const armLevelsAt = body.indexOf('armLevels(rewrite)');
  const armDeckAt = body.indexOf('armDeck();');
  const gateAt = body.indexOf("data-motion') !== 'on' || !shouldAnimate()) return;");
  assert.notEqual(armLevelsAt, -1, 'init() no longer calls armLevels(rewrite) at all.');
  assert.notEqual(armDeckAt, -1, 'init() no longer calls armDeck() at all.');
  assert.notEqual(gateAt, -1, 'init() no longer has the data-motion/shouldAnimate() early-return gate this test locates the two calls against.');
  assert.ok(
    armLevelsAt < gateAt,
    'armLevels(rewrite) is called AFTER the data-motion gate instead of before it — on a '
    + 'phone, under reduced motion, or on any visit the gate never opens for, the tabs '
    + 'would stay `disabled` forever (armRewrite, which is what re-enables them once the '
    + 'sequence finishes, is itself behind the same gate and would also never run).',
  );
  assert.ok(
    armDeckAt < gateAt,
    'armDeck() is called AFTER the data-motion gate instead of before it — on a phone, '
    + 'under reduced motion, or on any visit the gate never opens for, the deck\'s Skip '
    + 'button would stay `hidden` forever (page.js\'s own no-JS fallback), leaving the '
    + 'hero deck with no control at all on the one class of visit this page promises it '
    + 'to.',
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
  // Derived from PILE itself, not a hardcoded "25" — a hand-typed number
  // would happily let PILE grow or shrink by a few rows and never notice
  // that the wheel's only accessible equivalent silently dropped some of
  // them (`>= 20` used to let up to 5 vanish without failing).
  assert.equal(
    items.length,
    PILE.length,
    `expected the wheel's companion list to carry the full paper set (PILE.length === `
    + `${PILE.length}); found ${items.length}.`,
  );
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
    /var status = root\.querySelector\('\.lp-rewrite__status'\);\s*\n\s*if \(loseFocusToBody && status\) \{\s*\n[\s\S]*?status\.focus\(\{ preventScroll: true \}\);\s*\n\s*status\.scrollIntoView\(\{ block: 'nearest' \}\);\s*\n\s*\}/,
    'armRewrite() no longer moves focus to .lp-rewrite__status once the card goes '
    + 'inert, or lost the explicit scrollIntoView() call (fix round 1 — WCAG 2.4.11). '
    + 'Verified live (real Tab to the button, then activate), at 1440x900: '
    + 'document.activeElement lands on the status line; `.focus()` alone landed it at '
    + 'viewport y=44, 12px INSIDE the sticky bar\'s 56px, despite '
    + '`scroll-padding-top: var(--nav-height)` being set — `.focus()`\'s own implicit '
    + 'scroll and scrollIntoView() are not the same algorithm in this engine, and only '
    + 'the explicit scrollIntoView({ block: \'nearest\' }) call respects the padding, '
    + 'landing it at exactly y=56.',
  );
  assert.match(
    motionJs,
    /if \(phase === 'done' && status && document\.activeElement === status\) \{\s*\n\s*status\.scrollIntoView\(\{ block: 'nearest' \}\);\s*\n\s*\}/,
    'armRewrite() no longer re-corrects the scroll position at the \'done\' phase. '
    + 'Verified live: the FIRST correction above (fired at the idle→source transition, '
    + '~140ms in, the only moment card.contains(document.activeElement) can still be '
    + 'tested) gets silently undone by the time the sequence actually finishes — '
    + 'measured back at y=44 under the bar by \'done\', with nothing else in this file '
    + 'touching scroll position in between (scroll anchoring reacting to the grid '
    + 'cell\'s own height changing as the card fades and the reader/ghost/passage swap '
    + 'is the likely cause). Only re-asserting the position once more, after everything '
    + 'has finished animating, actually holds — confirmed live back at y=56.',
  );
});

// ── Fix round 1 (code review) ────────────────────────────────────────────

test('the "Read in plain words" button has no aria-label fighting its visible text (WCAG 2.5.3, defect found by axe)', () => {
  assert.doesNotMatch(
    html,
    /data-rewrite-start aria-label="Read this paper in plain words"/,
    'the rewrite trigger button carries `aria-label="Read this paper in plain words"` '
    + 'again. Its accessible name (the aria-label) does not CONTAIN its visible text '
    + '("Read in plain words") as a substring — "Read this paper in plain words" has '
    + '"this paper" inserted in the middle, breaking the match. axe-core\'s '
    + '`label-content-name-mismatch` rule (enabled explicitly in landing-axe.mjs — it '
    + 'is tagged `experimental` and excluded by tag-only `runOnly`) flags this: someone '
    + 'using speech input who says "click Read in plain words" has no accessible name '
    + 'containing that phrase to match against. The visible text alone is already a '
    + 'perfectly good accessible name; no aria-label is needed here at all.',
  );
  assert.match(
    html,
    /<button class="lp-btn lp-btn--ai lp-btn--lg" type="button" data-rewrite-start>/,
    'the rewrite trigger button\'s opening tag changed shape unexpectedly — expected no '
    + 'aria-label attribute on it at all.',
  );
});

test('scroll-padding-top keeps the sticky bar from covering a freshly-scrolled-to focus target (WCAG 2.4.11)', () => {
  assert.match(
    sharedNoComments,
    /html \{ scroll-padding-top: var\(--nav-height\); \}/,
    '`html` lost its `scroll-padding-top: var(--nav-height)`. `.lp-bar` is `position: '
    + 'sticky; top: 0` with an opaque background on every static page that imports this '
    + 'stylesheet — once stuck it sits over whatever scrolls underneath it. Without '
    + 'scroll-padding reserving room for it, the browser\'s own "scroll the newly-focused '
    + 'element into view" can stop with the element\'s top edge merely at y=0 — still '
    + 'UNDER the bar, not below it. Verified live (Chrome, real Tab, 390 and 1440): see '
    + '`docs/ACCESIBILIDAD-EVIDENCIA.md`, "Landing (2026-09)", the 2.4.11 row.',
  );
});
