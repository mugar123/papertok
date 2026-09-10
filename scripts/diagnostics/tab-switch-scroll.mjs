// What the page does to the READER'S SCROLL when the Explorer changes tab.
// No dependencies (Node >= 22 for the global WebSocket).
//
//   node scripts/diagnostics/tab-switch-scroll.mjs '#/explorer/institution/I…' [at=4000] [ms] [tab=authors|papers]
//
// Switching an institution from Papers to Authors swaps ~30 tall rows for ~30
// short cards, so the document loses thousands of pixels in ONE frame. This
// records the two numbers that say whether the reader is thrown by that:
// `scrollY` and `documentElement.scrollHeight`, per rAF, on the same clock,
// plus the tab strip's viewport-relative top.
//
// WHAT IT MEASURED, 2026-09-11, and the trap it caught. Driven from `at=4000`
// it looks damning: scrollY 3619 -> 2120 in one frame (the browser clamping to
// the new maximum), doc 6177 -> 2933, and then a SECOND jump 2.5s later —
// the clamp lands scrollY exactly ON the maximum, so the infinite-scroll
// sentinel is in view and fetches 30 more authors nobody asked for, the doc
// grows and scroll anchoring drops the reader back down 1463px.
//
// None of it is reachable. `.ee-tabs` is `position: relative`; the only sticky
// thing on the page is `.explorer-toolbar-wrapper`, the search row BELOW it. So
// the strip scrolls away with the content and a finger can only press a tab
// while it is on screen — scrollY <= ~416 on a 1280x900. Driven from `at=416`,
// the honest position, the same switch measures scrollY 416 -> 416, a 0px jump,
// with the strip pinned at tabs.top 56.2 throughout. The document still loses
// 4266px, entirely below the fold, where nobody is looking.
//
// The lesson is the probe's, not the app's: `element.click()` will happily press
// a control no reader could reach, and a scroll bug measured from an impossible
// scroll position is a bug in the measurement. Always drive this from a
// position the tab strip is actually visible at.
//
// `at=` is where the reader is when they click, in document pixels. `at=max`
// scrolls to the bottom.
//
// PROFILE_DIR=<dir> reuses a Chrome profile the user has signed in to.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9229);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const OWN_PROFILE = !process.env.PROFILE_DIR;
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-tabscroll-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch() {
  mkdirSync(PROFILE, { recursive: true });
  return spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
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

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      } else (this.listeners.get(m.method) || []).forEach((fn) => fn(m.params));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result.value;
  }
}

const SAMPLER = `(() => {
  window.__s = []; window.__on = true;
  if (window.__ticking) return; window.__ticking = true;
  const r1 = (n) => Math.round(n * 10) / 10;
  const tick = () => {
    if (window.__on) {
      const tabs = document.querySelector('.ee-tabs');
      const row = document.querySelector('.explorer-list-item, .ee-author-card');
      window.__s.push({
        t: Date.now(),
        y: Math.round(scrollY),
        doc: Math.round(document.documentElement.scrollHeight),
        max: Math.round(document.documentElement.scrollHeight - innerHeight),
        tabs: tabs ? r1(tabs.getBoundingClientRect().top) : null,
        row: row ? r1(row.getBoundingClientRect().top) : null,
        kind: document.querySelector('.ee-author-card') ? 'authors' : (document.querySelector('.explorer-list-item') ? 'papers' : '-'),
        n: document.querySelectorAll('.explorer-list-item, .ee-author-card').length,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const REPORT = `(() => {
  window.__on = false;
  const p = window.__s; const changes = []; let last = '';
  for (const x of p) { const k = JSON.stringify({ ...x, t: 0 }); if (k !== last) { last = k; changes.push(x); } }
  return { frames: p.length, changes, t0: p[0]?.t || 0 };
})()`;

const [, , route, ...rest] = process.argv;
const flags = new Set(rest);
const flag = (name, dflt) => ([...flags].find((f) => f.startsWith(name + '=')) || `${name}=${dflt}`).slice(name.length + 1);
const at = flag('at', '4000');
const tab = flag('tab', 'authors');
const ms = Number([...flags].find((f) => /^\d+$/.test(f)) || 2500);
if (!route) { console.error('usage: tab-switch-scroll.mjs <#route> [at=N|max] [tab=authors|papers] [ms]'); process.exit(2); }

const chrome = launch();
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => console.error('[page exception]', exceptionDetails.text, exceptionDetails.exception?.description?.split('\n')[0] || ''));
  const waitFor = async (expr, limit = 40000) => { const s = Date.now(); while (Date.now() - s < limit) { if (await cdp.eval(expr).catch(() => false)) return true; await sleep(50); } return false; };

  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}${route}` });
  console.log('hero live:      ', await waitFor("!!document.querySelector('.explorer-hero-content') && !document.querySelector('.explorer-skeleton')"));
  console.log('rows present:   ', await waitFor("document.querySelectorAll('.explorer-list-item').length >= 10"));
  await sleep(2500);

  // Where the reader is when they reach for the tab.
  const target = at === 'max' ? 'document.documentElement.scrollHeight' : at;
  console.log('scrolled to:    ', await cdp.eval(`(() => { scrollTo({ top: ${target}, behavior: 'instant' }); return Math.round(scrollY); })()`));
  await sleep(400);

  await cdp.eval(SAMPLER);
  await sleep(150);
  const label = tab === 'authors' ? /autor|author/i : /paper|public/i;
  console.log('clicked:        ', await cdp.eval(`(() => { const b = [...document.querySelectorAll('.ee-tab')].find((x) => ${label}.test(x.textContent)); if (!b) return null; b.click(); return b.textContent.trim(); })()`));
  await sleep(ms);

  const report = await cdp.eval(REPORT);
  const t0 = report.t0;
  console.log(`\nframes: ${report.frames}, distinct: ${report.changes.length}\n`);
  console.log('   t     scrollY    doc     max   tabs.top  row.top  list      n');
  let prev = null;
  for (const c of report.changes) {
    const jump = prev && Math.abs(c.y - prev.y) > 1 ? `  <-- scroll ${c.y - prev.y > 0 ? '+' : ''}${c.y - prev.y}px` : '';
    const shrink = prev && Math.abs(c.doc - prev.doc) > 1 ? `  doc ${c.doc - prev.doc > 0 ? '+' : ''}${c.doc - prev.doc}px` : '';
    console.log(
      String(c.t - t0).padStart(5) + 'ms'
      + String(c.y).padStart(8)
      + String(c.doc).padStart(8)
      + String(c.max).padStart(8)
      + String(c.tabs ?? '-').padStart(10)
      + String(c.row ?? '-').padStart(9)
      + String(c.kind).padStart(9)
      + String(c.n).padStart(4)
      + jump + shrink,
    );
    prev = c;
  }
  const first = report.changes[0]; const last = report.changes[report.changes.length - 1];
  if (first && last) {
    console.log(`\nscrollY  ${first.y} -> ${last.y}   (${last.y - first.y >= 0 ? '+' : ''}${last.y - first.y}px)`);
    console.log(`doc      ${first.doc} -> ${last.doc}   (${last.doc - first.doc >= 0 ? '+' : ''}${last.doc - first.doc}px)`);
    console.log(`tabs.top ${first.tabs} -> ${last.tabs}   (${(last.tabs - first.tabs).toFixed(1)}px)  <- the number a fix has to hold`);
  }
} finally {
  chrome.kill('SIGTERM');
  await sleep(700);
  if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
}
