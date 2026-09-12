// El relevo de caras de la píldora de refresco, fotograma a fotograma.
//   ORIGIN=http://localhost:5173 node scripts/diagnostics/refresh-face-probe.mjs
//
// Lo que contesta: si en algún fotograma se leen DOS caras a la vez (la doble
// exposición que el relevo existe para quitar), si hay alguno con la píldora
// VACÍA (el agujero que deja un retardo mayor que la salida), y cómo escalan
// la píldora y la cara que llega. `refresh-anim-probe.mjs` mira el entorno —
// el velo, las tarjetas, el salto—; esto mira sólo los catorce píxeles de
// dentro del botón.
//
// Necesita dos puertas abiertas a mano en FeedContainer.jsx, porque el lector
// de un perfil de Chrome nuevo en localhost es un INVITADO y el feed de
// invitado no tiene píldora ni activa nunca `isRefreshing`:
//   1. la guarda `!publicMode &&` de la píldora,
//   2. un `isRefreshing` que se pueda encender desde la página:
//        const [probeRefreshing, setProbeRefreshing] = useState(false);
//        useEffect(() => { window.__probeRefresh = (ms) => { setProbeRefreshing(true);
//          window.setTimeout(() => setProbeRefreshing(false), ms); }; }, []);
//        const isRefreshing = probeRefreshing || (source ? … : feed.isRefreshing);
// Hubo una tercera, y ya NO hace falta: había que meter `papers.length` en las
// dependencias del efecto que engancha el `mousemove`, porque con
// `[handleMouseMove, publicMode]` —las dos estables— el efecto corría una sola
// vez por montaje, y si en ese commit no había `.feed-container`, `feedRef.current`
// era null y el oyente no se enganchaba nunca. No era un apaño de la sonda: era
// el fallo, y en el arranque de invitado ocurría siempre (`GuestFeedPage` no
// declara `initialLoadPending`, así que cargar sin papers va al esqueleto). El
// efecto depende ahora del NODO, publicado por un callback ref, y se reengancha
// solo cuando el contenedor aparece. Si alguna vez vuelve a hacer falta tocar
// esas dependencias para que esta sonda mida, es que la regresión ha vuelto.
// Y hay que devolverlas después. Lo que se mide sigue siendo el código que se
// envía: lo único falso es quién enciende el estado.
//
// Otra trampa: headless no declara ningún dispositivo apuntador, y
// `handleMouseMove` se va en la primera línea si `(pointer: fine)` no casa.
// Se emula con `Emulation.setEmulatedMedia` (abajo) y el valor medido viaja en
// la salida, para que un fallo no se disfrace de «no pasa nada».
//
// Trampa: el medidor (`.feed-refresh-gauge`) lleva las tres etiquetas y está
// en la misma celda, así que para saber qué se lee hay que EXCLUIRLO y ordenar
// las caras vivas por opacidad — durante un relevo conviven dos.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9238);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const RUN_MS = Number(process.env.RUN_MS || 900);
const PROFILE = join(tmpdir(), `pt-face-${process.pid}`);
mkdirSync(PROFILE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* aún no escucha */ }
    await sleep(100);
  }
  throw new Error('no page');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (!m.id) return;
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async e(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

try {
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r));
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable');
  // Headless no declara ningún dispositivo apuntador, y `handleMouseMove` se
  // va en la primera línea si `(pointer: fine)` no casa: sin esto la pasada
  // del ratón mide una píldora que nunca asoma y no dice por qué. El valor
  // medido viaja en la salida (`punteroFino`) para que no pueda mentir.
  await c.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'pointer', value: 'fine' }, { name: 'any-pointer', value: 'fine' }],
  }).catch(() => {});
  await c.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });

  const until = Date.now() + 40000;
  while (Date.now() < until) {
    const ready = await c.e(`(()=>{
      const b=[...document.querySelectorAll('button')].find(x=>/Not now|Ahora no/i.test(x.textContent));
      if (b) b.click();
      return !!document.querySelector('.feed-refresh') && typeof window.__probeRefresh === 'function';
    })()`).catch(() => false);
    if (ready) break;
    await sleep(300);
  }
  await sleep(1200);

  const out = await c.e(`(async()=>{
    const pill = document.querySelector('.feed-refresh');
    if (!pill) return { error: 'sin píldora: ¿está abierta la guarda !publicMode?' };
    if (!window.__probeRefresh) return { error: 'sin __probeRefresh: falta la segunda puerta' };
    const gauge = pill.querySelector('.feed-refresh-gauge');
    const faces = () => [...pill.querySelectorAll('.feed-refresh-content')]
      .filter((el) => !gauge.contains(el))
      .map((el) => {
        const cs = getComputedStyle(el);
        return {
          text: el.textContent.trim(),
          op: Number(cs.opacity),
          // La matriz de la cara: [4] y [5] son la traslación.
          y: Number((new DOMMatrixReadOnly(cs.transform)).m42.toFixed(2)),
        };
      })
      .sort((a, b) => b.op - a.op);
    const rows = [];
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      // La propiedad scale, y NO la matriz de transform: la píldora se centra
      // con translate y escala con scale, las dos independientes, así que su
      // transform computado es none y la matriz sale identidad.
      // (Sin acentos graves aquí dentro: esto vive en un template literal.)
      const cs = getComputedStyle(pill);
      rows.push({
        at: Math.round(performance.now() - t0),
        cls: pill.className.replace('feed-refresh', '').trim() || '-',
        pillScale: Number(parseFloat(cs.scale) || 1),
        faces: faces(),
      });
      raf = requestAnimationFrame(tick);
    };
    tick();
    window.__probeRefresh(${RUN_MS});
    await new Promise((r) => setTimeout(r, ${RUN_MS} + 2600));
    cancelAnimationFrame(raf);

    // Lo que de verdad se pregunta.
    const LEGIBLE = 0.15;
    const doble = rows.filter((r) => r.faces.filter((f) => f.op > LEGIBLE).length > 1)
      .map((r) => ({ at: r.at, caras: r.faces.filter((f) => f.op > LEGIBLE).map((f) => f.text + '@' + f.op.toFixed(2)) }));
    const vacia = rows.filter((r) => r.faces.every((f) => f.op <= 0.05)).map((r) => r.at);
    // El relevo que importa: de «Actualizando…» a «Actualizado». Se localiza
    // por el primer fotograma en que la cara de trabajo deja de estar entera
    // DESPUÉS de haber estado entera — no por el reloj, que no sabe cuándo
    // llegó el commit de React.
    const full = rows.findIndex((r) => /Actualizando|Refreshing/.test(r.faces[0]?.text || '') && r.faces[0].op > 0.99);
    let from = rows.findIndex((r, i) => i > full && /Actualizando|Refreshing/.test(r.faces[0]?.text || '') && r.faces[0].op < 0.99);
    if (from < 0) from = full;
    const swap = [];
    for (let i = Math.max(0, from - 1); i < rows.length; i++) {
      swap.push(rows[i]);
      const top = rows[i].faces[0];
      if (/Actualizado|Updated/.test(top?.text || '') && top.op > 0.995 && Math.abs(top.y) < 0.15 && rows[i].pillScale === 1) break;
    }
    const peak = rows.reduce((best, r) => (r.pillScale > best.pillScale ? r : best), rows[0]);

    // Segunda pasada: el ratón QUIETO en la franja mientras el refresco cae.
    // Es el caso que se reportó — la cara volvía al verbo delante del lector,
    // sin que nada hubiera pasado — y el unico que no se ve en la primera
    // pasada, donde la píldora se esconde sola en cuanto acaba el beat.
    // El pestillo del hover (refreshHoverLockedRef) nace cerrado y solo se
    // abre con un movimiento FUERA de la franja: sin ese primer movimiento la
    // píldora nunca asoma y la medida saldría vacía sin decir por qué.
    const wrapper = document.querySelector('.feed-container').parentElement;
    const top = wrapper.getBoundingClientRect().top;
    const move = (y) => wrapper.dispatchEvent(new MouseEvent('mousemove', { clientY: top + y, clientX: 640, bubbles: true }));
    const cara = () => {
      const vivas = faces();
      return { cls: pill.className.replace('feed-refresh', '').trim() || '-', cara: vivas[0]?.text, op: Number(vivas[0]?.op.toFixed(2)) };
    };
    // Contador propio. Si el evento llega al envoltorio y aun asi la pildora
    // no asoma, el que falla es el oyente de la app y no el disparo — y eso
    // pasa: ver la tercera puerta del cabecero.
    let llegan = 0;
    wrapper.addEventListener('mousemove', () => { llegan += 1; });
    move(300); move(40);
    const conRaton = [{ at: 'antes', ...cara() }];
    window.__probeRefresh(600);
    for (let i = 0; i < 34; i++) {
      move(40);
      await new Promise((r) => setTimeout(r, 100));
      if (i === 8 || i === 20 || i === 33) conRaton.push({ at: (i + 1) * 100, ...cara() });
    }
    // Y ahora el ratón se va: la píldora se mete bajo la barra, y solo ahí
    // vuelve el verbo.
    move(300);
    const alIrse = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 100));
      alIrse.push({ at: (i + 1) * 100, ...cara() });
    }
    return {
      punteroFino: window.matchMedia('(pointer: fine)').matches,
      // Las dos señales que impiden que la pasada del ratón mienta: si los
      // eventos llegan y la píldora no asoma, lo que falla es el oyente.
      mousemovesQueLlegan: llegan,
      envoltorioEsElPadreDeLaPildora: pill.parentElement === wrapper,
      conElRatonEnLaFranja: conRaton,
      cuandoElRatonSeVa: alIrse,
      frames: rows.length,
      dobleExposicion: doble,
      fotogramasVacios: vacia,
      picoPildora: { at: peak.at, scale: peak.pillScale },
      relevo: swap.map((r) => ({
        at: r.at - swap[0].at,
        pill: r.pillScale,
        caras: r.faces.map((f) => f.text.replace(/\\s+/g, ' ') + ' op=' + f.op.toFixed(2) + ' y=' + f.y),
      })),
      colaDeLaCara: rows.filter((r) => r.at > ${RUN_MS} + 900)
        .filter((r, i, a) => i === 0 || r.faces[0]?.text !== a[i - 1].faces[0]?.text || r.cls !== a[i - 1].cls)
        .map((r) => ({ at: r.at, cls: r.cls, cara: r.faces[0]?.text, op: r.faces[0]?.op.toFixed(2) })),
    };
  })()`);
  console.log(JSON.stringify(out, null, 1));
} finally {
  chrome.kill('SIGKILL');
}
