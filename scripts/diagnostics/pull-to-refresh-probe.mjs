// Real touch input (CDP Input.dispatchTouchEvent) against the mobile feed, to
// tell a pull-to-refresh from the swipe to the previous paper.
//
// The gesture is for signed-in readers only, and a fresh Chrome profile on
// localhost has no session, so to run this you have to open the two guest
// gates in FeedContainer.jsx by hand first (the `publicMode` checks on the
// listener effect and on the pill) and put them back afterwards. `prevented`
// is the signal that matters: a synthetic touch does not always drive the
// compositor in headless, so the scroll position itself proves nothing.
//
// Known limit: each dispatch is a CDP round trip, so a "fling" here arrives
// at the page around 0.5 px/ms — under `PULL_FLING_VELOCITY_PX_PER_MS`. The
// fling path is covered by src/utils/feedPullToRefresh.test.js instead.
//   ORIGIN=http://localhost:5173 PROFILE_DIR=~/.papertok-probe-profile node scripts/diagnostics/pull-to-refresh-probe.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9234);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const PROFILE = (process.env.PROFILE_DIR || join(tmpdir(), `papertok-pull-${process.pid}`)).replace(/^~/, homedir());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
async function pageTarget() { for (let i = 0; i < 150; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(100); } throw new Error('no page'); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const x = this.p.get(m.id); this.p.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; } }
try {
  const ws = new WebSocket(await pageTarget()); await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__PROBE_PULL = true;' });
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  const s = Date.now(); let ready = false;
  while (Date.now() - s < 30000) { ready = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Not now|Ahora no/i.test(x.textContent)); b&&b.click(); return !!document.querySelector('.feed-container .pc');})()`).catch(() => false); if (ready) break; await sleep(300); }
  if (!ready) throw new Error('feed never showed: ' + await cdp.eval('document.body.innerText.slice(0,120)'));
  await sleep(2500);
  // Two exact signals. `prevented` is what decides whether the feed can
  // scroll under the gesture (a synthetic touch does not always drive the
  // compositor in headless, so the scroll position itself proves nothing).
  // `refreshes` watches the pill's own class, not the network, because a card
  // arriving fetches its own metadata and would look like a refresh.
  await cdp.eval(`(()=>{
    window.__moves=[]; window.__refreshes=0;
    window.addEventListener('touchstart', ()=>{ window.__t0=performance.now(); }, false);
    window.addEventListener('touchmove', (e)=>{ window.__moves.push({y:Math.round(e.touches[0]?.clientY||0), prevented:e.defaultPrevented}); }, false);
    window.addEventListener('touchend', (e)=>{ window.__gesture={ms:Math.round(performance.now()-window.__t0), dy:Math.round((e.changedTouches[0]?.clientY||0)-(window.__moves[0]?.y||0))}; }, false);
    const pill=document.querySelector('.feed-refresh');
    if(pill) new MutationObserver(()=>{ if(pill.classList.contains('is-refreshing')) window.__refreshes++; }).observe(pill,{attributes:true,attributeFilter:['class']});
    return true;
  })()`);
  const drag = async (x, y, dy, steps, stepMs) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) { await sleep(stepMs); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + Math.round((dy * i) / steps) }] }); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const setCard = async (n) => { await cdp.eval(`(()=>{const f=document.querySelector('.feed-container'); f.scrollTop=${n}*f.clientHeight; return true;})()`); await sleep(900); };
  const state = () => cdp.eval(`(()=>{const f=document.querySelector('.feed-container'); return {card: Math.round(f.scrollTop/f.clientHeight), scrollTop: Math.round(f.scrollTop), refreshes: window.__refreshes, top: Math.round(f.getBoundingClientRect().top), pull: Number(document.querySelector('.feed-refresh')?.style.getPropertyValue('--pull')||0)};})()`);
  const run = async (label, { card, fromBandOffset, dy, steps = 12, stepMs = 30 }) => {
    await setCard(card);
    await cdp.eval('window.__refreshes=0; window.__moves=[]; window.__gesture=null');
    const before = await state();
    const y = fromBandOffset === null ? 520 : before.top + fromBandOffset;
    let maxPull = 0;
    const poll = setInterval(async () => { const p = (await state()).pull; if (p > maxPull) maxPull = p; }, 40);
    await drag(190, y, dy, steps, stepMs);
    clearInterval(poll);
    await sleep(1600);
    const after = await state();
    const moves = await cdp.eval('window.__moves');
    const prevented = moves.filter((m) => m.prevented).length;
    return {
      label,
      desde: fromBandOffset === null ? 'medio de la tarjeta' : `franja +${fromBandOffset}px`,
      dy,
      movimientos: moves.length,
      conScrollBloqueado: prevented,
      elFeedPuedeMoverse: prevented === 0,
      pillLlegoA: Number(maxPull.toFixed(2)),
      gestoVistoPorLaPagina: await cdp.eval('window.__gesture'),
      refresco: after.refreshes > 0,
    };
  };
  const out = [];
  out.push(await run('A · tarjeta 2, tiro desde la franja', { card: 2, fromBandOffset: 40, dy: 160 }));
  out.push(await run('B · tarjeta 2, tiro desde el medio', { card: 2, fromBandOffset: null, dy: 160 }));
  out.push(await run('C · tarjeta 2, franja pero hacia ARRIBA', { card: 2, fromBandOffset: 40, dy: -160 }));
  out.push(await run('D · tarjeta 0, tiro desde el medio', { card: 0, fromBandOffset: null, dy: 160 }));
  out.push(await run('E · tarjeta 3, fling corto desde la franja', { card: 3, fromBandOffset: 30, dy: 80, steps: 2, stepMs: 0 }));
  out.push(await run('F · tarjeta 4, arrastre largo desde la franja', { card: 4, fromBandOffset: 30, dy: 200, steps: 10, stepMs: 25 }));
  console.log(JSON.stringify(out, null, 1));
} finally { chrome.kill('SIGKILL'); }
