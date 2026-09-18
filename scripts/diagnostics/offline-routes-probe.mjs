// Sin red, ¿qué sirve cada ruta? Levanta su propio `vite preview` sobre el
// `dist/` ya construido, deja que el service worker se instale y tome el
// control, APAGA el servidor y entonces pide cuatro caminos: dos rutas de la
// app, que tienen que salir de la caché, y dos páginas que no lo son —la
// landing y la política—, que tienen que quedarse sin respuesta en vez de que
// se les sustituya por la app.
//
//   node scripts/diagnostics/offline-routes-probe.mjs http://localhost:4175
//
// Lo que hace falta saber para no repetir una tarde: `Network.emulateNetworkConditions`
// con `offline: true` se aplica al target de la PESTAÑA, y el service worker es
// otro target. Con el servidor vivo, el worker sigue teniendo red y esta sonda
// mide lo que responde el servidor. Medido el 18-09-2026: con emulación, las
// cuatro rutas salían bien sin que la última oportunidad del worker llegara a
// correr ni una vez. Por eso se apaga el servidor.
//
// `CHROME=<ruta>` para otro binario. Deja el perfil en un temporal y lo borra.
import { spawn } from 'node:child_process';
import { join as joinPath } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9253;
const PROFILE = join(tmpdir(), `papertok-offline-${process.pid}`);
const ORIGIN = process.argv[2] || 'http://localhost:4175';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

const READ = `({
  url: location.href,
  title: document.title,
  app: !!document.querySelector('#root') && document.querySelector('#root').children.length > 0,
  landing: !!document.querySelector('#main-content .lp-hero'),
  policy: /privacy/i.test(document.title),
  body: (document.body.innerText || '').slice(0, 60).replace(/\\s+/g, ' '),
})`;

mkdirSync(PROFILE, { recursive: true });
const puerto = new URL(ORIGIN).port || '4175';
const servidor = spawn(joinPath(process.cwd(), 'node_modules', '.bin', 'vite'), ['preview', '--port', puerto, '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 100; i++) {
  try { await fetch(ORIGIN + '/'); break; } catch { await sleep(200); }
}
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let fallos = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'OK  ' : 'FALLA'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) fallos += 1;
};

try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* arrancando */ }
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  // Instala el worker y deja que tome el control.
  await cdp.send('Page.navigate', { url: `${ORIGIN}/feed` });
  await sleep(4000);
  const reg = await cdp.evaluate("navigator.serviceWorker.ready.then((r) => !!r.active)");
  check('el service worker esta activo', reg === true, String(reg));
  await cdp.send('Page.navigate', { url: `${ORIGIN}/feed` });
  await sleep(3000);
  const controlled = await cdp.evaluate('!!navigator.serviceWorker.controller');
  check('la pagina esta controlada por el worker', controlled === true, String(controlled));
  const warmed = await cdp.evaluate("caches.open('papertok-html').then((c) => c.keys()).then((k) => k.map((r) => new URL(r.url).pathname))");
  console.log('    en la cache papertok-html:', JSON.stringify(warmed));

  // Se APAGA el servidor, no se emula la red. `Network.emulateNetworkConditions`
  // se aplica al target de la pestana y el service worker es otro target: con
  // el servidor vivo, el worker sigue teniendo red y la sonda mide lo que
  // responde el servidor, no lo que hace el worker. Medido: con emulacion, las
  // cuatro rutas salian igual de bien sin que la ultima oportunidad llegara a
  // correr nunca.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  servidor.kill('SIGKILL');
  for (let i = 0; i < 50; i++) {
    try { await fetch(ORIGIN + '/feed'); await sleep(200); } catch { break; }
  }
  console.log('    servidor apagado');

  // Ninguna de las cuatro se ha visitado todavia, asi que la cache no las
  // tiene: lo que se mide es la ultima oportunidad, no un acierto de cache.
  // Las dos primeras son rutas de la app y tienen que salir; las dos ultimas
  // NO son rutas de la app, y que se queden sin pagina es la respuesta
  // correcta -- sustituirlas por la app seria cambiarle la pagina al lector.
  for (const [ruta, esApp] of [['/research', true], ['/lists', true], ['/', false], ['/privacy.html', false]]) {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    const nav = await cdp.send('Page.navigate', { url: ORIGIN + ruta });
    await sleep(3500);
    const s = await cdp.evaluate(READ).catch(() => ({ app: false, title: '(sin documento)', body: '' }));
    const ok = esApp ? s.app : !s.app;
    check(`sin red, ${ruta.padEnd(14)} ${esApp ? 'da la app' : 'NO da la app'}`, ok, `${nav.errorText || ''} ${s.title} | ${s.body}`.trim());
  }

  console.log(fallos ? `\n${fallos} fallo(s) sin red` : '\nsin red, las cuatro como deben');
  process.exitCode = fallos ? 1 : 0;
} finally {
  chrome.kill('SIGKILL');
  servidor.kill('SIGKILL');
  rmSync(PROFILE, { recursive: true, force: true });
}
