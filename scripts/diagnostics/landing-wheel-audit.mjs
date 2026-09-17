// Proves three things about the pile's picker wheel (src/landing/motion.js,
// armPile/makeWheel) that a unit test cannot: that it actually turns in a
// real browser, that nothing about turning it moves the page's scroll
// position, and that a click spins it again. No dependencies; Node >= 22 for
// the global WebSocket — same no-dependency CDP harness as the other scripts
// in this directory (see landing-shots.mjs).
//
//   node scripts/diagnostics/landing-wheel-audit.mjs [origin]
//
// Defaults to http://localhost:4179/ (`npx vite preview --port 4179
// --strictPort`). PORT=<n> picks another debugging port, CHROME=<path>
// another Chromium binary.
//
// Method: navigate, then run a page-side rAF loop for ~2.5s that (a) fires
// `.lp-pile.scrollIntoView()` — the arrival a real visitor triggers by
// scrolling down to it — and (b) every frame records the barrel's `rotate`,
// the centre slot's title, and `document.documentElement.scrollTop`. The
// barrel's fractional angle plus a whole-row counter (incremented whenever
// the centre slot's text changes — exactly when motion.js's own `base`
// advances) gives a continuous row position; consecutive frames' deltas are
// rows-per-frame. A synthetic `element.click()` would prove nothing about
// reachability (see the profile-anatomy probe's own finding on this) — a
// handler bound to an unreachable or covered element still fires — so the
// click test dispatches a REAL mouse press at the pile's on-screen
// coordinates over CDP, the same class of input `Input.dispatchMouseEvent`
// gives the older deck/graph wheel-audit in this directory.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9256);
const ORIGIN = process.argv[2] || process.env.ORIGIN || 'http://localhost:4179/';
const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Number(process.env.HEIGHT || 900);
const PROFILE = join(tmpdir(), `lp-wheel-audit-${process.pid}`);
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

let exitCode = 0;
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Belt and suspenders against this machine's own accessibility settings —
  // the wheel is JS-gated on prefers-reduced-motion (shouldAnimate() in
  // motion.js), and a host with "reduce motion" on would otherwise make
  // every number below a false "it doesn't spin" rather than a true one.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  const ev = async (expression, awaitPromise = true) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  await cdp.send('Page.navigate', { url: ORIGIN });
  await sleep(1200); // self-hosted fonts and the prerendered markup settling

  const gate = await ev(`JSON.stringify({
    dataMotion: document.documentElement.getAttribute('data-motion'),
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    wide: window.matchMedia('(min-width: 768px) and (hover: hover) and (pointer: fine)').matches,
    pile: !!document.querySelector('.lp-pile'),
    barrelSlots: (document.querySelector('.lp-pile__barrel') || { children: [] }).children.length,
  })`);
  console.log('gate:', gate);
  const gateObj = JSON.parse(gate);
  if (gateObj.dataMotion !== 'on') {
    console.log('⚠ data-motion is not "on" — armPile() never runs, so nothing below will move. Failing loudly rather than reporting zeroes as if they proved something.');
    process.exitCode = 1;
  }

  // ── Phase 1: arrival ──────────────────────────────────────────────────
  const ARRIVAL_MS = 2500;
  const arrivalJson = await ev(`(() => new Promise((resolve) => {
    const barrel = document.querySelector('.lp-pile__barrel');
    const pile = document.querySelector('.lp-pile');
    if (!barrel || !pile) { resolve(JSON.stringify({ error: 'no .lp-pile__barrel found' })); return; }
    const centre = barrel.children[6];
    const titleEl = centre.querySelector('.lp-pile__title');
    function readAngle() {
      const raw = barrel.style.rotate || '';
      const m = raw.match(/(-?[\\d.]+)deg/);
      return m ? parseFloat(m[1]) : 0;
    }
    let wholeRows = 0;
    let lastText = titleEl.textContent;
    const log = [];
    const t0 = performance.now();
    function frame() {
      const now = performance.now();
      const txt = titleEl.textContent;
      if (txt !== lastText) { wholeRows += 1; lastText = txt; }
      const angle = readAngle();
      const fractional = angle === 0 ? 0 : (-angle / 9);
      log.push({ t: Math.round(now - t0), pos: wholeRows + fractional, scrollTop: Math.round(document.documentElement.scrollTop) });
      if (now - t0 < ${ARRIVAL_MS}) requestAnimationFrame(frame);
      else resolve(JSON.stringify({ log }));
    }
    requestAnimationFrame(frame);
    // The arrival a real visitor triggers by scrolling down to the section.
    pile.scrollIntoView({ block: 'center', behavior: 'instant' });
  }))()`);
  const arrival = JSON.parse(arrivalJson);
  if (arrival.error) throw new Error(`arrival phase: ${arrival.error}`);

  const log = arrival.log;
  const rpf = [];
  for (let i = 1; i < log.length; i++) rpf.push(log[i].pos - log[i - 1].pos);
  const peak = Math.max(...rpf);
  const totalMoved = log[log.length - 1].pos - log[0].pos;

  // Where scrollTop stopped changing — everything after that is the spin
  // alone, decoupled from the one deliberate scroll this script made.
  let lastScrollChangeIdx = 0;
  for (let i = 1; i < log.length; i++) if (log[i].scrollTop !== log[i - 1].scrollTop) lastScrollChangeIdx = i;
  const scrollSettledAt = log[lastScrollChangeIdx].t;
  const posAtSettle = log[lastScrollChangeIdx].pos;
  const posAtEnd = log[log.length - 1].pos;
  const spunAfterSettle = posAtEnd - posAtSettle;
  const scrollTopsAfterSettle = new Set(log.slice(lastScrollChangeIdx).map((s) => s.scrollTop));
  const scrollStableWhileSpinning = scrollTopsAfterSettle.size === 1;

  console.log('\n══════ ARRIVAL (IntersectionObserver, threshold 0.5) ══════');
  console.log(`frames sampled: ${log.length} over ${log[log.length - 1].t}ms`);
  console.log(`barrel moved: ${totalMoved.toFixed(2)} rows (${totalMoved > 0 ? 'YES, it turned' : 'NO — did not move'})`);
  console.log(`peak rows/frame: ${peak.toFixed(3)} ${peak <= 0.8 ? '(at or under the ~0.8 ceiling)' : '⚠ ABOVE ~0.8 — this would read as strobing, not spinning'}`);
  console.log(`scrollTop: settled at t=${scrollSettledAt}ms (value ${log[lastScrollChangeIdx].scrollTop}px); wheel then turned ${spunAfterSettle.toFixed(2)} more rows over the remaining ${log[log.length - 1].t - scrollSettledAt}ms with scrollTop ${scrollStableWhileSpinning ? 'UNCHANGED' : 'ALSO CHANGING ⚠'}`);
  console.log(`scrollTop distinct values after settle: ${[...scrollTopsAfterSettle].join(', ')}`);

  // ── Phase 2: click re-spins ──────────────────────────────────────────
  await sleep(300); // let the arrival flick fully finish coasting
  const before = await ev(`(() => {
    const barrel = document.querySelector('.lp-pile__barrel');
    const titleEl = barrel.children[6].querySelector('.lp-pile__title');
    return JSON.stringify({ text: titleEl.textContent, angle: barrel.style.rotate || '' });
  })()`);
  const beforeState = JSON.parse(before);

  const rectJson = await ev(`(() => {
    const r = document.querySelector('.lp-pile').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: r.top, bottom: r.bottom, vh: window.innerHeight });
  })()`);
  const rect = JSON.parse(rectJson);

  const CLICK_MS = 1500;
  // Start the post-click sampler BEFORE dispatching the click so the very
  // first frame after the press is inside the sampling window; `send`
  // returns a promise keyed by request id, so it can be issued now and
  // awaited after the real click below without blocking on it.
  const clickWatchPromise = cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => new Promise((resolve) => {
      const barrel = document.querySelector('.lp-pile__barrel');
      const titleEl = barrel.children[6].querySelector('.lp-pile__title');
      let wholeRows = 0;
      let lastText = titleEl.textContent;
      const t0 = performance.now();
      const log = [];
      function frame() {
        const now = performance.now();
        const txt = titleEl.textContent;
        if (txt !== lastText) { wholeRows += 1; lastText = txt; }
        log.push({ t: Math.round(now - t0), wholeRows, angle: barrel.style.rotate || '' });
        if (now - t0 < ${CLICK_MS}) requestAnimationFrame(frame);
        else resolve(JSON.stringify({ log }));
      }
      requestAnimationFrame(frame);
    }))()`,
  });
  await sleep(60); // let the sampler's first frame land before the press arrives
  if (rect.top < 0 || rect.top > rect.vh) console.log(`⚠ pile is not in the viewport (top=${rect.top}, vh=${rect.vh}) — the click below will miss`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  const clickResult = await clickWatchPromise;
  if (clickResult.exceptionDetails) throw new Error(clickResult.exceptionDetails.exception?.description || 'click watch failed');
  const clickLog = JSON.parse(clickResult.result.value).log;
  const clickMoved = clickLog[clickLog.length - 1].wholeRows > 0 || clickLog.some((s) => s.angle !== clickLog[0].angle);

  console.log('\n══════ CLICK (real CDP mouse press on .lp-pile) ══════');
  console.log(`clicked at (${rect.x}, ${rect.y})`);
  console.log(`state before: text="${beforeState.text}" angle="${beforeState.angle}"`);
  console.log(`spins again on click: ${clickMoved ? 'YES' : 'NO'} (${clickLog[clickLog.length - 1].wholeRows} whole rows crossed in ${CLICK_MS}ms after the press)`);

  console.log('\n══════ SUMMARY ══════');
  console.log(`moved=${totalMoved > 0} peakRowsPerFrame=${peak.toFixed(3)} scrollTopUnchangedWhileSpinning=${scrollStableWhileSpinning} clickReSpins=${clickMoved}`);

  ws.close();
} catch (error) {
  console.error('FAILED:', error.message);
  exitCode = 1;
} finally {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  process.exit(exitCode);
}
