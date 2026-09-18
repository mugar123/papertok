import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLandingHtml, assertSafeToken } from './page.js';

const html = buildLandingHtml();
const css = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const staticCss = readFileSync(fileURLToPath(new URL('../legal/static-page.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const motionCss = readFileSync(fileURLToPath(new URL('./motion.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// landing.css only `@import`s motion.css and static-page.css — a plain read
// of its text never inlines them, so a test that checks `css` alone is blind
// to whatever those two (owned by tasks 7 and 10) add. Every test that
// scans for something forbidden anywhere in the landing's CSS reads this.
const allCss = `${css}\n${staticCss}\n${motionCss}`;
const sections = [...html.matchAll(/<section class="([^"]*)"/g)].map((m) => m[1].split(' ')[0]);

/** Removes every `@keyframes name { ... }` block, brace-balanced. A naive
 * non-greedy `@keyframes[^{]*\{[\s\S]*?\}` stops at the first `}` — a per-step
 * block's OWN close, not the whole rule's — which is exactly the shape of
 * mistake that let a keyframe's step selector (`38%`) read as if it were a
 * CSS selector sharing the page with `.lp-hero`. Depth-counted, the same
 * technique keyframeContrast.test.js uses to walk keyframes, aimed here at
 * deleting them instead of collecting them. */
function stripKeyframes(source) {
  const re = /@keyframes\s+[A-Za-z0-9_-]+\s*\{/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(source))) {
    out += source.slice(last, m.index);
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    last = i;
    re.lastIndex = i;
  }
  return out + source.slice(last);
}

test('the skip link is the first thing in the document and points at main', () => {
  assert.ok(html.trimStart().startsWith('<a class="lp-skip" href="#main-content">'));
  assert.match(html, /<main id="main-content"/);
});

test('landmarks: one header with a labelled nav, one main, one footer', () => {
  assert.equal((html.match(/<header /g) || []).length, 1);
  assert.match(html, /<nav class="lp-bar__right" aria-label="Site">/);
  assert.equal((html.match(/<main /g) || []).length, 1);
  assert.equal((html.match(/<footer /g) || []).length, 1);
});

// The brief's literal check only iterates sections that ALREADY have an
// aria-labelledby — a section emitted without one is silently skipped, so
// the constraint went unenforced for exactly the four tasks that add new
// sections. This iterates EVERY <section>, requires the attribute, and
// requires the id it names to resolve to a heading INSIDE that section's own
// body (not merely somewhere in the document, which would pass even if two
// sections pointed at the same id, or at one that belongs to a neighbour).
//
// The brief's literal check also requires an <h2 id="…"> for every target.
// That holds for every section EXCEPT the hero: the hero's own
// aria-labelledby points at the page's single <h1> (id="lp-h1"), because the
// hero IS the section that carries the h1 — pointing a second, hidden,
// redundant h2 at it instead would be theatre for a regex, not better
// accessibility. So this accepts h1 OR h2 as a section's labelling heading.
test('every section is labelled by its own aria-labelledby, naming a heading inside it', () => {
  assert.equal((html.match(/<h1/g) || []).length, 1);
  const blocks = [...html.matchAll(/<section class="([^"]*)"([^>]*)>([\s\S]*?)<\/section>/g)];
  assert.ok(blocks.length >= 3, 'expected at least the three sections this task builds');
  for (const [, cls, attrs, body] of blocks) {
    const labelledby = attrs.match(/aria-labelledby="([^"]+)"/);
    assert.ok(labelledby, `section "${cls}" has no aria-labelledby`);
    assert.match(body, new RegExp(`<h[12][^>]*id="${labelledby[1]}"`), `"${cls}"'s heading #${labelledby[1]} is not inside it`);
  }
});

test('the hero deck ships three slides, the first visible, the others hidden and inert, and Skip hidden without JS', () => {
  assert.equal((html.match(/class="lp-hero__slide"/g) || []).length, 3);
  // Task 10 arms the carousel; until then slides 2 and 3 ship `hidden` as
  // well as `aria-hidden="true" inert`, so the deck is one paper tall in the
  // DOM itself, not just visually — see landing.css's `.is-armed` gating.
  assert.equal((html.match(/hidden aria-hidden="true" inert/g) || []).length, 2);
  assert.match(html, /<button class="lp-deck__skip" type="button" data-deck-skip hidden aria-label="Skip to the next paper">/);
  assert.match(html, /<span class="lp-deck__count" data-deck-count aria-live="polite">1 \/ 3<\/span>/);
  // The markup alone does not prove the deck stays one paper tall: an
  // author rule that sets `display` beats the user-agent's own
  // `[hidden] { display: none }` regardless of specificity, which is
  // exactly how the Skip button and counter rendered anyway the first time
  // this was looked at, in a browser, with all eight of the OTHER
  // assertions here still green. Delete either override and this is the
  // only thing that still catches it.
  assert.match(html, /<div class="lp-deck__foot" hidden>/);
  assert.match(css, /\.lp-deck__foot\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(css, /\.lp-deck__skip\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});

// A carousel that cannot be operated is not a carousel: role="group"
// aria-roledescription="carousel" would tell a screen reader this IS one,
// and tabindex="0" would let a keyboard reach it, while no keydown handler
// exists to answer either key until motion.js's armDeck() has run — the
// same "nothing focusable may do nothing" argument the tests above already
// hold the Skip button and foot to, extended to what an AT user is TOLD.
// armDeck adds all four attributes together, atomically, with .is-armed —
// see its own comment there and hero()'s in page.js.
test('the sheet ships as a plain div — no tabindex, no carousel role, until armDeck arms it', () => {
  assert.match(html, /<div class="lp-sheet" data-deck>/);
  assert.doesNotMatch(html, /<div class="lp-sheet"[^>]*tabindex/);
  assert.doesNotMatch(html, /<div class="lp-sheet"[^>]*role=/);
  assert.doesNotMatch(html, /<div class="lp-sheet"[^>]*aria-roledescription/);
  assert.doesNotMatch(html, /<div class="lp-sheet"[^>]*aria-label/);
});

test('yellow is a ground in four places, a travelling indicator, and one badge inside a window', () => {
  // .lp-bar--yellow and .lp-btn--yellow live in static-page.css, and
  // motion.css is owned by tasks 7 and 10 from here — read all three, or a
  // fifth yellow ground added to either evades this test.
  //
  // Task 7 forces one more match, pinned by rewriteMotion.test.js (copied
  // verbatim from the working prototype) rather than invented here:
  // `.lp-levels::after`, the active reading-level tab's travelling
  // indicator — a 1/3-width strip, not a field a visitor's eye rests on.
  //
  // Task 9 forces a sixth: `.lp-research__badge`, the Research edition's
  // "Lead story" badge. This is `.sr-lead-label` in the real app
  // (src/components/Report/ScientificReport.css:620-627) copied verbatim,
  // padding and all — the brief explicitly asked for the badge to "use
  // yellow as the app does," and the app's own badge is full
  // `--brand-yellow`, not a softened landing-page substitute. Unlike the
  // other five, it never sits on the page directly: it is one small badge
  // inside `.lp-window__inner`, itself `aria-hidden` and boxed inside a
  // `<figure>` — the picture-of-the-app pattern task 8 established, not a
  // field a visitor's eye rests on while reading the page. Flagged in the
  // task 9 report rather than widened here without comment, per this task's
  // own instruction to say so rather than quietly grow the number.
  //
  // @keyframes are stripped BEFORE the scan: a keyframe step's own selector
  // (e.g. `38%`, where the AI button's invitation keyframe peaks at the
  // full yellow — pinned separately by keyframeContrast.test.js, not
  // counted as a page "ground" here) would otherwise read as if it shared
  // the page with `.lp-hero`, and a second, unrelated keyframe with its own
  // 38% yellow step would produce an indistinguishable match. The AI
  // button's OWN resting, hover, focus and press states stay on
  // --brand-yellow-soft and never flip to the full colour (see .lp-btn--ai
  // and its [data-phase='press'] rule) — that flip is exactly where a real
  // seventh ground would have appeared, and it does not.
  const scanned = stripKeyframes(allCss);
  const grounds = [...scanned.matchAll(/([^{}]+)\{[^}]*background(?:-color)?:\s*var\(--brand-yellow\)[^}]*\}/g)].map((m) => m[1].trim());
  assert.deepEqual(grounds.sort(), ['.lp-bar--yellow', '.lp-btn--yellow', '.lp-close .lp-btn--yellow', '.lp-hero', '.lp-levels::after', '.lp-research__badge']);
});

test('no snap, no wheel capture, no figures, no eyebrows outside the card, no list-cards outside the library', () => {
  // All three sheets: a scroll-snap added in motion.css (task 7/10) is just
  // as much a violation as one added here.
  assert.doesNotMatch(allCss, /scroll-snap/);
  assert.doesNotMatch(html, /<img|<figure class="lp-figure"|pc-figure/);
  // `allCss`, not `css` — the same three sheets the scroll-snap ban two lines
  // up already reads. This scanned `css` alone until the whole-branch review
  // caught it: the two bans sat three lines apart and disagreed about what
  // "the landing's CSS" means, so a `text-transform: uppercase` added to
  // motion.css or static-page.css (neither of which this file owns, and
  // neither of which has one today — the escape was latent, not live) would
  // have walked straight past an allowlist that is the page's whole defence
  // against a second uppercase voice. Verified by mutation: dropping an
  // uppercase rule into static-page.css fails this line; with `css` it did
  // not.
  const upper = [...allCss.matchAll(/([^{}]+)\{[^}]*text-transform:\s*uppercase[^}]*\}/g)].map((m) => m[1].trim());
  // `pile` joins the allowlist here: `.lp-pile__venue` is the wheel's venue
  // column, set uppercase for the same reason `.lp-paper__meta` is — it's
  // the app's own mono metadata voice, not a fresh decision. `eyebrow` joins
  // it in task 7: the reader's kicker and its uses counter reuse the app's
  // own mono-uppercase voice class rather than inventing a new rule — see
  // the counterpart assertion below, which is what stops the allowance from
  // leaking to the rest of the page. `list-card` joins it in task 8, for the
  // same reason: `.lp-list-card__count` is the paper-count line on a list
  // card exactly as ListsPage.css sets its own rows, not a fresh decision —
  // see the second counterpart assertion below.
  // `brief` joins it in task 9: `.lp-brief__kicker` is the field+year row on
  // each of the eleven research cards, set uppercase the same mono way
  // `.lp-paper__meta` already is — not a fresh decision. `plate` and
  // `research` were already in this list before task 9 touched it; of the
  // two, only `.lp-research__badge` (the "Lead story" badge, matching the
  // app's own `.sr-lead-label`) actually declares `text-transform:
  // uppercase` — `plate`'s own rules never do (graphMap.js's SVG corner
  // labels are typed in caps as literal text, not transformed by CSS), so
  // it stays allowed but unused by this task. See the counterpart below,
  // which is what stops `brief` specifically from leaking.
  for (const sel of upper) assert.match(sel, /^\.lp-(paper|plate|research|chip|pile|eyebrow|list-card|brief)/, sel);
  // `.lp-eyebrow` is app UI that belongs INSIDE a reader's own window — the
  // `.lp-rewrite` widget here, the Research edition's own
  // `<figure class="lp-window">` — never a label loose on the page. Scoped
  // to `.lp-rewrite` and `.lp-window` THEMSELVES, not either section as a
  // whole: both sections also hold the left column's prose (`.lp-head`),
  // which is not either window, and stripping the entire section would
  // hide an eyebrow added there by mistake. That is not hypothetical —
  // task 9's first draft of this check stripped the whole
  // `<section class="lp-research">` instead of `.lp-window`, which would
  // have let a stray `.lp-eyebrow` in `.lp-head`'s own intro prose (inside
  // the section, outside the window) pass silently; caught in review, not
  // by this suite, which is exactly the gap fixed here.
  // `.lp-rewrite` is the last element before its section closes (page.js),
  // so matching through to the next `</section>` captures all of it
  // without needing brace-balanced HTML parsing — `.lp-window` doesn't need
  // that trick, since it closes with its own `</figure>` and is the ONLY
  // `<figure class="lp-window">` in the document (unlike `.lp-figure-ui`,
  // which task 8 had to prove two different ways because it repeats —
  // once in follow(), once in library() — so a single strip could not name
  // "the" one to remove).
  const outside = html.replace(/<div class="lp-rewrite"[\s\S]*?<\/section>/, '').replace(/<figure class="lp-window">[\s\S]*?<\/figure>/, '');
  assert.doesNotMatch(outside, /lp-eyebrow/);
  // `.lp-brief` is the app UI for task 9's eleven research cards — it
  // belongs INSIDE the Research window (`<figure class="lp-window">`),
  // never loose on the page and never in `.lp-head`'s own intro prose just
  // outside that window. The same `outside` already has the window removed
  // (above), so this is the direct counterpart to the `eyebrow` check just
  // above it: task 9's new allowance (`brief`) must not leak any more than
  // task 7's did.
  assert.doesNotMatch(outside, /lp-brief/);
  // `.lp-list-card` is app UI that belongs INSIDE the library's own
  // <figure> — the swatch legend and the left column's prose
  // (`.lp-library__head`) sit in the same SECTION but are not that figure,
  // and stripping the whole `lp-library` section would have hidden a card
  // rendered next to the swatches by mistake instead of inside the figure.
  // First assertion: every occurrence of the class inside the section is
  // also inside the section's own figure (a count match, not a containment
  // parse — brace-balanced HTML parsing buys nothing here since neither
  // element nests the other). Second: the class never appears anywhere
  // outside the section at all.
  const librarySection = html.match(/<section class="lp-library[^"]*"[\s\S]*?<\/section>/)[0];
  const libraryFigure = librarySection.match(/<figure class="lp-figure-ui">[\s\S]*?<\/figure>/)[0];
  assert.equal(
    (librarySection.match(/lp-list-card/g) || []).length,
    (libraryFigure.match(/lp-list-card/g) || []).length,
    'lp-list-card appears in the library section outside its figure',
  );
  assert.doesNotMatch(html.replace(librarySection, ''), /lp-list-card/);
});

test('chip tone and the paper accent are guarded against attribute-context injection', () => {
  // esc() escapes HTML entities; neither `tone` (spliced into a class list)
  // nor the accent token (spliced into `var(...)`) is in a context entities
  // protect — a space still opens a second class, and `)`/`;` still escape
  // the var() call. assertSafeToken() throws instead, which is what keeps
  // this from becoming the same class of bug as the Critical above: a
  // fixed-looking page whose "fix" only covers the element it was measured
  // on.
  assert.throws(() => assertSafeToken('blue evil-class', /^[a-z]+$/, 'chip tone'));
  assert.throws(() => assertSafeToken('--x); } .evil { color', /^--[a-z0-9-]+$/, 'accent token'));
  assert.doesNotThrow(() => assertSafeToken('blue', /^[a-z]+$/, 'chip tone'));
  assert.doesNotThrow(() => assertSafeToken('--gradient-bio', /^--[a-z0-9-]+$/, 'accent token'));
});

// Task 5 only builds hero/strip/close, and only close() highlights anything,
// so the count is 1 here, not the spec's eventual 3 — same reasoning as the
// order test below: bounded so a regression (0) or an overshoot (>3) still
// fails, without this test sitting red for four tasks.
test('the highlight appears at least once and at most three times, and never as a band on ink', () => {
  const count = (html.match(/class="lp-hl"/g) || []).length;
  assert.ok(count >= 1 && count <= 3, `expected 1-3 highlights, found ${count}`);
  // Both contexts share one declaration block via a comma-separated selector
  // (`[data-theme="dark"] .lp-hl, .lp-close .lp-hl { … }`) rather than two
  // rules repeating the same five declarations, so `[^{]*` stands in for the
  // rest of the selector list between each selector and the opening brace.
  assert.match(css, /\[data-theme="dark"\] \.lp-hl[^{]*\{[^}]*text-decoration: underline/);
  assert.match(css, /\.lp-close \.lp-hl[^{]*\{[^}]*text-decoration: underline/);
});

// Tasks 6-9 each inserted a section into this array; until task 9 the check
// here only asked the sections that already existed to be a subsequence of
// the canonical order, since the other eight/nine were still missing and a
// literal-equality check would have sat red for four tasks running. Task 9
// is the last of them — `lp-map` and `lp-research` complete the set — so
// this now pins the page's shape exactly: eleven sections, this order,
// nothing more and nothing missing. Any future task that reorders, drops or
// duplicates a section fails here first.
const CANONICAL = ['lp-hero', 'lp-problem', 'lp-signals', 'lp-reader', 'lp-labels', 'lp-follow', 'lp-library', 'lp-map', 'lp-research', 'lp-strip', 'lp-close'];
test('the eleven sections render in exactly the canonical order', () => {
  // Checked before the equality below so a duplicate reports as exactly
  // that ("a section appears more than once") rather than as an opaque
  // array-length mismatch against CANONICAL.
  assert.equal(new Set(sections).size, sections.length, 'a section appears more than once');
  assert.deepEqual(sections, CANONICAL);
});

test('the wheel is thirteen slots the screen reader never hears, next to a list it does', () => {
  assert.equal((html.match(/class="lp-pile__slot"/g) || []).length, 13);
  assert.match(html, /<div class="lp-pile" aria-hidden="true"/);
  assert.match(html, /<ul class="lp-visually-hidden" id="lp-pile-list">/);
  assert.equal((html.match(/<ul class="lp-visually-hidden" id="lp-pile-list">[\s\S]*?<\/ul>/)[0].match(/<li>/g) || []).length, 25);
  assert.match(html, /<script type="application\/json" id="lp-pile-data">/);
  assert.ok(html.lastIndexOf('lp-pile-data') > html.lastIndexOf('</main>'), 'the data lives outside main');
});

// `.lp-problem` reuses `.lp-sec` for its padding (the shared utility every
// task 6-9 section draws on), so its class attribute is "lp-problem lp-sec",
// not "lp-problem" alone — matching the `sections` array above, which
// already splits on space for exactly this reason. `class="lp-problem"`
// with nothing after it would never match, so this anchors on the prefix.
test('the problem section carries the first of the three highlights', () => {
  const sec = html.match(/<section class="lp-problem[^"]*"[\s\S]*?<\/section>/)[0];
  assert.equal((sec.match(/class="lp-hl"/g) || []).length, 1);
  assert.match(sec, /so I built one\./);
});

test('six signals, name and sentence each, no dl and no mono labels', () => {
  const sec = html.match(/<section class="lp-signals[^"]*"[\s\S]*?<\/section>/)[0];
  assert.equal((sec.match(/class="lp-signal"/g) || []).length, 6);
  assert.doesNotMatch(sec, /<dl|lp-eyebrow/);
});

// `.lp-reader` carries `lp-sec` too (`class="lp-reader lp-sec"`, same reason
// as `.lp-problem` above), so the match needs the same `[^"]*` wildcard —
// without it this regex never matches the section this task actually
// builds, brief text notwithstanding.
test('the reader ships at rest with the finished text, its tabs, a highlight and a note', () => {
  const sec = html.match(/<section class="lp-reader[^"]*"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /data-rewrite data-levels/);
  assert.match(sec, /role="tablist" aria-label="Rewrite level"/);
  assert.equal((sec.match(/role="tab"/g) || []).length, 3);
  assert.equal((sec.match(/class="lp-hl"/g) || []).length, 1);
  assert.match(sec, /<aside class="lp-note" aria-label="Your note">/);
  assert.match(sec, /data-rewrite-card hidden/);
  // Without JavaScript there is no click handler and no keydown handler
  // behind these buttons — armLevels wires both. An ENABLED tab that does
  // nothing on press is exactly the dead control this page may not leave
  // anyone with, so all three ship `disabled` and armLevels lifts it.
  assert.equal((sec.match(/class="lp-levels__tab"[^>]*disabled>/g) || []).length, 3);
});

// `.lp-levels::after` (the travelling indicator) positions itself from
// `--lp-level`, which only armLevels ever writes — its CSS fallback of `0`
// points at Beginner. Without an inline value matching DEFAULT_LEVEL, the
// indicator would sit under Beginner on first paint while aria-selected and
// data-active both already point at University: correct markup, wrong
// picture, for every visit before armLevels runs (which is every no-JS,
// phone or reduced-motion visit, and a flash of it for everyone else).
test("the level indicator agrees with the selected tab before any JavaScript runs", () => {
  const sec = html.match(/<section class="lp-reader[^"]*"[\s\S]*?<\/section>/)[0];
  const inlineLevel = sec.match(/<div class="lp-rewrite" data-rewrite data-levels style="--lp-level: (\d+)">/);
  assert.ok(inlineLevel, 'no inline --lp-level on .lp-rewrite');
  const tabs = [...sec.matchAll(/<button class="lp-levels__tab"[^>]*aria-selected="(true|false)"/g)].map((m) => m[1]);
  const selectedIndex = tabs.indexOf('true');
  assert.equal(tabs.filter((v) => v === 'true').length, 1, 'more or less than one tab is aria-selected');
  assert.equal(Number(inlineLevel[1]), selectedIndex, 'the inline --lp-level does not name the aria-selected tab');
});

// PaperCard's own action row (paper()'s default) says "Read in plain words"
// on a yellow button too — right in the hero, where the card IS the app's
// card and that row is the whole point. Stacked into the reader's card, that
// same decorative row sat directly above the section's OWN AI button with
// the same label, so a reader saw two identical yellow buttons for one
// action: one an aria-hidden decoration, one the real, focusable control.
// `lp-btn--ai` is the shared class both would carry, decoration or real —
// counting it is direct proof of the fix and does not trip on the status
// line's kicker (`Read in plain words` again, as a plain-text caption
// naming what the button below it does — not a button, no `lp-btn` class,
// never the thing this bug was about).
test('the reader shows exactly one "Read in plain words" button, not the card\'s own decoration and the real one both', () => {
  const sec = html.match(/<section class="lp-reader[^"]*"[\s\S]*?<\/section>/)[0];
  assert.equal((sec.match(/lp-btn--ai/g) || []).length, 1);
  assert.match(sec, /<button class="lp-btn lp-btn--ai lp-btn--lg" type="button" data-rewrite-start/);
  // The hero's own card is a different context — it IS PaperCard's card,
  // decoration included — and must keep its row. Three slides, three rows.
  const hero = html.match(/<section class="lp-hero[^"]*"[\s\S]*?<\/section>/)[0];
  assert.equal((hero.match(/lp-btn--ai/g) || []).length, 3);
});

test('five labels, each with its sentence, and no motion', () => {
  const sec = html.match(/<section class="lp-labels[^"]*"[\s\S]*?<\/section>/)[0];
  assert.deepEqual([...sec.matchAll(/lp-chip lp-chip--\w+">([^<]+)</g)].map((m) => m[1]), ['Verified', 'Preprint', 'Open access', 'Open version', 'Subscription']);
});

// `.lp-follow` carries `lp-sec` too (`class="lp-follow lp-sec"`, same reason
// as `.lp-problem`/`.lp-reader` above — the shared padding utility every
// task 6-9 section draws on), so this needs the same `[^"]*` wildcard the
// brief's own literal snippet omits.
test('the Explorer rows are a figure with a caption, not fake controls', () => {
  const sec = html.match(/<section class="lp-follow[^"]*"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /<figure class="lp-figure-ui">/);
  assert.match(sec, /<figcaption class="lp-visually-hidden">Three things you can follow: David Card, an author; Gravitational waves, a topic; Universidad de Salamanca, an institution\.<\/figcaption>/);
  assert.equal((sec.match(/<button/g) || []).length, 0);
  assert.match(sec, /<span lang="es">Universidad de Salamanca<\/span>/);
});

test('the four lists are a figure too, with the eight colours as a list of names', () => {
  const sec = html.match(/<section class="lp-library[^"]*"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /<figcaption class="lp-visually-hidden">Four lists as the app shows them: Favorites, Read later, Reading history and Papers de sugar, which is public\.<\/figcaption>/);
  assert.equal((sec.match(/class="lp-list-card"/g) || []).length, 4);
  assert.equal((sec.match(/class="lp-swatch"/g) || []).length, 8);
  assert.match(sec, /<ul class="lp-swatches" aria-label="The eight list colours">/);
});

// `.lp-map` carries `lp-sec` too, same reason as every section above.
test('the map is an svg with a text alternative list beside it', () => {
  const sec = html.match(/<section class="lp-map[^"]*"[\s\S]*?<\/section>/)[0];
  assert.equal((sec.match(/<svg/g) || []).length, 2, 'the wide and the compact plate');
  assert.match(sec, /<ul class="lp-visually-hidden" id="lp-map-list">/);
  assert.equal((sec.match(/<ul class="lp-visually-hidden" id="lp-map-list">[\s\S]*?<\/ul>/)[0].match(/<li>/g) || []).length, 7);
});

test('the edition is a window with a caption, cut with a fade, its percentages the real ones', () => {
  const sec = html.match(/<section class="lp-research[^"]*"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /<figure class="lp-window">/);
  assert.match(sec, /\+69%/); assert.match(sec, /\+47%/);
  assert.doesNotMatch(sec, /\+115%|\+87%/);
  assert.doesNotMatch(sec, /data-research-anchor|lp-pin/);
});
