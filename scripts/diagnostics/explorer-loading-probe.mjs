// Explorer loading probe over CDP against a headless Chrome. No dependencies.
// usage: node probe.mjs timeline '#/explorer/author/A…' [seconds]
//        node probe.mjs tabs '#/explorer/institution/I…'
//        node probe.mjs paint '#/explorer/author/A…' new|old
//        node probe.mjs bootload '#/' [demo,mobile,hold]   (PROFILE_DIR=<profile> to reuse one)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
    if (await cdp.eval(expression)) return true;
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
