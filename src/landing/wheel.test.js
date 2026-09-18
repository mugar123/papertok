import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Most of this file gates motion.js's SHAPE rather than its runtime
// behaviour — rAF, real layout and a real IntersectionObserver belong to a
// browser, and landing-wheel-audit.mjs (committed, CDP-driven) is what
// actually exercises those. Comments stripped the same way page.test.js
// strips landing.css's, so a fact stated only in prose can't fool a regex
// that happens to also match the word inside it. One test below (the last)
// is a real node:test execution of the module, with the DOM it needs
// stubbed — see its own comment for why that one can't be a source check.
const js = readFileSync(fileURLToPath(new URL('./motion.js', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const landingCss = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8');
const motionCss = readFileSync(fileURLToPath(new URL('./motion.css', import.meta.url)), 'utf8');

test('the wheel keeps its measured constants', () => {
  assert.match(js, /WHEEL_REACHES = \[14, 16, 18\]/);
  assert.match(js, /WHEEL_TAU = 380/);
  assert.match(js, /WHEEL_STOP_V = 0\.46/);
});

// A literal string check, not one tied to a call syntax: `wheel` can't name
// an event without that word appearing somewhere in the source, dot call or
// bracket call alike (`x.addEventListener('wheel', …)` and
// `x['addEventListener']('wheel', …)` both contain the bare string), so the
// plain substring already covers every way of registering the listener.
// touchmove and scroll are the other events a hand-rolled scroll-capture
// reaches for, and `overscrollBehavior` is the non-event way to fight a
// scroll gesture — checked here in its JS form, and against both
// stylesheets in their CSS form (`overscroll-behavior`) right after.
//
// The bare-word ban on `preventDefault` that used to sit here is gone: task
// 7's armLevels() legitimately calls it, on the arrow-key event in the
// tablist's keydown handler — WAI-ARIA's roving-tabindex pattern, so the
// arrow keys move focus between tabs instead of the browser's own default
// (which, in some hosts, is to scroll the page). That call has nothing to
// do with the page's own scroll gesture. What this test actually guards is
// narrower than "no preventDefault ever" and is still fully enforced
// without the bare word: no `wheel`, `touchmove` or `scroll` EVENT NAME
// anywhere (so no listener for any of them can exist, by whatever call
// syntax), and no `overscroll-behavior` WRITE — with none of those three
// events ever registered, there is nothing on this page for a
// `preventDefault()` to withhold a scroll from. Add a
// `frame.addEventListener('wheel', …)` back — or `frame['addEventListener'](
// 'wheel', …)` — and this still fails, on the bare `['"]wheel['"]` line.
test('the wheel turns on arrival by IntersectionObserver and on click, and never captures the scroll', () => {
  assert.match(js, /new IntersectionObserver\([\s\S]*?threshold: 0\.5/);
  assert.match(js, /frame\.addEventListener\('click'/);
  assert.doesNotMatch(js, /['"]wheel['"]/);
  assert.doesNotMatch(js, /['"]touchmove['"]/);
  assert.doesNotMatch(js, /['"]scroll['"]/);
  assert.doesNotMatch(js, /overscrollBehavior/);
  assert.doesNotMatch(js, /lp-scroller/);
});

// The event-name ban above has a gap the event name itself cannot close:
// `document.addEventListener('keydown', e => { if (e.key === 'ArrowDown')
// e.preventDefault(); })` names none of `wheel`/`touchmove`/`scroll` and
// still captures the page's scroll for anyone reaching for the arrow keys
// anywhere on the page — armLevels' own arrow-key handling is the reason
// that example is not hypothetical trouble, it is one keystroke away from
// where this file already calls preventDefault(), just on the wrong
// receiver. So this asserts the shape everything on this page actually has:
// every listener this module registers is scoped to an ELEMENT it queried
// (`tab.`, `button.`, `frame.`), never to the whole `window` or `document`,
// with the sole, load-bearing exception of the bootstrap itself —
// `document.addEventListener('DOMContentLoaded', …)`, which fires once,
// before there is any element to scope to yet, and touches nothing a
// reader's own scroll or keyboard input could be mistaken for.
test('every listener is scoped to an element it queried — window/document only ever hear DOMContentLoaded', () => {
  const globalListeners = [...js.matchAll(/\b(?:window|document)\.addEventListener\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(globalListeners, ['DOMContentLoaded']);
});

test('neither stylesheet declares overscroll-behavior either', () => {
  assert.doesNotMatch(landingCss, /overscroll-behavior/);
  assert.doesNotMatch(motionCss, /overscroll-behavior/);
});

// motion.js is a module (not the prototype's IIFE) precisely so a later
// task can import from it instead of duplicating a function — see task 10,
// which needs the same reduced-motion/viewport gate the hero deck arms
// under. A file that forgot to export anything would make that a copy-paste
// job instead, which is the defect this guards against.
test('shouldAnimate is an importable export, not trapped in a closure', () => {
  assert.match(js, /export function shouldAnimate\(/);
});

// The whole file, not just the wheel, is a module: no IIFE wrapper left over
// from the prototype this was copied out of.
test('not an IIFE', () => {
  assert.doesNotMatch(js, /^\s*\(function\s*\(\)\s*\{/);
  assert.doesNotMatch(js, /\}\)\(\);\s*$/);
});

/**
 * A real execution, not a source check — the two tests above prove
 * shouldAnimate() and armPile() each look right; neither proves init()
 * actually connects them, which is the one fact a regex genuinely cannot
 * see (it would pass just as happily if init() called armPile()
 * unconditionally and shouldAnimate() were dead code sitting beside it).
 *
 * motion.js touches `window`/`document` the moment it is imported (the
 * auto-run at the bottom) and again inside armPile()/makeWheel(), so this
 * stubs the minimal DOM both paths need: enough of `.lp-pile` /
 * `.lp-pile__barrel` / `#lp-pile-data` for makeWheel() to succeed, so the
 * ONLY thing standing between init() and `new IntersectionObserver(...)` is
 * the gate this test exists to prove. `document.readyState` is left
 * `'loading'` so the auto-run only registers a DOMContentLoaded listener
 * (never fired here) rather than calling init() itself before the test
 * controls what shouldAnimate() returns — init() is exported for exactly
 * this: a test can call it on demand instead of racing the module's own
 * side effect.
 */
test('shouldAnimate() actually gates armPile() — not just named beside it', async () => {
  let observerCount = 0;
  class FakeIntersectionObserver {
    constructor() { observerCount += 1; }
    observe() { /* the point of this test is that this is reached at all */ }
    disconnect() {}
  }
  const barrel = {
    children: Array.from({ length: 13 }, () => ({ children: [{ textContent: '' }, { textContent: '' }] })),
    style: {},
  };
  const frame = {
    querySelector: (sel) => (sel === '.lp-pile__barrel' ? barrel : null),
    addEventListener: () => {},
  };
  const pileData = { textContent: JSON.stringify(Array.from({ length: 25 }, (_, i) => [`V${i}`, `T${i}`])) };

  let allows = true; // flipped between the two calls below; everything else about the environment stays fixed
  const fakeWindow = {
    IntersectionObserver: FakeIntersectionObserver,
    matchMedia: (query) => ({ matches: query.includes('prefers-reduced-motion') ? false : allows }),
  };
  const fakeDocument = {
    readyState: 'loading',
    documentElement: { getAttribute: (name) => (name === 'data-motion' ? 'on' : null) },
    querySelector: (sel) => (sel === '.lp-pile' ? frame : null),
    getElementById: (id) => (id === 'lp-pile-data' ? pileData : null),
    addEventListener: () => {},
  };

  const hadWindow = 'window' in globalThis; const savedWindow = globalThis.window;
  const hadDocument = 'document' in globalThis; const savedDocument = globalThis.document;
  const hadIO = 'IntersectionObserver' in globalThis; const savedIO = globalThis.IntersectionObserver;
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  try {
    const mod = await import('./motion.js');

    allows = false; // (min-width: 768px) and (hover: hover) and (pointer: fine) fails — a phone, say
    assert.equal(mod.shouldAnimate(), false);
    mod.init();
    assert.equal(observerCount, 0, 'init() must not wire up the wheel while shouldAnimate() is false');

    allows = true;
    assert.equal(mod.shouldAnimate(), true);
    mod.init();
    assert.equal(observerCount, 1, 'init() must wire up the wheel once shouldAnimate() is true');
  } finally {
    if (hadWindow) globalThis.window = savedWindow; else delete globalThis.window;
    if (hadDocument) globalThis.document = savedDocument; else delete globalThis.document;
    if (hadIO) globalThis.IntersectionObserver = savedIO; else delete globalThis.IntersectionObserver;
  }
});
