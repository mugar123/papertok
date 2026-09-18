// Drives and measures the hero deck (src/landing/motion.js, armDeck) in a
// real headless Chrome: Skip three times and watch the counter wrap, the
// reel teleport back to the first paper without a frame of travel, and
// focus land on the sheet; the arrow keys move it too, without moving the
// page; prefers-reduced-motion turns the CSS transition off outright, live,
// no reload needed; and with the page's own scripts disabled, the hero
// stays exactly the one paper it ships as. No dependencies; Node >= 22 for
// the global WebSocket — same no-dependency CDP harness as the other
// scripts in this directory (see landing-shots.mjs, landing-wheel-audit.mjs,
// author-door-census.mjs for the real-key-press convention).
//
//   node scripts/diagnostics/landing-deck-probe.mjs [url]
//
// Defaults to http://localhost:4173/ (`npx vite preview --port 4173
// --strictPort`). PORT=<n> picks another debugging port, CHROME=<path>
// another Chromium binary.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9261);
const URL_ = process.argv[2] || process.env.URL || 'http://localhost:4173/';
const WIDTH = 1440;
const HEIGHT = 900;
const PROFILE = join(tmpdir(), `lp-deck-probe-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  `--window-size=${WIDTH},${HEIGHT}`, '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore', detached: true });

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('chrome did not start');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      } else if (m.method) {
        const fn = this.listeners.get(m.method);
        if (fn) fn(m.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  // Single active handler per method, REPLACING whatever was there —
  // every phase in this script that calls this registers its own handler
  // for the SAME event ('Fetch.requestPaused') as an earlier phase, and
  // an earlier phase's stale handler firing again during a later one is
  // exactly the bug this fixed (two handlers both trying to
  // Fetch.continueRequest the same, already-continued requestId).
  on(method, fn) { this.listeners.set(method, fn); }
}

try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  // A real, non-touch pointer, and explicitly NOT this machine's own
  // reduced-motion preference: shouldAnimate()/index.html's own gate reads
  // both, and a host with "reduce motion" on would otherwise make every
  // number below false for the wrong reason (armDeck itself does not
  // consult shouldAnimate(), but the reduced-motion CSS block does, and
  // that is exactly what the later phase below means to isolate).
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(1200); // self-hosted fonts and the prerendered markup settling

  const gate = JSON.parse(await ev(`JSON.stringify({
    dataMotion: document.documentElement.getAttribute('data-motion'),
    armed: document.querySelector('.lp-sheet').classList.contains('is-armed'),
    skipHidden: document.querySelector('[data-deck-skip]').hidden,
    footHidden: document.querySelector('.lp-deck__foot').hidden,
    count: document.querySelector('[data-deck-count]').textContent,
    reelTransform: document.querySelector('[data-deck-reel]').style.transform,
    slides: document.querySelectorAll('.lp-hero__slide').length,
  })`));
  console.log('══════ GATE (armed page) ══════');
  console.log(gate);
  if (!gate.armed) console.log('WARNING: .is-armed never landed — nothing below will move.');

  // ── Skip, three times, ~600ms apart ─────────────────────────────────────
  // Also reads .lp-deck's own box height at each stop: HERO_PAPERS are not
  // the same length, and (C)'s whole claim is that the deck's height comes
  // from measure()'s one-time max — set before any slide is shown — so it
  // must read identical at all three stops, not just "visually about the
  // same" in a screenshot.
  // The read-after-each-click helper below checks more than the counter:
  // WHICH slide is currently reachable (not `inert`), whether it is really
  // painted (`offsetParent`, null for display:none on itself or an
  // ancestor — this is what would have caught the `hidden` bug below), and
  // its title — a repeated or blank title would mean the counter is
  // advancing over content that never actually changed.
  const readSlide = () => ev(`JSON.stringify((() => {
    const on = [].find.call(document.querySelectorAll('.lp-hero__slide, .lp-hero__slide--clone'), (s) => !s.inert);
    return { title: on ? on.querySelector('.lp-paper__title').textContent.slice(0, 40) : null, painted: on ? on.offsetParent !== null : false, hiddenAttr: on ? on.hidden : null, isClone: on ? on.classList.contains('lp-hero__slide--clone') : null };
  })())`).then(JSON.parse);

  const counters = [];
  const deckHeights = [];
  const slideReads = [];
  for (let n = 0; n < 3; n++) {
    const rect = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('[data-deck-skip]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })())`));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await sleep(80); // let the click handler run and paint the counter
    const text = await ev(`document.querySelector('[data-deck-count]').textContent`);
    counters.push(text);
    const deckH = await ev(`document.querySelector('.lp-deck').getBoundingClientRect().height`);
    deckHeights.push(deckH);
    slideReads.push(await readSlide());
    await sleep(520); // ~600ms since the press, well past the 400ms transition + settle
  }
  console.log('\n══════ SKIP × 3 (~600ms apart) ══════');
  console.log('counter after each click:', counters);
  console.log('.lp-deck height at each stop (px):', deckHeights, ' constant:', new Set(deckHeights).size === 1);
  console.log('reachable slide after each click:', JSON.stringify(slideReads, null, 2));
  const titles = slideReads.map((s) => s.title);
  console.log('distinct real titles across the 3 stops:', new Set(titles).size, titles);
  console.log('all painted (offsetParent !== null):', slideReads.every((s) => s.painted));

  const after3 = JSON.parse(await ev(`JSON.stringify({
    reelTransform: document.querySelector('[data-deck-reel]').style.transform,
    activeIsSheet: document.activeElement === document.querySelector('[data-deck]'),
    activeTag: document.activeElement.tagName,
    activeHasDataDeck: document.activeElement.hasAttribute('data-deck'),
  })`));
  console.log('reel transform after the 3rd click:', after3.reelTransform);
  console.log('document.activeElement is the sheet:', after3.activeIsSheet, `(tag=${after3.activeTag}, data-deck=${after3.activeHasDataDeck})`);
  const settledSlide = await readSlide();
  console.log('reachable slide once fully settled (should be the REAL first paper, not the clone):', settledSlide);

  // ── Arrow keys: move the deck, do NOT move the page ─────────────────────
  await ev(`document.querySelector('[data-deck]').focus({ preventScroll: true }); 'focused'`);
  const beforeArrow = JSON.parse(await ev(`JSON.stringify({ count: document.querySelector('[data-deck-count]').textContent, scrollY: window.scrollY })`));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
  await sleep(500);
  const afterDown = JSON.parse(await ev(`JSON.stringify({ count: document.querySelector('[data-deck-count]').textContent, scrollY: window.scrollY })`));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
  await sleep(500);
  const afterUp = JSON.parse(await ev(`JSON.stringify({ count: document.querySelector('[data-deck-count]').textContent, scrollY: window.scrollY })`));

  console.log('\n══════ ARROW KEYS (sheet focused) ══════');
  console.log('before:', beforeArrow, '\nafter ArrowDown:', afterDown, '\nafter ArrowUp:', afterUp);
  console.log('deck moved on ArrowDown:', beforeArrow.count !== afterDown.count);
  console.log('deck moved back on ArrowUp:', afterDown.count !== afterUp.count);
  console.log('page scroll unchanged throughout:', beforeArrow.scrollY === afterDown.scrollY && afterDown.scrollY === afterUp.scrollY);

  // ── Tab from the very top of the page, through the hero ────────────────
  // A fresh navigation: every phase above has already moved focus and deck
  // state around, and this needs to start from document.activeElement ===
  // document.body, the same as a real visitor's first keypress.
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(1200);
  const focusOrder = [];
  let enteredHero = false;
  let leftHeroAt = -1;
  for (let i = 0; i < 20; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(60);
    const stop = JSON.parse(await ev(`JSON.stringify((() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: 'BODY' };
      const inHero = !!el.closest('.lp-hero');
      return {
        tag: el.tagName,
        cls: el.className || null,
        role: el.getAttribute('role'),
        text: (el.textContent || '').trim().slice(0, 40),
        href: el.getAttribute('href'),
        inHero,
      };
    })())`));
    focusOrder.push(stop);
    if (stop.inHero) enteredHero = true;
    // Stop one stop after LEAVING the hero, having actually entered it —
    // enough to show what comes right after without walking the rest of
    // the page. `leftHeroAt` guards against the pre-hero header stops
    // (skip link, wordmark, nav) ever looking like an "exit".
    if (enteredHero && !stop.inHero) {
      if (leftHeroAt === -1) leftHeroAt = focusOrder.length;
      else if (focusOrder.length > leftHeroAt) break;
    }
    if (stop.tag === 'BODY' && focusOrder.length > 1) break; // Tab cycled off the document
  }
  console.log('\n══════ TAB FROM THE TOP, THROUGH THE HERO ══════');
  focusOrder.forEach((s, i) => console.log(`  ${i + 1}. ${s.tag}${s.cls ? '.' + String(s.cls).split(' ').join('.') : ''}${s.role ? ` role=${s.role}` : ''}${s.href ? ` href=${s.href}` : ''} "${s.text}"${s.inHero ? '  [in .lp-hero]' : ''}`));

  // ── Reduced motion: the change is instant, live, no reload ─────────────
  const normalDuration = await ev(`getComputedStyle(document.querySelector('[data-deck-reel]')).transitionDuration`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(150);
  const reducedDuration = await ev(`getComputedStyle(document.querySelector('[data-deck-reel]')).transitionDuration`);
  console.log('\n══════ REDUCED MOTION (live media-query flip, same page, no reload) ══════');
  console.log('reel transitionDuration — normal:', normalDuration, ' reduced:', reducedDuration);
  console.log('instant under reduced motion:', reducedDuration === '0s');

  // ── No JavaScript: one paper, no Skip, nothing focusable does nothing ──
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(900);
  const noJs = JSON.parse(await ev(`JSON.stringify({
    slideCount: document.querySelectorAll('.lp-hero__slide').length,
    visibleSlides: [].filter.call(document.querySelectorAll('.lp-hero__slide'), function (s) { return !s.hidden; }).length,
    slide2: (function (s) { return { hidden: s.hidden, ariaHidden: s.getAttribute('aria-hidden'), inert: s.inert }; })(document.querySelectorAll('.lp-hero__slide')[1]),
    slide3: (function (s) { return { hidden: s.hidden, ariaHidden: s.getAttribute('aria-hidden'), inert: s.inert }; })(document.querySelectorAll('.lp-hero__slide')[2]),
    footHidden: document.querySelector('.lp-deck__foot').hidden,
    skipHidden: document.querySelector('[data-deck-skip]').hidden,
    armed: document.querySelector('.lp-sheet').classList.contains('is-armed'),
    focusables: [].map.call(document.querySelectorAll('.lp-hero a, .lp-hero button, .lp-hero [tabindex]'), function (el) {
      return { tag: el.tagName, cls: el.className, role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), hidden: el.hidden, inert: el.inert };
    }),
  })`));
  console.log('\n══════ NO JAVASCRIPT (Emulation.setScriptExecutionDisabled) ══════');
  console.log(JSON.stringify(noJs, null, 2));

  // ── The font-loading race: fallback metrics vs. the authoritative remeasure ──
  // Re-enable scripts (left off by the phase above). Rather than a
  // connection-wide throttle — which would also slow the HTML/CSS/JS the
  // FIRST measure() itself waits on, muddying which delay produced which
  // number — the Fetch domain intercepts ONLY the woff2 requests and holds
  // each one open for a fixed delay before letting it complete. That keeps
  // the race isolated to exactly the thing decision (font race) is about:
  // armDeck's first, synchronous measure() runs at DOMContentLoaded against
  // whatever metrics are available RIGHT THEN (fallback, since the fonts
  // are still being held), and document.fonts.ready only resolves once
  // this interception actually lets them through.
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
  const FONT_DELAY_MS = 2500;
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*.woff2', requestStage: 'Request' }] });
  let interceptedFonts = 0;
  cdp.on('Fetch.requestPaused', async (p) => {
    interceptedFonts += 1;
    await sleep(FONT_DELAY_MS);
    await cdp.send('Fetch.continueRequest', { requestId: p.requestId });
  });

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(600); // DOMContentLoaded + armDeck's synchronous first measure() — the woff2 files are still held by the interceptor above
  const fallback = JSON.parse(await ev(`JSON.stringify({
    height: document.querySelector('[data-deck-reel]').getBoundingClientRect().height,
    fontsStatus: document.fonts.status,
    armed: document.querySelector('.lp-sheet').classList.contains('is-armed'),
  })`));

  const afterFontsResult = await cdp.send('Runtime.evaluate', {
    expression: `document.fonts.ready.then(() => JSON.stringify({ height: document.querySelector('[data-deck-reel]').getBoundingClientRect().height, fontsStatus: document.fonts.status }))`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (afterFontsResult.exceptionDetails) throw new Error(afterFontsResult.exceptionDetails.exception?.description);
  const afterFonts = JSON.parse(afterFontsResult.result.value);

  console.log('\n══════ FONT-LOADING RACE (woff2 requests held ' + FONT_DELAY_MS + 'ms each via Fetch interception) ══════');
  console.log('fonts intercepted:', interceptedFonts);
  console.log('fallback measurement (armed:', fallback.armed, ', fonts:', fallback.fontsStatus, '):', fallback.height, 'px');
  console.log('authoritative measurement (fonts.ready resolved, fonts:', afterFonts.fontsStatus, '):', afterFonts.height, 'px');
  console.log('delta (px):', afterFonts.height - fallback.height);

  await cdp.send('Fetch.disable');

  // ── Fix round 2: fonts landing mid-transition must not strand the deck ──
  // Reproduces the actual race, not a proxy for it: hold every woff2
  // request open (this time indefinitely, under my own control) through
  // Skip #1 and #2, click Skip a 3rd time (the deck starts travelling
  // toward the wraparound clone, a real 400ms CSS transition in flight),
  // release the held fonts ~120ms into that transition — well before it
  // would finish on its own — then confirm a 4th Skip still advances. Pre
  // fix, jump()'s cancellation of that in-flight transition (from
  // remeasure(), fired by the now-resolved document.fonts.ready) would
  // have suppressed transitionend, left deck.index() pinned at 3, and
  // made this 4th Skip a silent no-op.
  //
  // AT 1440px THIS DOES NOT REPRODUCE THE BUG — found by testing the
  // reproduction itself against the reverted code and watching it stay
  // green. jump(deck.index()) only actually CANCELS the in-flight
  // transition if it writes a DIFFERENT pixel target than paint() already
  // set when the transition started; a same-value write is not a change,
  // and a transition that was never redirected completes and fires
  // transitionend normally regardless of how many times .is-jumping was
  // toggled around it. The target only differs if measure() (called by
  // remeasure(), just before jump()) produces a different `h` than the
  // one paint() used — i.e. only if the font swap actually changes the
  // tallest slide's height, which the FONT-LOADING RACE phase above
  // already established is 0px at 1440 on this machine and -27px at
  // 390px. So this phase runs at 390px, where the race is real.
  //
  // The FONT-LOADING RACE phase just above already loaded (and cached)
  // every font this page uses in this same long-lived browser profile —
  // without disabling the cache here, the fonts resolve from disk, no
  // network request is even made, and there is nothing for Fetch to hold.
  //
  // And the REDUCED MOTION phase earlier in this SAME script left
  // prefers-reduced-motion: reduce active — found by writing this
  // reproduction, running it, and getting a clean "not stranded" against
  // deliberately-reverted code, which should be impossible. Under reduced
  // motion .lp-deck__reel has `transition: none !important;`, so Skip #3
  // has no transition to interrupt in the first place: next()'s own
  // reduced() branch settles synchronously, inside the SAME click
  // handler, before this phase's font release ever runs — a real
  // reproduction needs a real, active transition to land inside.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  // height:1300, not 900 — at 390px the hero stacks to one column and the
  // Skip button sits around y=1200 (measured earlier, this same session);
  // Input.dispatchMouseEvent is viewport-relative, so a click computed
  // from getBoundingClientRect() at a Y past the emulated viewport height
  // lands nowhere, which would silently make every click in this phase a
  // no-op regardless of which build is running — a false "stranded" that
  // has nothing to do with the fix. Tall enough here that the whole hero
  // is in view without needing to scroll it first.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1300, deviceScaleFactor: 1, mobile: false }); // mobile:false — real mouse clicks, not touch emulation (see the round-1 report's own note on that quirk)
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*.woff2', requestStage: 'Request' }] });
  const held = [];
  cdp.on('Fetch.requestPaused', (p) => { held.push(p.requestId); });
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(1200);

  const clickSkip = async () => {
    const r = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('[data-deck-skip]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })())`));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };

  await clickSkip(); await sleep(450); // 1/3 -> 2/3, fully settled
  const afterFirst = await ev(`document.querySelector('[data-deck-count]').textContent`);
  await clickSkip(); await sleep(450); // 2/3 -> 3/3, fully settled
  const afterSecond = await ev(`document.querySelector('[data-deck-count]').textContent`);
  console.log('sanity — counter after clicks 1 and 2 (must be "2 / 3" then "3 / 3", or the clicks are not landing):', afterFirst, afterSecond);
  await clickSkip(); // 3/3 -> onto the clone; 400ms transition starts now
  await sleep(120); // well inside the transition
  const heldCount = held.length;
  await Promise.all(held.map((id) => cdp.send('Fetch.continueRequest', { requestId: id })));
  const fontsReadyStart = Date.now();
  await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
  const fontsReadyMs = Date.now() - fontsReadyStart;
  await sleep(300); // let remeasure()'s reconciliation (or, pre-fix, nothing) settle

  const afterRelease = JSON.parse(await ev(`JSON.stringify({ count: document.querySelector('[data-deck-count]').textContent, reelTransform: document.querySelector('[data-deck-reel]').style.transform })`));
  await clickSkip(); // the 4th Skip — must advance, not be a no-op
  await sleep(500);
  const afterFourth = JSON.parse(await ev(`JSON.stringify({ count: document.querySelector('[data-deck-count]').textContent, reelTransform: document.querySelector('[data-deck-reel]').style.transform })`));

  console.log('\n══════ FIX ROUND 2: FONTS RESOLVING MID-TRANSITION MUST NOT STRAND THE DECK ══════');
  console.log('woff2 requests held then released:', heldCount, ` (document.fonts.ready resolved ${fontsReadyMs}ms after release)`);
  console.log('after release, before the 4th Skip:', afterRelease, ' (fix: reconciled back to "1 / 3" already; bug: still "1 / 3" too, since the clone mirrors paper 1 — the counter alone cannot tell them apart)');
  console.log('after the 4th Skip:', afterFourth);
  const notStranded = afterRelease.count !== afterFourth.count;
  console.log('4th Skip actually advanced the counter (not stranded on the clone):', notStranded);

  await cdp.send('Fetch.disable');

  console.log('\n══════ SUMMARY ══════');
  console.log([
    `strandedFix=${notStranded ? 'OK-not-stranded' : 'STRANDED'}`,
    `counters=${JSON.stringify(counters)}`,
    `wrapsTo1/3=${counters[2] === '1 / 3'}`,
    `transformHomeAfter3rd=${after3.reelTransform === 'translateY(0px)'}`,
    `deckHeightConstant=${new Set(deckHeights).size === 1}(${deckHeights.join(',')})`,
    `focusIsSheet=${after3.activeIsSheet}`,
    `arrowsMove=${beforeArrow.count !== afterDown.count && afterDown.count !== afterUp.count}`,
    `noPageScroll=${beforeArrow.scrollY === afterDown.scrollY && afterDown.scrollY === afterUp.scrollY}`,
    `reducedInstant=${reducedDuration === '0s'}`,
    `noJsOnePaper=${noJs.visibleSlides === 1 && !noJs.armed && noJs.skipHidden === true && noJs.footHidden === true}`,
    `fontRaceDelta=${afterFonts.height - fallback.height}px(${fallback.height}->${afterFonts.height})`,
  ].join(' '));

  ws.close();
} finally {
  chrome.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
