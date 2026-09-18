// axe-core over the BUILT landing page, in headless Chrome via CDP. No
// dependencies beyond axe-core itself (devDependency) — same no-dependency
// CDP harness as landing-shots.mjs (spawn Chrome, Emulation.*, Page.navigate,
// Runtime.evaluate), extended with a `.evaluate()` helper that awaits a
// promise and returns its value (follow-sheet-probe.mjs's own pattern).
//
//   node scripts/diagnostics/landing-axe.mjs <url>
//
// Runs axe.run() against WCAG 2.0/2.1/2.2 A+AA plus best-practice, in three
// configurations (task 11's brief): 390x844 with touch emulation and
// prefers-color-scheme: light; the same at 390 with prefers-color-scheme:
// dark; and 1440x900. The 1440 run ALSO pins prefers-color-scheme to light
// explicitly — headless Chrome otherwise inherits this machine's own OS-level
// dark preference (see landing-shots.mjs's own THEME handling), which would
// make the "desktop" run silently test whichever theme the machine running
// this script happens to prefer, rather than a fixed, reproducible one.
//
// Same probe, two more checks task 11 groups with the axe run: reflow at
// 320x568 and 390x844 (no horizontal scroll, no body text under 16px) and a
// 200%-zoom equivalent at 1440 with deviceScaleFactor 2 and width 720 (no
// horizontal scroll). Every scene prints its numbers; the process exits 1 if
// any axe violation turned up in any configuration, OR if any reflow/zoom
// scene found horizontal scroll or sub-16px body text — a "0 violations, but
// the page still scrolls sideways at 320px" run is not a pass.
//
// PORT=<n> picks another debugging port, CHROME=<path> another Chromium
// binary — same env convention as this directory's other CDP scripts.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9242);
const PROFILE = join(tmpdir(), `papertok-landing-axe-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , url] = process.argv;
if (!url) {
  console.error('usage: node scripts/diagnostics/landing-axe.mjs <url>');
  process.exit(1);
}

const AXE_SRC = readFileSync(fileURLToPath(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');
const RULES = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];

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
  /** Runs `expression`, awaits it if it is a promise, and returns the JSON-serialized value. */
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('no page target');
}

/** Navigates fresh (so the theme-resolution inline script in index.html sees
 * the media emulation set below it) and gives fonts/prerendered markup a
 * moment to settle — mirrors landing-shots.mjs's own sleep(1200) comment. */
async function loadScene(cdp, { width, height, mobile, touch, theme, deviceScaleFactor = 1 }) {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!touch });
  await cdp.send('Page.navigate', { url });
  await sleep(1200);
  await cdp.evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true").catch(() => {});
  await sleep(150);
}

async function runAxe(cdp, label) {
  await cdp.send('Runtime.evaluate', { expression: AXE_SRC });
  const summarize = (v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    target: (v.nodes[0] && v.nodes[0].target && v.nodes[0].target[0]) || null,
    help: v.help,
    failureSummary: v.nodes[0] && v.nodes[0].failureSummary,
  });
  const result = await cdp.evaluate(`axe.run(document, { runOnly: ${JSON.stringify(RULES)} }).then((r) => ({
    violations: r.violations.map(${summarize}),
    incomplete: r.incomplete.map(${summarize}),
    passes: r.passes.length,
  }))`);
  console.log(`\n=== axe: ${label} ===`);
  console.log(`  ${result.passes} rule(s) passed, ${result.incomplete.length} incomplete (needs-review), ${result.violations.length} violation(s)`);
  for (const v of result.violations) {
    console.log(`  [VIOLATION, ${v.impact}] ${v.id} — ${v.nodes} node(s) — first target: ${v.target}`);
    console.log(`      ${v.help}`);
    if (v.failureSummary) console.log(`      ${v.failureSummary.replace(/\n/g, '\n      ')}`);
  }
  for (const v of result.incomplete) {
    console.log(`  [needs-review, ${v.impact}] ${v.id} — ${v.nodes} node(s) — first target: ${v.target}`);
    console.log(`      ${v.help}`);
    if (v.failureSummary) console.log(`      ${v.failureSummary.replace(/\n/g, '\n      ')}`);
  }
  return result.violations.length;
}

async function reflowScene(cdp, label) {
  const r = await cdp.evaluate(`(() => {
    const bodyTextEls = [...document.querySelectorAll('p.lp-body, .lp-strip p')];
    const sizes = bodyTextEls.map((el) => parseFloat(getComputedStyle(el).fontSize));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      count: sizes.length,
      minFontSize: sizes.length ? Math.min(...sizes) : null,
    };
  })()`, false);
  const overflow = r.scrollWidth > r.innerWidth;
  const tooSmall = r.minFontSize !== null && r.minFontSize < 16;
  console.log(`\n=== reflow: ${label} ===`);
  console.log(`  scrollWidth=${r.scrollWidth}px innerWidth=${r.innerWidth}px${overflow ? '  <-- HORIZONTAL SCROLL' : '  (no horizontal scroll)'}`);
  console.log(`  body text (p.lp-body, .lp-strip p): ${r.count} element(s), smallest font-size ${r.minFontSize}px${tooSmall ? '  <-- BELOW 16px' : ''}`);
  return overflow || tooSmall ? 1 : 0;
}

async function zoomScene(cdp, label) {
  const r = await cdp.evaluate(`(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))()`, false);
  const overflow = r.scrollWidth > r.innerWidth;
  console.log(`\n=== zoom: ${label} ===`);
  console.log(`  scrollWidth=${r.scrollWidth}px innerWidth=${r.innerWidth}px${overflow ? '  <-- HORIZONTAL SCROLL' : '  (no horizontal scroll)'}`);
  return overflow ? 1 : 0;
}

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

let failures = 0;
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ── axe: three configurations ──
  await loadScene(cdp, { width: 390, height: 844, mobile: true, touch: true, theme: 'light', deviceScaleFactor: 2 });
  failures += await runAxe(cdp, '390x844, touch, prefers-color-scheme: light');

  await loadScene(cdp, { width: 390, height: 844, mobile: true, touch: true, theme: 'dark', deviceScaleFactor: 2 });
  failures += await runAxe(cdp, '390x844, touch, prefers-color-scheme: dark');

  await loadScene(cdp, { width: 1440, height: 900, mobile: false, touch: false, theme: 'light', deviceScaleFactor: 1 });
  failures += await runAxe(cdp, '1440x900, prefers-color-scheme: light (pinned explicitly)');

  // ── reflow: 320 and 390, no horizontal scroll, no body text under 16px ──
  await loadScene(cdp, { width: 320, height: 568, mobile: true, touch: true, theme: 'light', deviceScaleFactor: 1 });
  failures += await reflowScene(cdp, '320x568');

  await loadScene(cdp, { width: 390, height: 844, mobile: true, touch: true, theme: 'light', deviceScaleFactor: 1 });
  failures += await reflowScene(cdp, '390x844');

  // ── zoom: 1440 CSS px squeezed into 720 by deviceScaleFactor 2 (200% zoom equivalent) ──
  await loadScene(cdp, { width: 720, height: 900, mobile: false, touch: false, theme: 'light', deviceScaleFactor: 2 });
  failures += await zoomScene(cdp, '1440 @ 200% zoom (width 720, deviceScaleFactor 2)');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} total issue(s) across all scenes.`);
} finally {
  chrome.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
process.exit(failures ? 1 : 0);
