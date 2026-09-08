// Institución → autor → ATRÁS, fotograma a fotograma. Qué se mueve en la
// página de institución cuando el lector vuelve a ella.
//
//   node scripts/diagnostics/entity-back-frames.mjs ['#/explorer/institution/I…']
//
// El camino que reprodujo el defecto de 2026-09-07: abrir una institución,
// abrir su pestaña Authors, entrar en un autor, y volver con `history.back()`.
// Lo que se registra es la vuelta.
//
// LA TRAMPA QUE HAY QUE CONOCER: mientras las dos páginas comparten pantalla
// (`AnimatePresence mode="sync"`), `document.querySelector` devuelve el nodo de
// la página SALIENTE, que va primera en el DOM. Medido así, la institución
// parecía dar un salto de −103px al desmontarse la otra — que no era un salto
// sino el selector cambiando de página. Todo se consulta dentro de la página
// que se QUEDA: la que no está en 'leave'/'hold'/'hold-lateral'/'fade'.
//
// PROFILE_DIR=<dir> reutiliza un perfil donde el usuario ha iniciado sesión: se
// usa tal cual y NUNCA se borra (OWN_PROFILE). Chrome bloquea un
// --user-data-dir mientras hay una instancia viva, así que la ventana donde se
// inició sesión tiene que estar cerrada. ORIGIN por defecto es :5174 y quiere
// un build de producción (`vite preview`), no `vite dev`: el modo desarrollo de
// React añade tareas de 90-135 ms que el build no tiene.
//
// DWELL=<ms> es cuánto se espera en la página de autor antes de volver (4000
// por defecto, con el autor ya asentado); bajarlo registra la vuelta tomada
// mientras el autor todavía llega.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9295);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const OWN_PROFILE = !process.env.PROFILE_DIR;
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-entity-back-${process.pid}`);
const INST = process.argv[2] || '#/explorer/institution/I136199984';
const DWELL = Number(process.env.DWELL || 4000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLER = `(() => { window.__s = []; window.__on = true; window.__gen = 0; window.__prev = null;
  if (window.__ticking) return; window.__ticking = true;
  const LEAVING = ['leave', 'hold', 'hold-lateral', 'fade'];
  const stay = () => [...document.querySelectorAll('#main-content > div')]
    .find((d) => !LEAVING.includes(d.getAttribute('data-page-motion'))) || document.body;
  const q = (s) => stay().querySelector(s);
  const r1 = (n) => Math.round(n * 10) / 10;
  const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return r1(b.top) + '+' + r1(b.height); };
  const tick = () => {
    if (window.__on) {
      const hero = q('.explorer-hero-content');
      if (hero && hero !== window.__prev) { window.__gen++; window.__prev = hero; }
      const a = hero && hero.getAnimations ? hero.getAnimations().find((x) => x.id === 'height-settle') : null;
      const k = a ? a.effect.getKeyframes() : null;
      window.__s.push({
        t: Math.round(performance.now()), gen: window.__gen,
        pages: [...document.querySelectorAll('#main-content > div')].map((p) => p.getAttribute('data-page-motion')).join('|'),
        skel: !!q('.explorer-skeleton'),
        heroH: hero ? r1(hero.getBoundingClientRect().height) : null,
        settle: k ? (k[0].height + '>' + k[1].height + '@' + Math.round(a.currentTime || 0)) : null,
        wiki: box(q('.ehc-wiki')), tabs: box(q('.ee-tabs')), row1: box(q('.explorer-list-item')),
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
try {
  let wsUrl = null;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* not up */ }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) throw new Error('no page target — ¿otra instancia de Chrome tiene el perfil bloqueado?');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pend.get(m.id); pend.delete(m.id); p(m.result); } });
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => (await cmd('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

  await cmd('Page.enable');
  await cmd('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}${INST}` });
  for (let i = 0; i < 400; i++) { if (await ev("!!document.querySelector('.ee-tabs .ee-tab')")) break; await sleep(100); }
  await sleep(3000);
  console.log('pestaña:', await ev("(() => { const t = document.querySelectorAll('.ee-tabs .ee-tab')[1]; if (!t) return null; t.click(); return t.textContent.trim(); })()"));
  // `.ex-skel-row` son las tarjetas del esqueleto: pulsarlas no navega.
  for (let i = 0; i < 300; i++) { if (await ev("!!document.querySelector('.ee-author-card:not(.ex-skel-row)')")) break; await sleep(100); }
  await sleep(1500);
  console.log('autor:', await ev("(() => { const c = document.querySelector('.ee-author-card:not(.ex-skel-row)'); if (!c) return null; const t = c.textContent.trim().slice(0, 28); c.click(); return t; })()"));
  await sleep(DWELL);
  await ev(SAMPLER);
  await ev('history.back(); true');
  await sleep(6000);

  const out = await ev(`(() => { window.__on = false; const p = window.__s; const t0 = p[0] ? p[0].t : 0;
    const o = []; let last = '';
    for (const x of p) { const k = JSON.stringify({ ...x, t: 0 }); if (k !== last) { last = k; o.push({ ...x, t: x.t - t0 }); } }
    const starts = []; let seen = '';
    for (const x of p) { const s = x.settle ? x.settle.split('@')[0] : ''; if (s && s !== seen) starts.push({ at: x.t - t0, settle: s }); seen = s; }
    return { frames: p.length, gens: window.__gen, starts, changes: o }; })()`);

  console.log(`fotogramas ${out.frames}  generaciones del héroe ${out.gens}`);
  console.log(`settles arrancados durante la vuelta: ${out.starts.length}${out.starts.length ? '  ' + out.starts.map((s) => `${s.settle}@${s.at}ms`).join('  ') : ''}`);
  const W = [6, 4, 15, 5, 7, 26, 16, 15, 15];
  const row = (v) => v.map((x, i) => String(x).padEnd(W[i])).join('');
  console.log(row(['t', 'gen', 'pages', 'skel', 'heroH', 'settle', 'wiki(top+h)', 'tabs', 'row1']));
  for (const c of out.changes) console.log(row([c.t, c.gen, c.pages, c.skel ? 'SK' : '-', c.heroH, c.settle || '-', c.wiki, c.tabs, c.row1]));
} finally {
  chrome.kill();
  await sleep(400);
  if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
