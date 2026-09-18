// Measures the AI button's actual WCAG contrast ratio, sampled every ~100ms
// across the whole `lpInvite`/`lpInviteDark` breathing animation (motion.css,
// .lp-btn--ai), in a real browser — the check keyframeContrast.test.js's own
// docstring names but that never existed as a file until this task. The unit
// test can only read the CSS source and refuse a keyframe that moves
// `background-color` without taking a position on `color`; it cannot compute
// what the two actually resolve to, because custom properties are only real
// once a browser resolves them, and it cannot see the DARK theme's separate
// keyframe never repainting the plate at all (by design — see motion.css's
// own comment on lpInviteDark) except by trusting the source. This probe
// drives the animation for real (scrolls `[data-rewrite]` into view, same
// arrival a visitor triggers, WITHOUT ever hovering or focusing the button —
// either one calls found() in motion.js and stops the breathing dead, which
// would make every sample after that a false pass reading the resting state
// forever instead of the animation) and reads `getComputedStyle` at every
// sample, in both themes. No dependencies; Node >= 22 for the global
// WebSocket — same no-dependency CDP harness as the other scripts in this
// directory (see landing-shots.mjs, landing-wheel-audit.mjs).
//
//   node scripts/diagnostics/landing-invite-contrast.mjs [url]
//
// Defaults to http://localhost:4173/ (`npx vite preview --port 4173
// --strictPort`), matching landing-deck-probe.mjs's own default. PORT=<n>
// picks another debugging port, CHROME=<path> another Chromium binary.
//
// Exits 1 if any sample in either theme falls under 4.5:1, if the animation
// never actually ran (data-motion never reached "on", or the background
// never changed at all in the light theme, where it is supposed to move),
// or if data-found flipped to '1' mid-run (the sampling itself touched the
// button and silenced the animation it was trying to measure).
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9265);
const URL_ = process.argv[2] || process.env.URL || 'http://localhost:4173/';
const WIDTH = 1440;
const HEIGHT = 900;
const PROFILE = join(tmpdir(), `lp-invite-contrast-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 900ms initial delay + 5 iterations of 2800ms (motion.css:
// `animation: lpInvite 2800ms ease-in-out 900ms 5`), plus a margin so the
// last sample lands after the final breath has fully settled back to rest.
const ANIMATION_MS = 900 + 5 * 2800 + 400;
const SAMPLE_EVERY_MS = 100;

/** WCAG relative luminance + contrast ratio from `rgb(r, g, b)` strings. */
function parseRgb(s) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s || '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

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

async function measureTheme(cdp, ev, theme) {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      // Belt and suspenders against this machine's own accessibility
      // settings, same reasoning as landing-wheel-audit.mjs and
      // landing-deck-probe.mjs: armRewrite() itself is gated behind
      // data-motion, which index.html's inline script refuses to set at
      // all under prefers-reduced-motion.
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ],
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL_ }); // fresh navigation: the theme/motion gates in index.html only run once, before first paint
  await sleep(1200); // self-hosted fonts and the prerendered markup settling

  const gate = JSON.parse(await ev(`JSON.stringify({
    dataMotion: document.documentElement.getAttribute('data-motion'),
    dataTheme: document.documentElement.getAttribute('data-theme'),
    hasRewrite: !!document.querySelector('[data-rewrite]'),
    hasButton: !!document.querySelector('.lp-rewrite .lp-btn--ai'),
  })`));
  if (gate.dataMotion !== 'on' || !gate.hasRewrite || !gate.hasButton) {
    return { theme, ok: false, reason: `gate not ready: ${JSON.stringify(gate)}`, samples: [] };
  }

  await ev(`document.querySelector('[data-rewrite]').scrollIntoView({ block: 'center', behavior: 'instant' }); 'scrolled'`);
  // The IntersectionObserver (threshold 0.5) fires within a frame or two of
  // the scroll landing; poll rather than a fixed sleep so a slow CI host
  // does not read data-seen too early and report a false "never armed".
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(100);
    seen = (await ev(`document.querySelector('[data-rewrite]').getAttribute('data-seen')`)) === '1';
  }
  if (!seen) return { theme, ok: false, reason: 'data-seen never reached 1 after scrolling [data-rewrite] into view', samples: [] };

  const foundBefore = await ev(`document.querySelector('[data-rewrite]').getAttribute('data-found')`);
  if (foundBefore !== '0') return { theme, ok: false, reason: `data-found was already "${foundBefore}" before sampling started — nothing left to measure`, samples: [] };

  // Page-side sampler: setInterval, not requestAnimationFrame — this only
  // needs colour values over time, not frame-perfect timing, and a 60fps
  // sample would be an unnecessarily large payload back over the wire for
  // a ~15s window.
  const raw = await ev(`(() => new Promise((resolve) => {
    var btn = document.querySelector('.lp-rewrite .lp-btn--ai');
    var root = document.querySelector('[data-rewrite]');
    var log = [];
    var t0 = performance.now();
    var timer = setInterval(function () {
      var cs = getComputedStyle(btn);
      log.push({ t: Math.round(performance.now() - t0), bg: cs.backgroundColor, color: cs.color, found: root.getAttribute('data-found') });
      if (performance.now() - t0 >= ${ANIMATION_MS}) {
        clearInterval(timer);
        resolve(JSON.stringify(log));
      }
    }, ${SAMPLE_EVERY_MS});
  }))()`);
  const log = JSON.parse(raw);

  const samples = log.map((s) => {
    const bg = parseRgb(s.bg);
    const fg = parseRgb(s.color);
    return { t: s.t, bg: s.bg, color: s.color, found: s.found, ratio: bg && fg ? ratio(bg, fg) : null };
  });
  const ratios = samples.filter((s) => s.ratio !== null).map((s) => s.ratio);
  const distinctBg = new Set(samples.map((s) => s.bg)).size;
  const foundFlippedMidRun = samples.some((s) => s.found === '1');

  return {
    theme,
    ok: true,
    samples,
    minRatio: Math.min(...ratios),
    minAt: samples.find((s) => s.ratio === Math.min(...ratios))?.t,
    maxRatio: Math.max(...ratios),
    distinctBg,
    foundFlippedMidRun,
  };
}

let exitCode = 0;
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  const results = [];
  for (const theme of ['light', 'dark']) {
    console.log(`\n══════ ${theme.toUpperCase()} ══════`);
    const result = await measureTheme(cdp, ev, theme);
    results.push(result);
    if (!result.ok) {
      console.log(`FAILED: ${result.reason}`);
      exitCode = 1;
      continue;
    }
    console.log(`samples: ${result.samples.length} over ~${ANIMATION_MS}ms, distinct background-color values seen: ${result.distinctBg}`);
    console.log(`contrast ratio: min ${result.minRatio.toFixed(2)}:1 (at t=${result.minAt}ms), max ${result.maxRatio.toFixed(2)}:1`);
    console.log(`data-found stayed "0" for the whole run (sampling never touched the button): ${!result.foundFlippedMidRun}`);
    const below = result.samples.filter((s) => s.ratio !== null && s.ratio < 4.5);
    if (below.length) {
      console.log(`⚠ ${below.length} sample(s) under 4.5:1 — first at t=${below[0].t}ms: bg=${below[0].bg} color=${below[0].color} ratio=${below[0].ratio.toFixed(2)}`);
      exitCode = 1;
    } else {
      console.log('every sample ≥ 4.5:1');
    }
    if (result.foundFlippedMidRun) exitCode = 1;
    // The light theme is expected to actually repaint the plate (three
    // stops: soft, peak, soft — see motion.css); a single distinct value
    // would mean the animation never really ran, which would make the "0
    // samples under 4.5:1" above vacuous rather than a real pass.
    if (theme === 'light' && result.distinctBg < 2) {
      console.log(`⚠ only ${result.distinctBg} distinct background-color value(s) — the light-theme keyframe is supposed to move background-color; this run never actually saw it animate`);
      exitCode = 1;
    }
  }

  console.log('\n══════ SUMMARY ══════');
  console.log(results.map((r) => r.ok
    ? `${r.theme}: min=${r.minRatio.toFixed(2)}:1 max=${r.maxRatio.toFixed(2)}:1 distinctBg=${r.distinctBg} foundFlipped=${r.foundFlippedMidRun}`
    : `${r.theme}: FAILED (${r.reason})`).join('  |  '));
  console.log(exitCode === 0 ? 'PASS' : 'FAIL');

  ws.close();
} catch (error) {
  console.error('FAILED:', error.message);
  exitCode = 1;
} finally {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  process.exit(exitCode);
}
