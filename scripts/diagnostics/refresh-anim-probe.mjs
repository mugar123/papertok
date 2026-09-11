// What a desktop refresh actually looks like, frame by frame.
//   ORIGIN=http://localhost:5173 node scripts/diagnostics/refresh-anim-probe.mjs
// Needs the two `publicMode` gates in FeedContainer open (see pull-to-refresh-probe.mjs).
//
// Known limit: with the gates merely opened the reader is still a GUEST, and
// the guest feed never sets `isRefreshing` — so the pill's spinning state and
// the `--refreshing` dip do not appear here. They need a real session. What
// this probe does show honestly is the content swap: the card count and the
// paper changing, and the long frames around them.
import { spawn } from 'node:child_process'; import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const PORT = Number(process.env.PORT || 9236), ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const PROFILE = join(tmpdir(), `pt-refresh-${process.pid}`); mkdirSync(PROFILE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
async function target() { for (let i = 0; i < 150; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(100); } throw new Error('no page'); }
class CDP { constructor(w) { this.w = w; this.i = 0; this.p = new Map(); w.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const x = this.p.get(m.id); this.p.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); } }); }
  send(m, p = {}) { const id = ++this.i; return new Promise((r, j) => { this.p.set(id, { resolve: r, reject: j }); this.w.send(JSON.stringify({ id, method: m, params: p })); }); }
  async e(x) { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; } }
try {
  const ws = new WebSocket(await target()); await new Promise((r) => ws.addEventListener('open', r));
  const c = new CDP(ws); await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__PROBE_PULL = true;' });
  await c.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  const s = Date.now(); while (Date.now() - s < 30000) { if (await c.e(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Not now|Ahora no/i.test(x.textContent));b&&b.click();return !!document.querySelector('.feed-refresh');})()`).catch(() => false)) break; await sleep(300); }
  await sleep(2500);
  const out = await c.e(`(async()=>{
    const pill = document.querySelector('.feed-refresh');
    const feed = document.querySelector('.feed-container');
    const title = () => document.querySelector('.pc-title')?.textContent.trim().slice(0,26) || null;
    const rows = []; const t0 = performance.now();
    const loaf = []; new PerformanceObserver(l=>l.getEntries().forEach(e=>{ if(e.duration>=40) loaf.push({at:Math.round(e.startTime-t0),dur:Math.round(e.duration)}); })).observe({type:'long-animation-frame'});
    const sample = () => {
      const card = document.querySelector('.pc');
      rows.push({
        at: Math.round(performance.now() - t0),
        pill: pill.className.replace('feed-refresh','').trim() || '-',
        pillText: pill.textContent.trim(),
        cards: document.querySelectorAll('.pc').length,
        title: title(),
        scroll: Math.round(feed.scrollTop),
        feedOpacity: Number(getComputedStyle(feed).opacity).toFixed(2),
        anims: card ? card.getAnimations({subtree:true}).map(a=>a.animationName).filter(Boolean).slice(0,3).join(',') : '',
      });
    };
    const iv = setInterval(sample, 50); sample();
    pill.click();
    await new Promise(r=>setTimeout(r, 4200)); clearInterval(iv); sample();
    const changes = []; let last = '';
    for (const r of rows) { const k = r.pill+'|'+r.pillText+'|'+r.cards+'|'+r.title+'|'+r.feedOpacity+'|'+r.anims+'|'+(r.scroll>4); if (k!==last) { last=k; changes.push(r); } }
    return { changes, longFrames: loaf };
  })()`);
  console.log(JSON.stringify(out, null, 1));
} finally { chrome.kill('SIGKILL'); }
