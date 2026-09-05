# Explorer Animations Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the measured jolts when an author, institution, project or topic is opened from the feed or from the search palette: the squeezed experience panel, the Wikipedia block that goes up and down, the entity that arrives as a skeleton although the palette already holds it, and the three-clock palette handover.

**Architecture:** The hero body's height settle (`useHeightSettle`) becomes a pure decision (`planHeightSettle`) wired to a layout effect that runs on every commit, so its memory can never go stale and a settle in flight is re-aimed when its target moves; a CSS rule stops the settle from squeezing the body's own children. Framer's `layout` projections that fought the settle are deleted. Pages are born live whenever the route or the search row already knows the entity, and the skeleton reserves only what the route can know. The palette hands the entity over in router state and vanishes in 100ms when a result is picked.

**Tech Stack:** React 19, framer-motion, react-router 7 (`HashRouter`), Web Animations API, plain CSS, `node --test` source tests (no DOM runtime), Vite.

**Spec:** `docs/AUDITORIA-ANIMACIONES-EXPLORER-2026-09-05.md` — findings A1–A12 with the measured numbers. Every task below names the finding it closes.

## Global Constraints

- Tests run with `node --test $(find src worker proxy -name '*.test.js')` under Node 22 in CI (local is Node 25); there is no DOM runtime, so behaviour tests cover pure modules and source tests pin JSX/CSS by regex after stripping comments (`stripComments` helper, as in `explorerMotion.test.js`).
- `src/services/firebase.js` must keep `export const IS_DEMO = false;` in every commit.
- Reduced motion keeps colour and opacity and drops movement; every new animation must be covered by the existing `@media (prefers-reduced-motion: reduce)` blocks of its stylesheet.
- Only `transform` and `opacity` animate in new motion; the height settles that already exist stay (they move the content below, which no transform can do).
- Curves and durations come from the review's catalog: entrances `cubic-bezier(0.23, 1, 0.32, 1)` at 100–250ms; the settle keeps `cubic-bezier(0.4, 0, 0.2, 1)` at 360ms.
- Commit messages in Spanish, `tipo(ámbito): …`, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Another session may be editing the same tree: `git status` before each commit and stage files by name.
- Never commit anything under `dist/` or the scratch probe profiles.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/hooks/heightSettlePlan.js` (new) | Pure decision for a height settle on one commit: none / animate / resume, plus the memory to keep. |
| `src/hooks/heightSettlePlan.test.js` (new) | Behaviour tests for the decision. |
| `src/hooks/useHeightSettle.js` | Measures the box, asks the plan, drives the Web Animation. Runs every commit. |
| `src/components/Explorer/EntityExplorer.css` | `flex-shrink: 0` on the hero body's children; the error screen's entrance. |
| `src/components/Explorer/EntityExplorer.jsx` | Experience panel fade on arrival; no `layout` on the wiki fold and the summary box; born-resolved local topics and handed entities; the ORCID-aware skeleton shape; the Wikipedia paragraph keyed by source. |
| `src/utils/explorerSkeletonShape.js` | `hasOrcid` option: the ORCID slot is reserved only when the route knows. |
| `src/utils/explorerHandover.js` (new) | What a search row hands the Explorer, and which handed entity a route accepts. |
| `src/utils/explorerHandover.test.js` (new) | Behaviour tests for the handover. |
| `src/components/Search/SearchCommand.jsx` | Rows hand the entity over; picking a result closes the sheet without its dismiss animation. |
| `src/components/Search/SearchCommand.css` | The 100ms "picked" exit for sheet and scrim. |
| `scripts/diagnostics/explorer-hero-frames.mjs` (new) | The per-frame sampler the review used, for the verification steps. |
| Tests touched | `explorerEntrance.test.js`, `explorerMotion.test.js`, `explorerLoading.test.js`, `explorerReservation.test.js`, `explorerSkeletonShape.test.js`, `paletteMotion.test.js`, `searchIntegration.test.js`. |

Tasks 1–10 are the fix. Tasks 11–13 are product decisions the review flagged; they are written out so they can be executed, and each says what it reverses.

---

### Task 0: The per-frame sampler, in the repo

The review measured with a script that lived in a session scratchpad. The verification steps of every task below run it, so it goes into `scripts/diagnostics/` next to `explorer-loading-probe.mjs`.

**Files:**
- Create: `scripts/diagnostics/explorer-hero-frames.mjs`
- Modify: `scripts/diagnostics/README.md` (append a section)

**Interfaces:**
- Produces: `node scripts/diagnostics/explorer-hero-frames.mjs route '<hash>' [mobile] [ms]`, `… fromfeed '<css>' [late] [idx=N] [ms]`, `… fromsearch <author|institution|topic|project> q=<text> [late] [mobile] [ms]`, `… shotwhen '<hash>' '<js expr>' <out.png>`. `ORIGIN` (default `http://localhost:5173`), `PORT` (CDP port, default 9226). Output: one JSON line per frame on which something moved.

- [ ] **Step 1: Create the script**

```js
// Per-frame geometry of the Explorer hero's arrivals, over CDP against a
// headless Chrome. No dependencies (Node >= 22 for the global WebSocket).
//
//   node explorer-hero-frames.mjs route '#/explorer/author/A…' [mobile] [ms]
//   node explorer-hero-frames.mjs fromfeed '<css selector>' [late] [idx=N] [ms]
//   node explorer-hero-frames.mjs fromsearch author|institution|topic|project q=<text> [late] [mobile] [ms]
//   node explorer-hero-frames.mjs shotwhen '#/explorer/…' '<js expression>' out.png
//
// `fromsearch` needs a build made with IS_DEMO = true (never committed): the
// palette only mounts for a signed-in user, and the demo session is whatever
// localStorage says it is.
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
const PROFILE = join(tmpdir(), `papertok-hero-frames-${process.pid}`);
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
    chrome.kill('SIGKILL'); rmSync(PROFILE, { recursive: true, force: true }); process.exit(0);
  } else if (mode === 'fromsearch') {
    const query = ([...flags].find((f) => f.startsWith('q=')) || 'q=harvard').slice(2);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'demo-user-123', displayName: 'Demo User', email: 'demo@papertok.app', photoURL: '', providerData: [{ providerId: 'google.com' }] })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['bio.neuro', 'physics'])); } catch {} })();` });
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
    await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
    for (let i = 0; i < 400; i++) { if (await cdp.eval(`document.querySelectorAll(${JSON.stringify(arg)}).length > ${idx}`).catch(() => false)) break; await sleep(100); }
    await sleep(flags.has('late') ? 4000 : 1500);
    await clickAndSample(arg, idx);
  }
  const report = await cdp.eval(REPORT);
  console.log(JSON.stringify({ frames: report.frames, gaps: report.gaps }));
  for (const c of report.changes) console.log(JSON.stringify(c));
} finally {
  chrome.kill('SIGKILL');
  rmSync(PROFILE, { recursive: true, force: true });
}
```

- [ ] **Step 2: Smoke-run it against a production preview**

Run (two terminals, or the launch entry `papertok-preview-5173`):

```bash
npm run build && npx vite preview --port 5173 --strictPort
```

```bash
node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/author/A5068353058' 7000 | head -5
```

Expected: a `[navigated]` line, then `{"frames":…,"gaps":[…]}` and JSON frame lines with `panel`, `inner`, `settle` fields. If Chrome is not at the default path, set `CHROME=`.

- [ ] **Step 3: Document it**

Append to `scripts/diagnostics/README.md` (the outer fence is four backticks because the section carries a fenced block of its own):

````markdown
## `explorer-hero-frames.mjs` — the hero's arrivals, frame by frame (2026-09-05)

The `open` probe above samples the hero's box. This one samples what is INSIDE
it as well — the experience panel and its inner, the Wikipedia fold with its
computed transform, the settle's own `from`/`to`/`currentTime` — because the
two mechanisms of the 2026-09-05 audit (`docs/AUDITORIA-ANIMACIONES-EXPLORER-2026-09-05.md`)
were invisible from the box: a panel squeezed to 0px by flex under a settle,
and a settle re-animating from a height the box had already left.

```bash
node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/author/A5068353058' 7000
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-topic-link' late 7000
node scripts/diagnostics/explorer-hero-frames.mjs fromsearch author q=moher late 6000   # needs an IS_DEMO build
node scripts/diagnostics/explorer-hero-frames.mjs shotwhen '#/explorer/author/A5068353058' "(()=>{const p=document.querySelector('#ehc-experience-panel');return !!p&&p.getBoundingClientRect().height<110;})()" squeeze.png
```

`fromsearch` seeds a demo session in `localStorage` before the first script and
types with `Input.insertText` (cmdk ignores the native value setter). Build with
`IS_DEMO = true` in `src/services/firebase.js` for it, and put it back to `false`
before committing anything.
````

- [ ] **Step 4: Commit**

```bash
git add scripts/diagnostics/explorer-hero-frames.mjs scripts/diagnostics/README.md
git commit -m "chore(diagnostics): sonda por fotograma del héroe del Explorer — lo de dentro de la caja, no solo la caja

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: The settle's decision as a pure function (A2)

**Files:**
- Create: `src/hooks/heightSettlePlan.js`
- Test: `src/hooks/heightSettlePlan.test.js`

**Interfaces:**
- Produces: `planHeightSettle({ remembered, depsChanged, running, current, natural }) → { action: 'none' | 'animate' | 'resume', from?, to?, currentTime?, remember }` and `depsAreSame(previous, next) → boolean`. Task 2 consumes both.

- [ ] **Step 1: Write the failing tests**

```js
// src/hooks/heightSettlePlan.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { depsAreSame, planHeightSettle } from './heightSettlePlan.js';

/**
 * The hero body's settle used to keep its memory only on the commits whose
 * deps changed. Every height change without a dep — the Wikipedia toggle
 * mounting a frame after the paragraph, the reader folding the experience
 * panel — left the memory behind, and the next dep animated the box from a
 * height it had already left: measured on a topic page, the list jumped 27px
 * up and slid back down 1.4s after the paragraph had landed.
 */
test('the first commit only remembers', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: null, depsChanged: true, running: null, current: null, natural: 226 }),
    { action: 'none', remember: 226 },
  );
});

test('a declared change animates from the remembered height to the natural one', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: 237.9, depsChanged: true, running: null, current: null, natural: 479.3 }),
    { action: 'animate', from: 237.9, to: 479.3, remember: 479.3 },
  );
});

test('a change too small to see is not animated', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: 226, depsChanged: true, running: null, current: null, natural: 226.6 }),
    { action: 'none', remember: 226.6 },
  );
});

test('a commit without a declared change re-syncs the memory instead of animating', () => {
  // The reader folded the panel: the box is at 243 and nothing declared it.
  assert.deepEqual(
    planHeightSettle({ remembered: 216.4, depsChanged: false, running: null, current: null, natural: 243.4 }),
    { action: 'none', remember: 243.4 },
  );
});

test('a settle in flight whose target moved is re-aimed from where the box is', () => {
  // Measured: Wikipedia lands (146 → 216.4), the toggle mounts a frame later
  // and the natural height is 243.4. Without this the box eased to 216.4 and
  // snapped +27px the frame the settle let go.
  assert.deepEqual(
    planHeightSettle({ remembered: 146, depsChanged: false, running: { from: 146, to: 216.4, currentTime: 17 }, current: 146.3, natural: 243.4 }),
    { action: 'animate', from: 146.3, to: 243.4, remember: 243.4 },
  );
});

test('a settle in flight whose target did not move resumes on its own clock', () => {
  // A row chunk mounted under the list mid-settle: nothing about the hero
  // changed, so the same keyframes carry on from the same instant.
  assert.deepEqual(
    planHeightSettle({ remembered: 146, depsChanged: false, running: { from: 146, to: 216.4, currentTime: 200 }, current: 205, natural: 216.4 }),
    { action: 'resume', from: 146, to: 216.4, currentTime: 200, remember: 216.4 },
  );
});

test('depsAreSame compares position by position with Object.is', () => {
  assert.equal(depsAreSame(null, [1]), false);
  assert.equal(depsAreSame([1, 'a', null], [1, 'a', null]), true);
  assert.equal(depsAreSame([1, 'a'], [1, 'b']), false);
  assert.equal(depsAreSame([NaN], [NaN]), true);
  assert.equal(depsAreSame([1], [1, 2]), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/hooks/heightSettlePlan.test.js`
Expected: FAIL with `Cannot find module … heightSettlePlan.js`.

- [ ] **Step 3: Write the module**

```js
// src/hooks/heightSettlePlan.js

/** Under this many pixels a change is not worth a movement. */
const SAME_HEIGHT_PX = 1;

/**
 * What a height settle should do on this commit. Pure: the hook measures and
 * animates, this decides.
 *
 * - `remembered`: the natural height remembered from the previous commit, or
 *   null on the first one.
 * - `depsChanged`: whether the pieces of state declared to change the height
 *   changed on this commit.
 * - `running`: the settle already in flight, read BEFORE cancelling it —
 *   `{ from, to, currentTime }` — or null.
 * - `current`: the box's animated height right now (meaningful only with a
 *   settle in flight).
 * - `natural`: the box's height with nothing holding it, measured on this
 *   commit.
 *
 * `remember` is always the natural height. The memory follows the box on
 * EVERY commit, so a height that changed without a declared dep — a toggle
 * mounting a frame late, the reader folding a panel — can never make the next
 * settle start from a height the box is no longer at (measured before this:
 * the list jumped 27px up and slid back down when a thumbnail loaded 1.4s
 * after the paragraph).
 *
 * A settle in flight is read every commit too. If its target still stands,
 * it resumes on the same keyframes and clock; if the target moved under it
 * (the toggle landing a frame after the paragraph it belongs to), it is
 * re-aimed from where the box is, so the box never eases to a height that is
 * already wrong and snaps the difference at the end.
 */
export function planHeightSettle({ remembered, depsChanged, running, current, natural }) {
  const remember = natural;
  if (running) {
    if (Math.abs(natural - running.to) < SAME_HEIGHT_PX) {
      return { action: 'resume', from: running.from, to: running.to, currentTime: running.currentTime, remember };
    }
    return { action: 'animate', from: current, to: natural, remember };
  }
  if (remembered == null || !depsChanged || Math.abs(natural - remembered) < SAME_HEIGHT_PX) {
    return { action: 'none', remember };
  }
  return { action: 'animate', from: remembered, to: natural, remember };
}

/** Whether two dependency lists are the same, the way React compares them. */
export function depsAreSame(previous, next) {
  if (previous == null || next == null) return false;
  if (previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/hooks/heightSettlePlan.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/heightSettlePlan.js src/hooks/heightSettlePlan.test.js
git commit -m "feat(explorer): la decisión del settle de altura, pura y con memoria en cada commit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `useHeightSettle` runs every commit on the plan (A2)

**Files:**
- Modify: `src/hooks/useHeightSettle.js` (whole file)
- Test: `src/components/Explorer/explorerEntrance.test.js:65-78` (the test named `the height settle is a FLIP on one property, chaining through a settle already running`)

**Interfaces:**
- Consumes: `planHeightSettle`, `depsAreSame` from Task 1.
- Produces: the same `useHeightSettle(ref, deps, { enabled, duration, easing })` signature; its one caller in `EntityExplorer.jsx:444-452` does not change.

- [ ] **Step 1: Replace the source test**

In `src/components/Explorer/explorerEntrance.test.js`, replace the whole test `the height settle is a FLIP on one property, chaining through a settle already running` with:

```js
test('the height settle is a FLIP on one property, decided every commit and re-aimed in flight', async () => {
  const hook = (await read('../../hooks/useHeightSettle.js')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.match(hook, /import \{ depsAreSame, planHeightSettle \} from '\.\/heightSettlePlan\.js';/);
  // Measured before paint, so the first frame is already the old height —
  // and with NO dependency list: the memory is kept on every commit.
  assert.match(hook, /useLayoutEffect\(\(\) => \{/);
  assert.match(hook, /\n  \}\);\n\}\n$/, 'the effect closes without a dependency array');
  assert.doesNotMatch(hook, /eslint-disable-next-line react-hooks\/exhaustive-deps/);
  // A settle in flight is read (keyframes and clock) before it is cancelled.
  assert.match(hook, /el\.getAnimations\(\)\.find\(\(animation\) => animation\.id === SETTLE_ID\)/);
  assert.match(hook, /const \[start, end\] = inFlight\.effect\.getKeyframes\(\);/);
  assert.match(hook, /current = el\.getBoundingClientRect\(\)\.height;\s*inFlight\.cancel\(\);/);
  // The decision is the pure module's; the hook only measures and drives.
  assert.match(hook, /const plan = planHeightSettle\(\{ remembered: lastHeightRef\.current, depsChanged, running, current, natural \}\);/);
  assert.match(hook, /lastHeightRef\.current = plan\.remember;/);
  assert.match(hook, /el\.animate\(\s*\[\{ height: `\$\{plan\.from\}px` \}, \{ height: `\$\{plan\.to\}px` \}\],/);
  assert.match(hook, /if \(plan\.action === 'resume'\) animation\.currentTime = plan\.currentTime;/);
  // Clipped only while moving; a newer settle keeps the clip.
  assert.match(hook, /el\.style\.overflow = 'hidden';/);
  assert.match(hook, /animation\.finished\.then\(release, release\);/);
  assert.match(hook, /if \(el\.getAnimations\(\)\.some\(\(other\) => other\.id === SETTLE_ID\)\) return;/, 'a newer settle keeps the clip');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Explorer/explorerEntrance.test.js`
Expected: FAIL on the `import { depsAreSame, planHeightSettle }` assertion.

- [ ] **Step 3: Rewrite the hook**

Replace the whole of `src/hooks/useHeightSettle.js` with:

```js
import { useLayoutEffect, useRef } from 'react';
import { depsAreSame, planHeightSettle } from './heightSettlePlan.js';

const SETTLE_ID = 'height-settle';
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** The `overflow` each element had before a settle clipped it, by element. */
const restingOverflow = new WeakMap();

/**
 * Settles an element's height across a change in what it holds, instead of
 * letting the box snap to its new size in one frame.
 *
 * FLIP on one property: after each commit the hook measures the element and,
 * if the decision (`planHeightSettle`) says so, plays a Web Animation from
 * the height it remembers to this one. The natural height is never written
 * to the element — the animation holds the old value and releases to whatever
 * layout says — so the content underneath keeps laying out on its own and
 * nothing has to know the final number in advance.
 *
 * The effect has NO dependency list on purpose. `deps` still say which
 * changes are worth a movement, but the memory of the box's height is kept
 * on every commit: a height that changed without a dep (a toggle mounting a
 * frame after the paragraph it belongs to, the reader folding a panel) used
 * to leave the memory behind, and the next dep animated the box from a
 * height it had already left — measured on a topic page as the list jumping
 * 27px up and sliding back down when the thumbnail loaded. A settle in
 * flight is read every commit as well: if its target still stands it resumes
 * on the same keyframes and clock; if the target moved under it, it is
 * re-aimed from where the box is. The cost is one layout read per commit on
 * a small subtree, which the browser was about to do before paint anyway.
 *
 * The ref may point at a different element from one commit to the next (a
 * skeleton and the live block it hands over to): the remembered height
 * belongs to the slot, not the node, which is what makes the handover between
 * the two settle rather than jump.
 *
 * While a settle runs the element clips (`overflow: hidden`), because its box
 * is smaller than its content on the way up; the `overflow` it had is put
 * back when the last settle ends, so a menu that hangs outside the box at
 * rest is only clipped while the box is moving.
 *
 * `enabled: false` keeps the memory up to date without animating (reduced
 * motion).
 */
export function useHeightSettle(ref, deps, { enabled = true, duration = 360, easing = EASE } = {}) {
  const lastHeightRef = useRef(null);
  const lastDepsRef = useRef(null);

  useLayoutEffect(() => {
    const depsChanged = !depsAreSame(lastDepsRef.current, deps);
    lastDepsRef.current = deps;
    const el = ref.current;
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      lastHeightRef.current = null;
      return;
    }
    const inFlight = typeof el.getAnimations === 'function'
      ? el.getAnimations().find((animation) => animation.id === SETTLE_ID)
      : null;
    let running = null;
    let current = null;
    if (inFlight) {
      const [start, end] = inFlight.effect.getKeyframes();
      running = { from: parseFloat(start.height), to: parseFloat(end.height), currentTime: inFlight.currentTime || 0 };
      current = el.getBoundingClientRect().height;
      inFlight.cancel();
    }
    const natural = el.getBoundingClientRect().height;
    const plan = planHeightSettle({ remembered: lastHeightRef.current, depsChanged, running, current, natural });
    lastHeightRef.current = plan.remember;
    if (!enabled || plan.action === 'none' || typeof el.animate !== 'function') return;
    if (!restingOverflow.has(el)) restingOverflow.set(el, el.style.overflow);
    el.style.overflow = 'hidden';
    const animation = el.animate(
      [{ height: `${plan.from}px` }, { height: `${plan.to}px` }],
      { duration, easing },
    );
    animation.id = SETTLE_ID;
    if (plan.action === 'resume') animation.currentTime = plan.currentTime;
    const release = () => {
      // A newer settle may have taken over the box; it will release it.
      if (el.getAnimations().some((other) => other.id === SETTLE_ID)) return;
      el.style.overflow = restingOverflow.get(el) ?? '';
      restingOverflow.delete(el);
    };
    animation.finished.then(release, release);
  });
}
```

- [ ] **Step 4: Run the Explorer tests**

Run: `node --test src/components/Explorer/explorerEntrance.test.js src/components/Explorer/explorerMotion.test.js src/hooks/heightSettlePlan.test.js`
Expected: all passing. `npm run lint` must also pass: the effect has no dependency array, which `react-hooks/exhaustive-deps` accepts.

- [ ] **Step 5: Verify on the page**

Run `npm run build && npx vite preview --port 5173 --strictPort`, then:

```bash
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-topic-link' late 7000 | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=s.split("\n").filter(l=>l.startsWith("{\"t\"")).map(JSON.parse);
let worst=0,at=0,prev=null;for(const r of rows){if(prev&&r.tabs&&prev.tabs){const d=Math.abs(parseFloat(r.tabs)-parseFloat(prev.tabs));if(d>worst){worst=d;at=r.t;}}prev=r;}
console.log("worst single-frame move of the tab strip:",worst.toFixed(1),"px at",at,"ms");});'
```

Expected: the worst single-frame move of `.ee-tabs` after the Wikipedia paragraph lands is under 8px (it was 27). No frame where the settle's `from` differs by more than 1px from the previous frame's `bodyH`.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useHeightSettle.js src/components/Explorer/explorerEntrance.test.js
git commit -m "fix(explorer): el settle del héroe recuerda la caja en cada commit y se re-apunta en vuelo — fuera el sube y baja de Wikipedia

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Nothing in the hero body gives way to the settle (A1)

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.css:101-106` (add a rule after `.explorer-hero-content`)
- Test: `src/components/Explorer/explorerMotion.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/components/Explorer/explorerMotion.test.js`:

```js
/**
 * `useHeightSettle` pins the hero body's height with a Web Animation. A flex
 * column with a definite height smaller than its content shrinks the items
 * whose automatic minimum size is 0 — exactly the ones with `overflow:
 * hidden`: the experience panel, the Wikipedia fold, the wiki block. Measured
 * on ORCID's arrival: the panel laid out at 0px for the first 117ms of a
 * 360ms settle, its inner 136px the whole time, then grew 0→152 in the tail
 * and shoved the card that had already landed.
 */
test('nothing in the hero body gives way to the settle', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.match(css, /\.explorer-hero-content > \* \{\s*flex-shrink: 0;\s*\}/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Explorer/explorerMotion.test.js`
Expected: FAIL on the new test.

- [ ] **Step 3: Add the rule**

In `src/components/Explorer/EntityExplorer.css`, right after the `.explorer-hero-content { … }` block (line 106), add:

```css
/* The settle (`useHeightSettle`) pins this box's height with a Web Animation.
   A flex column with a definite height smaller than its content shrinks the
   items whose automatic minimum size is 0 — exactly the ones with `overflow:
   hidden`: the experience panel, the Wikipedia fold, the wiki block. Measured
   on ORCID's arrival: the panel laid out at 0px for the first 117ms of a
   360ms settle, its inner 136px the whole time, then grew 0→152 in the tail
   and shoved the ORCID card that had already landed. Nothing in this column
   may give way: the box clips at the bottom while it grows, which is the
   reveal the settle exists for. */
.explorer-hero-content > * {
  flex-shrink: 0;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/components/Explorer/explorerMotion.test.js`
Expected: PASS.

- [ ] **Step 5: Verify on the page**

With the preview up:

```bash
node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/author/A5068353058' 7000 | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const rows=s.split("\n").filter(l=>l.startsWith("{\"t\"")).map(JSON.parse).filter(r=>r.panel);
const first=rows[0];console.log("first frame with the panel:",first.t,"panel",first.panel,"inner",first.inner);
const squeezed=rows.filter(r=>parseFloat(r.panel.split("+")[1])<parseFloat(r.inner.split("+")[1]));console.log("frames with the panel shorter than its inner:",squeezed.length);});'
```

Expected: `frames with the panel shorter than its inner: 0` (it was ~7). The panel's height equals its inner plus 16px from its first frame, and the ORCID card below it is revealed by the body's clip.

- [ ] **Step 6: Commit**

```bash
git add src/components/Explorer/EntityExplorer.css src/components/Explorer/explorerMotion.test.js
git commit -m "fix(explorer): el settle ya no aplasta a cero el panel de experiencia ni el bloque de Wikipedia

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The experience panel fades in on arrival (A4)

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx:1776-1784` (the `initial` prop and its comment)
- Test: `src/components/Explorer/explorerMotion.test.js:159` (the assertion inside `the ORCID experience panel mounts at full height on arrival and animates only for the toggle`)

- [ ] **Step 1: Change the assertion**

In `src/components/Explorer/explorerMotion.test.js`, replace the line

```js
  assert.match(jsx, /initial=\{!experienceToggled \? false : prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, height: 0 \}\}/);
```

with

```js
  // On arrival the panel mounts at full height (the settle carries the space)
  // and fades in (the words arrive): opacity does not touch layout, so the
  // height keeps a single owner. `initial={false}` used to switch the fade
  // off with the height — the bordered panel popped in at opacity 1.
  assert.match(jsx, /initial=\{experienceToggled \? \(prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, height: 0 \}\) : \{ opacity: 0 \}\}/);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Explorer/explorerMotion.test.js`
Expected: FAIL on that assertion.

- [ ] **Step 3: Change the prop**

In `src/components/Explorer/EntityExplorer.jsx`, replace the `initial` line of the `#ehc-experience-panel` motion.div (line 1784) and the comment above it (lines 1779-1783) with:

```jsx
                  // On arrival the panel is already open when the record
                  // lands, so it mounts at full height and the hero body's
                  // settle is the one animation that carries the SPACE (see
                  // `experienceToggled`). Its contents still arrive: an
                  // opacity-only entrance, which touches no layout, so the
                  // height keeps a single owner. `initial={false}` here used
                  // to switch the fade off with the height, and the bordered
                  // panel popped in at opacity 1 (measured). The entrance from
                  // 0 height is the reader's toggle, where the box is at rest.
                  initial={experienceToggled ? (prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }) : { opacity: 0 }}
```

The `transition` prop below it already fades opacity over 0.2s on the house curve; it stays.

- [ ] **Step 4: Run the tests**

Run: `node --test src/components/Explorer/explorerMotion.test.js`
Expected: PASS.

- [ ] **Step 5: Verify on the page**

```bash
node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/author/A5068353058' 7000 | grep '"panel"' | head -4 | cut -c1-40,200-260
```

Expected: the first frames with the panel show its opacity below 1.00 (`/0.35`, `/0.6`…) rising to `/1.00` within ~200ms, while `panel` height equals `inner` + 16 from the first frame.

- [ ] **Step 6: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerMotion.test.js
git commit -m "fix(explorer): el panel de experiencia llega fundido; el settle sigue siendo el único dueño de su altura

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: One owner per height — no `layout` on the wiki fold or the summary box (A3)

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx:1982-2019` (wiki fold) and `:1871-1884` (project summary box)
- Test: `src/components/Explorer/explorerLoading.test.js:121` and `src/components/Explorer/explorerMotion.test.js` (append)

- [ ] **Step 1: Change the fold's assertion and add the summary's**

In `src/components/Explorer/explorerLoading.test.js`, replace

```js
  const fold = jsx.match(/<motion\.div\s+layout\s+className="ehc-wiki-fold"[\s\S]*?>\s*<div\s+className=\{`ehc-wiki /);
```

with

```js
  // No `layout` on the fold: the hero body's settle already carries this
  // height, and a projection on top of it scaled the paragraph (measured:
  // scaleY 1.21 for 380ms on a topic, 1.3 for a frame on an institution).
  const fold = jsx.match(/<motion\.div\s+className="ehc-wiki-fold"[\s\S]*?>\s*<div\s+className=\{`ehc-wiki /);
  assert.ok(fold, 'the fold declares no layout projection');
  assert.doesNotMatch(fold[0], /\blayout\b/);
```

Append to `src/components/Explorer/explorerMotion.test.js`:

```js
/**
 * The project summary box carried `layout` too. The hero body's settle
 * already animates the space; the projection was a second owner of the same
 * height, and it scaled three lines of serif when the "Read more" toggle
 * mounted a frame after the text.
 */
test('the project summary box is a plain block; the settle owns its height', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /\{type === 'project' && entity\?\.summary && \(\s*<div\s+className=\{`project-summary-box/);
  const box = jsx.match(/<div\s+className=\{`project-summary-box[\s\S]*?<\/div>\s*\)\}/);
  assert.ok(box, 'the summary box is still rendered');
  assert.doesNotMatch(box[0], /\blayout\b/);
  assert.doesNotMatch(box[0], /transition=/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/components/Explorer/explorerLoading.test.js src/components/Explorer/explorerMotion.test.js`
Expected: FAIL on both new assertions.

- [ ] **Step 3: Remove the projections**

In `src/components/Explorer/EntityExplorer.jsx`:

(a) The wiki fold (line 1982): change `<motion.div\n                layout\n                className="ehc-wiki-fold"` to

```jsx
              <motion.div
                // No `layout`. The hero body's settle already carries this
                // height; a projection on top of it was a second owner of
                // the same number, and it scaled the paragraph while the
                // body was still settling (measured: scaleY 1.21 with 13.5px
                // of drift for 380ms on a topic, 1.3 for a frame on an
                // institution). The fold animates its own height only when
                // it arrives or leaves; in between, the settle moves it.
                className="ehc-wiki-fold"
```

and in its `transition` prop (line 2013-2019) delete the line `layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },`.

(b) The project summary (lines 1871-1884): change `<motion.div` to `<div`, delete the `layout={!prefersReducedMotion}` line and the whole `transition={…}` prop (three lines), and change the closing `</motion.div>` of that block (line ~1904) to `</div>`. The `onClick`, `onKeyDown`, `role`, `tabIndex`, `aria-*` props stay as they are.

- [ ] **Step 4: Run the tests and the linter**

Run: `node --test src/components/Explorer/explorerLoading.test.js src/components/Explorer/explorerMotion.test.js && npm run lint`
Expected: PASS; lint clean (`motion` is still imported and used elsewhere in the file).

- [ ] **Step 5: Verify on the page**

```bash
node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/institution/I173304897' 8000 | grep -c 'sy1\.[1-9]'
```

Expected: `0` (no frame with the fold scaled). The same command with `fromfeed '.pc-topic-link' late 7000` also prints `0`.

- [ ] **Step 6: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerLoading.test.js src/components/Explorer/explorerMotion.test.js
git commit -m "fix(explorer): una altura, un dueño — fuera la proyección layout del bloque de Wikipedia y del resumen del proyecto

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: A local topic is born resolved, on arrival and on navigation (A5)

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx:215-230` (initial state) and `:596-600` (the query-topic branch of `loadEntity`)
- Test: `src/components/Explorer/explorerReservation.test.js:47-49`

`getLocalTopicEntity` is already imported at the top of `EntityExplorer.jsx` (line 4). `isOpaqueQueryTopicText` and `resolveQueryTopicRoute` too (line 36).

- [ ] **Step 1: Change the assertions**

In `src/components/Explorer/explorerReservation.test.js`, replace lines 47-49 (the three `assert.match(jsx, …)` lines of `a query topic is born resolved rather than loading`) with:

```js
  // A local topic — the id a category pill on a card navigates to — resolves
  // from CATEGORIES with no fetch either. Born loading, it painted the skeleton
  // for one commit and settled 109→146 DURING the page's own entrance.
  assert.match(jsx, /const localTopic = useMemo\(\s*\(\) => \(type === 'topic' \|\| type === 'concept' \? getLocalTopicEntity\(id\) : null\),\s*\[id, type\],\s*\);/);
  assert.match(jsx, /const bornResolved = Boolean\(localTopic\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/);
  assert.match(jsx, /useState\(\(\) => \(bornResolved \? \(localTopic \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/);
  assert.match(jsx, /const \[isLoadingEntity, setIsLoadingEntity\] = useState\(\(\) => !bornResolved\);/);
  // And a navigation between entities takes the same shortcut, in the same
  // batch as the reset, so no skeleton commit ever paints.
  assert.match(jsx, /const local = type === 'topic' \|\| type === 'concept' \? getLocalTopicEntity\(id\) : null;\s*if \(local\) \{\s*setEntity\(local\);\s*setIsLoadingEntity\(false\);\s*return;\s*\}/);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Explorer/explorerReservation.test.js`
Expected: FAIL on the `localTopic` assertion.

- [ ] **Step 3: Seed the entity from the route**

In `src/components/Explorer/EntityExplorer.jsx`, replace lines 215-226 (from the comment `// A free-text topic is resolved from the route alone…` through the `const [entity, setEntity] = useState(…)` line) with:

```jsx
  // A free-text topic is resolved from the route alone, and a local one — the
  // id a category pill on a card navigates to — from CATEGORIES; neither has a
  // fetch behind it, so both are born live. Born loading instead, the page
  // painted the full skeleton for exactly one frame (the effect below resolves
  // it right after that paint) and `useHeightSettle` then spent 360ms
  // animating the hero body from the skeleton's height to the topic's — a
  // settle explaining a wait that never happened, on the very path a topic
  // tag on a card takes (measured: 109→146 during the page's own entrance).
  // The effect still re-resolves it; that is idempotent.
  const localTopic = useMemo(
    () => (type === 'topic' || type === 'concept' ? getLocalTopicEntity(id) : null),
    [id, type],
  );
  const bornResolved = Boolean(localTopic) || (type === 'topic' && isOpaqueQueryTopicText(id));
  const [entity, setEntity] = useState(() => (bornResolved ? (localTopic || resolveQueryTopicRoute(id, searchParams)) : null));
```

Then in `loadEntity` (line ~596), right after the existing query-topic branch

```js
      if (type === 'topic' && isOpaqueQueryTopicText(id)) {
        setEntity(resolveQueryTopicRoute(id, searchParams));
        setIsLoadingEntity(false);
        return;
      }
```

add:

```js
      // Same shortcut for a local topic on a navigation between entities: the
      // resets above and these two land in one batch, so no skeleton commit
      // paints in between.
      const local = type === 'topic' || type === 'concept' ? getLocalTopicEntity(id) : null;
      if (local) {
        setEntity(local);
        setIsLoadingEntity(false);
        return;
      }
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/components/Explorer/explorerReservation.test.js src/components/Explorer/explorerLoading.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 5: Verify on the page**

```bash
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-topic-link' late 4000 | grep '"skel":true' | wc -l
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-topic-link' late 4000 | grep '"settle":{' | head -1 | cut -c1-120
```

Expected: `0` skeleton frames, and the first settle line comes AFTER the page transition (its `t` is above 550ms, when the Wikipedia paragraph lands), not at `t` ≈ 215.

- [ ] **Step 6: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerReservation.test.js
git commit -m "fix(explorer): un tema local nace vivo — sin esqueleto de un fotograma ni settle durante la entrada

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The palette hands the entity over; the page is born with it (A7)

**Files:**
- Create: `src/utils/explorerHandover.js`
- Test: `src/utils/explorerHandover.test.js` (new), `src/components/Search/searchIntegration.test.js` (append), `src/components/Explorer/explorerEntrance.test.js` (append)
- Modify: `src/components/Search/SearchCommand.jsx:270-311` (author, institution, topic rows), `src/components/Explorer/EntityExplorer.jsx:2` (imports), `:215-230` (born resolved), `:583-600` and `:661-664` (`loadEntity`), `:751` (effect deps)

Projects are NOT handed over: their skeleton reserves the summary box and two stat cells that the search row cannot provide, and a live hero born from `{ display_name, funder }` would grow by more than the skeleton does when OpenAIRE answers.

**Interfaces:**
- Produces: `handoverFromSearchRow(type, row) → object | null` (what a palette row hands over) and `handedEntityFor(type, id, state) → object | null` (which handed entity a route accepts). Router state shape: `{ entity, entityType }`.

- [ ] **Step 1: Write the failing behaviour tests**

```js
// src/utils/explorerHandover.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { handedEntityFor, handoverFromSearchRow } from './explorerHandover.js';

/**
 * The palette's rows hold the entity they point at, and `go()` already hands a
 * paper over in router state. Measured before this: an author picked from the
 * palette arrived as a skeleton and collapsed 113px (156px on a phone, while
 * the page was still sliding in).
 */
test('an author row hands over what the hero paints', () => {
  const row = { id: 'https://openalex.org/A5068353058', display_name: 'David Moher', works_count: 1554, cited_by_count: 893080, h_index: 218, orcid: 'https://orcid.org/0000-0003-2434-4206', institution: "St. Michael's Hospital", concepts: [{ display_name: 'Medicine' }] };
  assert.deepEqual(handoverFromSearchRow('author', row), {
    id: 'https://openalex.org/A5068353058',
    display_name: 'David Moher',
    works_count: 1554,
    cited_by_count: 893080,
    summary_stats: { h_index: 218 },
    orcid: 'https://orcid.org/0000-0003-2434-4206',
    x_concepts: [{ display_name: 'Medicine' }],
    institution: "St. Michael's Hospital",
  });
});

test('an institution row is handed over as it is; a topic row keeps its name and count', () => {
  const institution = { id: 'https://openalex.org/I173304897', display_name: 'Harvard University', country_code: 'US', ror: 'https://ror.org/03vek6s52' };
  assert.deepEqual(handoverFromSearchRow('institution', institution), institution);
  assert.deepEqual(handoverFromSearchRow('topic', { id: 'https://openalex.org/T10001', display_name: 'Neuroscience', works_count: 12 }), { id: 'https://openalex.org/T10001', display_name: 'Neuroscience', works_count: 12 });
});

test('a row without a name, or a type the page cannot paint, hands nothing over', () => {
  assert.equal(handoverFromSearchRow('author', { id: 'A1' }), null);
  assert.equal(handoverFromSearchRow('project', { id: 'FW04020064', display_name: 'X' }), null);
  assert.equal(handoverFromSearchRow('author', null), null);
});

test('a route accepts the handed entity only when it names it', () => {
  const entity = { id: 'https://openalex.org/A5068353058', display_name: 'David Moher', orcid: 'https://orcid.org/0000-0003-2434-4206' };
  const state = { entity, entityType: 'author' };
  assert.equal(handedEntityFor('author', 'A5068353058', state), entity);
  assert.equal(handedEntityFor('author', 'https%3A%2F%2Forcid.org%2F0000-0003-2434-4206', state), entity, 'an ORCID route matches on the orcid');
  assert.equal(handedEntityFor('author', 'A999', state), null, 'another author is not this one');
  assert.equal(handedEntityFor('institution', 'A5068353058', state), null, 'another type is not this one');
  assert.equal(handedEntityFor('author', 'A5068353058', null), null);
  assert.equal(handedEntityFor('author', 'A5068353058', { entity: null, entityType: 'author' }), null);
});

test('institutions and topics match on the last path segment', () => {
  const institution = { id: 'https://openalex.org/I173304897', display_name: 'Harvard University' };
  assert.equal(handedEntityFor('institution', 'I173304897', { entity: institution, entityType: 'institution' }), institution);
  const topic = { id: 'https://openalex.org/T10001', display_name: 'Neuroscience' };
  assert.equal(handedEntityFor('topic', 'T10001', { entity: topic, entityType: 'topic' }), topic);
  assert.equal(handedEntityFor('topic', 'T10002', { entity: topic, entityType: 'topic' }), null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/utils/explorerHandover.test.js`
Expected: FAIL with `Cannot find module … explorerHandover.js`.

- [ ] **Step 3: Write the module**

```js
// src/utils/explorerHandover.js

const lastSegment = (value) => String(value || '').split('/').pop();

/**
 * What a search-palette row hands the Explorer through router state.
 *
 * The rows already hold the entity they point at, and the page can paint a
 * hero from it before the full record answers — the way `PublicPaperPage`
 * paints a paper handed over by the palette. Measured before this: an author
 * picked from the palette arrived as a skeleton and collapsed 113px when the
 * record came, 156px on a phone while the page was still sliding in.
 *
 * Returns null for a row the page cannot paint. Projects are never handed
 * over: their skeleton reserves a summary box and two stat cells that a
 * search row does not carry, and a live hero born from a name alone would
 * grow by more than the skeleton does when OpenAIRE answers.
 */
export function handoverFromSearchRow(type, row) {
  if (!row || !row.display_name) return null;
  if (type === 'author') {
    return {
      id: row.id,
      display_name: row.display_name,
      works_count: row.works_count ?? null,
      cited_by_count: row.cited_by_count ?? null,
      summary_stats: row.h_index != null ? { h_index: row.h_index } : null,
      orcid: row.orcid || null,
      x_concepts: Array.isArray(row.concepts) ? row.concepts : [],
      institution: row.institution || null,
    };
  }
  if (type === 'institution') return { ...row };
  if (type === 'topic') {
    return { id: row.id, display_name: row.display_name, works_count: row.works_count ?? null };
  }
  return null;
}

/**
 * The entity a page may be born with: the one handed over in router state,
 * only when it is the entity the route names. `state` is `location.state`;
 * a route reached by any other link, or a stale state after a reload, gets
 * null and loads as it always did.
 */
export function handedEntityFor(type, id, state) {
  const handed = state?.entity;
  if (!handed || !handed.display_name || typeof id !== 'string') return null;
  if (state.entityType !== type) return null;
  const routeId = decodeURIComponent(id);
  if (type === 'author') {
    const orcidInRoute = routeId.match(/orcid\.org\/([0-9X-]+)/i)?.[1];
    if (orcidInRoute) {
      return handed.orcid && String(handed.orcid).includes(orcidInRoute) ? handed : null;
    }
  }
  return lastSegment(handed.id) === lastSegment(routeId) ? handed : null;
}
```

- [ ] **Step 4: Run the behaviour tests**

Run: `node --test src/utils/explorerHandover.test.js`
Expected: 5 passing.

- [ ] **Step 5: Write the failing source tests for the wiring**

Append to `src/components/Search/searchIntegration.test.js`:

```js
test('author, institution and topic rows hand their entity over in router state', async () => {
  const palette = await readFile(new URL('./SearchCommand.jsx', import.meta.url), 'utf8');
  assert.match(palette, /import \{ handoverFromSearchRow \} from '\.\.\/\.\.\/utils\/explorerHandover\.js';/);
  assert.match(palette, /onSelect=\{\(\) => go\(path, \{ entity: handoverFromSearchRow\('author', author\), entityType: 'author' \}\)\}/);
  assert.match(palette, /onSelect=\{\(\) => go\(`\/explorer\/institution\/\$\{lastPathSegment\(institution\.id\)\}`, \{ entity: handoverFromSearchRow\('institution', institution\), entityType: 'institution' \}\)\}/);
  assert.match(palette, /onSelect=\{\(\) => go\(`\/explorer\/topic\/\$\{encodeURIComponent\(lastPathSegment\(concept\.id\)\)\}`, \{ entity: handoverFromSearchRow\('topic', concept\), entityType: 'topic' \}\)\}/);
});
```

(If that file does not already import `readFile` from `node:fs/promises`, add the import at its top.)

Append to `src/components/Explorer/explorerEntrance.test.js`:

```js
test('the explorer is born with the entity a link handed over, and treats its own fetch as an upgrade', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.match(jsx, /import \{ useParams, useNavigate, useSearchParams, useLocation \} from 'react-router-dom';/);
  assert.match(jsx, /import \{ handedEntityFor \} from '\.\.\/\.\.\/utils\/explorerHandover\.js';/);
  assert.match(jsx, /const handedEntity = useMemo\(\(\) => handedEntityFor\(type, id, location\.state\), \[id, location\.state, type\]\);/);
  assert.match(jsx, /const bornResolved = Boolean\(handedEntity\) \|\| Boolean\(localTopic\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/);
  assert.match(jsx, /useState\(\(\) => \(bornResolved \? \(handedEntity \|\| localTopic \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/);
  // The load never puts a handed page back into the skeleton.
  assert.match(jsx, /if \(handedEntity\) \{\s*setEntity\(handedEntity\);\s*setIsLoadingEntity\(false\);\s*\} else \{\s*setIsLoadingEntity\(true\);\s*setEntity\(null\);\s*\}/);
  assert.match(jsx, /setEntity\(data \|\| handedEntity\);/);
  assert.match(jsx, /\}, \[type, id, searchParams, entityReloadKey, handedEntity\]\);/);
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `node --test src/components/Search/searchIntegration.test.js src/components/Explorer/explorerEntrance.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 7: Wire the palette**

In `src/components/Search/SearchCommand.jsx`, add the import next to the other `../../utils/` imports:

```js
import { handoverFromSearchRow } from '../../utils/explorerHandover.js';
```

Then change the three `onSelect`s:

```jsx
        <CommandItem key={author.id} value={`author-${author.id}`} onSelect={() => go(path, { entity: handoverFromSearchRow('author', author), entityType: 'author' })}>
```

```jsx
        onSelect={() => go(`/explorer/institution/${lastPathSegment(institution.id)}`, { entity: handoverFromSearchRow('institution', institution), entityType: 'institution' })}
```

```jsx
        onSelect={() => go(`/explorer/topic/${encodeURIComponent(lastPathSegment(concept.id))}`, { entity: handoverFromSearchRow('topic', concept), entityType: 'topic' })}
```

`go(path, state)` already forwards `state` as `navigate(path, { state })`.

- [ ] **Step 8: Wire the Explorer**

In `src/components/Explorer/EntityExplorer.jsx`:

(a) Line 2: `import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';`

(b) Next to the other `../../utils/` imports: `import { handedEntityFor } from '../../utils/explorerHandover.js';`

(c) Replace the `localTopic` / `bornResolved` / `entity` block from Task 6 with:

```jsx
  // A page can be born live three ways: with the entity a search row handed
  // over in router state (`explorerHandover.js` — measured before this, an
  // author picked from the palette arrived as a skeleton and collapsed 113px,
  // 156px on a phone while the page was still sliding in); as a local topic,
  // resolved from CATEGORIES; or as a free-text topic, resolved from the
  // route. None has a fetch behind it. Born loading instead, the page painted
  // the skeleton for a frame and settled from its height to the real one — a
  // wait that never happened, animated. The effect below still fetches the
  // full record; for a handed entity that is an upgrade, never a wait.
  const location = useLocation();
  const handedEntity = useMemo(() => handedEntityFor(type, id, location.state), [id, location.state, type]);
  const localTopic = useMemo(
    () => (type === 'topic' || type === 'concept' ? getLocalTopicEntity(id) : null),
    [id, type],
  );
  const bornResolved = Boolean(handedEntity) || Boolean(localTopic) || (type === 'topic' && isOpaqueQueryTopicText(id));
  const [entity, setEntity] = useState(() => (bornResolved ? (handedEntity || localTopic || resolveQueryTopicRoute(id, searchParams)) : null));
```

(d) In `loadEntity` (line ~585), replace the first three lines of the function body

```js
      setIsLoadingEntity(true);
      setEntityError(null);
      setEntity(null);
```

with

```js
      setEntityError(null);
      if (handedEntity) {
        setEntity(handedEntity);
        setIsLoadingEntity(false);
      } else {
        setIsLoadingEntity(true);
        setEntity(null);
      }
```

(e) Line ~661, `setEntity(data);` (the one right before `setIsLoadingEntity(false);` after the author enrichment) becomes `setEntity(data || handedEntity);`.

(f) The effect's dependency list (line ~751) becomes `}, [type, id, searchParams, entityReloadKey, handedEntity]);`.

- [ ] **Step 9: Run the tests and the linter**

Run: `node --test src/utils/explorerHandover.test.js src/components/Search/searchIntegration.test.js src/components/Explorer/explorerEntrance.test.js src/components/Explorer/explorerReservation.test.js && npm run lint`
Expected: PASS. Task 6's `explorerReservation` assertion on `bornResolved` must be updated to the new three-way line if it fails: replace its `const bornResolved = …` regex with `/const bornResolved = Boolean\(handedEntity\) \|\| Boolean\(localTopic\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/` and its `useState` regex with `/useState\(\(\) => \(bornResolved \? \(handedEntity \|\| localTopic \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/`.

- [ ] **Step 10: Verify on the page (demo build)**

Set `export const IS_DEMO = true;` in `src/services/firebase.js`, `npm run build`, set it back to `false` (check with `git diff --stat`, which must be empty for that file), then with the preview up:

```bash
node scripts/diagnostics/explorer-hero-frames.mjs fromsearch author q=moher late 5000 | grep -c '"skel":true'
node scripts/diagnostics/explorer-hero-frames.mjs fromsearch author q=moher late 5000 | grep '"settle":{' | head -2 | cut -c1-140
```

Expected: `0` skeleton frames; the first settle, if any, starts after the page has finished entering (`t` > 540) and moves the tab strip by less than 40px in total. Rebuild without the flag afterwards (`npm run build`).

- [ ] **Step 11: Commit**

```bash
git add src/utils/explorerHandover.js src/utils/explorerHandover.test.js src/components/Search/SearchCommand.jsx src/components/Search/searchIntegration.test.js src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerEntrance.test.js src/components/Explorer/explorerReservation.test.js
git commit -m "feat(explorer): la paleta entrega la entidad que ya tiene y la página nace viva con ella

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The skeleton reserves the ORCID card only when the route knows (A8)

**Files:**
- Modify: `src/utils/explorerSkeletonShape.js:57-70`, `src/components/Explorer/EntityExplorer.jsx:1256`, `plans/005-explorer-what-the-skeleton-promises.md` (item 4 status)
- Test: `src/utils/explorerSkeletonShape.test.js:41-47`, `src/components/Explorer/explorerReservation.test.js` (append)

- [ ] **Step 1: Change the assertions**

In `src/utils/explorerSkeletonShape.test.js`, replace the test `each type reserves the block it actually carries` with:

```js
test('each type reserves the block it actually carries', () => {
  // An author's ORCID card is reserved only when the route knows there is one
  // (an ORCID id in the route). Three of four authors opened in the 2026-09-05
  // audit had no record: a reserved block that never comes is the list rising
  // 113px 400ms after the page has landed, while an unreserved one that does
  // come grows the hero from the bottom under the settle's clip.
  assert.equal(explorerSkeletonShape('author').aside, 'none');
  assert.equal(explorerSkeletonShape('author', { hasOrcid: true }).aside, 'orcid');
  assert.equal(explorerSkeletonShape('institution').aside, 'wiki');
  // Measured at 390px: a project hero landed 276px taller than its skeleton,
  // 122 of it the summary box OpenAIRE returns for nearly every grant.
  assert.equal(explorerSkeletonShape('project').aside, 'summary');
});
```

Append to `src/components/Explorer/explorerReservation.test.js`:

```js
test('the page skeleton asks the route whether an ORCID card is coming', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const shape = explorerSkeletonShape\(type, \{ hasOrcid: Boolean\(extractOrcid\(id\)\) \}\);/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/utils/explorerSkeletonShape.test.js src/components/Explorer/explorerReservation.test.js`
Expected: FAIL on `aside` for an author and on the source assertion.

- [ ] **Step 3: Add the option**

In `src/utils/explorerSkeletonShape.js`, add this paragraph at the end of the docstring that sits above `explorerSkeletonShape` (before its closing `*/`):

```js
 *
 * `hasOrcid`: whether the route already knows the author has an ORCID record
 * (an ORCID id in the URL). The card was reserved for every author; three of
 * four authors opened in the 2026-09-05 audit had no record, and a reserved
 * block that never comes is the list rising 113px 400ms after the page has
 * landed. Unreserved, a card that does come grows the hero from the bottom
 * under the settle's clip, which reads as an arrival.
```

Then replace the function itself with:

```js
export function explorerSkeletonShape(type, { hasOrcid = false } = {}) {
  const authorish = type === 'author';
  const institutionish = type === 'institution';
  const projectish = type === 'project';
  return {
    tabs: hasAuthorsTab(type) ? 2 : 1,
    identity: authorish ? 'topics' : institutionish ? 'credentials' : 'none',
    aside: authorish ? (hasOrcid ? 'orcid' : 'none') : institutionish ? 'wiki' : projectish ? 'summary' : 'none',
    stats: projectish ? 2 : 4,
    follow: true,
  };
}
```

In `src/components/Explorer/EntityExplorer.jsx` line 1256: `const shape = explorerSkeletonShape(type, { hasOrcid: Boolean(extractOrcid(id)) });` (`extractOrcid` is already imported on line 10).

In `plans/005-explorer-what-the-skeleton-promises.md`, under item 4 (`The ORCID slot has no way to leave`), add a line: `**Done 2026-09-05**: the slot is reserved only when the route carries an ORCID id (`explorerSkeletonShape(type, { hasOrcid })`); otherwise the card grows the hero under the settle's clip when it comes.`

- [ ] **Step 4: Run the tests**

Run: `node --test src/utils/explorerSkeletonShape.test.js src/components/Explorer/explorerReservation.test.js src/components/Explorer/explorerLoading.test.js`
Expected: PASS.

- [ ] **Step 5: Verify on the page**

```bash
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-authors a, .pc-author-btn' late idx=2 7000 | grep '"settle":{' | head -1 | cut -c1-160
```

Expected: for an author opened by name, the handover settle's `to` is not below its `from` by more than 60px (the −113/−176 collapse is gone); for an author with a record, a later settle GROWS the body when the card arrives.

- [ ] **Step 6: Commit**

```bash
git add src/utils/explorerSkeletonShape.js src/utils/explorerSkeletonShape.test.js src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerReservation.test.js plans/005-explorer-what-the-skeleton-promises.md
git commit -m "fix(explorer): el esqueleto reserva la tarjeta ORCID solo cuando la ruta sabe que llega

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Picking a result makes the palette vanish, not dismiss (A6)

**Files:**
- Modify: `src/components/Search/SearchCommand.jsx:129-170` (state + `go`), `:398` (the `CommandDialog` classNames), `src/components/Search/SearchCommand.css:344-375`
- Test: `src/components/Search/paletteMotion.test.js` (modify the scrim test's `overlayClassName` assertion; append a test)

- [ ] **Step 1: Write the failing test**

In `src/components/Search/paletteMotion.test.js`, in the test `the scrim is the palette's own, timed with the sheet`, replace

```js
  assert.match(palette, /<CommandDialog [^>]*overlayClassName="sc-scrim"/);
```

with

```js
  assert.match(palette, /<CommandDialog [^>]*overlayClassName=\{`sc-scrim\$\{leavingBySelect \? ' sc-scrim--select' : ''\}`\}/);
```

Append:

```js
/**
 * Picking a result is not dismissing the palette. Measured before this: the
 * sheet left on its 220ms ease-in with 14px of travel, the scrim on its own
 * 220ms `ease`, and the feed beneath on the page's 200ms exit — three
 * dissolves on three clocks, two empty frames at ~205ms, and the new page
 * arriving from the right under a 2% ghost of the sheet. When a row is
 * picked, sheet and scrim go in 100ms of opacity and the page transition is
 * the only movement left.
 */
test('a picked result closes the palette in 100ms of opacity, with no travel', async () => {
  const palette = await read('./SearchCommand.jsx');
  assert.match(palette, /const \[leavingBySelect, setLeavingBySelect\] = useState\(false\);/);
  assert.match(palette, /setLeavingBySelect\(true\);\s*onOpenChange\(false\);/);
  assert.match(palette, /if \(open\) \{\s*reset\(\);\s*setLeavingBySelect\(false\);\s*\}/);
  assert.match(palette, /className=\{`sc-sheet\$\{leavingBySelect \? ' sc-sheet--select' : ''\}`\}/);
  const css = await read('./SearchCommand.css');
  assert.match(css, /@keyframes scSheetGone \{\s*from \{\s*opacity: 1;\s*\}\s*to \{\s*opacity: 0;\s*\}\s*\}/);
  assert.match(css, /\.sc-sheet\.sc-sheet--select\[data-state='closed'\] \{\s*animation: scSheetGone 100ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both;\s*\}/);
  assert.match(css, /\.sc-scrim\.sc-scrim\.sc-scrim--select\[data-state='closed'\] \{\s*animation: fadeOut 100ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both;\s*\}/);
  // Reduced motion switches the picked exit off with the others.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sc-sheet\.sc-sheet--select\[data-state='closed'\],[\s\S]*?animation: none;/);
  assert.ok(reduced, 'the picked exit is inside the reduced-motion list');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Search/paletteMotion.test.js`
Expected: FAIL on the `overlayClassName` assertion.

- [ ] **Step 3: Add the state and the classes**

In `src/components/Search/SearchCommand.jsx`:

(a) Below `const navigate = useNavigate();` (line 130) add:

```js
  // Whether the palette is closing because a row was picked. Picking is not
  // dismissing: the reader is being answered, not getting out of the way, so
  // the sheet and its scrim go in 100ms of opacity (`.sc-sheet--select`) and
  // the page transition is the only movement left. Measured before this:
  // sheet, scrim and feed dissolved on three clocks with two empty frames in
  // the middle. Cleared on the way in, like `reset`.
  const [leavingBySelect, setLeavingBySelect] = useState(false);
```

(b) Replace the `useLayoutEffect` (lines 161-163) with:

```js
  useLayoutEffect(() => {
    if (open) {
      reset();
      setLeavingBySelect(false);
    }
  }, [open, reset]);
```

(c) In `go` (line 165), before `onOpenChange(false);` add `setLeavingBySelect(true);`:

```js
  const go = useCallback((path, state = null) => {
    setLeavingBySelect(true);
    onOpenChange(false);
    navigate(path, state ? { state } : undefined);
  }, [navigate, onOpenChange]);
```

(d) Line 398: 

```jsx
    <CommandDialog open={open} onOpenChange={onOpenChange} title={copy.placeholder} className={`sc-sheet${leavingBySelect ? ' sc-sheet--select' : ''}`} overlayClassName={`sc-scrim${leavingBySelect ? ' sc-scrim--select' : ''}`}>
```

Make sure `useState` is in the React import at the top of the file.

- [ ] **Step 4: Add the CSS**

In `src/components/Search/SearchCommand.css`, right after the `.sc-scrim.sc-scrim[data-state='closed'] { … }` rule (line 361) add:

```css
/* Picking a result is not dismissing the palette. The dismiss above gets out
   of the way — 220ms, 14px up, an ease-in — and that is right for Escape and
   for a tap on the scrim. When a row is picked the reader is being ANSWERED:
   the page they asked for is already on its way in from the right, and a
   sheet still drifting up at 14% opacity beside it (measured at 200ms) is a
   second movement arguing with the first. So the picked exit is opacity only,
   100ms, on the entrance curve, for the sheet and the scrim alike; the page
   transition is the only movement left. The class is doubled on the scrim
   for the reason the rule above gives. */
@keyframes scSheetGone {
  from {
    opacity: 1;
  }

  to {
    opacity: 0;
  }
}

.sc-sheet.sc-sheet--select[data-state='closed'] {
  animation: scSheetGone 100ms cubic-bezier(0.23, 1, 0.32, 1) both;
}

.sc-scrim.sc-scrim.sc-scrim--select[data-state='closed'] {
  animation: fadeOut 100ms cubic-bezier(0.23, 1, 0.32, 1) both;
}
```

And in the reduced-motion block that follows, extend the selector list:

```css
  .sc-sheet[data-state='open'],
  .sc-sheet[data-state='closed'],
  .sc-sheet.sc-sheet--select[data-state='closed'],
  .sc-scrim.sc-scrim[data-state='open'],
  .sc-scrim.sc-scrim[data-state='closed'],
  .sc-scrim.sc-scrim.sc-scrim--select[data-state='closed'] {
    animation: none;
  }
```

`fadeOut` is the shared keyframe from `src/styles/variables.css:470`.

- [ ] **Step 5: Run the tests and the linter**

Run: `node --test src/components/Search/paletteMotion.test.js src/components/Search/searchIntegration.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 6: Verify on the page (demo build, as in Task 7 step 10)**

```bash
node scripts/diagnostics/explorer-hero-frames.mjs fromsearch topic q=neuroscience late 4000 | grep '"sheet":"' | tail -3 | cut -c1-120
```

Expected: the last frames with a sheet show `data-state` `closed`, opacity falling to `0.00` within ~100ms of the click and `ty0` (no travel); no frame with a sheet after ~120ms.

- [ ] **Step 7: Commit**

```bash
git add src/components/Search/SearchCommand.jsx src/components/Search/SearchCommand.css src/components/Search/paletteMotion.test.js
git commit -m "fix(search): elegir un resultado no es descartar la paleta — hoja y velo se van en 100 ms sin recorrido

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The error screen arrives; the Wikipedia prose re-arrives when its source changes (A11)

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.css:20-30` and the reduced-motion comment at `:2379-2383`; `src/components/Explorer/EntityExplorer.jsx:2061`
- Test: `src/components/Explorer/explorerMotion.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/components/Explorer/explorerMotion.test.js`:

```js
/**
 * Measured opening an arXiv author with no OpenAlex profile from the feed:
 * 700ms of a 1300px skeleton, then a centred line in one frame. The error
 * resolves from the same 0.35 as every other arrival in the hero; the
 * reduced-motion block already names `.explorer-error`.
 */
test('the error screen resolves in place instead of cutting', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.match(css, /\.explorer-error \{[^}]*animation: slideUpFade 0\.42s cubic-bezier\(0\.16, 1, 0\.3, 1\) both;[^}]*\}/);
});

/**
 * The paragraph used to change text without remounting — from one line of
 * local description to three of Wikipedia at opacity 1, with none of the
 * arrival `wikiProseIn` promises. Keyed by source, the words arrive again.
 */
test('the Wikipedia paragraph is keyed by its source so its arrival replays', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /<p\s+key=\{visibleWikiInfo\?\.extract \? 'wiki' : 'fallback'\}\s+ref=\{wikiDescriptionTextRef\}/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/components/Explorer/explorerMotion.test.js`
Expected: FAIL on both.

- [ ] **Step 3: Make the changes**

In `src/components/Explorer/EntityExplorer.css`, add to the `.explorer-error { … }` block (line 20), after `background: var(--bg-primary);`:

```css
  /* Resolves from 0.35 like every other arrival in the hero: it replaces a
     skeleton that stood for 700ms, and it used to replace it in one frame. */
  animation: slideUpFade 0.42s cubic-bezier(0.16, 1, 0.3, 1) both;
```

In the reduced-motion block (line ~2379), replace the four-line "Forward guard" comment above `.explorer-error,` with:

```css
  /* The error screen's entrance (`slideUpFade`) goes with the rest. */
```

In `src/components/Explorer/EntityExplorer.jsx` line 2061, the paragraph becomes:

```jsx
                  <p
                    key={visibleWikiInfo?.extract ? 'wiki' : 'fallback'}
                    ref={wikiDescriptionTextRef}
```

(the rest of its props unchanged).

- [ ] **Step 4: Run the tests**

Run: `node --test src/components/Explorer/explorerMotion.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 5: Verify on the page**

```bash
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-topic-link' late 5000 | grep '"wikiP"' | grep -v '/1.00' | wc -l
```

Expected: more than 5 frames in which the paragraph's opacity is below 1.00 AFTER the Wikipedia text has replaced the local one (the `wikiP` height goes from 24 to 72 and its opacity restarts at 0.35).

- [ ] **Step 6: Commit**

```bash
git add src/components/Explorer/EntityExplorer.css src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerMotion.test.js
git commit -m "fix(explorer): el error llega en vez de cortar, y el párrafo de Wikipedia vuelve a llegar cuando cambia de fuente

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11 (product decision): the experience panel opens by default only when it is short (A8)

This reverses part of the 2026-09-04 decision that opened the panel by default ("the toggle stays"). Measured on an author with a long history opened from the feed: the panel opened at 590px and pushed the tab strip 1108px in 710ms. Skip this task if the default-open is wanted regardless of length.

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx:52-56` (a constant next to `HERO_STACK_GAP_PX`) and `:731-733` (`loadOrcid`)
- Test: `src/components/Explorer/explorerMotion.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
/**
 * The panel opens by default when the record lands (2026-09-04). Measured on
 * an author with a long history: 590px of panel, the tab strip pushed 1108px
 * in 710ms. Past a few rows the panel arrives folded, and the chevron by the
 * name opens it on the reader's own press.
 */
test('the experience panel arrives open only when it is short', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS = 4;/);
  assert.match(jsx, /setOrcidInfo\(record\);\s*setIsExperienceOpen\(\(record\?\.employments\?\.length \?\? 0\) <= EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS\);/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Explorer/explorerMotion.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the cap**

After `const HERO_STACK_GAP_PX = 16;` (line 56) add:

```js
// The experience panel arrives open by default (2026-09-04) — up to this many
// rows. Measured on an author with a long history opened from the feed: 590px
// of panel, the tab strip pushed 1108px in 710ms. Past this the panel arrives
// folded and the chevron by the name opens it on the reader's own press.
const EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS = 4;
```

In `loadOrcid` (line ~733), replace `if (!isCancelled) setOrcidInfo(record);` with:

```js
          if (!isCancelled) {
            setOrcidInfo(record);
            setIsExperienceOpen((record?.employments?.length ?? 0) <= EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS);
          }
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/components/Explorer/explorerMotion.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerMotion.test.js
git commit -m "fix(explorer): el panel de experiencia llega abierto solo cuando es corto

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12 (product decision): the project badge on a card arrives in 200ms, not 900 (A10)

The badge's 300ms delay and 600ms rise were deliberate ("the paper comes before its label"). What the review objects to is the amount: 900ms of motion on a card being read, on `height` and on framer's `y`/`scale` shorthands inside the feed. This keeps the height opening (the space has to open) but on the catalog's clock, and moves the badge's own arrival to `opacity` and a full `transform` string.

**Files:**
- Modify: `src/components/Feed/PaperCard.jsx:1258-1300`
- Test: `src/components/Feed/paperCardArrival.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
/**
 * The project badge arrives async and opens its own space. It used to take
 * 900ms: a 450ms height on a built-in-like curve, then the badge on `y`/
 * `scale` shorthands after a 300ms delay — main-thread motion inside the
 * feed, on a card being read, tens of times a day. The space still opens
 * (nothing else can move what is below), on the catalog's clock; the badge
 * itself arrives on opacity and a full transform string, with no delay.
 */
test('the project badge opens its space in 200ms and arrives on the compositor', async () => {
  const jsx = await read('./PaperCard.jsx');
  const slot = jsx.match(/className="pc-project-badge-slot"[\s\S]*?className="pc-project-badge-motion"[\s\S]*?>\s*<button/);
  assert.ok(slot, 'the badge slot and its motion wrapper are still there');
  assert.match(slot[0], /: \{ duration: 0\.2, ease: \[0\.23, 1, 0\.32, 1\] \}\}/, 'the slot opens in 200ms');
  assert.match(slot[0], /initial=\{prefersReducedMotion\s*\?\s*false\s*:\s*\{ opacity: 0, transform: 'translateY\(6px\)' \}\}/);
  assert.match(slot[0], /animate=\{\{ opacity: 1, transform: 'translateY\(0px\)' \}\}/);
  assert.doesNotMatch(slot[0], /delay:/);
  assert.doesNotMatch(slot[0], /\by: \d|scale:/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/components/Feed/paperCardArrival.test.js`
Expected: FAIL.

- [ ] **Step 3: Change the two motion.divs**

In `src/components/Feed/PaperCard.jsx`, the slot's `transition` (line ~1272) becomes:

```jsx
              transition={prefersReducedMotion
                ? { duration: 0.12 }
                : { duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
```

and the inner `pc-project-badge-motion` (lines ~1289-1300) becomes:

```jsx
                <motion.div
                  className="pc-project-badge-motion"
                  initial={prefersReducedMotion
                    ? false
                    : { opacity: 0, transform: 'translateY(6px)' }}
                  animate={{ opacity: 1, transform: 'translateY(0px)' }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={prefersReducedMotion
                    ? { duration: 0.12 }
                    : { duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                >
```

Update the comment above the slot (`// The badge arrives async…`) to say the space opens in 200ms on the catalog's entrance curve and the badge arrives on opacity and a full transform string, so it composites off the main thread while the feed paints.

- [ ] **Step 4: Run the feed tests and the linter**

Run: `node --test $(find src/components/Feed -name '*.test.js') && npm run lint`
Expected: PASS (`paperCardPress.test.js` and `paperCardOverflowStyles.test.js` pin the badge's CSS, which does not change).

- [ ] **Step 5: Commit**

```bash
git add src/components/Feed/PaperCard.jsx src/components/Feed/paperCardArrival.test.js
git commit -m "fix(feed): la insignia de proyecto abre su hueco en 200 ms y llega por el compositor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13 (product decision): the palette opens in 200ms (A9)

This reverses the 2026-09-03 request to make the palette slower (380/220). The reason then was that it "looked switched on", which the 24px of travel solved; the 380ms is what the review objects to, on a control opened tens of times a day. Skip if the slower palette is wanted.

**Files:**
- Modify: `src/components/Search/SearchCommand.css:344-361` and the comment above them, `src/components/Search/SearchCommand.jsx:100` (`ENTER_STAGGER_CAP`)
- Test: `src/components/Search/paletteMotion.test.js:12-16` and `:18-21`

- [ ] **Step 1: Change the assertions**

Replace the two tests at the top of `src/components/Search/paletteMotion.test.js` with:

```js
/**
 * 380/220 from 2026-09-03 ("looked switched on" — which the 24px of travel
 * solved, not the duration). A palette is opened tens of times a day: 200ms
 * on the entrance curve, the scrim on the same clock, the dismiss at 160.
 */
test('the palette arrives in 200ms and leaves in 160ms', async () => {
  const css = await read('./SearchCommand.css');
  assert.match(css, /\.sc-sheet\[data-state='open'\] \{\s*animation: scSheetIn 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\);/);
  assert.match(css, /\.sc-sheet\[data-state='closed'\] \{\s*animation: scSheetOut 160ms cubic-bezier\(0\.4, 0, 1, 1\) both;/);
});

test('the scrim is the palette\'s own, timed with the sheet', async () => {
  const css = await read('./SearchCommand.css');
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-state='open'\] \{\s*animation: fadeIn 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\);/);
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-state='closed'\] \{\s*animation: fadeOut 160ms cubic-bezier\(0\.4, 0, 1, 1\) both;/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sc-scrim\.sc-scrim\[data-state='closed'\] \{\s*animation: none;/) || css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sc-scrim\.sc-scrim\[data-state='closed'\],[\s\S]*?animation: none;/);
  assert.ok(reduced, 'reduced motion drops the scrim fade as it drops the sheet\'s');
  const palette = await read('./SearchCommand.jsx');
  assert.match(palette, /<CommandDialog [^>]*overlayClassName=\{`sc-scrim\$\{leavingBySelect \? ' sc-scrim--select' : ''\}`\}/);
  assert.match(palette, /const ENTER_STAGGER_CAP = 5;/);
  const command = await read('../ui/command.jsx');
  assert.match(command, /function CommandDialog\(\{ children, className, overlayClassName, title = 'Search', \.\.\.props \}\)/);
  assert.match(command, /overlayClassName=\{overlayClassName\}/);
  const dialog = await read('../ui/dialog.jsx');
  assert.match(dialog, /<DialogOverlay className=\{overlayClassName\} \/>/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/components/Search/paletteMotion.test.js`
Expected: FAIL on the durations.

- [ ] **Step 3: Change the values**

In `src/components/Search/SearchCommand.css`:

```css
.sc-sheet[data-state='open'] {
  animation: scSheetIn 200ms cubic-bezier(0.23, 1, 0.32, 1);
}

.sc-sheet[data-state='closed'] {
  animation: scSheetOut 160ms cubic-bezier(0.4, 0, 1, 1) both;
}

.sc-scrim.sc-scrim[data-state='open'] {
  animation: fadeIn 200ms cubic-bezier(0.23, 1, 0.32, 1);
}

.sc-scrim.sc-scrim[data-state='closed'] {
  animation: fadeOut 160ms cubic-bezier(0.4, 0, 1, 1) both;
}
```

In the long comment above them, replace the paragraph that begins `The exit is shorter than the entrance (220ms against 380ms)` with: `The exit is shorter than the entrance (160ms against 200ms): getting out of the way should never make anybody wait. They were 380 and 220 from 2026-09-03 to 2026-09-05, asked for slower because the palette "looked switched on"; the 24px of travel below is what fixed that, and 380ms on a control opened tens of times a day is what the 2026-09-05 audit measured as the palette still darkening its scrim 150ms after the sheet had landed. The scrim rides the sheet's two clocks and curves.`

In `src/components/Search/SearchCommand.jsx` line 100: `const ENTER_STAGGER_CAP = 5;` and, in the comment beside it, note that five rows at 24ms is 120ms of cascade, the top of the catalog's band.

- [ ] **Step 4: Run the tests**

Run: `node --test src/components/Search/paletteMotion.test.js src/components/Search/searchIntegration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Search/SearchCommand.css src/components/Search/SearchCommand.jsx src/components/Search/paletteMotion.test.js
git commit -m "fix(search): la paleta abre en 200 ms sobre un velo del mismo reloj

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Full verification and the audit's closing note

**Files:**
- Modify: `docs/AUDITORIA-ANIMACIONES-EXPLORER-2026-09-05.md` (append a "Después" section)

- [ ] **Step 1: The whole suite and the build**

Run: `npm run lint && npm test && npm run build`
Expected: clean.

- [ ] **Step 2: Measure the eight paths once more**

With `npx vite preview --port 5173 --strictPort` up on the production build (for the search paths, a demo build as in Task 7 step 10, reverted afterwards):

```bash
D=scripts/diagnostics/explorer-hero-frames.mjs
node $D route '#/explorer/author/A5068353058' 7000 > /tmp/a.log
node $D fromfeed '.pc-topic-link' late 7000 > /tmp/t.log
node $D route '#/explorer/institution/I173304897' 8000 > /tmp/i.log
node $D fromsearch author q=moher late 6000 > /tmp/sa.log
node $D fromsearch institution 'q=Harvard University' late 7000 > /tmp/si.log
node $D fromsearch topic q=neuroscience late 6000 > /tmp/st.log
node $D fromsearch project q=graphene late 8000 > /tmp/sp.log
for f in /tmp/a.log /tmp/t.log /tmp/i.log /tmp/sa.log /tmp/si.log /tmp/st.log /tmp/sp.log; do node -e '
const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l.startsWith("{\"t\"")).map(JSON.parse);
let worst=0,at=0,prev=null;for(const r of rows){if(prev&&r.tabs&&prev.tabs&&r.t-prev.t<40){const d=Math.abs(parseFloat(r.tabs)-parseFloat(prev.tabs));if(d>worst){worst=d;at=r.t;}}prev=r;}
const squeezed=rows.filter(r=>r.panel&&r.inner&&parseFloat(r.panel.split("+")[1])<parseFloat(r.inner.split("+")[1])).length;
const stretched=rows.filter(r=>r.fold&&/sy1\.[1-9]/.test(r.fold)).length;
console.log(process.argv[1],"worst tab-strip step",worst.toFixed(1),"px at",at,"ms | squeezed panel frames",squeezed,"| stretched fold frames",stretched,"| skeleton frames",rows.filter(r=>r.skel).length);' "$f"; done
```

Expected, per file: worst single-frame step of the tab strip under 10px except during a settle (where 360ms at `cubic-bezier(0.4, 0, 0.2, 1)` gives at most a quarter of the travel per frame at the middle); squeezed panel frames 0; stretched fold frames 0; skeleton frames 0 for the topic and for the three search paths that hand an entity over.

- [ ] **Step 3: Record the after**

Append to `docs/AUDITORIA-ANIMACIONES-EXPLORER-2026-09-05.md` a section `## Después (fecha)` with a table: one row per path, the three numbers above before (from the findings) and after (from step 2), and the commit range.

- [ ] **Step 4: Commit**

```bash
git add docs/AUDITORIA-ANIMACIONES-EXPLORER-2026-09-05.md
git commit -m "docs(animaciones): lo medido después del arreglo del Explorer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
