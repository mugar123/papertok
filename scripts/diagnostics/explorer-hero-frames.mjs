// Per-frame geometry of the Explorer hero's arrivals, over CDP against a
// headless Chrome. No dependencies (Node >= 22 for the global WebSocket).
//
//   node explorer-hero-frames.mjs route '#/explorer/author/A…' [demo] [mobile] [slow] [ms]
//   node explorer-hero-frames.mjs fromfeed '<css selector>' [demo] [late] [idx=N] [from=<hash>] [pre=<css>] [ms]
//   node explorer-hero-frames.mjs fromsearch author|institution|topic|project q=<text> [late] [mobile] [ms]
//   node explorer-hero-frames.mjs shotwhen '#/explorer/…' '<js expression>' out.png
//
// Two ways to reach a page that only exists for a signed-in reader, and they
// are not interchangeable:
//
//   * `demo` seeds a demo session in localStorage before the first script. It
//     needs a build made with IS_DEMO = true (never committed). Cheap, but it
//     short-circuits Firestore and auth — measured 2026-09-07, a demo build
//     HIDES the subtree remount and the navbar band snap on an entity page,
//     because the demo user resolves in a setTimeout(0). Use it for the
//     skeleton and the palette, not for what the session's arrival does.
//   * PROFILE_DIR=<dir> reuses a Chrome profile the user has signed in to.
//     Used as-is and NEVER deleted (see OWN_PROFILE below). This is the only
//     way to measure the real thing. Chrome locks a --user-data-dir, so the
//     window where the session was opened must be closed first.
//
// `fromsearch` is demo-only: the palette does not mount without a session and
// the demo one is whatever localStorage says it is.
//
// `from=<hash>` starts the click somewhere other than the feed — an author
// inside an institution page, which is the same route as the author page and
// so runs the whole unmount/mount transition. `pre=<css>` clicks something
// first (the Authors tab, whose cards do not exist until it is opened).
//
// Every rAF a record of the hero body (box, the WAAPI settle's from/to/
// currentTime, computed height, overflow), the experience panel and its inner,
// the ORCID skeleton/card, the wiki fold/block/paragraph/toggle with computed
// transforms, the tab strip, the content top, the first row, the palette sheet
// and scrim, and the pages under #main-content is taken; consecutive identical
// records are collapsed, so the output is the list of frames on which
// SOMETHING moved.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9226);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
// A run of its own leaves its profile behind, and inside the repo that is an
// untracked directory. `PROFILE_DIR` names a profile to reuse instead — one the
// user has signed in to, for what the page only does for a signed-in reader. It
// is used as-is, so a session survives between runs, and it is NEVER deleted.
const OWN_PROFILE = !process.env.PROFILE_DIR;
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-hero-frames-${process.pid}`);
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
  // Idempotent: a second run (fromsearch samples the opening, then the pick)
  // resets the buffer without starting a second rAF loop.
  if (window.__ticking) return; window.__ticking = true;
  const q = (s) => document.querySelector(s);
  const r1 = (n) => Math.round(n * 10) / 10;
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return r1(b.top) + '+' + r1(b.height); };
  const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null;
  const tf = (el) => { if (!el) return null; const t = getComputedStyle(el).transform; if (t === 'none') return 'none'; const m = t.match(/matrix\\(([^)]+)\\)/); if (!m) return t; const p = m[1].split(',').map(Number); return 'sx' + r1(p[0]) + ' sy' + r1(p[3]) + ' tx' + r1(p[4]) + ' ty' + r1(p[5]); };
  const settle = (el) => { if (!el || !el.getAnimations) return null; const a = el.getAnimations().find((x) => x.id === 'height-settle'); if (!a) return null; const k = a.effect.getKeyframes(); return { from: k[0].height, to: k[1].height, ct: Math.round(a.currentTime || 0) }; };
  const tick = () => {
    if (window.__on) {
      const body = q('.explorer-hero-content');
      const pages = [...document.querySelectorAll('#main-content > div')];
      window.__s.push({
        t: Math.round(performance.now()), hash: location.hash.slice(0, 48),
        sheet: q('.sc-sheet') ? box(q('.sc-sheet')) + '/' + op(q('.sc-sheet')) + '@' + tf(q('.sc-sheet')) + '/' + q('.sc-sheet').getAttribute('data-state') : null,
        scrim: q('.sc-scrim') ? op(q('.sc-scrim')) + '/' + q('.sc-scrim').getAttribute('data-state') : null,
        pages: pages.map((p) => op(p) + '@' + tf(p)).join(' | '),
        skel: !!q('.explorer-skeleton'), err: !!q('.explorer-error'),
        body: box(body), bodyH: body ? r1(parseFloat(getComputedStyle(body).height)) : null, bodyOv: body ? (body.style.overflow || '-') : null, bodyOp: op(body),
        settle: settle(body),
        toggle: q('.ehc-name-toggle') ? (q('.ehc-name-toggle').classList.contains('is-open') ? 'open' : 'closed') : null,
        panel: q('#ehc-experience-panel') ? box(q('#ehc-experience-panel')) + '/' + op(q('#ehc-experience-panel')) : null,
        inner: box(q('.ehc-experience-inner')), header: box(q('.ehc-header')),
        orcidSkel: box(q('.orcid-skeleton')),
        orcidCard: q('.orcid-career-section') ? box(q('.orcid-career-section')) + '/c1=' + op(q('.orcid-career-section > *')) + '@' + tf(q('.orcid-career-section > *')) : null,
        fold: q('.ehc-wiki-fold') ? box(q('.ehc-wiki-fold')) + '/' + op(q('.ehc-wiki-fold')) + '@' + tf(q('.ehc-wiki-fold')) : null,
        wiki: q('.ehc-wiki') ? box(q('.ehc-wiki')) + (q('.ehc-wiki').classList.contains('is-loading') ? '/loading' : '/live') : null,
        wikiP: q('.ehc-wiki p') ? box(q('.ehc-wiki p')) + '/' + op(q('.ehc-wiki p')) : null,
        wikiToggle: !!q('.ehc-wiki-toggle'), wikiSkel: !!q('.ehc-wiki-skeleton'),
        img: op(q('.ehc-wiki-image')), icon: op(q('.ehc-icon')), wash: op(q('.ehc-bg-blur')),
        rel: box(q('.ehc-ror-relations')),
        chips: box(q('.project-meta-chips')), summary: box(q('.project-summary-box')), parts: box(q('.project-participants-grid')),
        tabs: box(q('.ee-tabs')), content: box(q('.explorer-content')), row1: box(q('.explorer-list-item')),
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const REPORT = `(() => {
  window.__on = false;
  const p = window.__s; const t0 = p[0]?.t || 0;
  const changes = []; let last = '';
  for (const x of p) { const k = JSON.stringify({ ...x, t: 0 }); if (k !== last) { last = k; changes.push({ ...x, t: x.t - t0 }); } }
  const gaps = []; for (let i = 1; i < p.length; i++) { const g = p[i].t - p[i - 1].t; if (g > 34) gaps.push({ at: p[i - 1].t - t0, gap: g }); }
  return { frames: p.length, gaps, changes };
})()`;

// The demo session the app reads at boot. Inline in `fromsearch` before; named
// here because `fromfeed` needs it too: a signed-out feed links its authors to
// /public/entity/, not /explorer/author/, so the route under review is only
// reachable from the feed with a session. Needs an IS_DEMO = true build.
const DEMO_SEED = "(() => { try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'demo-user-123', displayName: 'Demo User', email: 'demo@papertok.app', photoURL: '', providerData: [{ providerId: 'google.com' }] })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['bio.neuro', 'physics'])); } catch {} })();";

const [, , mode, arg, ...rest] = process.argv;
const flags = new Set(rest);
const idx = Number(([...flags].find((f) => f.startsWith('idx=')) || 'idx=0').slice(4));
const ms = Number([...flags].find((f) => /^\d+$/.test(f)) || 8000);
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
  cdp.on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) console.log('[navigated]', frame.url.slice(0, 120)); });
  // `fromsearch` seeds it itself (before its own navigate); every other mode
  // opts in with `demo`.
  if (flags.has('demo') && mode !== 'fromsearch') await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DEMO_SEED });

  const clickAndSample = async (selector, pick) => {
    await cdp.eval(SAMPLER);
    console.log('target:', await cdp.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${pick}]; if (!el) return null; const t = (el.textContent || '').trim().slice(0, 40); el.click(); return t; })()`));
    await sleep(ms);
  };

  if (mode === 'route') {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SAMPLER });
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}${arg}` });
    await sleep(ms);
  } else if (mode === 'shotwhen') {
    const [expr, out] = rest;
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}${arg}` });
    const started = Date.now(); let hit = false;
    while (Date.now() - started < 20000) { if (await cdp.eval(expr).catch(() => false)) { hit = true; break; } await sleep(8); }
    console.log('hit:', hit);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out || 'shotwhen.png', Buffer.from(data, 'base64'));
    console.log('screenshot:', out || 'shotwhen.png');
    // SIGTERM, not SIGKILL: a kill only reaches the parent, and the renderers
    // go on writing into a profile that may be the user''s own.
    chrome.kill(); await sleep(300);
    if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
    process.exit(0);
  } else if (mode === 'fromsearch') {
    const query = ([...flags].find((f) => f.startsWith('q=')) || 'q=harvard').slice(2);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DEMO_SEED });
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
    const trigger = flags.has('mobile') ? '.navbar-icon-btn--search-compact' : '.navbar-search';
    for (let i = 0; i < 400; i++) { if (await cdp.eval(`!!document.querySelector(${JSON.stringify(trigger)})`).catch(() => false)) break; await sleep(100); }
    await sleep(flags.has('late') ? 4000 : 1500);
    await cdp.eval(SAMPLER);
    await cdp.eval(`document.querySelector(${JSON.stringify(trigger)}).click(); true`);
    await sleep(700);
    console.log('## palette opening\n' + await cdp.eval(`(() => { window.__on = false; const p = window.__s; const t0 = p[0]?.t || 0; const out = []; let last = ''; for (const x of p) { const k = x.sheet + '|' + x.scrim; if (k !== last) { last = k; out.push((x.t - t0) + ' sheet=' + x.sheet + ' scrim=' + x.scrim); } } return out.join('\\n'); })()`));
    for (let i = 0; i < 100; i++) { if (await cdp.eval("!!document.querySelector('[cmdk-input]')").catch(() => false)) break; await sleep(50); }
    await sleep(500);
    await cdp.eval("document.querySelector('[cmdk-input]').focus(); true");
    await cdp.send('Input.insertText', { text: query });
    const item = `[cmdk-item][data-value^="${arg}-"]`;
    let found = false;
    for (let i = 0; i < 200; i++) { if (await cdp.eval(`!!document.querySelector(${JSON.stringify(item)})`).catch(() => false)) { found = true; break; } await sleep(100); }
    console.log('result item:', found, item);
    await sleep(800);
    await clickAndSample(item, 0);
  } else if (mode === 'fromfeed') {
    // The page the click starts from. '#/' (the feed) by default; `from=<hash>`
    // for a click that starts anywhere else — an author inside an institution
    // page, which is the same route as the author page and so runs the whole
    // unmount/mount transition.
    const from = ([...flags].find((f) => f.startsWith('from=')) || 'from=#/').slice(5);
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}${from}` });
    for (let i = 0; i < 400; i++) { if (await cdp.eval(`document.querySelectorAll(${JSON.stringify(arg)}).length > ${idx}`).catch(() => false)) break; await sleep(100); }
    await sleep(flags.has('late') ? 4000 : 1500);
    // A click that has to be set up first — the Authors tab of an institution,
    // whose cards do not exist until the tab is opened. Waited for, clicked,
    // and given a second to mount what the real click needs.
    const pre = ([...flags].find((f) => f.startsWith('pre=')) || '').slice(4);
    if (pre) {
      for (let i = 0; i < 200; i++) { if (await cdp.eval(`!!document.querySelector(${JSON.stringify(pre)})`).catch(() => false)) break; await sleep(100); }
      console.log('pre:', await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(pre)}); if (!el) return null; el.click(); return (el.textContent || '').trim().slice(0, 30); })()`));
      for (let i = 0; i < 200; i++) { if (await cdp.eval(`document.querySelectorAll(${JSON.stringify(arg)}).length > ${idx}`).catch(() => false)) break; await sleep(100); }
      await sleep(1200);
    }
    await clickAndSample(arg, idx);
  }
  const report = await cdp.eval(REPORT);
  console.log(JSON.stringify({ frames: report.frames, gaps: report.gaps }));
  for (const c of report.changes) console.log(JSON.stringify(c));
} finally {
  chrome.kill();
  await sleep(300);
  if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
}
