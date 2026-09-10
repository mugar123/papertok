// Frames + geometry of an Explorer navigation, over CDP against headless Chrome.
// No dependencies (Node >= 22 for the global WebSocket).
//
//   node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/author/A…' [ms] [out=dir] [mobile] [slow] [profile]
//   node scripts/diagnostics/explorer-glitch-frames.mjs chain '#/explorer/institution/I…' '<selector>' [tab=authors] [idx=N] [wait=ms] [ms] [out=dir] [profile]
//
// Every rAF a record is taken PER PAGE under #main-content (there are two during
// a navigation): the page's motion attribute, opacity and transform, and inside
// it the hero, the hero body and its settle, the wash (.ehc-bg-blur) with its
// BOX, opacity and whether it carries an image, the picture's own box (washImg:
// the `::before`'s computed top/height), the visual slot, the ORCID
// skeleton/card/badge, the experience panel, the Wikipedia fold, the hero aside
// with its stats grid and the impact cell (with the detail's text), the tab
// strip and the first row.
// A Page.screencast runs at the same time and every frame the compositor
// produces is written as PNG to out=dir, named by its time relative to the
// first sample — the same clock on both sides (Date.now() epoch ms), so a frame
// file and a sampler line with the same number are the same instant.
// `profile` runs the V8 sampling profiler from the click and prints tasks >50ms
// with their outermost app frame, plus inclusive time per app function.
//
// Written for docs/AUDITORIA-GLITCHES-EXPLORER-2026-09-09.md. Three things it
// taught that explorer-hero-frames.mjs could not: the wash's box rode the
// hero's height (it was `top: -20%; bottom: 0`), the impact cell grows when its
// detail wraps, and the click freeze of `vite dev` is jsxDEV, not the app.
// Since 4853a3e the picture is a `::before` with a fixed box and its URL comes
// in on `--ehc-wash-image`, so `img=` reads that custom property (an inline
// `background-image` would report `n` forever) and `washImg` is the box that
// has to stay still while the container keeps riding the hero.
//
// PROFILE_DIR=<dir> reuses a Chrome profile the user has signed in to (see the
// README, "Measuring a page that only exists for a signed-in reader"). It is
// used as-is and NEVER deleted; Chrome is ended with SIGTERM so the renderers
// stop writing before the temp profile is removed.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9227);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const OWN_PROFILE = !process.env.PROFILE_DIR;
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-glitch-${process.pid}`);
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
  window.__s = []; window.__on = true; window.__t0 = Date.now();
  if (window.__ticking) return; window.__ticking = true;
  const r1 = (n) => Math.round(n * 10) / 10;
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return r1(b.left) + ',' + r1(b.top) + ' ' + r1(b.width) + 'x' + r1(b.height); };
  const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null;
  const tf = (el) => { if (!el) return null; const t = getComputedStyle(el).transform; if (t === 'none') return 'none'; const m = t.match(/matrix\\(([^)]+)\\)/); if (!m) return t; const p = m[1].split(',').map(Number); return 'sx' + r1(p[0]) + ' tx' + r1(p[4]) + ' ty' + r1(p[5]); };
  const settle = (el) => { if (!el || !el.getAnimations) return null; const a = el.getAnimations().find((x) => x.id === 'height-settle'); if (!a) return null; const k = a.effect.getKeyframes(); return k[0].height + '>' + k[1].height + '@' + Math.round(a.currentTime || 0); };
  const before = (el) => { if (!el) return null; const s = getComputedStyle(el, '::before'); return s.top + '/' + s.height; };
  const page = (p) => {
    const q = (s) => p.querySelector(s);
    const wash = q('.ehc-bg-blur');
    const hero = q('.explorer-hero');
    return {
      motion: p.getAttribute('data-page-motion'), dir: p.getAttribute('data-nav-direction'), pos: getComputedStyle(p).position, top: p.style.top || '', vis: p.style.visibility || '', op: op(p), tf: tf(p),
      hero: box(hero), heroPad: hero ? getComputedStyle(hero).paddingTop : null, rootPad: q('.explorer-container') ? getComputedStyle(q('.explorer-container')).paddingTop : null,
      skel: !!q('.explorer-skeleton'), body: box(q('.explorer-hero-content')), bodyOp: op(q('.explorer-hero-content')), settle: settle(q('.explorer-hero-content')),
      wash: wash ? box(wash) + '/' + op(wash) + '/img=' + (wash.style.getPropertyValue('--ehc-wash-image') ? 'y' : 'n') : null,
      washImg: before(wash),
      img: q('.ehc-wiki-image') ? box(q('.ehc-wiki-image')) + '/' + op(q('.ehc-wiki-image')) : null, icon: op(q('.ehc-icon')),
      name: q('.ehc-name') ? box(q('.ehc-name')) + ' "' + (q('.ehc-name').textContent || '').slice(0, 18) + '"' : null,
      toggle: q('.ehc-name-toggle') ? box(q('.ehc-name-toggle')) + '/' + (q('.ehc-name-toggle').classList.contains('is-open') ? 'open' : 'closed') : null,
      panel: q('#ehc-experience-panel') ? box(q('#ehc-experience-panel')) + '/' + op(q('#ehc-experience-panel')) : null,
      orcidSkel: box(q('.orcid-skeleton')),
      orcidCard: q('.orcid-career-section') ? box(q('.orcid-career-section')) : null,
      badge: q('.orcid-badge') ? box(q('.orcid-badge')) + '/' + op(q('.orcid-career-header')) + '@' + tf(q('.orcid-career-header')) : null,
      wiki: q('.ehc-wiki') ? box(q('.ehc-wiki')) + (q('.ehc-wiki').classList.contains('is-loading') ? '/loading' : '/live') : null,
      fold: q('.ehc-wiki-fold') ? box(q('.ehc-wiki-fold')) + '/' + op(q('.ehc-wiki-fold')) : null,
      inst: box(q('.ehc-author-institution')),
      aside: box(q('.ehc-hero-aside')), stats: box(q('.ehc-stats-grid')), impact: q('.ehc-stat-box--impact') ? box(q('.ehc-stat-box--impact')) + ' "' + (q('.ehc-stat-detail')?.textContent || '').slice(0, 24) + '"' : null, follow: box(q('.entity-follow-btn')), tags: box(q('.ehc-tags')),
      tabs: box(q('.ee-tabs')), row1: box(q('.explorer-list-item, .ee-author-card')),
    };
  };
  const tick = () => {
    if (window.__on) {
      const pages = [...document.querySelectorAll('#main-content > div')];
      window.__s.push({ t: Date.now(), hash: location.hash.slice(0, 40), scrollY: Math.round(scrollY), pages: pages.map(page) });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const REPORT = `(() => {
  window.__on = false;
  const p = window.__s; const changes = []; let last = '';
  for (const x of p) { const k = JSON.stringify({ ...x, t: 0 }); if (k !== last) { last = k; changes.push(x); } }
  const gaps = []; for (let i = 1; i < p.length; i++) { const g = p[i].t - p[i - 1].t; if (g > 34) gaps.push({ at: p[i - 1].t, gap: g }); }
  return { frames: p.length, gaps, changes, t0: p[0]?.t || window.__t0 };
})()`;

const [, , mode, arg, ...rest] = process.argv;
const flags = new Set(rest);
const flag = (name, dflt) => ([...flags].find((f) => f.startsWith(name + '=')) || `${name}=${dflt}`).slice(name.length + 1);
const idx = Number(flag('idx', 0));
const ms = Number([...flags].find((f) => /^\d+$/.test(f)) || 5000);
const outDir = flag('out', '');
if (outDir) mkdirSync(outDir, { recursive: true });
const chrome = launch();
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => console.error('[page exception]', exceptionDetails.text, exceptionDetails.exception?.description?.split('\n')[0] || ''));
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => { if (type === 'error') console.error('[console.error]', args.map((a) => a.value || a.description || '').join(' ').slice(0, 200)); });
  if (flags.has('mobile')) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  if (flags.has('slow')) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  let frameNo = 0; const frames = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    frames.push({ no: frameNo++, t: Math.round(metadata.timestamp * 1000), data });
  });
  const startCast = async () => { await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 }); };
  const startProfile = async () => { if (!flags.has('profile')) return; await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); };
  const waitFor = async (expr, limit = 30000) => { const s = Date.now(); while (Date.now() - s < limit) { if (await cdp.eval(expr).catch(() => false)) return true; await sleep(50); } return false; };

  if (mode === 'route') {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SAMPLER });
    await startCast();
    await startProfile();
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}${arg}` });
    await sleep(ms);
  } else if (mode === 'chain') {
    const selector = rest[0];
    const tab = flag('tab', '');
    const wait = Number(flag('wait', 2500));
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}${arg}` });
    console.log('first page live:', await waitFor("!!document.querySelector('.explorer-hero-content') && !document.querySelector('.explorer-skeleton')"));
    if (tab) {
      await sleep(600);
      console.log('tab click:', await cdp.eval(`(() => { const b = [...document.querySelectorAll('.ee-tab')].find((x) => /autor|author/i.test(x.textContent)); if (!b) return null; b.click(); return b.textContent.trim(); })()`));
    }
    console.log('target present:', await waitFor(`document.querySelectorAll(${JSON.stringify(selector)}).length > ${idx}`));
    await sleep(wait);
    await cdp.eval(SAMPLER);
    await startCast();
    await startProfile();
    await sleep(120);
    console.log('clicked:', await cdp.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${idx}]; if (!el) return null; const t = (el.textContent || '').trim().slice(0, 40); el.click(); return t; })()`));
    await sleep(ms);
  }
  await cdp.send('Page.stopScreencast').catch(() => {});
  let prof = null;
  if (flags.has('profile')) { prof = (await cdp.send('Profiler.stop')).profile; }
  const report = await cdp.eval(REPORT);
  const base = report.t0;
  console.log(JSON.stringify({ frames: report.frames, gaps: report.gaps.map((g) => ({ at: g.at - base, gap: g.gap })), screencast: frames.length }));
  for (const c of report.changes) {
    console.log(`t=${c.t - base} hash=${c.hash} y=${c.scrollY}`);
    c.pages.forEach((p, i) => console.log(`   p${i} ${JSON.stringify(p)}`));
  }
  const names = [];
  for (const f of frames) {
    const rel = f.t - base;
    const name = `f${String(f.no).padStart(3, '0')}_${rel < 0 ? 'm' : ''}${String(Math.abs(rel)).padStart(5, '0')}ms.png`;
    names.push(name);
    if (outDir) writeFileSync(join(outDir, name), Buffer.from(f.data, 'base64'));
  }
  if (outDir) console.log('frames:', names.join(' '));
  if (prof) {
    if (outDir) writeFileSync(join(outDir, 'profile.json'), JSON.stringify(prof));
    const parentOf = new Map(); for (const n of prof.nodes) for (const c of (n.children || [])) parentOf.set(c, n.id);
    const nodeById = new Map(prof.nodes.map((n) => [n.id, n]));
    const srcKey = (n) => { const u = (n.callFrame.url || '').replace(ORIGIN, '').replace(/\?.*$/, ''); return u.startsWith('/src/') || u.startsWith('/assets/') ? `${n.callFrame.functionName || '(anon)'} ${u}:${n.callFrame.lineNumber}` : null; };
    const incl = new Map();
    for (let i = 0; i < prof.samples.length; i++) {
      const seen = new Set(); let id = prof.samples[i];
      while (id != null) { const n = nodeById.get(id); const k = srcKey(n); if (k && !seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + (prof.timeDeltas[i] || 0)); } id = parentOf.get(id); }
    }
    console.log('\n### inclusive, app functions');
    for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${Math.round(v / 1000)}ms ${k}`);
    const tasks = []; let cur = null; let t = prof.startTime;
    for (let i = 0; i < prof.samples.length; i++) {
      const n = nodeById.get(prof.samples[i]); const fn = n.callFrame.functionName; t += (prof.timeDeltas[i] || 0);
      if (fn === '(idle)') { if (cur) { tasks.push(cur); cur = null; } continue; }
      if (!cur) cur = { start: t, dur: 0, top: new Map() };
      cur.dur += (prof.timeDeltas[i] || 0);
      let id = prof.samples[i]; let outer = null;
      while (id != null) { const m = nodeById.get(id); const k = srcKey(m); if (k) outer = k; id = parentOf.get(id); }
      const key = outer || fn; cur.top.set(key, (cur.top.get(key) || 0) + (prof.timeDeltas[i] || 0));
    }
    if (cur) tasks.push(cur);
    console.log('### tasks > 50ms (start relative to profiler start; outermost app frame)');
    for (const task of tasks.filter((x) => x.dur > 50000)) console.log(`  +${Math.round((task.start - prof.startTime) / 1000)}ms ${Math.round(task.dur / 1000)}ms  ` + [...task.top].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`).join(' | '));
  }
} finally {
  chrome.kill('SIGTERM');
  await sleep(800);
  if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
}
