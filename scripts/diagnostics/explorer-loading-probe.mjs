// Explorer loading probe over CDP against a headless Chrome. No dependencies.
// usage: node probe.mjs timeline '#/explorer/author/A…' [seconds]
//        node probe.mjs tabs '#/explorer/institution/I…'
//        node probe.mjs paint '#/explorer/author/A…' new|old
//        node probe.mjs bootload '#/' [demo,mobile,hold]   (PROFILE_DIR=<profile> to reuse one)
//        node probe.mjs open '#/' [mobile,slow,hold,late,viamodal,profile,sel=<css>,wait=<ms>]
//        node probe.mjs swipe '#/' [mobile,slow,n=<swipes>]
//        node probe.mjs tap '#/' demo,mobile[,slow=<rate>,follows=many,at=<ms>,until=<cards>,cycles=<n>,mouse,late]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `CHROME` names another Chromium binary (a Playwright download, Brave) on a
// machine without Chrome.
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9224);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
// Under the OS temp dir, never beside this script: a run that dies leaves
// its profile behind, and inside the repo that is an untracked directory.
// `PROFILE_DIR` names a profile to reuse instead — one the user has signed in
// to, for the routes behind the auth gate. It is used as-is, so a session's
// storage survives between runs, and it is never deleted.
const OWN_PROFILE = !process.env.PROFILE_DIR;
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-probe-${process.pid}`);
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

const RECORDER = `(() => {
  // The default buffer holds 250 entries and the explorer's chunks fill it
  // before the page's own requests are counted.
  performance.setResourceTimingBufferSize(4000);
  const t0 = performance.now();
  window.__tl = [];
  const q = (s) => document.querySelector(s);
  const snap = () => ({
    t: Math.round(performance.now() - t0),
    skeleton: !!q('.explorer-skeleton'),
    live: !!q('.explorer-hero-content:not(.is-skeleton)'),
    skelRows: document.querySelectorAll('.explorer-list-item.ex-skel-row').length,
    rows: document.querySelectorAll('.explorer-list-item:not(.ex-skel-row)').length,
    empty: !!q('.explorer-empty'),
    orcidSkel: !!q('.orcid-skeleton'),
    orcidCard: !!q('.orcid-career-section'),
    exp: !!q('#ehc-experience-panel'),
    wiki: q('.ehc-wiki') ? (q('.ehc-wiki').classList.contains('is-loading') ? 'loading' : 'live') : 'none',
    impact: q('.ehc-stat-box--impact .ehc-stat-value')?.textContent?.trim() || null,
    settled: !!q('.ehc-stat-value.is-settled'),
    authors: document.querySelectorAll('.ee-author-card:not(.ex-skel-row)').length,
    skelAuthors: document.querySelectorAll('.ee-author-card.ex-skel-row').length,
    tab: q('.ee-tab.active')?.textContent?.trim() || null,
  });
  let last = '';
  const push = () => { const s = snap(); const k = JSON.stringify({ ...s, t: 0 }); if (k !== last) { last = k; window.__tl.push(s); } };
  new MutationObserver(push).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
})();`;

async function pollUntil(cdp, expression, timeoutMs, every = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // An evaluation that lands on the navigation's own commit ("Inspected
    // target navigated or closed") is a miss, not a failure of the run.
    const hit = await cdp.eval(expression).catch(() => false);
    if (hit) return true;
    await sleep(every);
  }
  return false;
}

const [, , mode, route, extra] = process.argv;
const chrome = launch();
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Page errors, for when a probe sees nothing at all.
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => console.error('[page exception]', exceptionDetails.text, exceptionDetails.exception?.description?.split('\n')[0] || ''));
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => { if (type === 'error') console.error('[console.error]', args.map((a) => a.value || a.description || '').join(' ').slice(0, 300)); });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  // A chunk that fails to preload makes main.jsx reload the page once, which
  // ends any measurement in flight: name the chunk when it happens. Registered
  // before the app's own listener, so it sees the event first.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.addEventListener('vite:preloadError', (e) => console.error('[vite:preloadError]', (e.payload && e.payload.message) || ''));` });
  await cdp.send('Network.enable');
  cdp.on('Network.loadingFailed', ({ errorText, type }) => console.error('[loadingFailed]', type, errorText));
  cdp.on('Network.responseReceived', ({ response, type }) => { if (response.status >= 400) console.error('[http ' + response.status + ']', type, response.url.slice(0, 140)); });
  const url = `${ORIGIN}/?probe=${Date.now()}${route}`;

  if (mode === 'timeline') {
    await cdp.send('Page.navigate', { url });
    await sleep(Number(extra || 12) * 1000);
    const tl = await cdp.eval('window.__tl');
    console.log(JSON.stringify(tl, null, 0).replace(/\},\{/g, '},\n{'));
    const res = await cdp.eval(`(() => { const names = performance.getEntriesByType('resource').map(e => e.name); const count = (re) => names.filter(n => re.test(n)).length; return { publications: count(/openaire\\.eu\\/search\\/publications/), projects: count(/openaire\\.eu\\/search\\/projects/), arxiv: count(/arxiv/), works: count(/works/), total: names.length }; })()`);
    console.log('resources:', JSON.stringify(res));
  }

  if (mode === 'tabs') {
    await cdp.send('Page.navigate', { url });
    const ready = await pollUntil(cdp, "document.querySelectorAll('.explorer-list-item:not(.ex-skel-row)').length > 0", 45000);
    console.log('rows ready:', ready);
    const countWorks = "performance.getEntriesByType('resource').filter(e => /works/.test(e.name)).length";
    const worksBefore = await cdp.eval(countWorks);
    const rowsBefore = await cdp.eval("document.querySelectorAll('.explorer-list-item:not(.ex-skel-row)').length");
    const tlMark = await cdp.eval('window.__tl.length');
    await cdp.eval("document.querySelectorAll('.ee-tab')[1].click(); 'clicked'");
    const authorsReady = await pollUntil(cdp, "document.querySelectorAll('.ee-author-card:not(.ex-skel-row)').length > 0", 45000);
    console.log('authors ready:', authorsReady);
    const authorsCount = await cdp.eval("document.querySelectorAll('.ee-author-card:not(.ex-skel-row)').length");
    const back = await cdp.eval(`(() => { document.querySelectorAll('.ee-tab')[0].click(); return { rows: document.querySelectorAll('.explorer-list-item:not(.ex-skel-row)').length, skelRows: document.querySelectorAll('.explorer-list-item.ex-skel-row').length, empty: !!document.querySelector('.explorer-empty') }; })()`);
    await sleep(600);
    const after = await cdp.eval(`({ rows: document.querySelectorAll('.explorer-list-item:not(.ex-skel-row)').length, skelRows: document.querySelectorAll('.explorer-list-item.ex-skel-row').length, works: ${countWorks} })`);
    await cdp.eval("document.querySelectorAll('.ee-tab')[1].click(); 'clicked'");
    const again = await cdp.eval(`({ authors: document.querySelectorAll('.ee-author-card:not(.ex-skel-row)').length, skelAuthors: document.querySelectorAll('.ee-author-card.ex-skel-row').length, empty: !!document.querySelector('.explorer-empty') })`);
    const tl = await cdp.eval(`window.__tl.slice(${tlMark})`);
    console.log(JSON.stringify({ worksBefore, rowsBefore, authorsCount, backSameFrame: back, backAfter600ms: after, authorsAgain: again }, null, 1));
    console.log('timeline since the first tab click:');
    console.log(JSON.stringify(tl, null, 0).replace(/\},\{/g, '},\n{'));
  }

  if (mode === 'wikiexit') {
    // A topic whose Wikipedia lookup misses: the block's skeleton folds away.
    // Sample the list's top edge every frame around the fold and report the
    // biggest single-frame move — a jump is one frame carrying many pixels.
    await cdp.send('Page.navigate', { url });
    const shown = await pollUntil(cdp, "!!document.querySelector('.ehc-wiki')", 30000, 100);
    console.log('wiki block shown:', shown);
    await cdp.eval(`(() => { window.__pos = []; const tick = () => { const w = document.querySelector('.ehc-wiki'); const c = document.querySelector('.explorer-content'); window.__pos.push({ t: Math.round(performance.now()), top: c ? Math.round(c.getBoundingClientRect().top * 10) / 10 : null, wiki: w ? Math.round(w.getBoundingClientRect().height * 10) / 10 : null }); if (window.__pos.length < 3000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 'sampling'; })()`);
    const gone = await pollUntil(cdp, "!document.querySelector('.ehc-wiki')", 30000, 100);
    console.log('wiki block gone:', gone);
    await sleep(1200);
    const report = await cdp.eval(`(() => { const p = window.__pos; const moves = []; for (let i = 1; i < p.length; i++) { const d = (p[i].top ?? 0) - (p[i - 1].top ?? 0); if (Math.abs(d) > 0.05 || (p[i].wiki === null) !== (p[i - 1].wiki === null)) moves.push({ t: p[i].t - p[0].t, dt: p[i].t - p[i - 1].t, top: p[i].top, move: Math.round(d * 10) / 10, wiki: p[i].wiki }); } const biggest = moves.reduce((m, x) => Math.abs(x.move) > Math.abs(m.move) ? x : m, { move: 0 }); return { frames: p.length, biggestSingleFrameMove: biggest, moves: moves.slice(-40) }; })()`);
    console.log(JSON.stringify(report, null, 0).replace(/\},\{/g, '},\n{'));
  }

  if (mode === 'comments') {
    // The feed as a guest, the first card's comments opened: sample the
    // skeleton and the empty state every frame through the handover.
    await cdp.send('Page.navigate', { url });
    const card = await pollUntil(cdp, "[...document.querySelectorAll('.pc-side-btn')].some(b => /coment|comment/i.test(b.textContent))", 45000, 250);
    console.log('comments button:', card);
    await cdp.eval(`(() => { window.__cs = []; const tick = () => { const l = document.querySelector('.comments-sheet-loading'); const e = document.querySelector('.comments-sheet-state'); window.__cs.push({ t: Math.round(performance.now()), skel: l ? Number(getComputedStyle(l).opacity).toFixed(2) : null, skelPos: l ? getComputedStyle(l).position : null, empty: e ? Number(getComputedStyle(e).opacity).toFixed(2) : null, emptyY: e ? getComputedStyle(e).transform : null }); if (window.__cs.length < 900) requestAnimationFrame(tick); }; requestAnimationFrame(tick); const b = [...document.querySelectorAll('.pc-side-btn')].find(x => /coment|comment/i.test(x.textContent)); b.click(); return b.textContent.trim(); })()`).then((c) => console.log('clicked:', c));
    await sleep(6000);
    const report = await cdp.eval(`(() => { const p = window.__cs; const changes = []; let last = ''; for (const x of p) { const k = JSON.stringify([x.skel, x.skelPos, x.empty, x.emptyY]); if (k !== last) { last = k; changes.push(x); } } return { frames: p.length, changes: changes.slice(0, 60) }; })()`);
    console.log(JSON.stringify(report, null, 0).replace(/\},\{/g, '},\n{'));
  }

  if (mode === 'feedload') {
    // The guest feed from cold: every frame, the atom veil (presence, opacity,
    // the atom's transform) against the first card's sheet, through the
    // handover from one to the other.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__fl = []; const tick = () => { const v = document.querySelector('.feed-empty--veil'); const a = document.querySelector('.feed-empty--veil .atom-loader'); const c = document.querySelector('.pc-sheet'); const t = document.querySelector('.pc-title'); window.__fl.push({ t: Math.round(performance.now()), gate: !!document.querySelector('.feed-empty--initial-loading'), sk: document.querySelectorAll('.sk').length, veil: v ? Number(getComputedStyle(v).opacity).toFixed(2) : null, atom: a ? getComputedStyle(a).transform : null, cards: document.querySelectorAll('.feed-snap-item').length, sheet: c ? Number(getComputedStyle(c).opacity).toFixed(2) : null, title: t ? Number(getComputedStyle(t).opacity).toFixed(2) : null }); if (window.__fl.length < 6000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();` });
    // The guest feed answers in half a second, under the 1.5 s the atom waits
    // before showing; hold the source requests for a while so the wait is
    // long enough for the veil, then let them through and watch it leave.
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const held = [];
    let holding = true;
    cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
      // Other origins only: the app's own modules come from the dev server,
      // and holding one of those (a service named after a provider, say)
      // freezes the whole page instead of its feed.
      const source = !request.url.startsWith(ORIGIN) && /workers\.dev|api\.openalex|arxiv\.org|semanticscholar|ncbi\.nlm|europepmc|openaire|crossref/.test(request.url);
      if (holding && source) { held.push(requestId); console.log('holding', request.url.slice(0, 120)); return; }
      cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });
    setTimeout(() => {
      holding = false;
      console.log(`releasing ${held.length} held requests`);
      for (const requestId of held) cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }, 3500);
    await cdp.send('Page.navigate', { url });
    const sheet = await pollUntil(cdp, "document.querySelectorAll('.pc-sheet').length > 0", 40000, 200);
    console.log('first sheet:', sheet);
    await sleep(1500);
    const report = await cdp.eval(`(() => { const p = window.__fl; const changes = []; let last = ''; for (const x of p) { const k = JSON.stringify([x.gate, x.sk, x.veil, x.atom, x.cards > 0, x.sheet, x.title]); if (k !== last) { last = k; changes.push(x); } } const blank = p.filter(x => x.veil === null && x.cards === 0).length; return { frames: p.length, framesWithNeitherVeilNorCards: blank, where: { hash: location.hash, gate: !!document.querySelector('.feed-empty--initial-loading'), atomLoaders: document.querySelectorAll('.atom-loader').length, text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160) }, changes: changes.slice(0, 70) }; })()`);
    console.log(JSON.stringify(report, null, 0).replace(/\},\{/g, '},\n{'));
  }

  if (mode === 'bootload') {
    // The signed-in feed from cold, through every handover: the auth gate's
    // atom, the navbar mounting, the route entering, the veil leaving, the
    // first card composing. `extra` is a comma list of `mobile` (390×844,
    // touch) and `hold` (cross-origin source requests held 3.5 s, so the
    // wait is long enough for the feed's own veil to show).
    const flags = new Set((extra || '').split(',').filter(Boolean));
    if (flags.has('demo')) {
      // A signed-in tree without a session: the app's demo mode (IS_DEMO in
      // services/firebase.js, flipped locally) reads its account from
      // localStorage, seeded here before any app script runs.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'probe-demo', email: 'probe@example.com', displayName: 'Probe' })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['quant-ph', 'cond-mat.mtrl-sci', 'cs.AI'])); } catch {} })();` });
    }
    if (flags.has('mobile')) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__bl = []; const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null; const tick = () => { const gate = document.querySelector('.feed-empty--initial-loading'); const gateAtom = gate && gate.querySelector('.atom-loader'); const page = document.querySelector('#main-content > div'); const v = document.querySelector('.feed-empty--veil'); const a = v && v.querySelector('.atom-loader'); const c = document.querySelector('.pc-sheet'); const t = document.querySelector('.pc-title'); const r = (gateAtom || a); const rect = r ? r.getBoundingClientRect() : null; window.__bl.push({ t: Math.round(performance.now()), gate: !!gate, nav: !!document.querySelector('.navbar'), navOp: op(document.querySelector('.navbar')), page: op(page), pageTf: page ? getComputedStyle(page).transform : null, veil: op(v), atom: a ? getComputedStyle(a).transform : null, atomOp: op(r), atomY: rect ? Math.round(rect.top + rect.height / 2) : null, rail: (() => { const r = document.querySelector('.pc-side-actions'); if (!r) return null; const b = r.getBoundingClientRect(); return Math.round(b.top) + '/' + Math.round(b.height) + '/' + getComputedStyle(r).transform; })(), sk: document.querySelectorAll('.sk').length, cards: document.querySelectorAll('.feed-snap-item').length, sheet: op(c), title: op(t) }); if (window.__bl.length < 6000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();` });
    if (flags.has('hold')) {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      const held = [];
      let holding = true;
      cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
        const source = !request.url.startsWith(ORIGIN) && /workers\.dev|api\.papertok|api\.openalex|arxiv\.org|semanticscholar|ncbi\.nlm|europepmc|openaire|crossref/.test(request.url);
        if (holding && source) { held.push(requestId); return; }
        cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      });
      setTimeout(() => {
        holding = false;
        console.log(`releasing ${held.length} held requests`);
        for (const requestId of held) cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }, 3500);
    }
    // `shots`: three PNGs into SHOTS_DIR — the veil at boot, the handover
    // (captured the frame the first sheet is found, ~80 ms into the exit),
    // and the settled feed.
    const shots = flags.has('shots') ? (process.env.SHOTS_DIR || '.') : null;
    const shot = async (name) => {
      if (!shots) return;
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
    };
    const tag = flags.has('mobile') ? 'mobile' : 'desktop';
    await cdp.send('Page.navigate', { url });
    if (shots) { await pollUntil(cdp, "!!document.querySelector('.feed-empty--veil')", 20000, 30); await sleep(400); await shot(`${tag}-1-boot`); }
    const sheet = await pollUntil(cdp, "document.querySelectorAll('.pc-sheet').length > 0", 40000, shots ? 16 : 100);
    console.log('first sheet:', sheet);
    await shot(`${tag}-2-handover`);
    await sleep(1200);
    await shot(`${tag}-3-settled`);
    const report = await cdp.eval(`(() => { const p = window.__bl; const changes = []; let last = ''; for (const x of p) { const k = JSON.stringify([x.gate, x.nav, x.navOp, x.page, x.veil, x.atom, x.atomOp, x.atomY, x.sk, x.cards > 0, x.sheet, x.title, x.rail]); if (k !== last) { last = k; changes.push(x); } } const blank = p.filter(x => !x.gate && x.veil === null && x.cards === 0).length; return { frames: p.length, framesWithNothing: blank, changes }; })()`);
    console.log(JSON.stringify(report, null, 0).replace(/\},\{/g, '},\n{'));
  }

  if (mode === 'tabswitch') {
    // A tab switch on the bar, both ways: the outgoing and incoming page
    // (opacity, transform), the veil, the skeleton, the empty state and the
    // first card's sheet and title, every frame. `extra`: `demo`, `mobile`.
    const flags = new Set((extra || '').split(',').filter(Boolean));
    if (flags.has('demo')) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'probe-demo', email: 'probe@example.com', displayName: 'Probe' })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['quant-ph', 'cond-mat.mtrl-sci', 'cs.AI'])); localStorage.setItem('papertok_following_probe-demo', JSON.stringify([{ type: 'author', id: 'A5006398227', name: 'Probe author', source: 'openalex' }])); } catch {} })();` });
    }
    if (flags.has('mobile')) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }
    if (flags.has('slow')) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // Long tasks and the animations in flight: which thread the entrance runs
    // on, and what blocks it.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {} })();` });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__ts = []; window.__tsOn = false; const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null; const tf = (el) => el ? getComputedStyle(el).transform : null; const tick = () => { if (window.__tsOn) { const pages = [...document.querySelectorAll('#main-content > div')]; const sheet = document.querySelector('.pc-sheet'); const title = document.querySelector('.pc-title'); const rail = document.querySelector('.pc-side-actions'); window.__ts.push({ t: Math.round(performance.now()), pages: pages.map((p) => op(p) + '@' + tf(p)).join(' | '), hash: location.hash, dir: pages.map((p) => p.getAttribute('data-nav-direction')).join('|'), idx: (history.state && history.state.idx) + ' nt=' + window.__navType, veil: op(document.querySelector('.feed-empty--veil')), sk: document.querySelectorAll('.sk').length, empty: !!document.querySelector('.ff-empty, .feed-empty:not(.feed-empty--veil)'), cards: document.querySelectorAll('.feed-snap-item').length, sheet: sheet ? op(sheet) + '@' + tf(sheet) : null, title: title ? op(title) + '@' + tf(title) : null, rail: rail ? op(rail) : null, kids: (() => { const sh = document.querySelector('.feed-snap-item .pc-body') || document.querySelector('.feed-snap-item .pc-sheet'); if (!sh) return null; return [...sh.children].map((c) => { const b = c.getBoundingClientRect(); return (c.className || c.tagName).toString().split(' ')[0].replace('pc-', '') + ':' + Math.round(b.top) + '+' + Math.round(b.height); }).join(' '); })(), pieces: ['.pc-sheet', '.pc-title', '.pc-chips', '.pc-topics', '.pc-authors', '.pc-abstract', '.pc-action-bar'].map((sel) => { const el = document.querySelector(sel); if (!el) return sel.slice(4, 8) + '=-'; const b = el.getBoundingClientRect(); return sel.slice(4, 8) + '=' + op(el) + '/' + Math.round(b.top) + '+' + Math.round(b.height); }).join(' ') + ' fonts=' + document.fonts.status + '(' + [...document.fonts].filter((f) => f.status === 'loading').map((f) => f.family + ' ' + f.style + ' ' + f.weight).slice(0, 3).join('; ') + ')' + ' clip=' + (document.querySelector('.pc-abstract')?.className.replace('pc-abstract', '').trim() || '-'), anims: (window.__ts.length % 10 === 3) ? document.getAnimations().map((a) => (a.animationName || a.effect?.target?.className?.toString().slice(0, 24) || '?') + ':' + (a.constructor.name)).slice(0, 8).join(',') : undefined }); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();` });
    await cdp.send('Page.navigate', { url });
    await pollUntil(cdp, "document.querySelectorAll('.pc-sheet').length > 0", 40000, 100);
    // `late`: past the 2.5 s prefetch in App.jsx, so the Following chunk is warm.
    await sleep(flags.has('late') ? 6000 : 1500);
    const run = async (label, clickExpr) => {
      await cdp.eval('window.__ts = []; window.__tsOn = true; true');
      await cdp.eval(clickExpr);
      await sleep(2500);
      const report = await cdp.eval(`(() => { window.__tsOn = false; const p = window.__ts; const t0 = p[0]?.t || 0; const changes = []; let last = ''; for (const x of p) { const k = JSON.stringify([x.pages, x.hash, x.dir, x.idx, x.veil, x.sk, x.empty, x.cards > 0, x.sheet, x.title, x.rail, x.pieces]); if (k !== last) { last = k; changes.push({ ...x, t: x.t - t0 }); } } const gaps = []; for (let i = 1; i < p.length; i++) { const g = p[i].t - p[i - 1].t; if (g > 34) gaps.push({ at: p[i - 1].t - t0, gap: g }); } const longTasks = window.__lt.filter((e) => e.t >= t0 - 50 && e.t <= t0 + 1500).map((e) => ({ at: e.t - t0, d: e.d })); const anims = p.map((x) => x.anims).filter(Boolean); return { frames: p.length, frameGapsOver34ms: gaps, longTasks, animsSample: anims.slice(0, 3), changes }; })()`);
      console.log(`\n## ${label}`);
      console.log(JSON.stringify(report, null, 0).replace(/\},\{/g, '},\n{'));
    };
    await run('For you -> Following', "document.querySelector('.navbar-link[href=\"#/following\"]').click(); true");
    await run('Following -> For you', "[...document.querySelectorAll('.navbar-link')].find((l) => /For you|Para ti/.test(l.textContent)).click(); true");
    await run('back (history.back)', 'history.back(); true');
  }

  if (mode === 'tap') {
    // The tab bar under a REAL tap: `Input.dispatchTouchEvent`, so the gesture
    // recogniser, hit-testing and click synthesis all run as on a phone —
    // `element.click()` (the `tabswitch` mode) skips all three and can never
    // see a tap that another layer eats or a click React never receives.
    // Every touch/pointer/mouse/click event that reaches the document is
    // logged in the capture phase, with pushState and hashchange, and the
    // pages are sampled per frame through the handover. Both directions,
    // `cycles` times. `follows=many` seeds fourteen follows so Following has
    // cards and a chain still landing; `at=<ms>` taps For you that soon after
    // Following; `until=<cards>` waits for that many cards first; `slow=<rate>`
    // throttles the CPU; `mouse` is the desktop control. Exit code 1 when a
    // tap does not change the hash, or the outgoing page has not started to
    // leave 400 ms after touchend.
    const flags = new Set((extra || '').split(',').filter(Boolean));
    const num = (name, dflt) => { const f = [...flags].find((x) => x.startsWith(name + '=')); return f ? Number(f.slice(name.length + 1)) : dflt; };
    const cycles = num('cycles', 2);
    const atMs = num('at', 0);
    const untilCards = num('until', 0);
    const slowRate = num('slow', flags.has('slow') ? 4 : 0);
    const useMouse = flags.has('mouse');
    const manyFollows = [
      ['A5056895519', 'Markus Göker'], ['A5089245822', 'Joshua Adkins'], ['A5006191066', 'Scott Baker'], ['A5005196385', 'Matthew Monroe'], ['A5023982706', 'Richard Smith'],
      ['A5085384361', 'Mary Lipton'], ['A5075235007', 'Weijun Qian'], ['A5022928420', 'Samuel Purvine'], ['A5050316172', 'William R Schafer'], ['A5058699536', 'Sebastian Funk'],
    ].map(([id, name]) => ({ type: 'author', id, canonicalId: id, name, source: 'openalex' })).concat([
      { type: 'institution', id: 'I4210108322', canonicalId: 'I4210108322', name: 'National Institute for Fusion Science', source: 'openalex' },
      { type: 'institution', id: 'I1294671590', canonicalId: 'I1294671590', name: 'CNRS', source: 'openalex' },
      { type: 'institution', id: 'I142606810', canonicalId: 'I142606810', name: 'Pacific Northwest National Laboratory', source: 'openalex' },
      { type: 'topic', id: 'cs.AI', canonicalId: 'cs.AI', name: 'Artificial Intelligence', source: 'arxiv' },
    ]);
    const follows = JSON.stringify(flags.has('follows=many') ? manyFollows : [{ type: 'author', id: 'A5006398227', name: 'Probe author', source: 'openalex' }]);
    if (flags.has('demo')) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'probe-demo', email: 'probe@example.com', displayName: 'Probe' })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['quant-ph', 'cond-mat.mtrl-sci', 'cs.AI'])); localStorage.setItem('papertok_following_probe-demo', ${JSON.stringify(follows)}); } catch {} })();` });
    }
    if (flags.has('mobile')) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    if (slowRate > 0) await cdp.send('Emulation.setCPUThrottlingRate', { rate: slowRate });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__ev = [];
      const desc = (el) => { if (!el || !el.tagName) return String(el && el.nodeName); const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''; const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 16); return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (txt ? '[' + txt + ']' : ''); };
      const push = (o) => window.__ev.push({ t: Math.round(performance.now()), ...o });
      for (const type of ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click']) {
        document.addEventListener(type, (e) => { const p = e.changedTouches ? e.changedTouches[0] : e; push({ type, target: desc(e.target), x: Math.round(p?.clientX ?? -1), y: Math.round(p?.clientY ?? -1), dp: e.defaultPrevented }); }, true);
      }
      window.addEventListener('hashchange', () => push({ type: 'hashchange', hash: location.hash }));
      const ps = history.pushState.bind(history); history.pushState = (s, t, u) => { push({ type: 'pushState', url: String(u) }); return ps(s, t, u); };
      window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {}
      window.__fr = []; window.__frOn = false;
      const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null;
      const tf = (el) => el ? getComputedStyle(el).transform.replace('matrix(1, 0, 0, 1, ', 't(') : null;
      const tick = () => {
        if (window.__frOn) {
          const pages = [...document.querySelectorAll('#main-content > div')];
          const rule = document.querySelector('.navbar-link-rule');
          window.__fr.push({ t: Math.round(performance.now()), hash: location.hash, pages: pages.map((p) => op(p) + '@' + tf(p) + ' d=' + p.getAttribute('data-nav-direction')).join(' | '), active: (document.querySelector('.navbar-link.active')?.textContent || '').trim(), rule: rule ? tf(rule) : null, cards: document.querySelectorAll('.feed-snap-item').length, title: (document.querySelector('.pc-title')?.textContent || '').trim().slice(0, 28), veil: !!document.querySelector('.feed-empty--veil'), empty: !!document.querySelector('.ff-empty'), sk: document.querySelectorAll('.sk').length });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();` });
    await cdp.send('Page.navigate', { url });
    console.log('feed ready:', await pollUntil(cdp, "document.querySelectorAll('.pc-sheet').length > 0", 40000, 100));
    await sleep(flags.has('late') ? 6000 : 1500);
    const FOR_YOU = "[...document.querySelectorAll('.navbar-link')].find((l) => /For you|Para ti/.test(l.textContent))";
    const FOLLOWING = "document.querySelector('.navbar-link[href=\"#/following\"]')";
    let failures = 0;
    const tap = async (label, expr) => {
      const box = await cdp.eval(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y); return { x, y, w: Math.round(r.width), h: Math.round(r.height), hit: h ? h.tagName.toLowerCase() + '.' + String(h.className).split(' ').slice(0, 2).join('.') : null, hitIsTarget: h === el || (h && el.contains(h)) }; })()`);
      if (!box) { console.log(`\n## ${label}: TARGET NOT FOUND`); failures += 1; return null; }
      const evStart = await cdp.eval('window.__ev.length');
      await cdp.eval('window.__fr = []; window.__frOn = true; true');
      const t0 = await cdp.eval('Math.round(performance.now())');
      if (useMouse) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await sleep(40);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      } else {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, radiusX: 4, radiusY: 4, force: 1 }] });
        await sleep(60);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      return { label, box, evStart, t0 };
    };
    const report = async (info, waitMs, expectHash) => {
      if (!info) return;
      await sleep(waitMs);
      const r = await cdp.eval(`(() => { window.__frOn = false; const t0 = ${info.t0}; const ev = window.__ev.slice(${info.evStart}).map((e) => ({ ...e, t: e.t - t0 })); const fr = window.__fr; const changes = []; let last = ''; for (const x of fr) { const k = JSON.stringify([x.hash, x.pages, x.active, x.rule, x.cards > 0, x.title, x.veil, x.empty, x.sk]); if (k !== last) { last = k; changes.push({ ...x, t: x.t - t0 }); } } const longTasks = window.__lt.filter((e) => e.t >= t0 - 50 && e.t <= t0 + ${waitMs}).map((e) => ({ at: e.t - t0, d: e.d })); return { hash: location.hash, events: ev, longTasks, changes: changes.slice(0, 30) }; })()`);
      const touchEnd = r.events.find((e) => e.type === (useMouse ? 'mouseup' : 'touchend'));
      const click = r.events.find((e) => e.type === 'click');
      const push = r.events.find((e) => e.type === 'pushState' || e.type === 'hashchange');
      const first = r.changes.find((c) => c.hash === expectHash);
      const exit = r.changes.find((c) => c.hash === expectHash && /^0\.9[0-8]|^0\.[0-8]/.test(c.pages));
      const verdict = { hash: r.hash, clickOn: click?.target ?? null, clickAt: click?.t ?? null, pushAt: push?.t ?? null, firstNewFrameAt: first?.t ?? null, exitStartAt: exit?.t ?? null, longTasks: r.longTasks };
      const ok = r.hash === expectHash && exit && touchEnd && exit.t - touchEnd.t <= 400;
      if (!ok) failures += 1;
      console.log(`\n## ${info.label}  tap@(${Math.round(info.box.x)},${Math.round(info.box.y)}) target ${info.box.w}x${info.box.h} elementFromPoint=${info.box.hit} hitIsTarget=${info.box.hitIsTarget}  ${ok ? 'OK' : 'FAIL'}`);
      console.log('verdict:', JSON.stringify(verdict));
      console.log('events:', JSON.stringify(r.events));
      console.log('frames:', JSON.stringify(r.changes, null, 0).replace(/\},\{/g, '},\n{'));
    };
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const a = await tap(`cycle ${cycle}: For you -> Following`, FOLLOWING);
      if (untilCards > 0) {
        await pollUntil(cdp, `document.querySelectorAll('.feed-snap-item').length >= ${untilCards}`, 25000, 50);
        await report(a, 0, '#/following');
      } else if (atMs > 0) {
        await sleep(atMs);
        await report(a, 0, '#/following');
      } else {
        await report(a, 2500, '#/following');
      }
      const b = await tap(`cycle ${cycle}: Following -> For you`, FOR_YOU);
      await report(b, 3500, '#/');
    }
    console.log(`\n${failures === 0 ? 'ALL TAPS OK' : failures + ' TAP(S) FAILED'}`);
    process.exitCode = failures === 0 ? 0 : 1;
  }

  if (mode === 'open') {
    // Opening an entity from a card, and coming back: the guest feed, a tap
    // on an author (or `sel=<css>` — a topic tag, a project badge, an
    // institution link on an author page), and every frame of the handover
    // sampled: both pages under `#main-content` (opacity, transform,
    // direction), the skeleton and the live hero, the hero's box, the first
    // row, the fallback, long tasks and dropped frames. `extra`: `mobile`,
    // `slow` (CPU ×4), `hold` (the entity's own requests held 2.5 s so the
    // skeleton lasts), `sel=…`, `late` (past the 2.5 s chunk prefetch).
    const flags = new Set((extra || '').split(',').filter(Boolean));
    const selFlag = [...flags].find((f) => f.startsWith('sel='));
    const sel = selFlag ? selFlag.slice(4) : '.pc-authors a, .pc-author-btn';
    // `wait=<ms>`: how long the opening is sampled (default 3000). A works
    // page under a throttled CPU can take longer than that to arrive.
    const waitFlag = [...flags].find((f) => f.startsWith('wait='));
    const openWaitMs = waitFlag ? Number(waitFlag.slice(5)) || 3000 : 3000;
    if (flags.has('mobile')) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }
    if (flags.has('slow')) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    if (flags.has('hold')) {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      let holding = false;
      const held = [];
      cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
        const entity = /api\.openalex\.org\/(authors|institutions|concepts|topics)|openaire|orcid|wikipedia|api\.papertok|workers\.dev/.test(request.url);
        if (holding && entity) { held.push(requestId); return; }
        cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      });
      // Armed from the click: the feed's own requests go through untouched.
      cdp.__armHold = () => { holding = true; setTimeout(() => { holding = false; for (const id of held) cdp.send('Fetch.continueRequest', { requestId: id }).catch(() => {}); }, 2500); };
    }
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {} })();` });
    // The hero's blocks, for the skeleton and for the live page: what each
    // reserves against what the other draws, so a collapse at the handover
    // can be read block by block.
    const HERO_DUMP = `(() => { const box = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.top) + '+' + Math.round(b.height); }; const name = (el) => (el.className || el.tagName).toString().split(' ').slice(0, 2).join('.'); const hero = document.querySelector('.explorer-hero'); if (!hero) return null; const content = hero.querySelector('.explorer-hero-content'); const walk = (el, depth) => [...el.children].filter((c) => c.getBoundingClientRect().height > 0).map((c) => ' '.repeat(depth) + name(c) + ' ' + box(c) + (depth < 2 && c.children.length ? '\\n' + walk(c, depth + 1).join('\\n') : '')); return { hero: box(hero), content: content ? box(content) : null, tabs: (() => { const t = document.querySelector('.ee-tabs'); return t ? box(t) : null; })(), blocks: walk(content || hero, 0).join('\\n') }; })()`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__heroDump = () => ${HERO_DUMP};` });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__op = []; window.__opOn = false; const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null; const tf = (el) => el ? getComputedStyle(el).transform.replace('matrix(1, 0, 0, 1, ', 't(').replace(/^matrix\\((.{0,14}).*\\)$/, 'm($1..)') : null; const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return Math.round(b.top) + '+' + Math.round(b.height); }; const tick = () => { if (window.__opOn) { if (!window.__heroSkel && document.querySelector('.explorer-skeleton')) window.__heroSkel = window.__heroDump(); if (!window.__heroLive && document.querySelector('.explorer-hero-content:not(.is-skeleton)')) window.__heroLive = window.__heroDump(); const pages = [...document.querySelectorAll('#main-content > div')]; window.__op.push({ t: Math.round(performance.now()), hash: location.hash.slice(0, 40), pages: pages.map((p) => op(p) + '@' + tf(p) + ' d=' + p.getAttribute('data-nav-direction') + ' ' + (p.firstElementChild?.className || '').toString().split(' ')[0]).join(' | '), fb: !!document.querySelector('.route-fallback'), modal: !!document.querySelector('.pc-authors-modal'), skel: !!document.querySelector('.explorer-skeleton'), live: !!document.querySelector('.explorer-hero-content:not(.is-skeleton)'), exc: box(document.querySelector('.explorer-container')), hero: box(document.querySelector('.explorer-hero')), heroOp: op(document.querySelector('.explorer-hero-content')), name: (document.querySelector('.ehc-name')?.textContent || '').trim().slice(0, 24) + '/' + op(document.querySelector('.ehc-name')) + '/' + box(document.querySelector('.ehc-name')), row1: box(document.querySelector('.explorer-list-item')) + '/' + op(document.querySelector('.explorer-list-item')), tabs: box(document.querySelector('.ee-tabs')), skels: document.querySelectorAll('.ex-skel').length, rows: document.querySelectorAll('.explorer-list-item:not(.ex-skel-row)').length, feed: box(document.querySelector('.feed-container')), fs: document.querySelector('.feed-container')?.scrollTop ?? null, sy: Math.round(scrollY), docH: document.documentElement.scrollHeight, nav: box(document.querySelector('.navbar')), fonts: document.fonts.status, modalBox: (() => { const o = document.querySelector('.pc-authors-modal-overlay'); const sh = document.querySelector('.pc-authors-modal-sheet'); if (!o) return null; const ob = o.getBoundingClientRect(); const sb = sh ? sh.getBoundingClientRect() : null; return 'ov=' + Math.round(ob.top) + '+' + Math.round(ob.height) + '/' + op(o) + (sb ? ' sheet=' + Math.round(sb.top) + '+' + Math.round(sb.height) + '@' + tf(sh) : ''); })() }); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();` });
    // `nosweep`: the skeleton's sweep switched off, to tell the cost of its
    // compositor layers apart from the page's own raster.
    if (flags.has('nosweep')) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const s = document.createElement('style'); s.textContent = '.ex-skel::after, .ehc-wiki-skeleton span::after { animation: none !important; }'; document.documentElement.appendChild(s); })();` });
    }
    // A whole-document navigation mid-run (a service worker reload, the
    // chunk-404 reload in main.jsx) destroys the samples; say so if it happens.
    const bootAt = Date.now();
    cdp.on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) console.log('[navigated]', `+${Date.now() - bootAt}ms`, frame.url.slice(0, 120)); });
    await cdp.send('Page.navigate', { url });
    const ready = await pollUntil(cdp, `document.querySelectorAll(${JSON.stringify(sel)}).length > 0`, 40000, 100);
    console.log('target ready:', ready, sel);
    await sleep(flags.has('late') ? 4000 : 1500);
    // `profile`: a CPU profile of each run, summed by function (self time)
    // and by script, for the long tasks the frame loop shows but cannot name.
    // Read against a build made with `--minify false`, which keeps the names.
    const profiling = flags.has('profile');
    if (profiling) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    }
    const summarizeProfile = ({ nodes, samples, timeDeltas }) => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const self = new Map();
      let total = 0;
      for (let i = 0; i < samples.length; i++) {
        const dt = (timeDeltas[i] || 0) / 1000;
        total += dt;
        self.set(samples[i], (self.get(samples[i]) || 0) + dt);
      }
      const byFn = new Map();
      const byScript = new Map();
      for (const [id, ms] of self) {
        const n = byId.get(id);
        const f = n?.callFrame || {};
        const script = (f.url || '').split('/').pop() || '(program)';
        const key = `${f.functionName || '(anonymous)'} ${script}:${f.lineNumber ?? '?'}`;
        byFn.set(key, (byFn.get(key) || 0) + ms);
        byScript.set(script, (byScript.get(script) || 0) + ms);
      }
      const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, ms]) => `${Math.round(ms)}ms ${name}`);
      return { sampledMs: Math.round(total), byScript: top(byScript, 8), byFunction: top(byFn, 22) };
    };
    const run = async (label, clickExpr, ms = 3000) => {
      await cdp.eval('window.__op = []; window.__opOn = true; true');
      if (cdp.__armHold) cdp.__armHold();
      if (profiling) await cdp.send('Profiler.start');
      await cdp.eval(clickExpr);
      await sleep(ms);
      const profile = profiling ? (await cdp.send('Profiler.stop')).profile : null;
      const report = await cdp.eval(`(() => { window.__opOn = false; const p = window.__op; const t0 = p[0]?.t || 0; const changes = []; let last = ''; for (const x of p) { const k = JSON.stringify([x.hash, x.pages, x.fb, x.modal, x.skel, x.live, x.exc, x.hero, x.heroOp, x.name, x.row1, x.tabs, x.skels, x.rows, x.feed, x.fs, x.sy, x.docH, x.nav, x.modalBox]); if (k !== last) { last = k; changes.push({ ...x, t: x.t - t0 }); } } const gaps = []; for (let i = 1; i < p.length; i++) { const g = p[i].t - p[i - 1].t; if (g > 34) gaps.push({ at: p[i - 1].t - t0, gap: g }); } const longTasks = window.__lt.filter((e) => e.t >= t0 - 50 && e.t <= t0 + ${ms}).map((e) => ({ at: e.t - t0, d: e.d })); return { frames: p.length, frameGapsOver34ms: gaps, longTasks, changes: changes.slice(0, 90) }; })()`);
      console.log(`\n## ${label}`);
      console.log(JSON.stringify(report, null, 0).replace(/\},\{/g, '},\n{'));
      if (profile) console.log(`\n## profile: ${label}\n` + JSON.stringify(summarizeProfile(profile), null, 1));
    };
    if (flags.has('viamodal')) {
      // The phone's path: a tap on the authors row opens the sheet (the names
      // themselves take no pointer events under 768px), and the author is
      // picked from the sheet. Every Web Animation the sheet starts is logged
      // (keyframes, duration), so the exit it actually ran can be read.
      await cdp.eval(`(() => { window.__sheetAnims = []; const original = Element.prototype.animate; Element.prototype.animate = function (keyframes, options) { if (this.classList && (this.classList.contains('pc-authors-modal-sheet') || this.classList.contains('pc-authors-modal-overlay'))) { window.__sheetAnims.push({ t: Math.round(performance.now()), cls: this.className.split(' ')[0], keyframes: JSON.stringify(keyframes).slice(0, 200), options: JSON.stringify(options).slice(0, 160) }); } return original.call(this, keyframes, options); }; })(); true`);
      await cdp.eval("document.querySelector('.pc-authors--mobile-clickable').click(); true");
      await sleep(900);
      console.log('modal open:', await cdp.eval("!!document.querySelector('.pc-authors-modal-sheet')"));
      await run('open (via authors sheet)', "(() => { const el = document.querySelector('.pc-authors-modal-item'); window.__target = (el.textContent || '').trim().slice(0, 40); el.click(); return window.__target; })()", openWaitMs);
      console.log('sheet animations:', JSON.stringify(await cdp.eval('window.__sheetAnims'), null, 0).replace(/\},\{/g, '},\n{'));
    } else {
      await run('open', `(() => { const el = document.querySelector(${JSON.stringify(sel)}); window.__target = (el.textContent || '').trim().slice(0, 40); el.click(); return window.__target; })()`, openWaitMs);
    }
    console.log('target:', await cdp.eval('window.__target'));
    await pollUntil(cdp, 'Boolean(window.__heroLive)', 15000, 100);
    console.log('\n## hero (skeleton, first frame)\n' + JSON.stringify(await cdp.eval('window.__heroSkel || null'), null, 1));
    console.log('\n## hero (live, first frame)\n' + JSON.stringify(await cdp.eval('window.__heroLive || null'), null, 1));
    await sleep(1500);
    console.log('\n## hero (live, +1.5 s)\n' + JSON.stringify(await cdp.eval(HERO_DUMP), null, 1));
    console.log('openalex cache blob:', await cdp.eval("(localStorage.getItem('papertok_openalex_cache_v1') || '').length"), 'chars');
    console.log('reload key:', await cdp.eval("sessionStorage.getItem('papertok_preload_reloaded_at')"), 'sw:', await cdp.eval("navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlled' : 'none'"));
    await run('back (history.back)', 'history.back(); true', 2000);
  }

  if (mode === 'swipe') {
    // The feed on a phone, card to card: a swipe gesture on the snap
    // container, sampled every frame — the container's scrollTop, the card
    // under the reader, the pieces of the arriving card — with long tasks and
    // dropped frames, under `slow` (CPU ×4). `extra`: `mobile`, `slow`,
    // `n=<swipes>` (default 4).
    const flags = new Set((extra || '').split(',').filter(Boolean));
    const nFlag = [...flags].find((f) => f.startsWith('n='));
    const swipes = nFlag ? Number(nFlag.slice(2)) : 4;
    if (flags.has('mobile')) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }
    if (flags.has('slow')) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {} })();` });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__sw = []; window.__swOn = false; const tick = () => { if (window.__swOn) { const f = document.querySelector('.feed-container'); window.__sw.push({ t: Math.round(performance.now()), st: f ? Math.round(f.scrollTop) : null, cards: document.querySelectorAll('.feed-snap-item').length, sk: document.querySelectorAll('.sk').length, anims: document.getAnimations().length }); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();` });
    await cdp.send('Page.navigate', { url });
    await pollUntil(cdp, "document.querySelectorAll('.pc-sheet').length > 1", 40000, 100);
    await sleep(3000);
    const feedBox = await cdp.eval("(() => { const b = document.querySelector('.feed-container').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), top: Math.round(b.top), h: Math.round(b.height) }; })()");
    console.log('feed:', JSON.stringify(feedBox), 'cards:', await cdp.eval("document.querySelectorAll('.feed-snap-item').length"));
    for (let i = 0; i < swipes; i++) {
      await cdp.eval('window.__sw = []; window.__swOn = true; true');
      const t0 = await cdp.eval('Math.round(performance.now())');
      // A finger travelling up the screen: 600 px in 180 ms, then the snap.
      await cdp.send('Input.synthesizeScrollGesture', { x: feedBox.x, y: feedBox.top + Math.round(feedBox.h * 0.7), yDistance: -600, speed: 3400, gestureSourceType: 'touch' });
      await sleep(1400);
      const report = await cdp.eval(`(() => { window.__swOn = false; const p = window.__sw; const t0 = ${t0}; const gaps = []; for (let i = 1; i < p.length; i++) { const g = p[i].t - p[i - 1].t; if (g > 34) gaps.push({ at: p[i - 1].t - t0, gap: g }); } const longTasks = window.__lt.filter((e) => e.t >= t0 - 20 && e.t <= t0 + 1400).map((e) => ({ at: e.t - t0, d: e.d })); const from = p[0]?.st; const to = p[p.length - 1]?.st; const moving = p.filter((x, i) => i > 0 && x.st !== p[i - 1].st); return { frames: p.length, from, to, movingFrames: moving.length, firstMoveAt: moving[0] ? moving[0].t - t0 : null, settledAt: moving.length ? moving[moving.length - 1].t - t0 : null, cards: p[p.length - 1]?.cards, anims: p[p.length - 1]?.anims, frameGapsOver34ms: gaps, longTasks }; })()`);
      console.log(`\n## swipe ${i + 1}`);
      console.log(JSON.stringify(report));
    }
  }

  if (mode === 'consent') {
    // The analytics banner in the guest feed: press "Allow analytics" and
    // sample the button's faces, the check, the button's width and the
    // banner itself every frame until the banner has gone.
    await cdp.send('Page.navigate', { url });
    const shown = await pollUntil(cdp, "!!document.querySelector('.analytics-consent-accept')", 60000, 250);
    console.log('banner shown:', shown);
    await sleep(600);
    const clicked = await cdp.eval(`(() => { window.__cn = []; const face = (name) => { const f = document.querySelector('.analytics-consent-accept-face[data-face="' + name + '"]'); if (!f) return null; const cs = getComputedStyle(f); return Number(cs.opacity).toFixed(2) + '@' + (cs.transform === 'none' ? '0' : cs.transform.split(',').pop().trim().replace(')', '')); }; const tick = () => { const b = document.querySelector('.analytics-consent'); const btn = document.querySelector('.analytics-consent-accept'); const check = document.querySelector('.analytics-consent-accept-face[data-face="success"] svg'); window.__cn.push({ t: Math.round(performance.now()), banner: b ? Number(getComputedStyle(b).opacity).toFixed(2) : null, width: btn ? Math.round(btn.getBoundingClientRect().width) : null, state: btn ? btn.className.replace('analytics-consent-accept ', '') : null, idle: face('idle'), loading: face('loading'), success: face('success'), check: check ? getComputedStyle(check).transform.slice(0, 22) : null, icon: b ? getComputedStyle(b.querySelector('.analytics-consent-icon')).color : null }); if (window.__cn.length < 400) requestAnimationFrame(tick); }; requestAnimationFrame(tick); const button = document.querySelector('.analytics-consent-accept'); button.click(); return button.textContent.trim(); })()`);
    console.log('clicked:', clicked);
    await sleep(2600);
    const report = await cdp.eval(`(() => { const p = window.__cn; const changes = []; let last = ''; for (const x of p) { const k = JSON.stringify([x.banner, x.width, x.state, x.idle, x.loading, x.success, x.check, x.icon]); if (k !== last) { last = k; changes.push(x); } } return { frames: p.length, widths: [...new Set(p.map(x => x.width))], changes: changes.slice(0, 80) }; })()`);
    console.log(JSON.stringify(report, null, 0).replace(/\},\{/g, '},\n{'));
  }

  if (mode === 'paint') {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const held = [];
    cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
      if (/openalex/.test(request.url) && /\/(authors|institutions)\/[AI]\d+/.test(request.url)) { held.push(request.url); return; }
      cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });
    await cdp.send('Page.navigate', { url });
    const skeleton = await pollUntil(cdp, "!!document.querySelector('.explorer-skeleton')", 20000);
    await sleep(1500);
    if (extra === 'old') {
      await cdp.eval(`(() => { const s = document.createElement('style'); s.textContent = \`
        .ex-skel { animation: shimmer 1.5s ease-in-out infinite; background: linear-gradient(90deg, var(--bg-secondary) 25%, var(--border-subtle) 50%, var(--bg-secondary) 75%); background-size: 200% 100%; overflow: visible; }
        .ex-skel::after { content: none; animation: none; }\`; document.head.appendChild(s); return 'old shimmer restored'; })()`);
      await sleep(500);
    }
    const anims = await cdp.eval(`(() => { const a = document.getAnimations(); const byKind = {}; for (const an of a) { const k = (an.effect?.pseudoElement || 'element') + ':' + (an.animationName || an.constructor.name); byKind[k] = (byKind[k] || 0) + 1; } return { total: a.length, byKind, shapes: document.querySelectorAll('.ex-skel').length, elementAnim: getComputedStyle(document.querySelector('.ex-skel')).animationName, afterAnim: getComputedStyle(document.querySelector('.ex-skel'), '::after').animationName, held: ${JSON.stringify(held)} }; })()`);
    console.log('skeleton:', skeleton, JSON.stringify(anims));
    const events = [];
    cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    const complete = new Promise((r) => cdp.on('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame', transferMode: 'ReportEvents' });
    await sleep(3000);
    await cdp.send('Tracing.end');
    await complete;
    const agg = {};
    for (const e of events) {
      if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
      const a = agg[e.name] || (agg[e.name] = { count: 0, ms: 0 });
      a.count += 1; a.ms += e.dur / 1000;
    }
    const frames = events.filter((e) => e.name === 'DrawFrame').length;
    const rows = Object.entries(agg).sort((x, y) => y[1].ms - x[1].ms).slice(0, 14)
      .map(([name, v]) => `${name.padEnd(28)} ${String(v.count).padStart(6)}  ${v.ms.toFixed(1).padStart(8)} ms`);
    const pick = ['Paint', 'PaintImage', 'RasterTask', 'GPUTask', 'UpdateLayoutTree', 'PrePaint', 'Layerize', 'UpdateLayer', 'Commit', 'RunTask']
      .map((name) => `${name}=${agg[name]?.count || 0}/${(agg[name]?.ms || 0).toFixed(1)}ms`).join('  ');
    console.log(`variant=${extra || 'new'} events=${events.length} drawFrames=${frames}\n${pick}\n${rows.join('\n')}`);
  }
} finally {
  chrome.kill();
  await sleep(300);
  if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
}
