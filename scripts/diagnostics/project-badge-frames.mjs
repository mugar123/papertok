// Frame-by-frame record of the project badge (PaperCard.jsx, `.pc-project-badge-slot`) arriving on the first card of
// the guest feed. OpenAIRE is answered from here (Fetch.fulfillRequest) with a
// fake funded project, so the badge always arrives and the run is
// deterministic. A rAF sampler installed before the app's first script notes,
// per frame: the slot's box height, the inner motion's opacity/transform, the
// title's top/height and running animations.
//
//   node scripts/diagnostics/project-badge-frames.mjs <label> [mobile] [delay=MS]
//
// delay=MS holds the OpenAIRE answer that long after the request, so the
// badge can be made to land while the title is still arriving (delay=0) or
// long after (delay=2000). Writes <label>-samples.json and <label>-frames/
// (JPEGs from 150 ms before the slot appears to 900 ms after) into OUT (the
// working directory by default); PORT=9234 picks another debugging port,
// ORIGIN another dev server. No dependencies; Node >= 22 for the global
// WebSocket. The 2026-09-06 numbers this recorded are in the comment on the
// slot in PaperCard.jsx and in paperCardArrival.test.js.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9233);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const OUT = process.env.OUT || process.cwd();
const PROFILE = join(tmpdir(), `papertok-pill-probe-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , label = 'run', ...rest] = process.argv;
const flags = new Set(rest);
const mobile = flags.has('mobile');
const delayMs = Number(([...flags].find((f) => f.startsWith('delay=')) || 'delay=0').slice(6));

const FAKE_OPENAIRE = JSON.stringify({
  response: { results: { result: [{ metadata: { 'oaf:entity': { 'oaf:result': { rels: { rel: [{
    to: { '@type': 'project', $: 'corda__h2020::abc' },
    code: { $: '101000000' },
    acronym: { $: 'QUANTUMLEAP' },
    title: { $: 'Quantum leap in entanglement distribution' },
    funding: { funder: { '@shortname': 'EC', '@name': 'European Commission' }, funding_level_0: { '@name': 'H2020' } },
  }] } } } } }] } },
});

// Installed before the app runs. Watches for the first card's title, then
// samples every frame until 2.5 s after the badge slot shows up.
const SAMPLER = `(() => {
  const samples = [];
  window.__pillSamples = samples;
  let started = null;
  let slotSeenAt = null;
  const tick = () => {
    const card = document.querySelector('.pc-card, .paper-card, [class*="pc-sheet"]')?.closest('[class*="card"]') || document;
    const title = document.querySelector('.pc-title');
    const slot = document.querySelector('.pc-project-badge-slot');
    const motion = document.querySelector('.pc-project-badge-motion');
    const badge = document.querySelector('.pc-project-badge');
    const now = performance.now();
    if (title && started === null) started = now;
    if (started !== null) {
      if (slot && slotSeenAt === null) slotSeenAt = now;
      const tr = title ? title.getBoundingClientRect() : null;
      const tcs = title ? getComputedStyle(title) : null;
      const sr = slot ? slot.getBoundingClientRect() : null;
      const mcs = motion ? getComputedStyle(motion) : null;
      const br = badge ? badge.getBoundingClientRect() : null;
      samples.push({
        t: Math.round(now - started),
        sinceSlot: slotSeenAt === null ? null : Math.round(now - slotSeenAt),
        titleTop: tr ? +tr.top.toFixed(2) : null,
        titleHeight: tr ? +tr.height.toFixed(2) : null,
        titleOpacity: tcs ? +Number(tcs.opacity).toFixed(3) : null,
        titleTransform: tcs ? tcs.transform : null,
        titleAnims: title ? title.getAnimations().map((a) => (a.animationName || a.id || 'anim') + '@' + Math.round(a.currentTime ?? -1)) : [],
        slotHeight: sr ? +sr.height.toFixed(2) : null,
        slotStyleHeight: slot ? slot.style.height : null,
        motionOpacity: mcs ? +Number(mcs.opacity).toFixed(3) : null,
        motionTransform: mcs ? mcs.transform : null,
        badgeTop: br ? +br.top.toFixed(2) : null,
        badgeHeight: br ? +br.height.toFixed(2) : null,
      });
    }
    if (slotSeenAt === null || now - slotSeenAt < 2500) requestAnimationFrame(tick);
    else window.__pillDone = true;
  };
  requestAnimationFrame(tick);
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
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api.openaire.eu/search/publications*', requestStage: 'Request' }] });
  let served = 0;
  cdp.on('Fetch.requestPaused', async (p) => {
    await sleep(delayMs);
    served += 1;
    cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Access-Control-Allow-Origin', value: '*' },
      ],
      body: Buffer.from(FAKE_OPENAIRE).toString('base64'),
    }).catch(() => {});
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SAMPLER });

  const frames = [];
  cdp.on('Page.screencastFrame', (p) => {
    frames.push({ ts: p.metadata.timestamp, data: p.data });
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: mobile ? 390 : 1280, maxHeight: mobile ? 844 : 900, everyNthFrame: 1 });
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  let done = false;
  for (let i = 0; i < 400; i++) {
    if (await cdp.eval('window.__pillDone === true').catch(() => false)) { done = true; break; }
    await sleep(100);
  }
  await cdp.send('Page.stopScreencast');
  console.log('done:', done, 'openaire answers served:', served);
  const samples = await cdp.eval('window.__pillSamples');
  writeFileSync(join(OUT, `${label}-samples.json`), JSON.stringify(samples, null, 1));

  // Keep the frames from 150 ms before the slot appears to 900 ms after.
  const dir = join(OUT, `${label}-frames`);
  mkdirSync(dir, { recursive: true });
  // The screencast timestamps are wall-clock seconds; map them through the
  // frame stream itself: the last frame is ~ when sampling stopped (2.5 s
  // after the slot appeared).
  const end = frames[frames.length - 1]?.ts ?? 0;
  const slotAt = end - 2.5;
  const kept = frames.filter((f) => f.ts >= slotAt - 0.15 && f.ts <= slotAt + 0.9);
  kept.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(3, '0')}_${Math.round((f.ts - slotAt) * 1000)}ms.jpg`), Buffer.from(f.data, 'base64')));
  console.log(`frames kept: ${kept.length} of ${frames.length}`);

  // Summary: title top before/after, per-frame deltas, and biggest jump.
  const around = samples.filter((s) => s.sinceSlot !== null && s.sinceSlot <= 900);
  const before = samples.filter((s) => s.sinceSlot === null).slice(-3);
  console.log('title before slot:', before.map((s) => `${s.t}ms top=${s.titleTop} anims=[${s.titleAnims}]`).join(' | '));
  let prev = before[before.length - 1];
  let biggest = { d: 0 };
  for (const s of around) {
    const d = prev && prev.titleTop !== null && s.titleTop !== null ? s.titleTop - prev.titleTop : 0;
    if (Math.abs(d) > Math.abs(biggest.d)) biggest = { d, at: s.sinceSlot };
    console.log(`+${String(s.sinceSlot).padStart(4)}ms slot=${String(s.slotHeight).padStart(6)} (${s.slotStyleHeight || 'auto'}) title.top=${s.titleTop} (${d >= 0 ? '+' : ''}${d.toFixed(2)}) op=${s.titleOpacity} tr=${s.titleTransform} anims=[${s.titleAnims}] motion.op=${s.motionOpacity} motion.tr=${s.motionTransform} badge.h=${s.badgeHeight}`);
    prev = s;
  }
  console.log(`biggest single-frame title move: ${biggest.d.toFixed(2)} px at +${biggest.at} ms`);
} finally {
  chrome.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
