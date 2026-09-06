// Follow sheet probe over CDP against a headless Chrome. No dependencies.
//
// Opens the follow sheet on a public profile and samples, per frame, what
// the open and the close move (sheet opacity/transform, backdrop, body
// height, rows, state band), stamping when the edges, the names and the
// state band land. `stall` fails every request to Firestore at the network —
// a live client whose channel died — watches what the sheet says for 24 s,
// heals the network and reopens. Written for the 2026-09-06 audit
// ("followers sometimes takes forever"), and kept for the next one.
//
// usage: node scripts/diagnostics/follow-sheet-probe.mjs open  [followers|following] [idle=<s>] [hover=<ms>] [repeat=<n>] [shots] [width=<px>]
//        node scripts/diagnostics/follow-sheet-probe.mjs stall [followers|following]
// env:   ORIGIN  the app (default http://localhost:5173)
//        SERVE   a checkout to serve on ORIGIN's port for the length of the run (its own Vite, killed at the end)
//        HANDLE  the public profile to open (default nick_mugar)
//        PORT    Chrome's remote-debugging port (default 9224; use distinct ports for parallel runs)
//        OUT     where `shots` writes its PNG frames (default: under the OS temp dir)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9224);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const HANDLE = process.env.HANDLE || 'nick_mugar';
// Never beside this script: frames are output, and the repository root is not
// the place for it.
const OUT = process.env.OUT || join(tmpdir(), 'papertok-follow-sheet-frames');
const PROFILE = join(tmpdir(), `papertok-follow-probe-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [mode = 'open', tab = 'followers', ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((f) => f === name || f.startsWith(`${name}=`));
const flagValue = (name, fallback) => { const f = flag(name); return f && f.includes('=') ? f.split('=')[1] : fallback; };
const IDLE_S = Number(flagValue('idle', 0));
const SHOTS = Boolean(flag('shots'));
const WIDTH = Number(flagValue('width', 1280));
const HOVER_MS = Number(flagValue('hover', 0));

function launch() {
  mkdirSync(PROFILE, { recursive: true });
  return spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${WIDTH},900`, '--hide-scrollbars', 'about:blank',
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
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) { this.listeners.set(method, [...(this.listeners.get(method) || []), fn]); }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

async function pollUntil(cdp, expression, timeoutMs, every = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdp.evaluate(expression, false)) return true;
    await sleep(every);
  }
  return false;
}

const BUTTON = (which) => `button[title="${which === 'following' ? 'See followed users' : 'See followers'}"]`;

// Per-frame sampling of everything the open and the close move.
const OPEN_SCRIPT = (which) => `(async () => {
  const q = (s) => document.querySelector(s);
  const btn = q('${BUTTON(which)}');
  if (!btn) return { error: 'no button' };
  const t0 = performance.now();
  const now = () => +(performance.now() - t0).toFixed(1);
  const marks = {};
  const stamp = (k) => { if (marks[k] == null) marks[k] = now(); };
  const check = () => {
    if (q('.follow-sheet')) stamp('sheet');
    if (q('.follow-sheet-loading')) stamp('skeleton');
    if (q('.follow-sheet-loading-note')) stamp('slowNote');
    if (q('.follow-row')) stamp('rows');
    if (q('.follow-row-name')) stamp('names');
    if (q('.follow-sheet-state')) stamp('state');
  };
  const obs = new MutationObserver(check);
  obs.observe(document.body, { childList: true, subtree: true, attributes: true });
  const samples = [];
  const cs = (el) => getComputedStyle(el);
  const sample = () => {
    const sheet = q('.follow-sheet'), backdrop = q('.ui-drawer-backdrop'), body = q('.follow-sheet-body');
    const state = q('.follow-sheet-state'), row = q('.follow-row'), loading = q('.follow-sheet-loading');
    samples.push({
      t: now(),
      sheet: sheet ? { o: +cs(sheet).opacity, tf: cs(sheet).transform, starting: sheet.hasAttribute('data-starting-style'), h: +sheet.getBoundingClientRect().height.toFixed(1) } : null,
      backdrop: backdrop ? +cs(backdrop).opacity : null,
      bodyH: body ? +body.getBoundingClientRect().height.toFixed(1) : null,
      loadingO: loading ? +cs(loading).opacity : null,
      state: state ? { o: +cs(state).opacity, tf: cs(state).transform } : null,
      row: row ? { o: +cs(row).opacity, tf: cs(row).transform } : null,
    });
  };
  let sampling = true;
  const loop = () => { if (!sampling) return; sample(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  if (${HOVER_MS} > 0) {
    // Intent first: the pointer reaches the counter before the click lands.
    btn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    await new Promise((r) => setTimeout(r, ${HOVER_MS}));
    marks.hoverMs = ${HOVER_MS};
  }
  btn.click();
  const settled = () => (marks.names != null || marks.state != null);
  const started = performance.now();
  while (performance.now() - started < 25000) {
    await new Promise((r) => setTimeout(r, 50));
    if (settled() && performance.now() - started > 1200) break;
  }
  sampling = false; obs.disconnect();
  marks.stateText = q('.follow-sheet-state')?.textContent || null;
  marks.nameText = q('.follow-row-name')?.textContent || null;
  marks.noteText = q('.follow-sheet-loading-note')?.textContent || null;
  marks.sheetStyle = q('.follow-sheet')?.getAttribute('style') || null;
  marks.stateAnimations = (q('.follow-sheet-state')?.getAnimations({ subtree: true }) || []).length;
  return { marks, samples };
})()`;

const CLOSE_SCRIPT = `(async () => {
  const q = (s) => document.querySelector(s);
  const close = q('.follow-sheet-close');
  if (!close) return { error: 'no close button' };
  const t0 = performance.now();
  const now = () => +(performance.now() - t0).toFixed(1);
  const samples = [];
  const cs = (el) => getComputedStyle(el);
  let unmountAt = null, backdropGoneAt = null, lastBackdrop = null, lastSheet = null;
  const sample = () => {
    const sheet = q('.follow-sheet'), backdrop = q('.ui-drawer-backdrop');
    if (sheet) lastSheet = { o: +cs(sheet).opacity, tf: cs(sheet).transform, ending: sheet.hasAttribute('data-ending-style') };
    else if (unmountAt == null) unmountAt = now();
    if (backdrop) lastBackdrop = +cs(backdrop).opacity; else if (backdropGoneAt == null) backdropGoneAt = now();
    samples.push({ t: now(), sheet: sheet ? lastSheet : null, backdrop: backdrop ? lastBackdrop : null });
  };
  let sampling = true;
  const loop = () => { if (!sampling) return; sample(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  close.click();
  const started = performance.now();
  while (performance.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 30));
    if (unmountAt != null && backdropGoneAt != null && performance.now() - started > 600) break;
  }
  sampling = false;
  return { unmountAt, backdropGoneAt, lastSheetBeforeUnmount: lastSheet, lastBackdropBeforeGone: lastBackdrop, samples };
})()`;

async function shots(cdp, prefix, count, everyMs) {
  const frames = [];
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const at = Date.now() - t0;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: 700, scale: 1 } });
    const file = join(OUT, `${prefix}-${String(i).padStart(2, '0')}-${at}ms.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ i, at, file });
    const wait = everyMs - (Date.now() - t0 - at);
    if (wait > 0) await sleep(wait);
  }
  return frames;
}

function summarizeSamples(samples, key) {
  // Compact: t, and the fields that changed since the previous sample.
  const out = [];
  let prev = null;
  for (const s of samples) {
    const line = { t: s.t };
    for (const k of Object.keys(s)) {
      if (k === 't') continue;
      const v = JSON.stringify(s[k]);
      if (!prev || JSON.stringify(prev[k]) !== v) line[k] = s[k];
    }
    if (Object.keys(line).length > 1) out.push(line);
    prev = s;
  }
  return out;
}

/** `SERVE=<dir>` runs that tree's Vite on ORIGIN's port for the length of the probe. */
async function serve() {
  const dir = process.env.SERVE;
  if (!dir) return null;
  const port = new URL(ORIGIN).port || '5173';
  const vite = spawn(process.execPath, [join(dir, 'node_modules/vite/bin/vite.js'), '--port', port, '--strictPort', '--clearScreen', 'false'], { cwd: dir, stdio: 'ignore' });
  for (let i = 0; i < 300; i++) {
    try { await fetch(ORIGIN, { method: 'HEAD' }); return vite; } catch { /* not up yet */ }
    await sleep(100);
  }
  vite.kill('SIGKILL');
  throw new Error(`vite never answered on ${ORIGIN}`);
}

const vite = await serve();
const chrome = launch();
try {
  mkdirSync(OUT, { recursive: true });
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: WIDTH < 768 });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const url = `${ORIGIN}/#/public/user/${HANDLE}`;
  const tNav = Date.now();
  await cdp.send('Page.navigate', { url });
  const ready = await pollUntil(cdp, `!!document.querySelector('${BUTTON(tab)}') && !document.querySelector('${BUTTON(tab)}').disabled`, 30000);
  console.log(JSON.stringify({ mode, tab, url, profileReadyMs: Date.now() - tNav, ready }));
  if (!ready) throw new Error('profile never became ready');
  await sleep(600);

  if (IDLE_S > 0) {
    console.log(`idle for ${IDLE_S}s so the listen stream closes on its own…`);
    await sleep(IDLE_S * 1000);
  }

  if (mode === 'stall') {
    // A live client whose channel dies: every new request to Firestore fails at the network.
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*firestore.googleapis.com*', requestStage: 'Request' }] });
    cdp.on('Fetch.requestPaused', (p) => { cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' }).catch(() => {}); });
    console.log('firestore requests now fail with ConnectionReset');
  }

  let frames = null;
  if (SHOTS) {
    // Click, then photograph the arrival at a coarse cadence.
    await cdp.evaluate(`document.querySelector('${BUTTON(tab)}').click(); true`, false);
    frames = await shots(cdp, `open-${tab}`, 12, 60);
    await sleep(1500);
    const closeFrames = [];
    await cdp.evaluate(`document.querySelector('.follow-sheet-close').click(); true`, false);
    frames.push(...await shots(cdp, `close-${tab}`, 10, 60));
    console.log(JSON.stringify({ frames: frames.map((f) => `${f.at}ms ${f.file.split('/').pop()}`) }, null, 0));
  } else {
    const open = await cdp.evaluate(OPEN_SCRIPT(tab));
    if (open.error) throw new Error(open.error);
    console.log('OPEN marks', JSON.stringify(open.marks));
    console.log('OPEN samples (changes only)', JSON.stringify(summarizeSamples(open.samples)));
    if (mode === 'stall') {
      // Keep watching what the sheet says for the rest of the budget, then heal the network and reopen.
      for (let i = 0; i < 6; i++) {
        await sleep(4000);
        console.log(JSON.stringify({ at: `+${(i + 1) * 4}s`, state: await cdp.evaluate(`(() => { const q = s => document.querySelector(s); return { skeleton: !!q('.follow-sheet-loading'), note: q('.follow-sheet-loading-note')?.textContent || null, state: q('.follow-sheet-state')?.textContent || null, rows: document.querySelectorAll('.follow-row').length, names: [...document.querySelectorAll('.follow-row-name')].map(n => n.textContent) }; })()`, false) }));
      }
      await cdp.send('Fetch.disable');
      console.log('network healed; closing and reopening the sheet');
      const closed = await cdp.evaluate(CLOSE_SCRIPT);
      console.log('CLOSE', JSON.stringify({ unmountAt: closed.unmountAt, backdropGoneAt: closed.backdropGoneAt }));
      await sleep(300);
      const reopen = await cdp.evaluate(OPEN_SCRIPT(tab));
      console.log('REOPEN marks', JSON.stringify(reopen.marks));
      await sleep(3000);
      console.log(JSON.stringify({ after3s: await cdp.evaluate(`(() => { const q = s => document.querySelector(s); return { state: q('.follow-sheet-state')?.textContent || null, rows: document.querySelectorAll('.follow-row').length, names: [...document.querySelectorAll('.follow-row-name')].map(n => n.textContent) }; })()`, false) }));
    } else {
      await sleep(400);
      const closed = await cdp.evaluate(CLOSE_SCRIPT);
      if (closed.error) throw new Error(closed.error);
      console.log('CLOSE', JSON.stringify({ unmountAt: closed.unmountAt, backdropGoneAt: closed.backdropGoneAt, lastSheetBeforeUnmount: closed.lastSheetBeforeUnmount, lastBackdropBeforeGone: closed.lastBackdropBeforeGone }));
      console.log('CLOSE samples (changes only)', JSON.stringify(summarizeSamples(closed.samples)));
      // Further opens, after clearing the session caches so each one reads again over a warm connection.
      const repeat = Number(flagValue('repeat', 0));
      for (let i = 0; i < repeat; i++) {
        await sleep(500);
        await cdp.evaluate(`import('/src/utils/profileSessionCaches.js').then(m => { m.followListCache.clear(); m.followRowProfileCache.clear(); return true; })`);
        const again = await cdp.evaluate(OPEN_SCRIPT(tab));
        console.log(`REOPEN#${i + 1} marks`, JSON.stringify({ sheet: again.marks.sheet, rows: again.marks.rows, names: again.marks.names, state: again.marks.state }));
        await sleep(300);
        await cdp.evaluate(CLOSE_SCRIPT);
      }
    }
  }
} finally {
  chrome.kill('SIGKILL');
  vite?.kill('SIGKILL');
}
