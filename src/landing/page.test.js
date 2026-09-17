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

test('yellow is a ground only in the hero and the closing button', () => {
  // .lp-bar--yellow and .lp-btn--yellow live in static-page.css, and
  // motion.css is owned by tasks 7 and 10 from here — read all three, or a
  // fifth yellow ground added to either evades this test.
  const grounds = [...allCss.matchAll(/([^{}]+)\{[^}]*background(?:-color)?:\s*var\(--brand-yellow\)[^}]*\}/g)].map((m) => m[1].trim());
  assert.deepEqual(grounds.sort(), ['.lp-bar--yellow', '.lp-btn--yellow', '.lp-close .lp-btn--yellow', '.lp-hero']);
});

test('no snap, no wheel capture, no figures, no eyebrows outside the card', () => {
  // All three sheets: a scroll-snap added in motion.css (task 7/10) is just
  // as much a violation as one added here.
  assert.doesNotMatch(allCss, /scroll-snap/);
  assert.doesNotMatch(html, /<img|<figure class="lp-figure"|pc-figure/);
  const upper = [...css.matchAll(/([^{}]+)\{[^}]*text-transform:\s*uppercase[^}]*\}/g)].map((m) => m[1].trim());
  // `pile` joins the allowlist here: `.lp-pile__venue` is the wheel's venue
  // column, set uppercase for the same reason `.lp-paper__meta` is — it's
  // the app's own mono metadata voice, not a fresh decision.
  for (const sel of upper) assert.match(sel, /^\.lp-(paper|plate|research|chip|pile)/, sel);
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

// The brief's own test asserts the eleven sections exactly; only three exist
// after this task, so it would sit red for four tasks. This checks instead
// that the sections which DO exist are a subsequence of the spec's canonical
// order — passes now, and still gates the order once tasks 6-9 land theirs.
const CANONICAL = ['lp-hero', 'lp-problem', 'lp-signals', 'lp-reader', 'lp-labels', 'lp-follow', 'lp-library', 'lp-map', 'lp-research', 'lp-strip', 'lp-close'];
test('the sections that exist appear in the canonical order', () => {
  for (const s of sections) assert.ok(CANONICAL.includes(s), `unknown section ${s}`);
  // A subsequence check alone passes on a repeat (e.g. two `lp-strip`s: the
  // second's position is still >= the first's), which is exactly the shape
  // of mistake four tasks inserting sections into the same array are about
  // to have a chance to make.
  assert.equal(new Set(sections).size, sections.length, 'a section appears more than once');
  const positions = sections.map((s) => CANONICAL.indexOf(s));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(sections.length >= 3);
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
