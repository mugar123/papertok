// Does a feed clipping ACTUALLY play its entrance, or does it just appear?
// No dependencies (Node >= 22 for the global WebSocket).
//
//   node scripts/diagnostics/feed-figure-entrance.mjs fresh  [cards=3] [ms]
//   node scripts/diagnostics/feed-figure-entrance.mjs return [entity=#/explorer/…] [ms]
//
// `.pc-figure` carries `figureClipIn` (620ms) and is held at `opacity: 0` with
// `animation: none` by `:not(.is-loaded)` until its picture lands. Whether the
// reader SEES that entrance cannot be read off the stylesheet: the class, the
// image's cache state, React's commit and the card's `content-visibility: auto`
// all land on the same frame budget. So this records, per rAF and per figure:
// the class, the computed opacity, and — the only thing that settles it —
// `getAnimations()`: the animation's name, playState and currentTime.
//
// An entrance the reader saw looks like currentTime climbing 0 -> 620 while the
// card is on screen. An entrance they did NOT see looks like the figure's first
// on-screen frame already at the resting pose: no running animation, or one
// whose currentTime is already past its duration.
//
// `fresh` is the control: a cold feed, scrolled card by card. `return` is the
// path the reader reported — feed, out to an entity page, back, then on to the
// next card, with every cache warm.
//
// PROFILE_DIR=<dir> reuses a Chrome profile the user has signed in to.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9231);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const OWN_PROFILE = !process.env.PROFILE_DIR;
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-figentrance-${process.pid}`);
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
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result.value;
  }
}

// Records every figure on the page, keyed by the card it belongs to, with the
// one reading that decides the question: its running animations.
const SAMPLER = `(() => {
  window.__f = []; window.__on = true; window.__gen = (window.__gen || 0);
  if (window.__figTicking) return; window.__figTicking = true;
  const r2 = (n) => Math.round(n * 100) / 100;
  const tick = () => {
    if (window.__on) {
      const figs = [...document.querySelectorAll('.pc-figure')].map((el, i) => {
        const b = el.getBoundingClientRect();
        const anims = (el.getAnimations ? el.getAnimations() : []).map((a) => ({
          name: a.animationName || (a.effect && a.effect.getKeyframes && 'kf') || '?',
          state: a.playState,
          ct: Math.round(a.currentTime || 0),
        }));
        return {
          i,
          loaded: el.classList.contains('is-loaded'),
          op: r2(Number(getComputedStyle(el).opacity)),
          // Is this figure's card actually in front of the reader?
          onScreen: b.top < innerHeight && b.bottom > 0 && b.width > 0,
          top: Math.round(b.top),
          anims,
        };
      });
      window.__f.push({ t: Date.now(), y: Math.round(document.querySelector('.feed-container')?.scrollTop ?? scrollY), figs });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const REPORT = `(() => {
  window.__on = false;
  if (!window.__f) return { reloaded: true, frames: 0, changes: [], t0: 0 };
  const p = window.__f; const out = []; let last = '';
  for (const x of p) { const k = JSON.stringify({ ...x, t: 0, y: 0 }); if (k !== last) { last = k; out.push(x); } }
  return { frames: p.length, changes: out, t0: p[0]?.t || 0 };
})()`;

const [, , ...rest] = process.argv;
const flags = new Set(rest);
const flag = (name, dflt) => ([...flags].find((f) => f.startsWith(name + '=')) || `${name}=${dflt}`).slice(name.length + 1);
const entity = flag('entity', '#/explorer/institution/I136199984');
const maxCards = Number(flag('max', 14));
const dwell = Number(flag('dwell', 1700));

// One card forward, the way the reader does it: the feed is a scroll-snap
// column, so a page-height scroll is one swipe.
const NEXT_CARD = `(() => {
  const c = document.querySelector('.feed-container') || document.scrollingElement;
  c.scrollBy({ top: c.clientHeight, behavior: 'instant' });
  return Math.round(c.scrollTop);
})()`;
const TO_TOP = `(() => {
  const c = document.querySelector('.feed-container') || document.scrollingElement;
  c.scrollTo({ top: 0, behavior: 'instant' });
  return Math.round(c.scrollTop);
})()`;
const FIG_COUNT = "document.querySelectorAll('.pc-figure').length";

function render(label, report) {
  if (report.reloaded) { console.log(`\n──────── ${label} ────────`);
    console.log('MEDIDA INVÁLIDA: la página se recargó durante la fase (404 de chunk: reconstruye ANTES de arrancar el preview).'); return; }
  const t0 = report.t0;
  console.log(`\n──────── ${label} ────────`);
  const seen = new Map();
  for (const c of report.changes) {
    for (const f of c.figs) {
      if (!f.loaded || !f.onScreen || seen.has(f.i)) continue;
      const clip = f.anims.find((a) => a.name === 'figureClipIn');
      seen.set(f.i, { at: c.t - t0, clip, op: f.op });
    }
  }
  if (!seen.size) { console.log('(ninguna figura llegó a estar cargada y en pantalla)'); return; }
  console.log('  figura | primer fotograma cargada Y en pantalla');
  let unseen = 0;
  for (const [i, v] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    let verdict;
    if (!v.clip) { verdict = 'SIN ENTRADA — figureClipIn ya no existe: corrió y terminó sin que nadie la viera'; unseen++; }
    else if (v.clip.ct >= 620) { verdict = `PERDIDA — la entrada iba por @${v.clip.ct}ms de 620`; unseen++; }
    else verdict = `vista — entrada en @${v.clip.ct}ms de 620, opacidad ${v.op}`;
    console.log(`     #${i}   | t=${String(v.at).padStart(5)}ms  ${verdict}`);
  }
  console.log(`\n  ${unseen} de ${seen.size} figuras llegaron a pantalla con su entrada ya gastada.`);
}

const chrome = launch();
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => console.error('[page exception]', exceptionDetails.text, exceptionDetails.exception?.description?.split('\n')[0] || ''));
  const waitFor = async (expr, limit = 45000) => { const s = Date.now(); while (Date.now() - s < limit) { if (await cdp.eval(expr).catch(() => false)) return true; await sleep(60); } return false; };

  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  console.log('feed vivo:      ', await waitFor("document.querySelectorAll('.feed-snap-item').length > 1"));
  await sleep(3500);

  // ── Fase 1, EN FRÍO: avanzar hasta que una tarjeta traiga figuras.
  await cdp.eval(SAMPLER);
  let hitAt = -1;
  for (let i = 1; i <= maxCards; i++) {
    await cdp.eval(NEXT_CARD);
    await sleep(dwell);
    if (await cdp.eval(FIG_COUNT) > 0) { hitAt = i; break; }
  }
  if (hitAt < 0) { console.log(`\nNinguna de las ${maxCards} primeras tarjetas trae figuras; sube max=`); }
  console.log(`\ntarjeta con figuras: #${hitAt}`);
  render(`EN FRÍO — primera vez en la tarjeta #${hitAt}`, await cdp.eval(REPORT));

  // ── Fase 2: salir a una entidad y volver, como hace el lector.
  console.log('\nsalida a entidad:', await cdp.eval(`(() => { location.hash = ${JSON.stringify(entity)}; return location.hash; })()`));
  console.log('entidad viva:   ', await waitFor("!!document.querySelector('.explorer-hero-content')"));
  await sleep(3000);
  // Vaciar el registro JUSTO antes de volver, para ver la entrada correr
  // (o no) durante la propia transición de vuelta.
  await cdp.eval(`(() => { window.__f = []; window.__on = true; })()`);
  await cdp.eval('history.back()');
  console.log('feed de vuelta: ', await waitFor("document.querySelectorAll('.feed-snap-item').length > 1"));
  await sleep(2000);
  const back = await cdp.eval(REPORT);
  render('DURANTE LA VUELTA — ¿corre la entrada, y con la tarjeta delante?', back);
  if (flags.has('raw')) {
    console.log('\n  ── fotogramas crudos de la vuelta (primeros 14 con figuras) ──');
    let n = 0;
    for (const c of back.changes) {
      if (!c.figs.length) continue;
      const d = c.figs.map((f) => `#${f.i}${f.loaded ? '+L' : '-l'} op${f.op} ${f.onScreen ? 'ON' : 'off'} [${f.anims.map((a) => `${a.name}@${a.ct}`).join(' ') || '—'}]`).join('  ');
      console.log(String(c.t - back.t0).padStart(6) + 'ms | ' + d);
      if (++n >= 14) break;
    }
  }
  await cdp.eval(`(() => { window.__on = true; })()`);

  // ── Fase 3, CALIENTE: seguir hacia DELANTE, que es lo que hace el lector al
  // volver — no revisitar la tarjeta que ya vio.
  await cdp.eval(`(() => { window.__f = []; window.__on = true; })()`);
  await sleep(300);
  let fwdAt = -1;
  const before = await cdp.eval(FIG_COUNT);
  for (let i = 1; i <= maxCards; i++) {
    await cdp.eval(NEXT_CARD);
    await sleep(dwell);
    if (await cdp.eval(FIG_COUNT) > before) { fwdAt = i; break; }
  }
  console.log(`\nsiguiente tarjeta con figuras, ${fwdAt < 0 ? 'ninguna en ' + maxCards + ' intentos' : fwdAt + ' swipes por delante'}`);
  render('CALIENTE — avanzando tras volver del Explorer', await cdp.eval(REPORT));

} finally {
  chrome.kill('SIGTERM');
  await sleep(700);
  if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
}
