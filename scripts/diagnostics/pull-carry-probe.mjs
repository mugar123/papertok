// Lo que el pulgar mueve durante el tirón: los papers, la píldora y el icono,
// muestra a muestra. Complementa a `pull-to-refresh-probe.mjs`, que contesta
// QUÉ arrastres arman el gesto; éste contesta QUÉ se mueve mientras dura y
// cómo vuelve al soltar.
//
// Igual que aquél, necesita las dos puertas de `publicMode` de FeedContainer
// abiertas a mano (el `publicMode` del efecto de los listeners y el de la
// píldora) y devueltas después.
//
// Dos cosas que confundieron la medida la primera vez:
//   - Un tirón que PASA del umbral dispara el refresco, y en el feed de
//     invitado eso remonta las tarjetas: el `.pc` que mides al soltar es otro
//     elemento, sin transición que correr, y el retorno parece un salto. Para
//     medir el retorno hay que quedarse por debajo del umbral (80px).
//   - La emulación táctil se come el primer `touchMove` a veces; cuenta los
//     `defaultPrevented`, no los dispatches.
//
//   ORIGIN=http://localhost:5173 node scripts/diagnostics/pull-carry-probe.mjs
import { spawn } from 'node:child_process'; import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const PORT = Number(process.env.PORT || 9257), ORIGIN = 'http://localhost:5173';
const PROFILE = join(tmpdir(), `pt-carry-${process.pid}`); mkdirSync(PROFILE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
async function target() { for (let i = 0; i < 150; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(100); } throw new Error('no page'); }
class CDP { constructor(w) { this.w = w; this.i = 0; this.p = new Map(); w.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const x = this.p.get(m.id); this.p.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); } }); }
  send(m, p = {}) { const id = ++this.i; return new Promise((r, j) => { this.p.set(id, { resolve: r, reject: j }); this.w.send(JSON.stringify({ id, method: m, params: p })); }); }
  async e(x) { const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description||'')); return r.result.value; } }
const y2 = (m) => { const v = /matrix\(1, 0, 0, 1, [-\d.]+, ([-\d.]+)\)/.exec(m); return v ? Number(v[1]).toFixed(1) : (m === 'none' ? '0.0' : m); };
try {
  const ws = new WebSocket(await target()); await new Promise((r) => ws.addEventListener('open', r));
  const c = new CDP(ws); await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await c.send('Page.navigate', { url: `${ORIGIN}/?carry=${Date.now()}#/` });
  const s = Date.now(); let ok = false;
  while (Date.now() - s < 40000) { ok = await c.e(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Not now|Ahora no/i.test(x.textContent));b&&b.click();return !!document.querySelector('.feed-container .pc');})()`).catch(()=>false); if (ok) break; await sleep(300); }
  if (!ok) throw new Error('sin feed');
  await sleep(2500);
  console.log('píldora presente:', await c.e(`!!document.querySelector('.feed-refresh')`));
  console.log('transition de .pc:', await c.e(`getComputedStyle(document.querySelector('.pc')).transition`));
  await c.e(`window.__pc = document.querySelector('.pc'); true`);
  await c.e(`window.__prev=0; window.addEventListener('touchmove', e=>{ if(e.defaultPrevented) window.__prev++; }, false); true`);
  const probe = `(()=>{const w=document.querySelector('.feed-wrapper'),p=document.querySelector('.feed-refresh'),card=document.querySelector('.pc'),ic=document.querySelector('.feed-refresh-icon');
    const cs=getComputedStyle(card), ps=p?getComputedStyle(p):null;
    return { pull:(w.style.getPropertyValue('--pull')||'0').trim(), py:(w.style.getPropertyValue('--pull-y')||'0px').trim(),
      cardY: cs.transform, same: (window.__pc === card), anims: card.getAnimations().map(a=>a.transitionProperty||a.animationName).join('+')||'-', pillT: ps?ps.translate:'-', pillOp: ps?Number(ps.opacity).toFixed(2):'-', icon: ic?getComputedStyle(ic).rotate:'-', prevented: window.__prev };})()`;
  const rows = [];
  const at = (label) => c.e(probe).then(r => rows.push({ label, ...r }));
  // Tarjeta 0: cualquier arrastre hacia abajo es el tirón.
  await c.e(`(()=>{const f=document.querySelector('.feed-container'); f.scrollTop=0; return true;})()`); await sleep(600);
  const X = 190, Y0 = 400;
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: X, y: Y0 }] });
  for (const dy of [10, 30, 60, 80]) {
    await sleep(70);
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: X, y: Y0 + dy }] });
    await sleep(60); await at(`dedo +${dy}px`);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  let acc = 0;
  for (const ms of [16, 50, 100, 160, 240, 340, 460]) { await sleep(ms - acc); acc = ms; await at(`suelto +${ms}ms`); }
  console.log('\nlabel               pull   --pull-y   card transform Y   pill translate        icono        prevented');
  for (const r of rows) console.log(r.label.padEnd(18), String(Number(r.pull||0).toFixed(2)).padStart(5), String(r.py).padStart(9), y2(r.cardY).padStart(16), String(r.pillT).padStart(22), String(r.icon).padStart(11), String(r.prevented).padStart(6), r.same?'':'CARD NUEVA', r.anims);
} finally { chrome.kill('SIGKILL'); }
