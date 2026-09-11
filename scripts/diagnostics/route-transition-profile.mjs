// CPU profile of a route transition: feed → topic page (a topic pill) and back.
// Reuses the launcher of tab-switch-scroll.mjs. No dependencies (Node >= 22).
//   PROFILE_DIR=~/.papertok-probe-profile ORIGIN=http://localhost:5173 node scripts/diagnostics/route-transition-profile.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9231);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const PROFILE = (process.env.PROFILE_DIR || join(tmpdir(), `papertok-routeprof-${process.pid}`)).replace(/^~/, homedir());
const OUT = process.env.OUT || join(tmpdir(), 'route-transition-profile.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function launch() {
  mkdirSync(PROFILE, { recursive: true });
  return spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
}
async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const page = list.find((t) => t.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch {}
    await sleep(100);
  }
  throw new Error('no page target');
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; }
}
const short = (url) => (url || '').replace(/^.*\/(src|node_modules\/\.vite\/deps|node_modules)\//, '$1/').replace(/\?.*$/, '');
function aggregate(profile, limit = 18) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map(), incl = new Map(); let total = 0;
  const key = (n) => `${n.callFrame.functionName || '(anon)'} — ${short(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = (profile.timeDeltas[i] || 0) / 1000; total += dt;
    const leaf = byId.get(profile.samples[i]); if (!leaf) continue;
    const lk = key(leaf); if (!/^\((program|idle|garbage collector|root)\)/.test(leaf.callFrame.functionName)) self.set(lk, (self.get(lk) || 0) + dt);
    const seen = new Set(); let id = leaf.id;
    while (id !== undefined) { const n = byId.get(id); const k = key(n); if (!seen.has(k) && !/^\((program|idle|garbage collector|root)\)/.test(n.callFrame.functionName)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + dt); } id = parent.get(id); }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, v]) => `${String(Math.round(v)).padStart(5)} ms  ${k}`);
  return { sampledMs: Math.round(total), self: top(self), inclusive: top(incl) };
}
const chrome = launch();
try {
  const ws = new WebSocket(await pageTarget()); await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  const waitFor = async (expr, limit = 40000) => { const s = Date.now(); while (Date.now() - s < limit) { if (await cdp.eval(expr).catch(() => false)) return true; await sleep(50); } return false; };
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  if (!(await waitFor(`!!document.querySelector('.pc .pc-topic-link')`))) throw new Error('feed did not show a topic pill');
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Not now|Ahora no/i.test(x.textContent)); b&&b.click(); return true;})()`);
  await sleep(2500);
  const signedIn = await cdp.eval(`!document.querySelector('a[href*="login"]') && !![...document.querySelectorAll('button')].find(b=>/Preferences|Preferencias/i.test(b.getAttribute('aria-label')||''))`);
  const results = { origin: ORIGIN, signedIn };
  const run = async (label, expr) => {
    await cdp.send('Profiler.start'); const t0 = Date.now();
    await cdp.eval(expr); await sleep(2000);
    const { profile } = await cdp.send('Profiler.stop');
    results[label] = { wallMs: Date.now() - t0, route: await cdp.eval('location.hash'), domNodes: await cdp.eval('document.getElementsByTagName("*").length'), ...aggregate(profile) };
  };
  await run('IDA', `(()=>{document.querySelector('.pc[data-active="true"] .pc-topic-link, .pc .pc-topic-link').click(); return true;})()`);
  await run('VUELTA', `(()=>{history.back(); return true;})()`);
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  for (const k of ['IDA', 'VUELTA']) { const r = results[k]; console.log(`\n══════ ${k}  ruta=${r.route}  nodosDOM=${r.domNodes}  muestreado=${r.sampledMs} ms  sesión=${signedIn}`); console.log('── self:'); console.log(r.self.join('\n')); console.log('── inclusivo:'); console.log(r.inclusive.join('\n')); }
} finally { chrome.kill('SIGKILL'); }
