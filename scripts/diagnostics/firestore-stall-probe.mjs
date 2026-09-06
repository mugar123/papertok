// Firestore dead-stream probe over CDP against a headless Chrome. No dependencies.
//
// Reproduces the stall behind "the feed / the lists / followers sometimes take
// forever and I have to reload" (2026-09-06): the SDK's one listen stream dies
// silently under a live client and every getDoc/getDocs issued afterwards
// hangs — measured at 96 s and counting, network back or not. The probe visits
// a public profile (two SDK reads anyone can make without a session), notes
// the stream's SID, then HOLDS every request that carries that SID at the
// network — the stream is dead, the network is fine, a new stream would work —
// and navigates in-app to a second profile. It samples what the page shows
// and when it paints, and lists the Firestore requests: a rebuilt stream shows
// up as a new handshake with a new SID.
//
// usage: node scripts/diagnostics/firestore-stall-probe.mjs [hold=<s>]
// env:   ORIGIN  the app (default http://localhost:5173; https://papertok.app for the deployed build)
//        HANDLE / HANDLE2  the two public profiles (default mugar, nick_mugar)
//        PORT    Chrome's remote-debugging port (default 9224)
//        CHROME  the binary (default: Google Chrome in /Applications)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9224);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const PROFILE = join(tmpdir(), `papertok-stall-probe-${process.pid}`);
const flags = process.argv.slice(2);
const flagValue = (name, fallback) => { const f = flags.find((x) => x.startsWith(`${name}=`)); return f ? f.split('=')[1] : fallback; };
const HOLD_S = Number(flagValue('hold', 25));
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
      if (m.id) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); }
      else (this.listeners.get(m.method) || []).forEach((fn) => fn(m.params));
    });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  on(method, fn) { this.listeners.set(method, [...(this.listeners.get(method) || []), fn]); }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

const chrome = launch();
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} }, 1500); };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const ws = new WebSocket(await pageTarget());
await new Promise((r) => ws.addEventListener('open', r));
const cdp = new CDP(ws);

// --- network log: every Firestore request, with its SID and its fate -----
const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)} ms`;
const firestore = [];
const hosts = new Map();
const sidOf = (url) => (url.match(/[?&]SID=([^&]+)/) || [])[1] || null;
cdp.on('Network.requestWillBeSent', (p) => {
  try { const h = new URL(p.request.url).host; hosts.set(h, (hosts.get(h) || 0) + 1); } catch {}
  if (!/firestore\.googleapis\.com/.test(p.request.url)) return;
  firestore.push({ id: p.requestId, at: Date.now() - t0, method: p.request.method, sid: sidOf(p.request.url), kind: /\/Listen\//.test(p.request.url) ? 'listen' : /\/Write\//.test(p.request.url) ? 'write' : 'other', status: null });
});
cdp.on('Network.responseReceived', (p) => { const e = firestore.find((x) => x.id === p.requestId); if (e) e.status = p.response.status; });
cdp.on('Network.loadingFailed', (p) => { const e = firestore.find((x) => x.id === p.requestId); if (e) e.status = `failed: ${p.errorText}`; });
const consoleLog = [];
cdp.on('Runtime.consoleAPICalled', (p) => consoleLog.push(`${stamp()} [${p.type}] ${p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160)}`));

// --- the dead stream: hold at the network everything that carries this SID --
let deadSid = null;
const held = [];
cdp.on('Fetch.requestPaused', (p) => {
  const sid = sidOf(p.request.url);
  if (deadSid && sid === deadSid) { held.push({ at: Date.now() - t0, method: p.request.method }); return; } // never answered
  cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
});

await cdp.send('Network.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*firestore.googleapis.com*', requestStage: 'Request' }] });


const PAGE_STATE = `(() => {
  const main = document.querySelector('main.public-profile-page, main[class*="public-profile"]') || document.querySelector('main');
  if (!main) return { main: false };
  const busy = main.getAttribute('aria-busy') === 'true';
  const identity = main.querySelector('.public-profile-identity');
  const name = identity ? identity.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : '';
  const skeleton = !!main.querySelector('.public-profile-skeleton');
  const state = main.querySelector('.public-profile-state-body, .public-profile-page--state h1, .public-profile-page--state h2');
  return { main: true, busy, skeleton, name, state: state ? state.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90) : null,
    retry: !!main.querySelector('.public-profile-retry') };
})()`;
/** Samples the page until a profile has painted (a name, no skeleton) or the clock runs out. */
async function watchPage(seconds, handle) {
  const started = Date.now();
  const timeline = [];
  let last = '';
  while (Date.now() - started < seconds * 1000) {
    const s = await cdp.evaluate(PAGE_STATE).catch(() => ({ main: false }));
    const key = JSON.stringify(s);
    if (key !== last) { timeline.push({ at: Date.now() - started, ...s }); last = key; }
    // Painted means THIS profile's name is up, not the previous page's: an
    // in-app navigation keeps the old page on screen until the new one has
    // something to show.
    if (s.main && !s.skeleton && s.name && s.name.includes('@' + handle)) return { loadedAt: Date.now() - started, timeline };
    await sleep(120);
  }
  return { loadedAt: null, timeline };
}

const FIRST = process.env.HANDLE || 'mugar';
const SECOND = process.env.HANDLE2 || 'nick_mugar';
console.log(`origin ${ORIGIN}`);
// 1. a healthy visit: establishes the stream and gives us its SID
await cdp.send('Page.navigate', { url: `${ORIGIN}/#/public/user/${FIRST}` });
const healthy = await watchPage(30, FIRST);
console.log(`${stamp()} healthy visit to @${FIRST}: ${healthy.loadedAt == null ? 'NOT loaded' : `painted in ${healthy.loadedAt} ms`}; ${JSON.stringify(healthy.timeline.at(-1))}`);
await sleep(800);
const sids = [...new Set(firestore.map((e) => e.sid).filter(Boolean))];
deadSid = sids.at(-1);
console.log(`${stamp()} stream SID ${deadSid ? deadSid.slice(0, 10) + '…' : 'NOT SEEN'} (${sids.length} seen)`);
if (!deadSid) {
  console.log('no stream SID observed; cannot simulate a dead stream. Hosts seen:');
  [...hosts.entries()].sort((a, b) => b[1] - a[1]).forEach(([h, n]) => console.log(`   ${String(n).padStart(4)}  ${h}`));
  console.log('firestore requests:', firestore.length);
  process.exit(2);
}

// 2. the stream is dead now. Visit the second profile (an in-app navigation: same client, same stream).
console.log(`${stamp()} --- the stream is now dead at the network (held, never answered); the network itself is fine ---`);
await cdp.evaluate(`location.hash = '#/public/user/${SECOND}'`);
const stalled = await watchPage(HOLD_S, SECOND);
console.log(`${stamp()} visit to @${SECOND} over the dead stream: ${stalled.loadedAt == null ? `NOT painted after ${HOLD_S} s` : `painted in ${stalled.loadedAt} ms`}`);
stalled.timeline.forEach((s) => console.log(`   ${String(s.at).padStart(6)} ms  ${JSON.stringify(s)}`));

console.log(`\nheld requests (the dead stream): ${held.length}`);
console.log('firestore requests:');
firestore.forEach((e) => console.log(`   ${String(e.at).padStart(6)} ms  ${e.method.padEnd(4)} ${e.kind.padEnd(6)} SID=${e.sid ? e.sid.slice(0, 8) + (e.sid === deadSid ? ' (dead)' : ' (NEW)') : 'handshake'}  ${e.status ?? 'pending'}`));
const newSids = [...new Set(firestore.filter((e) => e.sid && e.sid !== deadSid && e.at > (held[0]?.at ?? Infinity)).map((e) => e.sid))];
console.log(`new streams after the stall: ${newSids.length}`);
console.log('console:'); consoleLog.slice(-25).forEach((l) => console.log('  ' + l));
ws.close();
process.exit(0);
