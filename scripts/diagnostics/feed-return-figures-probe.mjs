// feed -> research -> (overlay open/close) -> feed, recorded around the return.
//   node research-return-probe.mjs <label> [overlay]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9235, ORIGIN = 'http://localhost:5174', OUT = process.cwd();
const PROFILE = process.env.HOME + '/.papertok-probe-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [, , label = 'run', ...rest] = process.argv;
const withOverlay = rest.includes('overlay'); const useBack = rest.includes('back'); const from = (rest.find(f => f.startsWith('from=')) || 'from=feed').slice(5); const recordFirst = rest.includes('first');
const SAMPLER = `(() => {
  const samples = []; const start = performance.now(); window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime - start), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  const tick = () => {
    const pages = [...document.querySelectorAll('#main-content > *')].map((el) => { const cs = getComputedStyle(el); return { motion: el.dataset.pageMotion || null, nav: el.dataset.navDirection, opacity: +cs.opacity, transform: cs.transform, position: cs.position, top: el.style.top || null }; });
    const feed = document.querySelector('.feed-container');
    const t = document.querySelector('.feed-container .pc-title');
    const anims = document.getAnimations().filter(a => a.playState === 'running').map(a => (a.animationName || a.transitionProperty || '?') + '@' + (a.effect?.target?.className?.toString?.().split(' ')[0] || '?'));
    samples.push({ t: Math.round(performance.now() - start), pages, overlay: !!document.querySelector('.paper-overlay'), modal: !!document.querySelector('[aria-modal="true"]'), html: document.documentElement.style.cssText, body: document.body.style.cssText, scrollY: window.scrollY, feed: feed ? { st: feed.scrollTop, ch: feed.clientHeight, cards: feed.querySelectorAll('.pc-title').length } : null, card: t ? { op: +getComputedStyle(t).opacity, tr: getComputedStyle(t).transform } : null, anims, figs: [...document.querySelectorAll('.feed-container .pc-figure')].map(f => (f.classList.contains('is-loaded') ? 'L' : '-') + (f.querySelector('img')?.complete ? 'c' : '.') + (f.querySelector('img')?.getAttribute('src') ? 's' : '_')).join(' ') });
    if (performance.now() - start < 1600) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick); window.__s = samples;
})();`;
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
async function pageTarget() { for (let i = 0; i < 150; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(100); } throw new Error('no target'); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.l = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const p = this.p.get(m.id); this.p.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } else (this.l.get(m.method) || []).forEach((fn) => fn(m.params)); }); }
  send(m, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method: m, params })); }); }
  on(m, fn) { (this.l.get(m) || this.l.set(m, []).get(m)).push(fn); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + JSON.stringify(r.exceptionDetails.exception || {})); return r.result.value; } }
async function waitFor(cdp, sel, ms = 40000) { for (let i = 0; i < ms / 100; i++) { if (await cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`).catch(() => false)) return true; await sleep(100); } throw new Error('timeout ' + sel); }
const click = (sel, i = 0) => `(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); return (el.textContent||'').trim().slice(0,40); })()`;
const state = `JSON.stringify({ hash: location.hash, overlay: !!document.querySelector('.paper-overlay'), modal: !!document.querySelector('[aria-modal="true"]'), html: document.documentElement.style.cssText, body: document.body.style.cssText, scrollY: scrollY, feed: (() => { const f = document.querySelector('.feed-container'); return f ? { st: f.scrollTop, ch: f.clientHeight, cards: f.querySelectorAll('.pc-title').length } : null; })() })`;
try {
  const ws = new WebSocket(await pageTarget()); await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); let netT0 = 0; const net = []; cdp.on('Network.requestWillBeSent', (p) => { if (netT0) net.push(`${Math.round(p.wallTime * 1000 - netT0)}ms ${p.request.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)}`); });
  const logs = []; cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') logs.push(p.args.map(a => a.value || a.description).join(' ').slice(0, 200)); });
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  await waitFor(cdp, '.feed-container .pc-title'); await sleep(4500);
  // scroll one card down so the resume has something to restore
  await cdp.eval(`(() => { const f = document.querySelector('.feed-container'); f.scrollTo({ top: f.clientHeight, behavior: 'instant' }); })()`); await sleep(800);
  console.log('feed before leaving:', await cdp.eval(state));
  async function record(name, expr, ms = 1800) {
    const fr = []; const h = (p) => { fr.push({ ts: p.metadata.timestamp, data: p.data }); cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {}); };
    cdp.on('Page.screencastFrame', h);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 800, maxHeight: 562, everyNthFrame: 1 }); await sleep(400);
    const t0 = Date.now() / 1000; netT0 = Date.now(); net.length = 0; const r = await cdp.eval(`${SAMPLER} ${expr}`); await sleep(ms); await cdp.send('Page.stopScreencast');
    cdp.l.set('Page.screencastFrame', []);
    const samples = await cdp.eval('window.__s'); console.log('  longtasks [start,dur]:', JSON.stringify(await cdp.eval('window.__lt')), '| first rAF sample at', samples[0]?.t, 'ms');
    const kept = fr.filter((f) => f.ts >= t0 - 0.05).map((f) => ({ t: Math.round((f.ts - t0) * 1000), data: f.data }));
    const dir = join(OUT, `${name}-frames`); mkdirSync(dir, { recursive: true });
    kept.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(3, '0')}_${f.t}ms.jpg`), Buffer.from(f.data, 'base64')));
    writeFileSync(join(OUT, `${name}-samples.json`), JSON.stringify(samples, null, 1));
    console.log(`${name}: ${r}; frames ${kept.length}; samples ${samples.length}`); console.log('  net:', net.filter(u => !u.includes('/@') && !u.includes('node_modules')).slice(0, 25).join('\n       '));
    return samples;
  }
  if (from === 'following') { console.log('to following:', await cdp.eval(click('a[href="#/following"]'))); await sleep(4000); }
  if (recordFirst) await record(`${label}-first`, click('a[href="#/research"]'));
  else console.log('to research:', await cdp.eval(click('a[href="#/research"]')));
  await waitFor(cdp, '.sr-hero-actions button'); await sleep(1500);
  if (withOverlay) {
    console.log('open:', await cdp.eval(click('.sr-hero-actions button')));
    await waitFor(cdp, '.paper-overlay[data-open] .pc-title'); await sleep(1500);
    console.log('overlay open:', await cdp.eval(state));
    await record(`${label}-close`, click('.paper-overlay-back'), 900); await sleep(400);
  }
  console.log('before return:', await cdp.eval(state));
  const samples = await record(label, useBack ? "history.back(); 'back'" : click('a[href="#/"]'));
  console.log('after return:', await cdp.eval(state));
  // compact per-frame summary
  for (const s of samples) console.log(s.t, s.pages.map(p => `${p.motion}/${p.nav}/${p.opacity.toFixed(2)}/${p.transform === 'none' ? '-' : p.transform.replace('matrix(1, 0, 0, 1, ', 'm(')}${p.top ? '/top' + p.top : ''}`).join(' | '), 'ov', +s.overlay, 'md', +s.modal, 'html', JSON.stringify(s.html), 'body', JSON.stringify(s.body), 'feed', JSON.stringify(s.feed), 'card', JSON.stringify(s.card), 'anims', s.anims.join(','));
  if (logs.length) console.log('console:', logs.slice(0, 8).join('\n  '));
} finally { chrome.kill(); await sleep(400); }
