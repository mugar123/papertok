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
// `label-content-name-mismatch` (WCAG 2.5.3, tagged wcag21a) is enabled
// explicitly, not just tag-included: axe-core ships it tagged BOTH `wcag21a`
// and `experimental`, and `runOnly` with a tag list excludes any rule also
// tagged `experimental` regardless of its other tags — the RULES tag set
// below would silently never run it otherwise (fix round 1, review finding).
//
// Same probe, two more checks task 11 groups with the axe run: reflow at
// 320x568 and 390x844 (no horizontal scroll, no body text under 16px) and a
// 200%-zoom equivalent at 720x450 — a true half of 1440x900, not a
// same-height crop of it — with deviceScaleFactor 2 (no horizontal scroll).
// Every scene prints its numbers; the process exits 1 if any axe violation
// turned up in any configuration, OR if any reflow/zoom scene found
// horizontal scroll or sub-16px body text — a "0 violations, but the page
// still scrolls sideways at 320px" run is not a pass.
//
// Every scene also checks that it actually loaded THIS page, not a dead
// server's error page or a blank tab (fix round 1, review finding: the
// harness used to report 0 violations against Chrome's own "can't reach this
// page" screen). `Page.navigate`'s own `errorText` is checked, and a
// sentinel (`#main-content .lp-hero` by default) must exist after load, or
// the scene throws instead of silently proceeding as if nothing were wrong.
//
// If nothing answers at `url` yet, this script starts its own `vite preview`
// on that port from the already-built `dist/` (never touches a server that
// was already answering — never kills someone else's) and tears it down in
// `finally`, so `npm run a11y:landing` is safe to chain straight after
// `npm run build` in `npm run check` without a developer having to remember
// to start a preview server by hand first.
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
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , url] = process.argv;
if (!url) {
  console.error('usage: node scripts/diagnostics/landing-axe.mjs <url>');
  process.exit(1);
}

const AXE_SRC = readFileSync(fileURLToPath(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');
const RULES = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];
const SENTINEL = '#main-content .lp-hero';

/** Starts our own `vite preview` for `url`'s port if nothing answers there
 * yet; returns the child process to kill in `finally`, or `null` if a server
 * was already up (in which case it is left running — it is not ours). */
async function ensurePreviewServer(target) {
  try {
    await fetch(target);
    return null; // something is already serving this URL — use it, don't touch it
  } catch { /* nothing there — start our own */ }

  const { port } = new URL(target);
  console.log(`no server answering at ${target} — starting "vite preview --port ${port}" from ${REPO_ROOT}dist`);
  // The vite binary directly, not `npx vite`: npx interposes its own process
  // between this script and vite, and killing THAT process does not
  // reliably kill the vite child it spawned underneath — measured: it
  // leaked a listener on the port past this script's own exit.
  const proc = spawn(join(REPO_ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--port', port || '4173', '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  // Poll our OWN server on localhost, not `target` — `target`'s host may not
  // be local at all (a bad hostname stays unreachable forever regardless of
  // what we just started; a live diagnosis of that needs Page.navigate's own
  // errorText, below, not a poll loop that can never succeed). Confirming
  // localhost:<port> answers is all "did our own `vite preview` come up"
  // needs; it deliberately does not confirm `target` itself is reachable.
  // "localhost", not the literal 127.0.0.1: measured, `vite preview`'s
  // default host binds IPv6 loopback (::1) only — curl/fetch to the literal
  // IPv4 address refuses the connection even while "localhost" answers.
  for (let i = 0; i < 150; i++) {
    try { await fetch(`http://localhost:${port || '4173'}/`); return proc; } catch { /* still starting */ }
    await sleep(200);
  }
  proc.kill('SIGKILL');
  throw new Error(`our own "vite preview --port ${port}" never came up on 127.0.0.1 in time`);
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
 * moment to settle — mirrors landing-shots.mjs's own sleep(1200) comment.
 * Then proves the page that loaded is actually THIS page: `Page.navigate`'s
 * own `errorText` (set for a refused connection, a DNS failure, etc.) fails
 * loudly instead of being ignored, and `sentinel` must exist in the DOM
 * afterwards — a dead server, a blank tab or Chrome's own error page all
 * have neither, and used to read as "0 violations, nothing to report". */
async function loadScene(cdp, { width, height, mobile, touch, theme, deviceScaleFactor = 1, sentinel = SENTINEL }, label) {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!touch });
  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) {
    throw new Error(`[${label}] Page.navigate failed: ${nav.errorText} — is anything actually serving ${url}?`);
  }
  await sleep(1200);
  await cdp.evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true").catch(() => {});
  await sleep(150);

  const check = await cdp.evaluate(`(() => ({
    hasSentinel: !!document.querySelector(${JSON.stringify(sentinel)}),
    title: document.title,
    bodySnippet: (document.body && document.body.innerText || '').slice(0, 120),
  }))()`, false);
  if (!check.hasSentinel) {
    throw new Error(
      `[${label}] loaded a page with no "${sentinel}" — this is not the landing page. `
      + `title=${JSON.stringify(check.title)} body starts with ${JSON.stringify(check.bodySnippet)}. `
      + `A dead/refused server, an empty tab or Chrome's own error page would all look like `
      + `this and previously read as "0 violations" instead of failing.`,
    );
  }
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
  const options = { runOnly: RULES, rules: { 'label-content-name-mismatch': { enabled: true } } };
  const result = await cdp.evaluate(`axe.run(document, ${JSON.stringify(options)}).then((r) => ({
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
// No --hide-scrollbars: this script never screenshots (unlike landing-shots.mjs,
// where that flag earns its keep), and suppressing scrollbars here would only
// ever make the scrollWidth/innerWidth reflow checks MORE forgiving than a real
// browser with a classic (non-overlay) scrollbar — the opposite of what a gate
// should do (fix round 1, review finding).
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let ownServer = null;

let failures = 0;
try {
  // Inside the try, not before it: if starting our own preview server fails,
  // `chrome` (already spawned above) still needs the `finally` below to kill it.
  ownServer = await ensurePreviewServer(url);
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ── axe: three configurations ──
  await loadScene(cdp, { width: 390, height: 844, mobile: true, touch: true, theme: 'light', deviceScaleFactor: 2 }, '390x844 light');
  failures += await runAxe(cdp, '390x844, touch, prefers-color-scheme: light');

  await loadScene(cdp, { width: 390, height: 844, mobile: true, touch: true, theme: 'dark', deviceScaleFactor: 2 }, '390x844 dark');
  failures += await runAxe(cdp, '390x844, touch, prefers-color-scheme: dark');

  await loadScene(cdp, { width: 1440, height: 900, mobile: false, touch: false, theme: 'light', deviceScaleFactor: 1 }, '1440x900 light');
  failures += await runAxe(cdp, '1440x900, prefers-color-scheme: light (pinned explicitly)');

  // ── reflow: 320 and 390, no horizontal scroll, no body text under 16px ──
  await loadScene(cdp, { width: 320, height: 568, mobile: true, touch: true, theme: 'light', deviceScaleFactor: 1 }, '320x568');
  failures += await reflowScene(cdp, '320x568');

  await loadScene(cdp, { width: 390, height: 844, mobile: true, touch: true, theme: 'light', deviceScaleFactor: 1 }, '390x844 reflow');
  failures += await reflowScene(cdp, '390x844');

  // ── zoom: a true half of 1440x900 (720x450), deviceScaleFactor 2 — 200% zoom, not a taller crop of it ──
  await loadScene(cdp, { width: 720, height: 450, mobile: false, touch: false, theme: 'light', deviceScaleFactor: 2 }, '720x450 zoom');
  failures += await zoomScene(cdp, '1440x900 @ 200% zoom (width 720, height 450, deviceScaleFactor 2)');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} total issue(s) across all scenes.`);
} finally {
  chrome.kill('SIGKILL');
  if (ownServer) ownServer.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
process.exit(failures ? 1 : 0);
