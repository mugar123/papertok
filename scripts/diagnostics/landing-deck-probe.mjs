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
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
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

  console.log('\n══════ SUMMARY ══════');
  console.log([
    `counters=${JSON.stringify(counters)}`,
    `wrapsTo1/3=${counters[2] === '1 / 3'}`,
    `transformHomeAfter3rd=${after3.reelTransform === 'translateY(0px)'}`,
    `deckHeightConstant=${new Set(deckHeights).size === 1}(${deckHeights.join(',')})`,
    `focusIsSheet=${after3.activeIsSheet}`,
    `arrowsMove=${beforeArrow.count !== afterDown.count && afterDown.count !== afterUp.count}`,
    `noPageScroll=${beforeArrow.scrollY === afterDown.scrollY && afterDown.scrollY === afterUp.scrollY}`,
    `reducedInstant=${reducedDuration === '0s'}`,
    `noJsOnePaper=${noJs.visibleSlides === 1 && !noJs.armed && noJs.skipHidden === true && noJs.footHidden === true}`,
  ].join(' '));

  ws.close();
} finally {
  chrome.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
