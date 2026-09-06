// Frame-by-frame record of ONE route transition — a card to an entity page,
// the entity back to the feed, a tab to the next — for the before/after of
// docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md.
//
//   node scripts/diagnostics/page-transition-frames.mjs '<css selector>' <label> [demo] [mobile] [back] [idx=N] [scroll=N]
//
// Loads ORIGIN (default http://localhost:5174) at `#/`, waits for the selector
// and the 4.5 s the explorer chunk prefetch needs, then records around ONE
// navigation: the click on the selector, or — with `back` — `history.back()`
// 1.8 s after that click. Two records of the same second:
//
//   * every compositor frame as a JPEG (Page.startScreencast), to
//     <label>-frames/, plus a contact sheet of up to 24 of them,
//     <label>-sheet.png, rendered by the same headless Chrome;
//   * a requestAnimationFrame sampler installed in the page, which notes per
//     frame whether `.navbar` exists and, for each `#main-content > *` (the
//     route pages), its data-page-motion, computed opacity, transform,
//     position and — when the page holds cards under it — the first
//     `.pc-title`'s computed opacity, the held feed must keep it at 1 —
//     written to <label>-samples.json. From it the script prints: frames
//     with the bar, frames with no page at ≥ 0.5 opacity ("void"), frames
//     with two pages (overlap), frames where a held page is still there
//     beside a page already at rest ("exposed": fixed, it paints OVER the
//     page that has just settled — the flash on every tab switch before
//     2026-09-06's fix), the first frame after which one page stands alone
//     at rest ("settled"), and the lowest held-card opacity seen
//     ("held cards ≥ …"). A main thread busy mounting a page skips rAF
//     ticks, so the sampler counts frames the page produced, not wall-clock
//     milliseconds.
//
// `demo` seeds a signed-in demo session in localStorage before the first
// script: build with IS_DEMO = true in src/services/firebase.js for it, and
// put it back to false before committing anything. `mobile` is 390×844 at 2x
// with touch emulation. `idx=N` clicks the Nth match; `scroll=N` (with `back`)
// scrolls the page it opened N px down before the way back, so the leaving
// page's lift by its own scroll (`top` in the samples) is on record. PORT=9232 picks another
// debugging port; OUT=<dir> another output directory; CHROME=<path> another
// binary. No dependencies; Node ≥ 22 for the global WebSocket.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9231);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const OUT = process.env.OUT || process.cwd();
const PROFILE = join(tmpdir(), `papertok-page-transition-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , sel, label = 'run', ...rest] = process.argv;
if (!sel) {
  console.error("usage: page-transition-frames.mjs '<css selector>' <label> [demo] [mobile] [back] [idx=N] [scroll=N]");
  process.exit(2);
}
const flags = new Set(rest);
const idx = Number(([...flags].find((f) => f.startsWith('idx=')) || 'idx=0').slice(4));
const mobile = flags.has('mobile');
const demo = flags.has('demo');
const back = flags.has('back');
const scrollPx = Number(([...flags].find((f) => f.startsWith('scroll=')) || 'scroll=0').slice(7));

const DEMO_SEED = `(() => { try {
  localStorage.setItem('papertok_user', JSON.stringify({ uid: 'demo-user-123', displayName: 'Demo User', email: 'demo@papertok.app', photoURL: '', providerData: [{ providerId: 'google.com' }] }));
  localStorage.setItem('papertok_onboardingComplete', 'true');
  localStorage.setItem('papertok_selectedCategories', JSON.stringify(['bio.neuro', 'physics']));
} catch {} })();`;

// Installed in the page the same tick the navigation is triggered, so t=0 is
// the tap. Samples for 1.4 s, well past every duration in PageTransition.css.
const SAMPLER = `(() => {
  const samples = [];
  const start = performance.now();
  const tick = () => {
    const pages = [...document.querySelectorAll('#main-content > *')].map((el) => {
      const cs = getComputedStyle(el);
      return {
        motion: el.dataset.pageMotion || null,
        opacity: Number(cs.opacity),
        transform: cs.transform,
        position: cs.position,
        top: el.style.top || null,
        card: (() => { const t = el.querySelector('.pc-title'); return t ? Number(getComputedStyle(t).opacity) : null; })(),
      };
    });
    samples.push({ t: Math.round(performance.now() - start), navbar: Boolean(document.querySelector('.navbar')), pages });
    if (performance.now() - start < 1400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__ptSamples = samples;
})();`;

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  }
}

function summarise(samples) {
  const total = samples.length;
  const withBar = samples.filter((s) => s.navbar).length;
  // A held page dims to 0.6 by design, so "void" is a frame with no page even
  // half painted — what mode="wait" used to leave between exit and entrance.
  const voidFrames = samples.filter((s) => !s.pages.some((p) => p.opacity >= 0.5));
  const overlap = samples.filter((s) => s.pages.length >= 2).length;
  const atRest = (s) => s.pages.length === 1
    && (s.pages[0].motion === null || s.pages[0].motion === 'rest')
    && s.pages[0].opacity >= 0.99 && s.pages[0].transform === 'none';
  let moved = false;
  let settled = null;
  for (const s of samples) {
    if (!atRest(s)) moved = true;
    else if (moved && settled === null) settled = s.t;
  }
  // Three answers, not two: a page that never moved is not a page that
  // never stopped moving.
  const settledText = !moved ? 'no movement observed' : settled === null ? 'never within the window' : `${settled} ms`;
  // A held page is meant to be UNDER the page arriving, and the arriving page
  // drops its stacking the frame it settles; a held page still there in that
  // frame is fixed beside a static sibling, and paints over it. Eight such
  // frames per tab switch before 2026-09-06's fix: the For you card at 60%
  // over a Research page already at rest.
  const isHeld = (p) => p.motion === 'hold' || p.motion === 'hold-lateral';
  const isRest = (p) => p.motion === null || p.motion === 'rest';
  const exposed = samples.filter((s) => s.pages.some(isHeld) && s.pages.some(isRest));
  const heldCards = samples.flatMap((s) => s.pages.filter((p) => isHeld(p) && p.card !== null).map((p) => p.card));
  const heldText = heldCards.length ? `held cards ≥ ${Math.min(...heldCards).toFixed(2)}` : 'held cards n/a';
  return `sampler: ${total} frames; bar in ${withBar}/${total}; void ${voidFrames.length} (${voidFrames.map((s) => `${s.t}ms`).join(' ') || '-'}); overlap ${overlap}; exposed ${exposed.length} (${exposed.map((s) => `${s.t}ms`).join(' ') || '-'}); settled at ${settledText}; ${heldText}`;
}

try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (mobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  if (demo) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DEMO_SEED });
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  let ready = false;
  for (let i = 0; i < 400; i++) {
    if (await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length > ${idx}`).catch(() => false)) { ready = true; break; }
    await sleep(100);
  }
  console.log('target ready:', ready);
  if (!ready) throw new Error(`no element matches ${sel} (index ${idx}) within 40 s`);
  await sleep(4500); // past the explorer chunk prefetch, so the transition is the warm case
  const clickExpr = `(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; const t = (el.textContent || '').trim().slice(0, 40); el.click(); return t; })()`;
  if (back) {
    console.log('opened:', await cdp.eval(clickExpr));
    await sleep(1800); // the page it opened is still by now; the record is the way back
    if (scrollPx) {
      // A scroll event only reaches the page's listener on a rendered frame:
      // give it a few before the way back.
      await cdp.eval(`window.scrollTo({ top: ${scrollPx}, behavior: 'instant' })`);
      await sleep(300);
      console.log('scrolled to:', await cdp.eval('window.scrollY'));
    }
  }
  const frames = [];
  cdp.on('Page.screencastFrame', (p) => {
    frames.push({ ts: p.metadata.timestamp, data: p.data });
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: mobile ? 390 : 800, maxHeight: mobile ? 844 : 562, everyNthFrame: 1 });
  await sleep(400);
  const t0 = Date.now() / 1000;
  const target = await cdp.eval(back ? `${SAMPLER} history.back(); 'back'` : `${SAMPLER} ${clickExpr}`);
  console.log(back ? 'went back' : `clicked: ${target}`);
  await sleep(1500);
  await cdp.send('Page.stopScreencast');
  const samples = await cdp.eval('window.__ptSamples');

  const kept = frames.filter((f) => f.ts >= t0 - 0.05);
  const dir = join(OUT, `${label}-frames`);
  mkdirSync(dir, { recursive: true });
  const rel = kept.map((f) => ({ t: Math.round((f.ts - t0) * 1000), data: f.data }));
  rel.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(3, '0')}_${f.t}ms.jpg`), Buffer.from(f.data, 'base64')));
  writeFileSync(join(OUT, `${label}-samples.json`), JSON.stringify(samples, null, 1));
  console.log(`frames kept: ${rel.length} (of ${frames.length}), t = ${rel[0]?.t}..${rel[rel.length - 1]?.t} ms`);
  console.log('frame times (ms):', rel.map((f) => f.t).join(' '));
  console.log(summarise(samples));

  // Contact sheet: up to 24 frames, evenly spaced, rendered by the same Chrome.
  const pick = rel.length <= 24 ? rel : Array.from({ length: 24 }, (_, i) => rel[Math.round(i * (rel.length - 1) / 23)]);
  const w = mobile ? 195 : 320;
  const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#222;font:12px monospace;color:#eee}div.g{display:grid;grid-template-columns:repeat(6,${w}px);gap:6px;padding:8px}figure{margin:0}img{width:${w}px;display:block;border:1px solid #555}figcaption{text-align:center;padding:2px}</style><div class=g>${pick.map((f) => `<figure><img src="data:image/jpeg;base64,${f.data}"><figcaption>${f.t} ms</figcaption></figure>`).join('')}</div>`;
  const sheetPath = join(OUT, `${label}-sheet.html`);
  writeFileSync(sheetPath, html);
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  const rows = Math.ceil(pick.length / 6);
  // A row is one frame scaled to `w` plus its caption. The screencast keeps
  // the viewport's aspect inside its max box (390×844 on mobile, ~800×562
  // for the 1280×900 window), so the height follows from that box, not
  // from a guess — a guessed 180px cropped the desktop sheet's lower rows.
  const capW = mobile ? 390 : 800;
  const capH = mobile ? 844 : 562;
  const rowH = Math.round(capH * w / capW) + 22;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 6 * (w + 6) + 16, height: rows * rowH + 16, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: pathToFileURL(sheetPath).href });
  await sleep(1200);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(OUT, `${label}-sheet.png`), Buffer.from(shot.data, 'base64'));
  console.log('sheet:', join(OUT, `${label}-sheet.png`));
} finally {
  chrome.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
