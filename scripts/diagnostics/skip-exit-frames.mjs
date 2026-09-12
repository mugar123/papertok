// The Skip exit, frame by frame (2026-09-12).
//
// What it answers: does the card that was passed over actually travel, is its
// successor already in the slot while it goes, does the scroll position move
// under the reader, and does the scroller grow a horizontal axis while a card
// hangs off its right edge.
//
//   PROFILE_DIR=$HOME/.papertok-probe-profile \
//     node scripts/diagnostics/skip-exit-frames.mjs '#/' 2
//
// The first argument is the route ('#/' or '#/following'), the second how many
// cards to scroll past first — the exit behaves differently on the first card
// than in the middle of a feed, so measure both. `PROFILE_DIR` names a Chrome
// profile the user has signed in to; it is used as-is and NEVER deleted (see
// the note at the top of README.md). Without it the probe measures whatever a
// visitor sees, which for the feed is the guest feed.
//
// NOTE: this presses a real Skip. On a signed-in profile that writes a real
// "not interested" to that account, and the write needs a few seconds to land
// — see the memory on probes that kill Chrome too early.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9250);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-skip-exit-${process.pid}`);
const ROUTE = process.argv[2] || '#/';
const CARD = Number(process.argv[3] || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 150; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(100); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `${ORIGIN}/${ROUTE}` });
for (let i = 0; i < 120; i++) { if (await ev(`document.querySelectorAll('.pc-side-btn--skip').length`)) break; await sleep(500); }
await sleep(3000);
for (let i = 0; i < CARD; i++) { await ev(`(() => { const f = document.querySelector('.feed-container'); f.scrollBy({ top: f.clientHeight, behavior: 'instant' }); })()`); await sleep(900); }
await sleep(1800);

await ev(`(() => {
  window.__f = []; window.__on = true;
  const q = (s) => document.querySelector(s);
  const tx = (el) => { const t = getComputedStyle(el).transform; if (!t || t === 'none') return 0; const m = t.match(/matrix\\(([^)]+)\\)/); return m ? Math.round(Number(m[1].split(',')[4])) : 0; };
  const tick = () => {
    if (window.__on) {
      const feed = q('.feed-container');
      const leaving = q('.feed-snap-item--leaving > .pc');
      const mid = innerHeight / 2;
      const items = [...document.querySelectorAll('.feed-snap-item:not(.feed-snap-item--leaving)')];
      const inView = items.find(el => { const r = el.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
      window.__f.push({
        t: Math.round(performance.now() - window.__t0),
        x: leaving ? tx(leaving) : null,
        op: leaving ? Number(getComputedStyle(leaving).opacity).toFixed(2) : null,
        pos: q('.feed-snap-item--leaving') ? getComputedStyle(q('.feed-snap-item--leaving')).position : null,
        top: Math.round(feed.scrollTop),
        overflowX: feed.scrollWidth - feed.clientWidth,
        n: document.querySelectorAll('.feed-snap-item').length,
        view: inView ? (inView.querySelector('h1,h2,.pc-title')||{}).textContent?.slice(0, 28) : null,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`);

const target = await ev(`(() => {
  const mid = innerHeight / 2;
  for (const b of document.querySelectorAll('.pc-side-btn--skip')) {
    const card = b.closest('.feed-snap-item'); const cr = card.getBoundingClientRect();
    if (!(cr.top <= mid && cr.bottom >= mid)) continue;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
             onCard: (card.querySelector('h1,h2,.pc-title')||{}).textContent?.slice(0,28) };
  }
  return null;
})()`);
await ev(`window.__t0 = performance.now()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 });
await sleep(50);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 0 });
await sleep(900);
await ev(`window.__on = false`);
const frames = await ev(`window.__f`);
const during = frames.filter(f => f.t >= 0 && f.t <= 480);
console.log(JSON.stringify({
  route: ROUTE, skipped: target.onCard,
  framesInFirst400ms: during.filter(f => f.t <= 400).length,
  timeline: during.map(f => `${String(f.t).padStart(3)}ms x=${f.x === null ? '-' : f.x} op=${f.op ?? '-'} ${f.pos ?? ''} top=${f.top} n=${f.n} ovX=${f.overflowX} "${f.view}"`),
}, null, 2));
ws.close(); chrome.kill('SIGTERM');
