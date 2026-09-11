// Timing of the feed → topic → feed transitions in a headless Chrome (visible to rAF, no throttling).
//   ORIGIN=http://localhost:5173 PROFILE_DIR=~/.papertok-probe-profile node scripts/diagnostics/route-transition-timing.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9232);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const PROFILE = (process.env.PROFILE_DIR || join(tmpdir(), `papertok-routetiming-${process.pid}`)).replace(/^~/, homedir());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
async function pageTarget() { for (let i = 0; i < 150; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(100); } throw new Error('no page'); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; } }
const WINDOW_MS = Number(process.env.WINDOW_MS || 1400);
const PROBE = `(async()=>{ const probe=async(label, act)=>{ const out=[]; const t0=performance.now(); const po=new PerformanceObserver(l=>l.getEntries().forEach(e=>{ if(e.duration<40) return; out.push({at:Math.round(e.startTime-t0), total:Math.round(e.duration), script:Math.round((e.scripts||[]).reduce((a,s)=>a+s.duration,0)), top:(e.scripts||[]).filter(s=>s.duration>25).map(s=>(s.sourceFunctionName||'?')+':'+Math.round(s.duration)).join(',')}); })); po.observe({type:'long-animation-frame'}); const shifts=[]; const ls=new PerformanceObserver(l=>l.getEntries().forEach(e=>{ if(!e.hadRecentInput && e.value>0.001) shifts.push({at:Math.round(e.startTime-t0), v:+e.value.toFixed(3), src:(e.sources||[]).map(x=>x.node?.className?.toString().slice(0,30)||x.node?.tagName||'?').slice(0,2).join('|')}); })); ls.observe({type:'layout-shift'}); const timeline=[]; const sampler=setInterval(()=>{ const pages=[...document.querySelectorAll('.page-transition')]; const a=pages.flatMap(p=>[...p.getAnimations({subtree:false})].map(x=>Math.round(x.currentTime||0))); if(a.length) timeline.push({at:Math.round(performance.now()-t0), t:a[0]}); },40); const stamps=[]; let go=true; const loop=(ts)=>{stamps.push(ts); if(go) requestAnimationFrame(loop)}; requestAnimationFrame(loop); await act(); await new Promise(r=>setTimeout(r,${WINDOW_MS})); clearInterval(sampler); po.disconnect(); ls.disconnect(); go=false; const rel=stamps.map(s=>Math.round(s-t0)); const gaps=[]; for(let i=1;i<rel.length;i++){const g=rel[i]-rel[i-1]; if(g>20) gaps.push(rel[i-1]+'→+'+g);} const advancing=timeline.filter((s,i)=>i>0 && s.t>timeline[i-1].t).length; return {label, vis:document.visibilityState, longFrames:out, layoutShifts:shifts, gapsOver20ms:gaps, animStartMs: timeline[0]?.at ?? null, animSamples: timeline.length, advancing, fps: Math.round(1000/(rel[rel.length-1]/rel.length))}; }; const pill=document.querySelector('.pc .pc-topic-link, .pc .pc-category-pill'); if(!pill) return {error:'sin pildora'}; const A=await probe('IDA', async()=>pill.click()); await new Promise(r=>setTimeout(r,1800)); const B=await probe('VUELTA', async()=>history.back()); await new Promise(r=>setTimeout(r,1800)); const p2=document.querySelector('.pc .pc-topic-link, .pc .pc-category-pill'); const C=await probe('IDA 2', async()=>p2.click()); await new Promise(r=>setTimeout(r,1800)); const D=await probe('VUELTA 2', async()=>history.back()); return {A,B,C,D}; })()`;
try {
  const ws = new WebSocket(await pageTarget()); await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  const s = Date.now(); let ok = false;
  while (Date.now() - s < 30000) { ok = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Not now|Ahora no/i.test(x.textContent)); b&&b.click(); return !!document.querySelector('.pc .pc-topic-link, .pc .pc-category-pill');})()`).catch(() => false); if (ok) break; await sleep(300); }
  if (!ok) throw new Error('no topic pill within 30s: ' + await cdp.eval('document.body.innerText.slice(0,120)'));
  await sleep(2500);
  const r = await cdp.eval(PROBE);
  console.log(JSON.stringify(r, null, 1));
} finally { chrome.kill('SIGKILL'); }
